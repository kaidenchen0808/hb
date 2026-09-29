#!/usr/bin/env bash
# Claude Code hook → companion-layer 原始事件上报
# 用法（settings.json 的 hooks 里）: bash <repo>/hooks/report-event.sh PostToolUse
# stdin 是 Claude Code 传入的 hook JSON（含 session_id / tool_name 等）
set -u
COMPANION_URL="${COMPANION_URL:-http://127.0.0.1:8787}"
HOOK_TYPE="${1:-PostToolUse}"

input=$(cat)

session_id=$(printf '%s' "$input" | jq -r '.session_id // "unknown"' 2>/dev/null)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)

# 失败静默（服务没开也不能拖慢 Claude）
curl -s -m 2 -X POST "$COMPANION_URL/api/events" \
  -H 'Content-Type: application/json' \
  --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","session_id":"${session_id}","hook_type":"${HOOK_TYPE}","tool_name":"${tool_name}"}
EOF
