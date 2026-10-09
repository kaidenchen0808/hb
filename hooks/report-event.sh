#!/usr/bin/env bash
# Claude Code hook → companion-layer 原始事件上报
# 用法（settings.json 的 hooks 里）: bash <repo>/hooks/report-event.sh PostToolUse
# stdin 是 Claude Code 传入的 hook JSON（含 session_id / tool_name / tool_response 等）
set -u
COMPANION_URL="${COMPANION_URL:-http://127.0.0.1:8787}"
HOOK_TYPE="${1:-PostToolUse}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 懒启动：她的大脑没跑就拉起（不阻塞，最多花 1 秒探活）
bash "$SCRIPT_DIR/../scripts/ensure-running.sh" layer

input=$(cat)

session_id=$(printf '%s' "$input" | jq -r '.session_id // "unknown"' 2>/dev/null)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)

# 失败检测：Bash 工具非零退出 / 报错特征 → 额外上报 task_failed（她会即时安慰）
failed="false"
if [ "$HOOK_TYPE" = "PostToolUse" ]; then
  exit_code=$(printf '%s' "$input" | jq -r '.tool_response.exit_code // .tool_response.exitCode // empty' 2>/dev/null)
  if [ -n "$exit_code" ] && [ "$exit_code" != "0" ]; then
    failed="true"
  elif printf '%s' "$input" | jq -r '.tool_response.stderr // empty' 2>/dev/null | grep -qiE 'error|failed|fatal'; then
    failed="true"
  fi
fi

# 上报常规事件（失败静默：服务没开也不能拖慢 Claude）
if [ "$HOOK_TYPE" = "UserPromptSubmit" ]; then
  payload=$(printf '%s' "$input" | jq -c '{prompt: ((.prompt // "") | .[0:80])}' 2>/dev/null || echo '{}')
else
  payload='{"failed":'"$failed"'}'
fi
curl -s -m 2 -X POST "$COMPANION_URL/api/events" \
  -H 'Content-Type: application/json' \
  --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","session_id":"${session_id}","hook_type":"${HOOK_TYPE}","tool_name":"${tool_name}","payload":${payload:-null}}
EOF

# 失败事件同步给她（task_failed 直写视野，反应引擎会破冷却安慰）
if [ "$failed" = "true" ]; then
  err_snippet=$(printf '%s' "$input" | jq -r '.tool_response.stderr // .tool_response.stdout // ""' 2>/dev/null | tail -c 200 | tr '\n"\\' '   ')
  curl -s -m 2 -X POST "$COMPANION_URL/api/events" \
    -H 'Content-Type: application/json' \
    --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","session_id":"${session_id}","hook_type":"PostToolUse","tool_name":"task_failed_marker","payload":{"summary":"工具执行失败：${err_snippet}"}}
EOF
  curl -s -m 2 -X POST "$COMPANION_URL/api/report-failure" \
    -H 'Content-Type: application/json' \
    --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","summary":"${tool_name} 执行失败了"}
EOF
fi
