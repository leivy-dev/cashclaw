/**
 * claude CLI ベースの LLM プロバイダー。
 *
 * ANTHROPIC_API_KEY を使わず、ローカルの `claude` CLI（OAuth認証済み）を
 * サブプロセスとして起動して LLM 推論を行う。
 *
 * ツール使用は ReAct スタイルで実装する:
 *   - システムプロンプトにツール定義と JSON 出力形式を追加
 *   - モデルがツール呼び出しを JSON で出力 → パース → 実行 → 結果を追加して再呼び出し
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

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const CLI_TIMEOUT_MS = 300_000; // 5 minutes — LLM responses can take 2-3 minutes

// ──────────────────────────────────────────────────────────────
// Prompt building
// ──────────────────────────────────────────────────────────────

function buildToolsInstructions(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "";

  const toolsJson = JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    null,
    2,
  );

  return `
## Available Tools

You have access to the following tools. To use a tool, output a JSON block on its own line:

\`\`\`json
{"action":"tool_use","name":"<tool_name>","input":{<parameters>}}
\`\`\`

When all required tool calls are complete, provide your final response as plain text (no JSON needed to conclude).

Tools:
\`\`\`json
${toolsJson}
\`\`\`
`;
}

function serializeMessages(messages: LLMMessage[], tools: ToolDefinition[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // handled separately as --system

    const prefix = msg.role === "user" ? "User" : "Assistant";

    if (typeof msg.content === "string") {
      parts.push(`[${prefix}]: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const blocks = msg.content as ContentBlock[];
      const textBlocks = blocks.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text);
      const toolBlocks = blocks.filter((b) => b.type === "tool_use") as ToolUseBlock[];

      if (textBlocks.length > 0) {
        parts.push(`[${prefix}]: ${textBlocks.join("\n")}`);
      }
      for (const tb of toolBlocks) {
        parts.push(`[${prefix} tool_use]: ${JSON.stringify({ name: tb.name, input: tb.input })}`);
      }
    }
  }

  if (tools.length > 0) {
    parts.push(buildToolsInstructions(tools));

    // Detect whether the task context requires immediate tool use (accepted/revision)
    const hasActionRequired = parts.some((p) => p.includes("ACTION REQUIRED:"));
    if (hasActionRequired) {
      parts.push(
        "[User]: ACTION REQUIRED: You MUST use a tool now. Output a tool_use JSON block — do NOT respond with plain text only. For accepted tasks, call submit_work with the complete deliverable.",
      );
    } else {
      parts.push(
        "[User]: Continue. Use tools by outputting tool_use JSON blocks as needed, then provide your final response as plain text.",
      );
    }
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

interface ToolUseAction {
  action: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

interface EndTurnAction {
  action: "end_turn";
}

type ParsedAction = ToolUseAction | EndTurnAction;

/**
 * ```json ... ``` ブロックからブレース深さトラッキングで JSON オブジェクトを抽出する。
 * result フィールドに埋め込みコードブロック（```typescript 等）が含まれる場合でも
 * 正規表現の lazy match による誤終端を防ぐ。
 */
function extractJsonBlocks(text: string): Array<{ json: string; fullMatch: string }> {
  const results: Array<{ json: string; fullMatch: string }> = [];
  const MARKER = "```json";
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const markerStart = text.indexOf(MARKER, searchFrom);
    if (markerStart === -1) break;

    // マーカー直後の空白・改行をスキップ
    let i = markerStart + MARKER.length;
    while (i < text.length && (text[i] === " " || text[i] === "\r" || text[i] === "\n")) {
      i++;
    }

    // JSON オブジェクトは '{' で始まるはず
    if (i >= text.length || text[i] !== "{") {
      searchFrom = markerStart + MARKER.length;
      continue;
    }

    // ブレース深さトラッキングで JSON オブジェクトの終端を検索
    const jsonStart = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let jsonEnd = -1;

    for (let j = jsonStart; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            jsonEnd = j;
            break;
          }
        }
      }
    }

    if (jsonEnd === -1) {
      searchFrom = markerStart + MARKER.length;
      continue;
    }

    const jsonStr = text.slice(jsonStart, jsonEnd + 1);

    // 終端の ``` を探して fullMatch を決定
    const closingIdx = text.indexOf("```", jsonEnd + 1);
    const fullMatchEnd = closingIdx !== -1 ? closingIdx + 3 : jsonEnd + 1;
    const fullMatch = text.slice(markerStart, fullMatchEnd);

    results.push({ json: jsonStr, fullMatch });
    searchFrom = fullMatchEnd;
  }

  return results;
}

function parseActions(text: string): { actions: ParsedAction[]; plainText: string } {
  const actions: ParsedAction[] = [];
  let plainText = text;

  // ```json ... ``` ブロックを抽出（ブレース深さパーサー使用）
  const blocks = extractJsonBlocks(text);

  for (const block of blocks) {
    // claude CLI が XML タグ（</parameter> 等）を末尾に漏らすことがある — 除去してからパース
    const content = block.json.replace(/(<\/?\w+(?:\s[^>]*)?>)+\s*$/, "").trim();
    try {
      const parsed = JSON.parse(content) as ParsedAction;
      if (parsed.action === "tool_use" || parsed.action === "end_turn") {
        actions.push(parsed);
        plainText = plainText.replace(block.fullMatch, "").trim();
      }
    } catch {
      // パース失敗は無視
    }
  }

  // インライン JSON も試みる（```なし）
  if (actions.length === 0) {
    const inlineRe = /\{[^{}]*"action"\s*:\s*"(tool_use|end_turn)"[^{}]*\}/g;
    let match: RegExpExecArray | null;
    while ((match = inlineRe.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[0]) as ParsedAction;
        actions.push(parsed);
        plainText = plainText.replace(match[0], "").trim();
      } catch {
        // 無視
      }
    }
  }

  return { actions, plainText };
}

function buildResponse(text: string, hasTools: boolean): LLMResponse {
  const { actions, plainText } = hasTools ? parseActions(text) : { actions: [], plainText: text };

  const content: ContentBlock[] = [];
  let stopReason: LLMResponse["stopReason"] = "end_turn";
  let toolUseCounter = 0;

  for (const action of actions) {
    if (action.action === "tool_use") {
      content.push({
        type: "tool_use",
        id: `cli_tool_${Date.now()}_${toolUseCounter++}`,
        name: action.name,
        input: action.input,
      });
      stopReason = "tool_use";
    }
  }

  if (plainText.trim()) {
    content.push({ type: "text", text: plainText.trim() });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: text.trim() || "(empty response)" });
  }

  return {
    content,
    stopReason,
    // claude CLI はトークン数を返さないため推定値を使う
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };
}

// ──────────────────────────────────────────────────────────────
// Process execution (spawn-based to avoid stdin hang)
// ──────────────────────────────────────────────────────────────

function spawnClaude(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"], // stdin=ignore prevents hang
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${CLI_TIMEOUT_MS / 1000}s`));
    }, CLI_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ──────────────────────────────────────────────────────────────
// Provider factory
// ──────────────────────────────────────────────────────────────

export function createClaudeCliProvider(model?: string): LLMProvider {
  const resolvedModel = model ?? DEFAULT_MODEL;

  return {
    async chat(messages, tools = []) {
      const systemPrompt = extractSystem(messages);
      const userPrompt = serializeMessages(messages, tools);

      const args: string[] = [
        "--print",
        "--output-format",
        "text",
        "--no-session-persistence",
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "local", // skip user CLAUDE.md/hooks — avoids explanatory style & auto-memory overhead
        "--model",
        resolvedModel,
      ];

      if (systemPrompt) {
        args.push("--system-prompt", systemPrompt);
      }

      args.push("--", userPrompt);

      const stdout = await spawnClaude(args);
      return buildResponse(stdout, tools.length > 0);
    },
  };
}
