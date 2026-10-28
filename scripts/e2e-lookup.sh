#!/usr/bin/env bash
# 代查链路端到端验证：mock 大脑（SSE 回带 [lookup] 标记的回复）→ 隔离实例 → 真实 claude
# 代查 → 断言指示条实时更新 + 结果落库干净（无工具转储）。不碰生产 DB/端口。
# 用法：bash scripts/e2e-lookup.sh [查询词]；退出码 0=全过。
set -euo pipefail
HB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUERY="${1:-上证指数今日收盘点位}"
MOCK_PORT=18901
BRAIN_PORT=18902
WORK=$(mktemp -d /tmp/companion-e2e.XXXXXX)
PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[1;31m失败: %s\033[0m\n' "$1" >&2; exit 1; }

step "构建 brain bundle"
( cd "$HB_DIR" && pnpm build:brain > /dev/null )

step "起 mock 大脑与隔离实例, 端口 $MOCK_PORT / $BRAIN_PORT"
cat > "$WORK/mock.mjs" << 'EOF'
import http from 'node:http'
const REPLY = '[happy] 我去帮主人查哦～[lookup]' + process.env.E2E_QUERY
http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const part of [REPLY.slice(0, 12), REPLY.slice(12)]) {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: part } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
}).listen(process.env.E2E_MOCK_PORT, () => console.log('mock ready'))
EOF
E2E_QUERY="$QUERY" E2E_MOCK_PORT=$MOCK_PORT node "$WORK/mock.mjs" > "$WORK/mock.log" 2>&1 & PIDS+=($!)
PORT=$BRAIN_PORT DB_PATH="$WORK/e2e.db" PERSONA_PATH="$HB_DIR/persona/persona.yaml" \
  BRAIN_BASE_URL="http://127.0.0.1:$MOCK_PORT" BRAIN_API_KEY=test BRAIN_MODEL=mock \
  BRAIN_API_FORMAT=hybrid node "$HB_DIR/dist/brain.mjs" > "$WORK/brain.log" 2>&1 & PIDS+=($!)
sleep 3
curl -sf -m 3 "http://127.0.0.1:$BRAIN_PORT/health" | grep -q '"ok"' || fail "隔离实例未就绪，看 $WORK/brain.log"

step "触发聊天（第一段 mock 秒回，第二段真实 claude 代查）"
curl -s -m 30 "http://127.0.0.1:$BRAIN_PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"帮我查一下$QUERY\"}]}" > /dev/null || fail "聊天请求失败"

step "轮询指示条与落库（代查最长 300s）"
SAW_STATUS=0
for i in $(seq 1 60); do
  sleep 5
  STATUS=$(curl -s -m 3 "http://127.0.0.1:$BRAIN_PORT/v1/notifications" \
    | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('activeLookup')))" 2>/dev/null || echo '"err"')
  if [ "$STATUS" != "null" ] && [ "$STATUS" != '"err"' ]; then
    [ $SAW_STATUS -eq 0 ] && echo "  指示条: $STATUS"
    SAW_STATUS=1
  fi
  if [ "$STATUS" = "null" ] && [ $SAW_STATUS -eq 1 ]; then break; fi
done
[ $SAW_STATUS -eq 1 ] || fail "指示条从未出现（onToolEvent 链路断了）"
ROWS=$(sqlite3 "$WORK/e2e.db" "SELECT COUNT(*) FROM chat_history" 2>/dev/null || echo 0)
[ "$ROWS" -ge 3 ] || fail "chat_history 应≥3 行（user/转场/结果），实际 $ROWS"
RESULT=$(sqlite3 "$WORK/e2e.db" "SELECT content FROM chat_history WHERE id=(SELECT MAX(id) FROM chat_history)")
echo "  代查结果: ${RESULT:0:80}…"
echo "$RESULT" | grep -q "Z.ai Built-in Tool\|webReader_result_summary" \
  && fail "结果被工具转储污染（parseLookupResult 回退了）"

echo ""
echo "✅ e2e 全过：指示条实时 + 结果落库干净（$WORK 即将清理）"
