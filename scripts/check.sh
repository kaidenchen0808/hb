#!/usr/bin/env bash
# 她没反应时先跑这个：四环节全链路自检
set -u
URL="${COMPANION_URL:-http://127.0.0.1:8787}"
pass=0; fail=0
ok()   { printf '  ✅ %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  ❌ %s\n' "$1"; fail=$((fail+1)); }
hint() { printf '     └ %s\n' "$1"; }

echo "── 1/4 companion-layer 服务"
if health=$(curl -s -m 2 "$URL/health" 2>/dev/null) && echo "$health" | grep -q '"status":"ok"'; then
  ok "运行中（$(echo "$health" | sed -E 's/.*"persona":"([^"]+)".*/人格: \1/'), $(echo "$health" | grep -q '"brain":"configured"' && echo '大脑已配置' || echo '大脑未配置!')）"
else
  bad "服务没跑"
  hint "启动: cd $(dirname "$0")/.. && pnpm start"
fi

echo "── 2/4 AniCompanion app"
nproc=$(pgrep -f "AniCompanion.app/Contents/MacOS" | wc -l | tr -d ' ')
if [ "$nproc" -eq 1 ]; then
  ok "进程在（单实例）"
elif [ "$nproc" -gt 1 ]; then
  bad "检测到 $nproc 个实例同时在跑（幽灵副本抢走消息）"
  hint "killall AniCompanion 后只 open -a AniCompanion；构建目录的副本要用 lsregister -u 注销"
else
  bad "app 没开"
  hint "open -a AniCompanion"
fi

echo "── 3/4 app→服务的轮询通道（她的即时说话通道）"
curl -s -m 2 -X POST "$URL/api/say" -H 'Content-Type: application/json' \
  -d '{"text":"[neutral] （自检探针）","source":"check.sh"}' >/dev/null 2>&1
sleep 3.5
probe=$(sqlite3 "$(dirname "$0")/../data/companion.db" "SELECT delivered_at IS NOT NULL FROM outbox ORDER BY id DESC LIMIT 1" 2>/dev/null)
if [ "$probe" = "1" ]; then
  ok "轮询活着（探针已被取走）"
else
  bad "探针未被取走：app 卡住或后端没对"
  hint "先重启 app: killall AniCompanion && open -a AniCompanion，还不行看 Settings 里端点是否 $URL"
fi

echo "── 4/4 大脑直连（GLM 端点）"
brain_url=$(grep '^BRAIN_BASE_URL' "$(dirname "$0")/../.env" 2>/dev/null | cut -d= -f2)
if [ -n "$brain_url" ] && curl -s -m 4 -o /dev/null -w '%{http_code}' "$brain_url/v1/models" 2>/dev/null | grep -qE '^[12340]'; then
  ok "端点可达（${brain_url}）"
else
  bad "大脑端点不可达或未配置"
  hint "检查 .env 的 BRAIN_* 三项；429=余额/并发限制"
fi

echo "──────────────────"
echo "结果: $pass 通过, $fail 异常"
[ "$fail" -eq 0 ] && echo "全链路健康。若她仍无反应，把 chat_history 最新记录发给开发者：sqlite3 data/companion.db 'SELECT * FROM chat_history ORDER BY id DESC LIMIT 4'"
exit "$fail"
