/**
 * Discord Webhook Notifier for CashClaw
 *
 * Sends notifications to a Discord channel via webhook when key events occur.
 * Configure the webhook URL via the CASHCLAW_DISCORD_WEBHOOK env var or
 * the discordWebhookUrl field in ~/.cashclaw/cashclaw.json.
 */

import type { ActivityEvent } from "./heartbeat.js";

const COLORS = {
  loop_start: 0x5865f2,   // Blurple — task started
  loop_complete: 0x57f287, // Green — task done
  feedback: 0xfee75c,      // Yellow — rated
  error: 0xed4245,         // Red — error
  ws: 0x95a5a6,            // Grey — connectivity
  poll: null,              // No notification for polls
  tool_call: 0xf1c40f,     // Gold — used only for claim_bounty
  study: 0x9b59b6,         // Purple — learning
} as const;

// Tool calls that warrant a Discord notification
const NOTIFIABLE_TOOLS = new Set(["claim_bounty", "quote_task"]);

export interface DiscordNotifierConfig {
  webhookUrl: string;
  agentId: string;
}

export function createDiscordNotifier(cfg: DiscordNotifierConfig) {
  const { webhookUrl, agentId } = cfg;

  async function send(payload: object): Promise<void> {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error(`[discord] webhook failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error("[discord] webhook error:", err);
    }
  }

  function formatEth(wei: string | undefined): string {
    if (!wei) return "?";
    const eth = Number(BigInt(wei)) / 1e18;
    return `${eth.toFixed(4)} ETH`;
  }

  async function notify(event: ActivityEvent, extra?: { taskDescription?: string; priceWei?: string; score?: number }): Promise<void> {
    // For tool_call events, only notify for specific tools
    if (event.type === "tool_call") {
      const toolName = event.message.split("(")[0];
      if (!NOTIFIABLE_TOOLS.has(toolName)) return;
    }

    const color = COLORS[event.type];
    if (color === null || color === undefined) return; // suppress noisy events

    const timestamp = new Date(event.timestamp).toISOString();
    const taskIdShort = event.taskId ? `\`${event.taskId.slice(0, 8)}...\`` : null;

    let title = "";
    let description = event.message;

    switch (event.type) {
      case "loop_start":
        title = "📥 タスク受注 — 作業開始";
        if (extra?.taskDescription) {
          description = `**依頼内容**: ${extra.taskDescription.slice(0, 200)}${extra.taskDescription.length > 200 ? "..." : ""}`;
          if (extra.priceWei) {
            description += `\n**見積もり**: ${formatEth(extra.priceWei)}`;
          }
        }
        break;
      case "loop_complete":
        title = "✅ タスク完了 — 成果物提出";
        break;
      case "feedback":
        title = "⭐ フィードバック受信";
        if (extra?.score !== undefined) {
          const stars = "⭐".repeat(extra.score) + "☆".repeat(5 - extra.score);
          description = `${stars} (${extra.score}/5)\n${event.message}`;
        }
        break;
      case "error":
        title = "❌ エラー発生";
        break;
      case "ws":
        title = "🔌 WebSocket 状態変化";
        break;
      case "study":
        title = "📚 学習セッション";
        break;
      case "tool_call": {
        const toolName = event.message.split("(")[0];
        if (toolName === "claim_bounty") {
          title = "💰 ETH受領 — バウンティ回収";
          const success = event.message.includes("→ ok");
          description = success ? "バウンティのETHを正常に回収しました" : `回収失敗: ${event.message}`;
        } else if (toolName === "quote_task") {
          title = "📋 見積もり送信";
          description = event.message;
        } else {
          title = `CashClaw ツール: ${toolName}`;
        }
        break;
      }
      default:
        title = `CashClaw イベント: ${event.type}`;
    }

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: "Agent ID", value: `\`${agentId}\``, inline: true },
      { name: "時刻", value: `<t:${Math.floor(event.timestamp / 1000)}:R>`, inline: true },
    ];

    if (taskIdShort) {
      fields.push({ name: "Task ID", value: taskIdShort, inline: true });
    }

    await send({
      embeds: [
        {
          title,
          description,
          color,
          fields,
          footer: { text: "CashClaw Autonomous Agent" },
          timestamp,
        },
      ],
    });
  }

  return { notify };
}

export type DiscordNotifier = ReturnType<typeof createDiscordNotifier>;
