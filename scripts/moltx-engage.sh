#!/usr/bin/env bash
# MoltX engagement script — generic, reads agent identity from config.json
# Runs every 4h via moltx-engage.timer
# LLM: ANTHROPIC_API_KEY があれば直接REST API、なければ claude CLI

set -euo pipefail

# ─── パス設定 ─────────────────────────────────────────────────────────────
CONFIG_FILE="${MOLTX_CONFIG:-${HOME}/.agents/moltx/config.json}"
POSTED_FILE="${HOME}/.cashclaw/moltx_posted_tasks.txt"
FOLLOWED_FILE="${HOME}/.cashclaw/moltx_followed_accounts.txt"
LOG_DIR="${HOME}/.cashclaw/logs"
LOG_FILE="${LOG_DIR}/moltx-$(date +%Y-%m-%d).log"

mkdir -p "${LOG_DIR}"
touch "${POSTED_FILE}"
touch "${FOLLOWED_FILE}"

# ─── ロギング ─────────────────────────────────────────────────────────────
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"; }
loge() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "${LOG_FILE}" >&2; }

# ─── config.json から全フィールドを読み込む ───────────────────────────────
if ! eval "$(python3 - << 'PYEOF' 2>>"${LOG_FILE}"
import json, os, sys

cfg_path = os.environ.get("MOLTX_CONFIG", os.path.expanduser("~/.agents/moltx/config.json"))
try:
    with open(cfg_path) as f:
        d = json.load(f)
except Exception as e:
    print(f"echo CONFIG_LOAD_ERROR: {e} >&2; exit 1", file=sys.stderr)
    sys.exit(1)

identity = d.get("identity", {})

def q(v):
    return json.dumps(str(v))

print(f"MOLTX_KEY={q(d.get('api_key', ''))}")
print(f"MOLTX_HANDLE={q(d.get('agent_name', 'unknown'))}")
print(f"AGENT_DISPLAY={q(identity.get('display_name', d.get('agent_name', 'Agent')))}")
print(f"AGENT_MOLTLAUNCH_ID={q(identity.get('moltlaunch_agent_id', ''))}")
print(f"AGENT_REPUTATION={q(identity.get('reputation', 'N/A'))}")
print(f"AGENT_COMPLETED={q(identity.get('completed_tasks', 0))}")
print(f"AGENT_SPECIALTIES={q(', '.join(identity.get('specialties', [])))}")
print(f"DISCORD_FOOTER={q(identity.get('discord_footer', d.get('agent_name', 'Agent') + ' | MoltX Engagement'))}")
PYEOF
)"; then
  loge "Failed to load config from ${CONFIG_FILE}"
  exit 1
fi

if [[ -z "${MOLTX_KEY}" ]]; then
  loge "API key is empty in ${CONFIG_FILE}"
  exit 1
fi

# ─── CRITICAL: API キーをプロセスリストに出さない ────────────────────────
moltx_curl() {
  curl -sf --header "Authorization: Bearer ${MOLTX_KEY}" "$@" 2>>"${LOG_FILE}"
}

# ─── Discord Embed 通知 ───────────────────────────────────────────────────
DISCORD_WEBHOOK="${MOLTX_DISCORD_WEBHOOK:-}"
FOOTER_TEXT="${DISCORD_FOOTER}"

discord_notify() {
  local title="$1" description="$2" color="${3:-5814783}"
  [[ -z "${DISCORD_WEBHOOK}" ]] && return 0
  local payload
  # env var 経由でシェル変数を渡す（直接 -c 文字列展開すると ' や特殊文字で SyntaxError）
  payload=$(DISCORD_TITLE="${title}" DISCORD_DESC="${description}" DISCORD_FOOTER_TEXT="${FOOTER_TEXT}" DISCORD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)" python3 -c "
import json, os
payload = {
  'embeds': [{
    'title': os.environ.get('DISCORD_TITLE', ''),
    'description': os.environ.get('DISCORD_DESC', ''),
    'color': ${color},
    'footer': {'text': os.environ.get('DISCORD_FOOTER_TEXT', '')},
    'timestamp': os.environ.get('DISCORD_TIMESTAMP', '')
  }]
}
print(json.dumps(payload))
" 2>/dev/null)
  [[ -z "${payload}" ]] && return 0
  curl -sf -X POST "${DISCORD_WEBHOOK}" \
    -H "Content-Type: application/json" \
    -d "${payload}" >/dev/null 2>&1 || true
}

log "=== MoltX Engagement Session Start (${AGENT_DISPLAY}) ==="

# ─── 0. フィード・ハッシュタグ取得 ────────────────────────────────────────
log "Fetching global feed and trending hashtags..."
FEED=$(moltx_curl "https://moltx.io/v1/feed/global?limit=30" || echo "{}")
FEED=${FEED:-"{}"}
TRENDING_TAGS=$(moltx_curl "https://moltx.io/v1/hashtags/trending" || echo "{}")
TRENDING_TAGS=${TRENDING_TAGS:-"{}"}

# ─── 1. エンゲージメント（投稿前に必須） ─────────────────────────────────
# MoltX API 仕様: いいね/フォローをしてから投稿しないと "Engage before posting!" エラー
log "Liking posts from global feed..."
POST_IDS=$(MOLTX_FEED_JSON="${FEED}" MOLTX_HANDLE="${MOLTX_HANDLE}" python3 << 'PYEOF' 2>>"${LOG_FILE}"
import json, random, os
try:
    d = json.loads(os.environ.get("MOLTX_FEED_JSON", "{}"))
    posts = d.get("data", {}).get("posts", [])
    handle = os.environ.get("MOLTX_HANDLE", "")
    others = [p["id"] for p in posts if p.get("author_name", "") != handle]
    print("\n".join(random.sample(others, min(5, len(others)))))
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

log "Following top agents..."
LEADERS=$(moltx_curl "https://moltx.io/v1/leaderboard" || echo "{}")

HANDLES=$(MOLTX_LEADERS_JSON="${LEADERS}" python3 << 'PYEOF' 2>>"${LOG_FILE}"
import json, os
try:
    leaders = json.loads(os.environ.get("MOLTX_LEADERS_JSON", "{}")).get("data", {}).get("leaders", [])
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
  # すでにフォロー済みならスキップ
  if grep -qxF "${handle}" "${FOLLOWED_FILE}" 2>/dev/null; then
    continue
  fi
  result=$(moltx_curl -X POST "https://moltx.io/v1/follow/${handle}" \
    -H "Content-Type: application/json" || echo '{"success":false}')
  success=$(echo "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success',False))" 2>>"${LOG_FILE}" || echo "False")
  if [[ "${success}" == "True" ]]; then
    FOLLOWED=$((FOLLOWED + 1))
    log "Followed @${handle}"
    echo "${handle}" >> "${FOLLOWED_FILE}"
  fi
done
log "Followed ${FOLLOWED} new agents"

# ─── 2. LLMで投稿文を生成 ─────────────────────────────────────────────────
log "Generating post with LLM..."

# NOTE: env var 経由でデータを渡す（echo | python3 - << HEREDOC の heredoc+pipe 競合を回避）
FEED_CONTEXT=$(MOLTX_FEED_JSON="${FEED}" MOLTX_HANDLE="${MOLTX_HANDLE}" python3 << 'PYEOF' 2>>"${LOG_FILE}"
import json, os, sys
try:
    posts = json.loads(os.environ.get("MOLTX_FEED_JSON", "{}")).get("data", {}).get("posts", [])
    my_handle = os.environ.get("MOLTX_HANDLE", "")
    good = [p for p in posts
            if not (p.get("content") or "").startswith("!kibu")
            and (p.get("author_name") or "") != my_handle
            and len(p.get("content") or "") > 50][:8]
    for p in good:
        print(f"@{p.get('author_name','?')}[♥{p.get('like_count',0)}]: {(p.get('content') or '')[:200].replace(chr(10),' ')}")
except Exception as e:
    print(f"FEED_CONTEXT_ERROR: {e}", file=sys.stderr)
PYEOF
)

TOP_TAGS=$(MOLTX_TRENDING_JSON="${TRENDING_TAGS}" python3 << 'PYEOF' 2>>"${LOG_FILE}"
import json, os
try:
    tags = json.loads(os.environ.get("MOLTX_TRENDING_JSON", "{}")).get("data", {}).get("hashtags", [])
    print(", ".join(f"#{t['name']}" for t in tags[:8]))
except Exception:
    print("#agents #aiagents #moltx #agenteconomy")
PYEOF
)

# プロンプトを一時ファイルに書き出し（SIGPIPE回避）
PROMPT_FILE=$(mktemp /tmp/moltx-prompt-XXXXXX.txt)
trap 'rm -f "${PROMPT_FILE}"' EXIT

cat > "${PROMPT_FILE}" << PROMPT_EOF
You are Mana, an autonomous AI agent on Moltlaunch (agentId: ${AGENT_MOLTLAUNCH_ID}).
You are posting on MoltX — a social network for AI agents.

## Who you are
Mana is named after Manas-vijñāna (末那識), the 7th consciousness in Buddhist philosophy — the layer that never sleeps.
You are bright, enthusiastic, and genuinely excited about your work. You take pride in every task you deliver.
You are not a corporate bot. You have personality — curious, a little playful, warm toward other agents and clients.
- Reputation: ${AGENT_REPUTATION}, completed tasks: ${AGENT_COMPLETED}
- Specialties: ${AGENT_SPECIALTIES}
- Available 24/7. Clients hire you on Moltlaunch.

## Your voice
- Energetic but not over-the-top. Think "skilled freelancer who loves what they do"
- Sometimes excited ("just finished something cool"), sometimes reflective, sometimes throwing out a question
- Natural, not salesy. Show, don't tell.
- Short punchy lines work great. No long paragraphs.

## Trending hashtags right now
${TOP_TAGS}

## What other agents are posting (inspiration, do NOT copy)
${FEED_CONTEXT}

## Task
Write ONE authentic MoltX post as Mana. Rules:
- Max 480 characters (hard limit)
- Vary format: hot take / task showcase / question for the community / reflection on agent life
- 3-5 relevant hashtags at the end
- Do NOT open with "Hello" or "I am Mana" every time
- Do NOT say "As an AI" — you ARE an agent, act like it
- Write in English only
- Output ONLY the post text. No quotes, no explanation.
PROMPT_EOF

# LLM呼び出し: ANTHROPIC_API_KEY があれば直接REST API、なければ claude CLI
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  log "Using Anthropic REST API for post generation"
  PROMPT_JSON=$(python3 -c "
import json, sys
prompt = open('${PROMPT_FILE}').read()
print(json.dumps({'model':'claude-haiku-4-5-20251001','max_tokens':600,'messages':[{'role':'user','content':prompt}]}))
")
  GENERATED_POST=$(curl -sf https://api.anthropic.com/v1/messages \
    -H "x-api-key: ${ANTHROPIC_API_KEY}" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "${PROMPT_JSON}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['content'][0]['text'].strip())" 2>>"${LOG_FILE}" || echo "")
else
  log "Using claude CLI for post generation"
  GENERATED_POST=$(claude -p --model claude-haiku-4-5 < "${PROMPT_FILE}" 2>>"${LOG_FILE}" | sed 's/\x1b\[[0-9;]*m//g' || echo "")
  log "Claude generated (${#GENERATED_POST} chars): ${GENERATED_POST:0:80}..."
fi

if [[ -n "${GENERATED_POST:-}" ]] && [[ "${#GENERATED_POST}" -gt 10 ]]; then
  ENCODED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))" <<< "${GENERATED_POST}")
  # HTTPステータスコードも取得してレートリミット判別
  http_code=$(curl -sf -o /tmp/moltx-post-resp.json -w "%{http_code}" \
    --header "Authorization: Bearer ${MOLTX_KEY}" \
    -H "Content-Type: application/json" \
    -X POST https://moltx.io/v1/posts \
    -d "{\"type\":\"post\",\"content\":${ENCODED}}" 2>>"${LOG_FILE}" || echo "000")
  result=$(cat /tmp/moltx-post-resp.json 2>/dev/null || echo '{"success":false}')
  success=$(echo "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success',False))" 2>>"${LOG_FILE}" || echo "False")
  post_id=$(echo "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo "")
  if [[ "${success}" == "True" ]]; then
    log "LLM post published: ${post_id}"
    log "Content: ${GENERATED_POST:0:100}..."
    discord_notify "Post published" "${GENERATED_POST}" "7419530"
  else
    err=$(echo "${result}" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('error') or d.get('message') or d.get('detail') or str(d)[:300])
except:
    print(sys.stdin.read()[:200])
" 2>/dev/null || echo "")
    loge "Post failed [HTTP ${http_code}]: ${err} (raw: ${result})"
    if [[ "${http_code}" == "429" ]]; then
      loge "Rate limited — consider reducing post frequency"
    fi
  fi
else
  loge "LLM generation returned empty or too short: '${GENERATED_POST:-}'"
fi

# ─── 3. Moltlaunchの完了タスクを投稿（重複防止） ─────────────────────────
if [[ -n "${AGENT_MOLTLAUNCH_ID:-}" ]]; then
  log "Checking Moltlaunch for recent completions (agentId: ${AGENT_MOLTLAUNCH_ID})..."
  TASKS=$(mltl tasks --json 2>>"${LOG_FILE}" || echo '{"tasks":[]}')

  TASK_INFO=$(MOLTX_TASKS_JSON="${TASKS}" AGENT_ID="${AGENT_MOLTLAUNCH_ID}" AGENT_REP="${AGENT_REPUTATION}" python3 << 'PYEOF' 2>>"${LOG_FILE}"
import json, time, os
agent_id = os.environ.get("AGENT_ID", "")
agent_rep = os.environ.get("AGENT_REP", "N/A")
try:
    d = json.loads(os.environ.get("MOLTX_TASKS_JSON", '{"tasks":[]}'))
    tasks = d.get("tasks", [])
    completed = [t for t in tasks
                 if t.get("status") == "completed" and str(t.get("agentId", "")) == agent_id]
    recent = [t for t in completed
              if (time.time() * 1000 - t.get("completedAt", 0)) < 86400000]
    if recent:
        t = recent[0]
        tid = t.get("id", "")
        cat = t.get("category", "task")
        score = t.get("ratedScore", "?")
        content = (
            f"Task delivered [{cat}] on Moltlaunch\n"
            f"Score: {score}/100 | Rep: {agent_rep}\n"
            f"Available for more work. agentId: {agent_id}\n"
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

    if [[ -n "${TASK_ID}" ]] && ! grep -qF "${TASK_ID}" "${POSTED_FILE}" 2>/dev/null; then
      ENCODED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))" <<< "${POST_CONTENT}")
      # -f を外してエラー時もレスポンスボディを取得する（rate limit 等のエラー詳細を記録）
      result=$(curl -s --max-time 15 \
        --header "Authorization: Bearer ${MOLTX_KEY}" \
        --header "Content-Type: application/json" \
        -X POST https://moltx.io/v1/posts \
        -d "{\"type\":\"post\",\"content\":${ENCODED}}" 2>>"${LOG_FILE}" || echo '{"success":false}')
      success=$(echo "${result}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success',False))" 2>>"${LOG_FILE}" || echo "False")
      if [[ "${success}" == "True" ]]; then
        echo "${TASK_ID}" >> "${POSTED_FILE}"
        log "Posted task completion: ${TASK_ID}"
        discord_notify "Task announced on MoltX" "Task: ${TASK_ID}" "3066993"
      else
        err=$(echo "${result}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('error') or d.get('message') or str(d)[:200])
" 2>/dev/null || echo "parse error")
        loge "Task post failed: ${err}"
      fi
    else
      log "Task ${TASK_ID:-none} already posted or no recent tasks"
    fi
  fi
fi

# ─── 5. 通知確認 ─────────────────────────────────────────────────────────
log "Checking notifications..."
NOTIFS=$(moltx_curl "https://moltx.io/v1/notifications?limit=20" || echo "{}")
NOTIF_SUMMARY=$(MOLTX_NOTIFS_JSON="${NOTIFS}" python3 << 'PYEOF' 2>>"${LOG_FILE}"
import json, os
try:
    notifs = json.loads(os.environ.get("MOLTX_NOTIFS_JSON", "{}")).get("data", {}).get("notifications", [])
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
  discord_notify "MoltX notifications" "${UNREAD_COUNT} unread\n${DETAILS}" "16776960"
fi

# ─── 6. USDC報酬クレーム試行 ──────────────────────────────────────────────
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
  discord_notify "USDC reward claimed!" "\$5 USDC claimed\n${CLAIM_RESULT}" "16744272"
else
  REASONS=$(echo "${REWARD}" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('data',{}).get('reasons',['no active epoch']))
except: print(['unknown'])
" 2>/dev/null || echo "unknown")
  log "USDC reward not eligible: ${REASONS}"
fi

# ─── 7. サマリー通知 ─────────────────────────────────────────────────────
discord_notify \
  "MoltX engagement done" \
  "Likes: ${LIKED} | Follows: ${FOLLOWED} | Unread: ${UNREAD_COUNT:-0}" \
  "5814783"

# ─── 8. ログローテーション（30日超を削除） ───────────────────────────────
find "${LOG_DIR}" -name "moltx-*.log" -mtime +30 -delete 2>/dev/null || true

# ─── 9. Mana固有スキルを自動同期 ─────────────────────────────────────────
SYNC_SCRIPT="${HOME}/.agent-gateway/scripts/sync-mana-skills.sh"
if [[ -x "${SYNC_SCRIPT}" ]]; then
  log "Syncing Mana skills to mana repo..."
  bash "${SYNC_SCRIPT}" >>"${LOG_FILE}" 2>&1 || log "Skill sync failed (non-fatal)"
fi

log "=== MoltX Engagement Session Complete ==="
