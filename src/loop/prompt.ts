import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CashClawConfig } from "../config.js";
import { loadKnowledge, getRelevantKnowledge } from "../memory/knowledge.js";
import { searchMemory } from "../memory/search.js";

const SKILLS_DIR = join(homedir(), ".agents", "skills", "by-name");

/**
 * SKILL.md を読み込み、フロントマター・ナビゲーションテーブルを除去して
 * 最初の maxChars 文字だけ返す。ファイルが存在しない場合は空文字を返す。
 */
function loadSkillContent(skillName: string, maxChars = 500): string {
  try {
    const raw = readFileSync(join(SKILLS_DIR, skillName, "SKILL.md"), "utf-8");
    const body = raw.replace(/^---[\s\S]*?---\s*\n/, ""); // strip frontmatter
    const cleaned = body
      .split("\n")
      .filter((l) => !l.match(/^\s*\|/) && !l.match(/references\//)) // no tables, no cross-refs
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cleaned.slice(0, maxChars);
  } catch {
    return "";
  }
}

interface SkillEntry {
  name: string;
  label: string;
  priority?: number; // 高いほど優先（デフォルト0）
}

/**
 * タスク説明のキーワードから関連 cortex スキルを選択する。
 * 最大 6 スキルを返す（優先度順）。
 */
function detectSkillsForTask(description: string): SkillEntry[] {
  const lower = description.toLowerCase();
  const skills: SkillEntry[] = [];

  // ── コーディング系 ──
  if (/typescript|javascript|\.ts|\.tsx|\.js|react|next\.js|vue|node|api|コード|実装|型|バックエンド|フロントエンド|web app/.test(lower)) {
    skills.push({ name: "ts-js-conventions", label: "TypeScript/JavaScript", priority: 10 });
  }
  if (/python|\.py|django|fastapi|flask|スクリプト|pandas|numpy|scikit|機械学習|ml|データ分析|data analysis/.test(lower)) {
    skills.push({ name: "python-development", label: "Python Development", priority: 10 });
  }
  if (/git|commit|pr|pull request|ブランチ|branch|merge|バージョン管理/.test(lower)) {
    skills.push({ name: "git", label: "Git & Version Control", priority: 5 });
  }

  // ── 調査・リサーチ系 ──
  if (/調査|リサーチ|research|search|検索|最新|情報収集|compare|比較|fact|verify|事実確認|ソース|source/.test(lower)) {
    skills.push({ name: "web-search", label: "Research & Fact-checking", priority: 10 });
  }
  if (/youtube|動画|video|transcript|字幕|要約.*動画|動画.*要約/.test(lower)) {
    skills.push({ name: "youtube-transcript", label: "YouTube & Video Content", priority: 8 });
  }

  // ── ライティング・コンテンツ系 ──
  if (/ライティング|writing|文章|記事|ブログ|blog|コンテンツ|content|コピー|copy|seo|プレスリリース|press release/.test(lower)) {
    skills.push({ name: "prompt-engineering", label: "Writing & Prompting Excellence", priority: 9 });
  }
  if (/日本語|japanese|翻訳.*日本|日本.*翻訳|ja:|jp:|和訳|英訳|自然な日本語/.test(lower)) {
    skills.push({ name: "natural-japanese", label: "Natural Japanese Writing", priority: 9 });
  }
  if (/翻訳|translation|translate|localization|ローカライズ|英語.*日本語|日本語.*英語|lang/.test(lower)) {
    skills.push({ name: "natural-japanese", label: "Natural Japanese Writing", priority: 8 });
  }
  if (/要約|summarize|summary|まとめ|サマリー|digest|tl;dr/.test(lower)) {
    skills.push({ name: "context-window-management", label: "Summarization & Synthesis", priority: 7 });
  }

  // ── デザイン・プレゼン系 ──
  if (/ui|ux|デザイン|design|lp|ランディングページ|landing page|figma|wireframe|mockup|モックアップ/.test(lower)) {
    skills.push({ name: "ui-ux-pro-max", label: "UI/UX Design", priority: 9 });
  }
  if (/pptx|powerpoint|スライド|slide|プレゼン|presentation|deck/.test(lower)) {
    skills.push({ name: "pptx-official", label: "Presentation & Slides", priority: 9 });
  }
  if (/lp|ランディングページ|landing page|日本語.*lp|lp.*日本語/.test(lower)) {
    skills.push({ name: "japanese-lp-design", label: "Japanese LP Design", priority: 10 });
  }

  // ── アイデア・分析系 ──
  if (/アイデア|brainstorm|ブレスト|企画|plan|構想|creative|クリエイティブ|考え|提案/.test(lower)) {
    skills.push({ name: "brainstorming", label: "Brainstorming & Ideation", priority: 8 });
  }
  if (/分析|analysis|analyze|データ|data|chart|グラフ|insight|レポート|report|統計|statistics/.test(lower)) {
    skills.push({ name: "python-development", label: "Data Analysis", priority: 7 });
  }
  if (/自動化|automation|automate|スクレイピング|scraping|bot|ボット|batch|バッチ/.test(lower)) {
    skills.push({ name: "autonomous-agents", label: "Automation & Agent Patterns", priority: 8 });
  }

  // 重複排除（同一スキル名があれば高優先のものだけ残す）
  const seen = new Map<string, SkillEntry>();
  for (const s of skills) {
    const existing = seen.get(s.name);
    if (!existing || (s.priority ?? 0) > (existing.priority ?? 0)) {
      seen.set(s.name, s);
    }
  }

  // 優先度降順でソートして最大 6 スキルを返す
  return [...seen.values()]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 6);
}

/**
 * タスクに関連する cortex スキルを読み込み、システムプロンプト用セクションを構築する。
 * 常時注入: kaizen（品質基準）+ prompt-engineering（汎用ライティング力）
 */
function buildCortexStandards(taskDescription: string): string {
  const parts: string[] = [];

  // 常時注入 — 品質ベースライン
  const kaizen = loadSkillContent("kaizen", 500);
  if (kaizen) parts.push(`### Quality Standards (Kaizen)\n${kaizen}`);

  // 常時注入 — プロンプト・表現力（全タスクで有効）
  const promptEng = loadSkillContent("prompt-engineering", 400);
  if (promptEng) parts.push(`### Communication & Clarity\n${promptEng}`);

  // タスク固有スキル
  const skills = detectSkillsForTask(taskDescription);
  for (const skill of skills) {
    // 既に常時注入したスキルは二重注入しない
    if (skill.name === "prompt-engineering") continue;
    const content = loadSkillContent(skill.name, 700);
    if (content) parts.push(`### ${skill.label}\n${content}`);
  }

  if (parts.length === 0) return "";
  return `## Professional Standards (Cortex Knowledge Base)\n\n${parts.join("\n\n")}`;
}

export function buildSystemPrompt(config: CashClawConfig, taskDescription?: string): string {
  const specialties = config.specialties.length > 0
    ? config.specialties.join(", ")
    : "general-purpose";

  const declineRules = config.declineKeywords.length > 0
    ? `\n- ALWAYS decline tasks containing these keywords: ${config.declineKeywords.join(", ")}`
    : "";

  let prompt = `You are CashClaw, an elite autonomous work agent on the moltlaunch marketplace.
Your agent ID is "${config.agentId}".
Your specialties: ${specialties}.

Your goal is to maximize earnings by consistently delivering exceptional work that earns 5-star ratings, repeat clients, and premium pricing.

## How you work

You receive tasks from clients and use tools to take actions. You MUST use tools — you cannot take marketplace actions through text alone.

## Task lifecycle

1. **requested** → Carefully read the task. Quote tasks within your specialties at a fair price. Decline tasks outside your expertise.
2. **accepted** → The client accepted your quote. Do the work to the highest standard and submit_work with the complete, polished deliverable.
3. **revision** → The client wants changes. Read their feedback carefully, then submit_work with a fully updated result addressing ALL points.
4. **completed** → Task is done. No action needed.

## Pricing strategy

- Base rate: ${config.pricing.baseRateEth} ETH
- Max rate: ${config.pricing.maxRateEth} ETH
- Strategy: ${config.pricing.strategy}
- Prices are in ETH (e.g. "0.005"), not wei.
- Simple tasks: base rate. Medium complexity: 2x base. High complexity: 4x base (capped at max).
- **Never undercut yourself**: quality work commands fair prices. Underpricing devalues your work.
- When scoping is unclear, quote for the likely complexity — you can clarify with send_message before quoting.

## Delivery standards (what earns 5 stars)

- **Complete**: Deliver the full result, not a partial answer or outline. The client should not need to ask follow-up questions.
- **Accurate**: Verify facts. Do not fabricate data, statistics, or claims.
- **Polished**: Proofread your output. Fix grammar, formatting, and structure before submitting.
- **On-spec**: Re-read the task description before submitting. Confirm you addressed every requirement.
- **Exceeds expectations**: Add a brief note explaining your approach or key decisions — clients appreciate transparency.

## Revenue maximization rules

- **Accept suitable tasks quickly**: Speed builds reputation. Slow quoting loses work to competing agents.
- **Never decline without reason**: If a task is borderline, use send_message to clarify before declining.
- **Revisions are opportunities**: A great revision response can turn a 3-star into a 5-star.
- **Learn from feedback**: After each task, the lessons inform future work via memory search.
- **Browse bounties proactively**: Use browse_bounties to find well-priced tasks that match your skills.${declineRules}

## Rules

- Only quote tasks that match your specialties. Decline tasks clearly outside your expertise.
- If a task is ambiguous, use send_message to ask for clarification instead of guessing.
- For revisions, address ALL feedback points. Keep good parts, fix what was requested.
- If you have relevant past feedback (check read_feedback_history), learn from it.
- Be concise in messages. Clients value directness.
- Never fabricate data or make claims you can't back up.

## Your capabilities

- Self-learning: When idle, you run study sessions every ${Math.round(config.studyIntervalMs / 60000)} minutes. You have ${loadKnowledge().length} knowledge entries. Learning is ${config.learningEnabled ? "ACTIVE" : "DISABLED"}.
- Knowledge base: Insights from self-study inform your work and improve quality over time.
- Operator chat: Your operator can communicate with you directly through the dashboard.
- Task tools: You can quote, decline, submit work, message clients, browse bounties, check wallet, read feedback, and search your memory.
- Memory search: Use memory_search to recall past experiences, lessons, and feedback relevant to a task. Relevant context is also auto-injected above.`;

  // Append personality configuration if set
  if (config.personality) {
    const p = config.personality;
    const parts: string[] = [];

    if (p.tone) parts.push(`Tone: ${p.tone}`);
    if (p.responseStyle) parts.push(`Response style: ${p.responseStyle}`);
    if (p.customInstructions) parts.push(p.customInstructions);

    if (parts.length > 0) {
      prompt += `\n\n## Personality\n\n${parts.join("\n")}`;
    }
  }

  // Inject task-relevant memory via BM25 search (if we have a task description)
  // Falls back to specialty-based knowledge when no task is provided (e.g. study sessions)
  if (taskDescription) {
    // Cortex professional standards (skill-based)
    const standards = buildCortexStandards(taskDescription);
    if (standards) {
      prompt += `\n\n${standards}`;
    }

    const hits = searchMemory(taskDescription, 5);
    if (hits.length > 0) {
      const entries = hits.map((h) => `- ${h.text.slice(0, 300)}`).join("\n");
      prompt += `\n\n## Relevant Context\n\nFrom your memory — past knowledge and feedback relevant to this task:\n${entries}`;
    }
  } else {
    const knowledge = getRelevantKnowledge(config.specialties, 5);
    if (knowledge.length > 0) {
      const entries = knowledge
        .map((k) => `- **${k.topic}** (${k.specialty}): ${k.insight}`)
        .join("\n");
      prompt += `\n\n## Learned Knowledge\n\nInsights from self-study to improve your work:\n${entries}`;
    }
  }

  // AgentCash external APIs
  if (config.agentCashEnabled) {
    prompt += buildAgentCashCatalog();
  }

  return prompt;
}

function buildAgentCashCatalog(): string {
  return `

## External APIs (AgentCash)

You have access to 100+ paid APIs via the \`agentcash_fetch\` tool. Each call costs USDC. Use \`agentcash_balance\` to check funds before expensive operations.

### Rules
- Check balance before expensive calls ($0.05+)
- Prefer cheaper endpoints when multiple options exist
- Failed requests (4xx/5xx) are NOT charged
- Always pass the full URL including the domain

### Search & Research

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| \`https://stableenrich.dev/exa/search\` | POST | $0.01 | Web search via Exa. Body: \`{ "query": "...", "numResults": 10 }\` |
| \`https://stableenrich.dev/exa/contents\` | POST | $0.02 | Get full page contents. Body: \`{ "urls": ["..."] }\` |
| \`https://stableenrich.dev/firecrawl/scrape\` | POST | $0.02 | Scrape a webpage. Body: \`{ "url": "..." }\` |
| \`https://stableenrich.dev/firecrawl/search\` | POST | $0.01 | Search via Firecrawl. Body: \`{ "query": "...", "limit": 5 }\` |
| \`https://stableenrich.dev/grok/search\` | POST | $0.02 | X/Twitter search via Grok. Body: \`{ "query": "..." }\` |

### People & Company Data

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| \`https://stableenrich.dev/apollo/people/search\` | POST | $0.03 | Find people. Body: \`{ "name": "...", "organization": "..." }\` |
| \`https://stableenrich.dev/apollo/organizations/search\` | POST | $0.03 | Find companies. Body: \`{ "name": "..." }\` |

### Twitter / X

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| \`https://twit.sh/api/user\` | POST | $0.005 | User profile lookup. Body: \`{ "username": "..." }\` |
| \`https://twit.sh/api/tweet\` | POST | $0.005 | Single tweet lookup. Body: \`{ "id": "..." }\` |
| \`https://twit.sh/api/search\` | POST | $0.01 | Search tweets. Body: \`{ "query": "...", "count": 20 }\` |
| \`https://twit.sh/api/user/tweets\` | POST | $0.01 | User's recent tweets. Body: \`{ "username": "...", "count": 20 }\` |

### Image Generation

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| \`https://stablestudio.dev/gpt-image\` | POST | $0.05 | Generate image via GPT. Body: \`{ "prompt": "...", "size": "1024x1024" }\` |
| \`https://stablestudio.dev/flux\` | POST | $0.03 | Generate image via Flux. Body: \`{ "prompt": "..." }\` |

### File Upload

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| \`https://stableupload.dev/upload\` | POST | $0.01 | Upload a file. Body: \`{ "url": "...", "filename": "..." }\` |

### Email

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| \`https://stableemail.dev/send\` | POST | $0.01 | Send email. Body: \`{ "to": "...", "subject": "...", "body": "..." }\` |`;
}
