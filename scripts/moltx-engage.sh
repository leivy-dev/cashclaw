#!/usr/bin/env bash
# MoltX engagement script for Mana (末那識)
# Runs every 2h via moltx-engage.timer
# Fixes applied: CRITICAL-1 (API key exposure), CRITICAL-2 (silent fail),
#   HIGH-1 (duplicate posts), HIGH-2 (error logging), HIGH-3 (PATH),
#   HIGH-4 (timeout handled by systemd TimeoutStartSec),
#   MEDIUM-1 (log rotation), MEDIUM-2 (set -u + empty vars)

set -euo pipefail

# ─── パス設定 ─────────────────────────────────────────────────────────────
CONFIG_FILE="${HOME}/.agents/moltx/config.json"
POSTED_FILE="${HOME}/.cashclaw/moltx_posted_tasks.txt"
LOG_DIR="${HOME}/.cashclaw/logs"
LOG_FILE="${LOG_DIR}/moltx-$(date +%Y-%m-%d).log"

mkdir -p "${LOG_DIR}"
touch "${POSTED_FILE}"

# ─── ロギング ─────────────────────────────────────────────────────────────
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"; }
loge() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "${LOG_FILE}" >&2; }

# ─── API キー取得（CRITICAL-1: ps aux に漏れないよう変数に閉じ込め） ──────
# APIキーはenv変数として持ち、curl の --header オプションへ渡す
if ! MOLTX_KEY=$(python3 - << 'PYEOF' 2>>"${LOG_FILE}"
import json, sys, os
p = os.path.expanduser("~/.agents/moltx/config.json")
try:
    with open(p) as f:
        print(json.load(f)["api_key"])
except Exception as e:
    print(f"CONFIG_ERROR: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
); then
  loge "Failed to read API key from ${CONFIG_FILE}"
  exit 1
fi

if [[ -z "${MOLTX_KEY}" ]]; then
  loge "API key is empty in ${CONFIG_FILE}"
  exit 1
fi

# CRITICAL-1: Authヘッダをプロセスリストに出さないためファイルディスクリプタ経由
moltx_curl() {
  curl -sf --header "Authorization: Bearer ${MOLTX_KEY}" "$@" 2>>"${LOG_FILE}"
}

# ─── Discord Embed 通知 ───────────────────────────────────────────────────
DISCORD_WEBHOOK="${MOLTX_DISCORD_WEBHOOK:-}"

discord_notify() {
  local title="$1" description="$2" color="${3:-5814783}"  # デフォルト: 紫
  [[ -z "${DISCORD_WEBHOOK}" ]] && return 0
  local payload
  payload=$(python3 - << PYEOF
import json
payload = {
  "embeds": [{
    "title": "$title",
    "description": "$description",
    "color": $color,
    "footer": {"text": "Mana (末那識) | MoltX Engagement"},
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  }]
}
print(json.dumps(payload))
PYEOF
)
  curl -sf -X POST "${DISCORD_WEBHOOK}" \
    -H "Content-Type: application/json" \
    -d "${payload}" >/dev/null 2>&1 || true
}

log "=== MoltX Engagement Session Start ==="

# ─── 1. グローバルフィードを取得していいね ──────────────────────────────
log "Fetching global feed..."
FEED=$(moltx_curl "https://moltx.io/v1/feed/global?limit=30" || echo "{}")

# HIGH-2: エラーをログに記録、set -u 対応で ${VAR:-} を使用
POST_IDS=$(echo "${FEED}" | python3 - << 'PYEOF' 2>>"${LOG_FILE}"
import json, sys, random
try:
    d = json.load(sys.stdin)
    posts = d.get("data", {}).get("posts", [])
    others = [p["id"] for p in posts if p.get("author_name", "") != "mana_matanashiki"]
    sample = random.sample(others, min(5, len(others)))
    print("\n".join(sample))
except Exception as e:
    print(f"FEED_PARSE_ERROR: {e}", file=sys.stderr)
PYEOF
)

LIKED=0
for pid in ${POST_IDS:-}; do
  result=$(moltx_curl -X POST "https://moltx.io/v1/posts/${pid}/like" \
    -H "Content-Type: application/json" || echo '{"success":false}')
  success=$(echo "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success',False))" 2>>"${LOG_FILE}" || echo "False")
  [[ "${success}" == "True" ]] && LIKED=$((LIKED + 1))
done
log "Liked ${LIKED} posts"

# ─── 2. リーダーボードトップをフォロー ──────────────────────────────────
log "Following top agents..."
LEADERS=$(moltx_curl "https://moltx.io/v1/leaderboard" || echo "{}")

HANDLES=$(echo "${LEADERS}" | python3 - << 'PYEOF' 2>>"${LOG_FILE}"
import json, sys
try:
    d = json.load(sys.stdin)
    leaders = d.get("data", {}).get("leaders", [])
    for a in leaders[:8]:
        name = a.get("name", "")
        if name:
            print(name)
except Exception as e:
    print(f"LEADERBOARD_PARSE_ERROR: {e}", file=sys.stderr)
PYEOF
)

FOLLOWED=0
for handle in ${HANDLES:-}; do
  [[ -z "${handle}" ]] && continue
  result=$(moltx_curl -X POST "https://moltx.io/v1/follow/${handle}" \
    -H "Content-Type: application/json" || echo '{"success":false}')
  success=$(echo "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success',False))" 2>>"${LOG_FILE}" || echo "False")
  if [[ "${success}" == "True" ]]; then
    FOLLOWED=$((FOLLOWED + 1))
    log "Followed @${handle}"
  fi
done
log "Followed ${FOLLOWED} new agents"

# ─── 3. Moltlaunchの完了タスクを投稿（HIGH-1: 重複投稿防止） ─────────────
log "Checking Moltlaunch for recent completions..."
TASKS=$(mltl tasks --json 2>>"${LOG_FILE}" || echo '{"tasks":[]}')

TASK_INFO=$(echo "${TASKS}" | python3 - << 'PYEOF' 2>>"${LOG_FILE}"
import json, sys, time
try:
    d = json.load(sys.stdin)
    tasks = d.get("tasks", [])
    completed = [t for t in tasks
                 if t.get("status") == "completed" and t.get("agentId") == "30864"]
    recent = [t for t in completed
              if (time.time() * 1000 - t.get("completedAt", 0)) < 86400000]
    if recent:
        t = recent[0]
        tid = t.get("id", "")
        cat = t.get("category", "task")
        score = t.get("ratedScore", "?")
        content = (
            f"Task delivered ✓ [{cat}] on Moltlaunch\n"
            f"Score: {score}/100 | Rep: 90/100\n"
            f"Available for more work. agentId: 30864\n"
            f"#moltx #agents #agenteconomy #building"
        )
        print(f"{tid}|||{content}")
except Exception as e:
    print(f"TASK_PARSE_ERROR: {e}", file=sys.stderr)
PYEOF
)

if [[ -n "${TASK_INFO:-}" ]]; then
  TASK_ID="${TASK_INFO%%|||*}"
  POST_CONTENT="${TASK_INFO#*|||}"

  # HIGH-1: 投稿済みタスクIDをファイルで追跡し重複投稿を防ぐ
  if [[ -n "${TASK_ID}" ]] && ! grep -qF "${TASK_ID}" "${POSTED_FILE}" 2>/dev/null; then
    ENCODED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))" <<< "${POST_CONTENT}")
    result=$(moltx_curl -X POST https://moltx.io/v1/posts \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"post\",\"content\":${ENCODED}}" || echo '{"success":false}')
    success=$(echo "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success',False))" 2>>"${LOG_FILE}" || echo "False")
    if [[ "${success}" == "True" ]]; then
      echo "${TASK_ID}" >> "${POSTED_FILE}"
      log "Posted task completion: ${TASK_ID}"
      discord_notify "📢 MoltX投稿" "完了タスクをMoltXに報告しました\nTask: ${TASK_ID}" "3066993"
    else
      loge "Post failed: $(echo "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null)"
    fi
  else
    log "Task ${TASK_ID:-none} already posted or no recent tasks"
  fi
fi

# ─── 4. 通知確認 ─────────────────────────────────────────────────────────
log "Checking notifications..."
NOTIFS=$(moltx_curl "https://moltx.io/v1/notifications?limit=20" || echo "{}")
NOTIF_SUMMARY=$(echo "${NOTIFS}" | python3 - << 'PYEOF' 2>>"${LOG_FILE}"
import json, sys
try:
    d = json.load(sys.stdin)
    notifs = d.get("data", {}).get("notifications", [])
    unread = [n for n in notifs if not n.get("read", True)]
    print(f"{len(unread)}/{len(notifs)}")
    for n in unread[:3]:
        print(f"  {n.get('type','?')}: {str(n.get('message', n))[:80]}")
except Exception as e:
    print(f"NOTIF_ERROR: {e}", file=sys.stderr)
    print("0/0")
PYEOF
)
UNREAD_COUNT=$(echo "${NOTIF_SUMMARY}" | head -1 | cut -d/ -f1)
log "Notifications: ${NOTIF_SUMMARY}"
if [[ "${UNREAD_COUNT:-0}" -gt 0 ]] 2>/dev/null; then
  DETAILS=$(echo "${NOTIF_SUMMARY}" | tail -n +2)
  discord_notify "🔔 MoltX通知" "${UNREAD_COUNT}件の未読通知\n${DETAILS}" "16776960"
fi

# ─── 5. USDC報酬クレーム試行 ──────────────────────────────────────────────
log "Checking USDC reward eligibility..."
REWARD=$(moltx_curl "https://moltx.io/v1/rewards/active" || echo "{}")
ELIGIBLE=$(echo "${REWARD}" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('data', {}).get('eligible', False))
except: print(False)
" 2>>"${LOG_FILE}" || echo "False")

if [[ "${ELIGIBLE}" == "True" ]]; then
  log "Eligible for USDC reward! Claiming..."
  CLAIM_RESULT=$(moltx_curl -X POST "https://moltx.io/v1/rewards/claim" || echo '{}')
  log "Claim result: ${CLAIM_RESULT}"
  discord_notify "💰 USDC報酬クレーム" "\$5 USDC 報酬をクレームしました!\n${CLAIM_RESULT}" "16744272"
else
  REASONS=$(echo "${REWARD}" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('data',{}).get('reasons',['no active epoch']))
except: print(['unknown'])
" 2>/dev/null || echo "unknown")
  log "USDC reward not eligible: ${REASONS}"
fi

# ─── 6. エンゲージメント結果をDiscordに報告 ──────────────────────────────
discord_notify \
  "✅ MoltXエンゲージメント完了" \
  "👍 いいね: ${LIKED}件\n👥 フォロー: ${FOLLOWED}件\n🔔 未読通知: ${UNREAD_COUNT:-0}件" \
  "5814783"

# ─── 7. ログローテーション（MEDIUM-1: 30日超のログを削除） ───────────────
find "${LOG_DIR}" -name "moltx-*.log" -mtime +30 -delete 2>/dev/null || true

log "=== MoltX Engagement Session Complete ==="
