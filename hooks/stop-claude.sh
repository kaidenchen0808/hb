#!/usr/bin/env bash
# Claude Code Stop hook → 定稿聚合事件（她听得懂的一句总结）+ 收工时自动拉齐桌宠
# stdin 是 Claude Code 传入的 hook JSON
set -u
COMPANION_URL="${COMPANION_URL:-http://127.0.0.1:8787}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // "unknown"' 2>/dev/null)

# 收工时刻：她的大脑 + 桌宠自动就位（app 有 10 分钟节流）
bash "$SCRIPT_DIR/../scripts/ensure-running.sh" both

curl -s -m 3 -X POST "$COMPANION_URL/api/aggregate" \
  -H 'Content-Type: application/json' \
  --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","session_id":"${session_id}"}
EOF
