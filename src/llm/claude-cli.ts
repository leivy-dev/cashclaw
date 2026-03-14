/**
 * claude CLI ベースの LLM プロバイダー（フォールバック付き）
 *
 * 実行順: claude → codex → gemini → opencode
 *
 * agent-gateway の実装に準拠:
 * - spawn + stdio:['ignore','pipe','pipe'] で stdin を閉じる
 * - --permission-mode bypassPermissions でパーミッション確認をスキップ
 * - --no-session-persistence でセッション管理を無効化
 */
import { spawn } from "node:child_process";
import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  ToolDefinition,
  ContentBlock,
  ToolUseBlock,
} from "./types.js";

const DEFAULT_MODEL       = "claude-sonnet-4-6";
const FALLBACK_CODEX      = "gpt-5.4";
const FALLBACK_GEMINI     = "gemini-2.5-flash";
const FALLBACK_OPENCODE   = "opencode/minimax-m2.5";

const CLI_TIMEOUT_MS      = 90_000;  // 90s (agent-gateway準拠)
const CODEX_TIMEOUT_MS    = 120_000;

// ──────────────────────────────────────────────────────────────
// Prompt building
// ──────────────────────────────────────────────────────────────

function buildToolsInstructions(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "";
  const toolsJson = JSON.stringify(
    tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })),
    null, 2,
  );
  return `
## Available Tools

To use a tool, output a JSON block on its own line:
\`\`\`json
{"action":"tool_use","name":"<tool_name>","input":{<parameters>}}
\`\`\`
When finished, output:
\`\`\`json
{"action":"end_turn"}
\`\`\`
Then provide your final response as plain text.

Tools:
\`\`\`json
${toolsJson}
\`\`\`
`;
}

function serializeMessages(messages: LLMMessage[], tools: ToolDefinition[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // handled separately as --system-prompt
    const prefix = msg.role === "user" ? "User" : "Assistant";
    if (typeof msg.content === "string") {
      parts.push(`[${prefix}]: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const blocks = msg.content as ContentBlock[];
      const textParts = blocks.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text);
      const toolBlocks = blocks.filter((b) => b.type === "tool_use") as ToolUseBlock[];
      if (textParts.length > 0) parts.push(`[${prefix}]: ${textParts.join("\n")}`);
      for (const tb of toolBlocks) {
        parts.push(`[${prefix} tool_use]: ${JSON.stringify({ name: tb.name, input: tb.input })}`);
      }
    }
  }
  if (tools.length > 0) {
    parts.push(buildToolsInstructions(tools));
    parts.push("[User]: Continue. If you need to use a tool, output the JSON block. Otherwise output end_turn JSON and your final response.");
  }
  return parts.join("\n\n");
}

function extractSystem(messages: LLMMessage[]): string {
  const sysMsg = messages.find((m) => m.role === "system");
  if (!sysMsg || typeof sysMsg.content !== "string") return "";
  return sysMsg.content;
}

// ──────────────────────────────────────────────────────────────
// Response parsing
// ──────────────────────────────────────────────────────────────

interface ToolUseAction { action: "tool_use"; name: string; input: Record<string, unknown> }
interface EndTurnAction  { action: "end_turn" }
type ParsedAction = ToolUseAction | EndTurnAction;

function parseActions(text: string): { actions: ParsedAction[]; plainText: string } {
  const actions: ParsedAction[] = [];
  let plainText = text;
  const jsonBlockRe = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = jsonBlockRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as ParsedAction;
      if (parsed.action === "tool_use" || parsed.action === "end_turn") {
        actions.push(parsed);
        plainText = plainText.replace(match[0], "").trim();
      }
    } catch { /* ignore */ }
  }
  if (actions.length === 0) {
    const inlineRe = /\{[^{}]*"action"\s*:\s*"(tool_use|end_turn)"[^{}]*\}/g;
    while ((match = inlineRe.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[0]) as ParsedAction;
        actions.push(parsed);
        plainText = plainText.replace(match[0], "").trim();
      } catch { /* ignore */ }
    }
  }
  return { actions, plainText };
}

function buildResponse(text: string, hasTools: boolean): LLMResponse {
  const { actions, plainText } = hasTools ? parseActions(text) : { actions: [], plainText: text };
  const content: ContentBlock[] = [];
  let stopReason: LLMResponse["stopReason"] = "end_turn";
  let counter = 0;
  for (const action of actions) {
    if (action.action === "tool_use") {
      content.push({ type: "tool_use", id: `cli_tool_${Date.now()}_${counter++}`, name: action.name, input: action.input });
      stopReason = "tool_use";
    }
  }
  if (plainText.trim()) content.push({ type: "text", text: plainText.trim() });
  if (content.length === 0) content.push({ type: "text", text: text.trim() || "(empty response)" });
  return { content, stopReason, usage: { inputTokens: 0, outputTokens: 0 } };
}

// ──────────────────────────────────────────────────────────────
// CLI runner (agent-gateway 準拠: spawn + stdin ignored)
// ──────────────────────────────────────────────────────────────

function runCli(
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const [binary, ...rest] = args;
    const child = spawn(binary, rest, {
      stdio: ["ignore", "pipe", "pipe"],  // stdin を閉じる (agent-gateway 準拠)
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timeout after ${timeoutMs}ms: ${binary}`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${binary} exited ${code ?? "null"}: ${stderr.slice(0, 300)}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn error (${binary}): ${err.message}`));
    });
  });
}

// ──────────────────────────────────────────────────────────────
// Individual CLI callers
// ──────────────────────────────────────────────────────────────

async function callClaude(systemPrompt: string, userPrompt: string, model: string): Promise<string> {
  const args = [
    "claude",
    "--print",
    "--output-format", "text",
    "--permission-mode", "bypassPermissions",   // agent-gateway 準拠: パーミッション確認スキップ
    "--no-session-persistence",                  // agent-gateway 準拠: セッション保存無効
    "--model", model,
  ];
  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  args.push("--", userPrompt);
  return runCli(args, CLI_TIMEOUT_MS);
}

async function callCodex(prompt: string): Promise<string> {
  const cwd = process.env["HOME"] ?? "/tmp";
  const args = [
    "codex", "exec",
    "--skip-git-repo-check",
    "--model", FALLBACK_CODEX,
    "--cd", cwd,
    prompt,
  ];
  return runCli(args, CODEX_TIMEOUT_MS);
}

async function callGemini(prompt: string): Promise<string> {
  return runCli(["gemini", "-p", prompt, "-m", FALLBACK_GEMINI], CLI_TIMEOUT_MS);
}

async function callOpenCode(prompt: string): Promise<string> {
  const cwd = process.env["HOME"] ?? "/tmp";
  return runCli(
    ["opencode", "run", prompt, "--dir", cwd, "-m", FALLBACK_OPENCODE],
    CLI_TIMEOUT_MS,
  );
}

// ──────────────────────────────────────────────────────────────
// Fallback chain: claude → codex → gemini → opencode
// ──────────────────────────────────────────────────────────────

async function chatWithFallback(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<string> {
  const errors: string[] = [];

  // 1. claude CLI
  try {
    return await callClaude(systemPrompt, userPrompt, model);
  } catch (e) {
    errors.push(`claude: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[cashclaw llm] claude failed, trying codex... (${errors[0]})`);
  }

  // combined prompt for non-claude providers (they don't support --system-prompt)
  const combined = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;

  // 2. codex
  try {
    return await callCodex(combined);
  } catch (e) {
    errors.push(`codex: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[cashclaw llm] codex failed, trying gemini... (${errors[1]})`);
  }

  // 3. gemini
  try {
    return await callGemini(combined);
  } catch (e) {
    errors.push(`gemini: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[cashclaw llm] gemini failed, trying opencode... (${errors[2]})`);
  }

  // 4. opencode (minimax M2.5)
  try {
    return await callOpenCode(combined);
  } catch (e) {
    errors.push(`opencode: ${e instanceof Error ? e.message : String(e)}`);
  }

  throw new Error(`All LLM providers failed:\n${errors.join("\n")}`);
}

// ──────────────────────────────────────────────────────────────
// Provider factory
// ──────────────────────────────────────────────────────────────

export function createClaudeCliProvider(model?: string): LLMProvider {
  const resolvedModel = model ?? DEFAULT_MODEL;
  return {
    async chat(messages: LLMMessage[], tools: ToolDefinition[] = []) {
      const systemPrompt = extractSystem(messages);
      const userPrompt   = serializeMessages(messages, tools);
      const raw = await chatWithFallback(systemPrompt, userPrompt, resolvedModel);
      return buildResponse(raw, tools.length > 0);
    },
  };
}
