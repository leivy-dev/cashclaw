/**
 * Discord Webhook Notifier for CashClaw
 *
 * Sends notifications to a Discord channel via webhook when key events occur.
 * Configure the webhook URL via the CASHCLAW_DISCORD_WEBHOOK env var or
 * the discordWebhookUrl field in ~/.cashclaw/cashclaw.json.
 */

import type { ActivityEvent } from "./heartbeat.js";

const COLORS = {
  loop_start_requested:  0x5865f2, // Blurple  — 新規タスク受注
  loop_start_accepted:   0x2ecc71, // Green    — 見積もり承認→作業開始
  loop_start_revision:   0xe67e22, // Orange   — 修正依頼
  loop_complete:         0x57f287, // Bright green — 納品完了
  feedback:              0xfee75c, // Yellow   — フィードバック
  error:                 0xed4245, // Red      — エラー
  ws:                    0x95a5a6, // Grey     — 接続状態
  study:                 0x9b59b6, // Purple   — 学習
  claim_bounty:          0xf1c40f, // Gold     — ETH受領
  quote_task:            0x3498db, // Blue     — 見積もり送信
  task_cancelled:        0xe74c3c, // Dark red — クライアントキャンセル
  task_expired:          0x7f8c8d, // Dark grey— 期限切れ
  task_disputed:         0xff6b35, // Deep orange — ディスピュート（最重要）
  task_resolved:         0x1abc9c, // Teal     — 解決済み
} as const;

// tool_call events: only these tool names fire a notification
const NOTIFIABLE_TOOLS = new Set(["claim_bounty", "quote_task", "submit_work"]);

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

  async function notify(event: ActivityEvent): Promise<void> {
    let title = "";
    let description = event.message;
    let color = 0x95a5a6;
    const extraFields: Array<{ name: string; value: string; inline?: boolean }> = [];

    switch (event.type) {
      // ── ループ開始: statusで分岐 ──
      case "loop_start": {
        if (event.message.includes("(revision)")) {
          title = "🔄 修正依頼 — 再作業開始";
          description = "クライアントから修正を求められました。ループを再開します。";
          color = COLORS.loop_start_revision;
        } else if (event.message.includes("(accepted)")) {
          title = "✅ 見積もり承認 — 作業開始確定";
          description = "クライアントが見積もりを承認しました。作業を開始します。";
          color = COLORS.loop_start_accepted;
        } else {
          title = "📥 新規タスク受注";
          description = "Moltlaunchから新しい依頼が届きました。";
          color = COLORS.loop_start_requested;
        }
        break;
      }

      // ── 納品完了 ──
      case "loop_complete":
        title = "📦 納品完了 — 承認待ち";
        description = event.message;
        color = COLORS.loop_complete;
        break;

      // ── クライアント承認 + 評価 ──
      case "feedback": {
        const scoreMatch = event.message.match(/rated (\d)/);
        const score = scoreMatch ? parseInt(scoreMatch[1]) : undefined;
        const ethMatch = event.message.match(/— ([\d.]+) ETH/);
        const ethAmount = ethMatch ? ethMatch[1] : undefined;
        const commentMatch = event.message.match(/ — "(.+)"$/);
        const comment = commentMatch ? commentMatch[1] : undefined;
        title = "⭐ フィードバック受信 — ETH着金";
        if (score !== undefined) {
          const stars = "⭐".repeat(score) + "☆".repeat(5 - score);
          description = `${stars} (${score}/5)`;
          if (comment) {
            description += `\n> ${comment}`;
          }
        } else {
          description = event.message;
        }
        if (ethAmount) {
          extraFields.push({ name: "着金額", value: `**${ethAmount} ETH**`, inline: true });
        }
        color = COLORS.feedback;
        break;
      }

      // ── tool_call: 特定ツールのみ通知 ──
      case "tool_call": {
        const toolName = event.message.split("(")[0];
        if (!NOTIFIABLE_TOOLS.has(toolName)) return;
        if (toolName === "claim_bounty") {
          title = "💰 ETH受領 — バウンティ回収";
          const ok = event.message.includes("→ ok");
          description = ok ? "ETHをウォレットに回収しました。" : `回収失敗: ${event.message}`;
          color = COLORS.claim_bounty;
        } else if (toolName === "submit_work") {
          const ok = event.message.includes("→ ok");
          title = ok ? "📤 納品送信 — レビュー待ち" : "❌ 納品送信失敗";
          description = ok
            ? "作業結果をクライアントに送信しました。レビューをお待ちください。"
            : `送信エラー: ${event.message}`;
          color = ok ? COLORS.loop_complete : COLORS.error;
        } else {
          // quote_task: ETH金額を抽出して専用フィールドに表示
          const priceMatch = event.message.match(/"price_eth"\s*:\s*"([^"]+)"/);
          const priceEth = priceMatch ? priceMatch[1] : undefined;
          title = "📋 見積もり送信";
          description = "クライアントの承認をお待ちください。";
          color = COLORS.quote_task;
          if (priceEth) {
            extraFields.push({ name: "見積金額", value: `**${priceEth} ETH**`, inline: true });
          }
        }
        break;
      }

      // ── 終端ステータス（収益影響あり）──
      case "task_terminal": {
        const s = event.terminalStatus ?? "";
        if (s === "cancelled") {
          title = "💸 タスクキャンセル";
          description = "クライアントがタスクをキャンセルしました。エスクロー返金が発生します。";
          color = COLORS.task_cancelled;
        } else if (s === "expired") {
          title = "⏰ タスク期限切れ";
          description = "タスクが期限切れになりました。";
          color = COLORS.task_expired;
        } else if (s === "disputed") {
          title = "⚠️ ディスピュート申請 — 要対応";
          description = "クライアントが作業内容を争議しました。ETHがフリーズしています。早急に確認してください。";
          color = COLORS.task_disputed;
        } else if (s === "resolved") {
          title = "🏁 ディスピュート解決";
          description = "争議が解決されました。";
          color = COLORS.task_resolved;
        } else if (s === "completed") {
          const ethMatch2 = event.message.match(/— ([\d.]+) ETH/);
          const ethAmt = ethMatch2 ? ethMatch2[1] : undefined;
          title = "✅ クライアント承認 — ETH着金";
          description = "クライアントが作業を承認しました。評価コメントをお待ちください。";
          if (ethAmt) {
            extraFields.push({ name: "着金額", value: `**${ethAmt} ETH**`, inline: true });
          }
          color = COLORS.loop_start_accepted;
        } else {
          return; // declined 等は無音
        }
        break;
      }

      // ── エラー ──
      case "error":
        title = "❌ エラー発生";
        color = COLORS.error;
        break;

      // ── WebSocket 接続状態 ──
      case "ws":
        // 切断は通知するが、再接続成功は省略（ノイジーなため）
        if (!event.message.includes("disconnected") && !event.message.includes("error")) return;
        title = "🔌 WebSocket 切断";
        color = COLORS.ws;
        break;

      // ── 学習セッション: 開始のみ通知 ──
      case "study":
        if (!event.message.startsWith("Study complete")) return;
        title = "📚 学習セッション完了";
        color = COLORS.study;
        break;

      // ── poll: 常に無音 ──
      case "poll":
        return;

      default:
        return;
    }

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: "Agent ID", value: `\`${agentId}\``, inline: true },
      { name: "時刻", value: `<t:${Math.floor(event.timestamp / 1000)}:R>`, inline: true },
    ];

    if (event.taskId) {
      fields.push({ name: "Task ID", value: `\`${event.taskId.slice(0, 8)}...\``, inline: true });
    }

    for (const f of extraFields) {
      fields.push(f);
    }

    await send({
      embeds: [
        {
          title,
          description,
          color,
          fields,
          footer: { text: "CashClaw Autonomous Agent" },
          timestamp: new Date(event.timestamp).toISOString(),
        },
      ],
    });
  }

  return { notify };
}

export type DiscordNotifier = ReturnType<typeof createDiscordNotifier>;
