#!/usr/bin/env bash
# 她没反应时先跑这个：五环节全链路自检
set -u
URL="${COMPANION_URL:-http://127.0.0.1:8787}"
pass=0; fail=0
ok()   { printf '  ✅ %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  ❌ %s\n' "$1"; fail=$((fail+1)); }
hint() { printf '     └ %s\n' "$1"; }

echo "── 1/5 companion-layer 服务"
if health=$(curl -s -m 2 "$URL/health" 2>/dev/null) && echo "$health" | grep -q '"status":"ok"'; then
  ok "运行中（$(echo "$health" | sed -E 's/.*"persona":"([^"]+)".*/人格: \1/'), $(echo "$health" | grep -q '"brain":"configured"' && echo '大脑已配置' || echo '大脑未配置!')）"
else
  bad "服务没跑"
  hint "启动: cd $(dirname "$0")/.. && pnpm start"
fi

echo "── 2/5 AniCompanion app"
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

echo "── 3/5 app→服务的轮询通道（她的即时说话通道）"
# 8787 可能是 dev 实例（写仓库库）或部署实例（写 ~/.companion-layer 库），
# 记两库 max(id)，探针落进哪个库就查哪个库的 delivered_at
DBS=("$(cd "$(dirname "$0")/.." && pwd)/data/companion.db" "$HOME/.companion-layer/data/companion.db")
BEFORE=()
for db in "${DBS[@]}"; do
  BEFORE+=("$(sqlite3 "$db" 'SELECT COALESCE(MAX(id),0) FROM outbox' 2>/dev/null || echo 0)")
done
curl -s -m 2 -X POST "$URL/api/say" -H 'Content-Type: application/json' \
  -d '{"text":"[neutral] （自检探针）","source":"check.sh"}' >/dev/null 2>&1
sleep 3.5
probe=""
for i in "${!DBS[@]}"; do
  after=$(sqlite3 "${DBS[$i]}" 'SELECT COALESCE(MAX(id),0) FROM outbox' 2>/dev/null || echo 0)
  if [ "$after" -gt "${BEFORE[$i]}" ] 2>/dev/null; then
    probe=$(sqlite3 "${DBS[$i]}" "SELECT delivered_at IS NOT NULL FROM outbox WHERE id=$after" 2>/dev/null)
  fi
done
if [ "$probe" = "1" ]; then
  ok "轮询活着（探针已被取走）"
else
  bad "探针未被取走：app 卡住或后端没对"
  hint "先重启 app: killall AniCompanion && open -a AniCompanion，还不行看 Settings 里端点是否 $URL"
fi

echo "── 4/5 大脑直连（GLM 端点）"
brain_url=$(grep '^BRAIN_BASE_URL' "$(dirname "$0")/../.env" 2>/dev/null | cut -d= -f2)
if [ -n "$brain_url" ] && curl -s -m 4 -o /dev/null -w '%{http_code}' "$brain_url/v1/models" 2>/dev/null | grep -qE '^[12340]'; then
  ok "端点可达（${brain_url}）"
else
  bad "大脑端点不可达或未配置"
  hint "检查 .env 的 BRAIN_* 三项；429=余额/并发限制"
fi

echo "── 5/5 真实聊天（大脑真回话，防降级文案冒充成功）"
# 教训（2026-10-26）：launchd 环境 claude ENOENT 时网关回降级文案，SSE 流形状正常——
# 只看"有输出"不算过，必须断言回复内容不是兜底话术。
reply=$(curl -s -m 90 "$URL/v1/chat/completions" -H 'Content-Type: application/json' \
  -d '{"model":"x","stream":false,"messages":[{"role":"user","content":"（自检）请只回复四个字：自检通过"}]}' 2>/dev/null \
  | python3 -c "
import sys, json
text = ''
for line in sys.stdin:
    line = line.strip()
    if not line.startswith('data: ') or line == 'data: [DONE]': continue
    try: d = json.loads(line[6:])
    except Exception: continue
    c = d.get('choices', [{}])[0].get('delta', {}).get('content')
    if c: text += c
print(text)")
if [ -n "$reply" ] && ! echo "$reply" | grep -q "脑子突然有点乱"; then
  ok "大脑真回话（${reply:0:30}…）"
  # 自检不留痕：清掉这轮的 user 行与好感度影响（结算与记忆照常，仅清理展示记忆）
  for db in "${DBS[@]}"; do
    sqlite3 "$db" "DELETE FROM chat_history WHERE content LIKE '%（自检）请只回复%'" 2>/dev/null || true
  done
else
  bad "大脑没真回话（空或降级文案）"
  hint "看 /tmp/companion.log 的 [gateway] 上游失败；claude-code 模式查 claude 是否可执行"
fi

echo "──────────────────"
echo "结果: $pass 通过, $fail 异常"
[ "$fail" -eq 0 ] && echo "全链路健康。若她仍无反应，把 chat_history 最新记录发给开发者：sqlite3 data/companion.db 'SELECT * FROM chat_history ORDER BY id DESC LIMIT 4'"
exit "$fail"
