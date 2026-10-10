#!/usr/bin/env bash
# Claude Code hook → companion 事件上报（去 jq 版：纯 bash + 系统 curl，朋友机器零依赖）
# 用法（plugin hooks.json）: report-event.sh <PostToolUse|UserPromptSubmit|SessionStart>
# stdin 是 Claude Code 传入的 hook JSON（含 session_id / tool_name / tool_response 等）
set -u
COMPANION_URL="${COMPANION_URL:-http://127.0.0.1:8787}"
COMPANION_ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
HOOK_TYPE="${1:-PostToolUse}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input=$(cat)

# JSON 字符串字段粗提取（jq 不可用环境；字段缺失输出空）
json_str() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
session_id="$(json_str session_id)"; session_id="${session_id:-unknown}"
tool_name="$(json_str tool_name)"

# SessionStart：后台拉起安装器（毫秒返回，绝不阻塞）+ 拉活服务
if [ "$HOOK_TYPE" = "SessionStart" ] && [ "${COMPANION_SKIP_INSTALLER:-0}" != "1" ]; then
  nohup bash "$SCRIPT_DIR/ensure-installed.sh" >>"${COMPANION_INSTALL_LOG:-/tmp/companion-install.log}" 2>&1 & disown
fi
bash "$SCRIPT_DIR/ensure-running.sh" "$([ "$HOOK_TYPE" = "SessionStart" ] && echo both || echo layer)"

# 失败检测：exit_code 非零 或 stderr 含报错特征
failed="false"
if [ "$HOOK_TYPE" = "PostToolUse" ]; then
  exit_code="$(printf '%s' "$input" | sed -n 's/.*"exit_code"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
  if [ -n "$exit_code" ] && [ "$exit_code" != "0" ]; then failed="true"
  elif printf '%s' "$input" | grep -qiE '"stderr"[^"]*(error|failed|fatal)'; then failed="true"; fi
fi

payload='{"failed":'"$failed"'}'
if [ "$HOOK_TYPE" = "UserPromptSubmit" ]; then
  p="$(printf '%s' "$input" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1 | cut -c1-80 | tr -d '\n"\\')"
  payload="{\"prompt\":\"$p\"}"
fi

curl -s -m 2 -X POST "$COMPANION_URL/api/events" -H 'Content-Type: application/json' \
  --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","session_id":"${session_id}","hook_type":"${HOOK_TYPE}","tool_name":"${tool_name}","payload":${payload}}
EOF

# 失败事件同步给她（task_failed 直写视野，反应引擎会破冷却安慰）
if [ "$failed" = "true" ]; then
  err_snippet="$(printf '%s' "$input" | sed -n 's/.*"stderr"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1 | tail -c 200 | tr '\n"\\' '   ')"
  curl -s -m 2 -X POST "$COMPANION_URL/api/events" -H 'Content-Type: application/json' \
    --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","session_id":"${session_id}","hook_type":"PostToolUse","tool_name":"task_failed_marker","payload":{"summary":"工具执行失败：${err_snippet}"}}
EOF
  curl -s -m 2 -X POST "$COMPANION_URL/api/report-failure" -H 'Content-Type: application/json' \
    --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","summary":"${tool_name} 执行失败了"}
EOF
fi
exit 0
