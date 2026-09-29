#!/usr/bin/env bash
# 朋友军团一键安装：companion-layer + Claude Code hooks/MCP
# 用法: bash scripts/install-friend.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
URL="http://127.0.0.1:${PORT}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m错误: %s\033[0m\n' "$1" >&2; exit 1; }

step "检查依赖"
command -v node >/dev/null || die "需要 node >= 23.6"
node -e 'process.exit(process.versions.node.split(".").map(Number)[0] >= 23 ? 0 : 1)' || die "node 版本过低（需要 >= 23.6，当前 $(node --version)）"
command -v pnpm >/dev/null || die "请先: npm i -g pnpm"
command -v jq >/dev/null || die "请先: brew install jq"
command -v curl >/dev/null || die "缺少 curl"
command -v python3 >/dev/null || die "缺少 python3"

step "安装依赖 (pnpm install)"
pnpm install --dir "$REPO_DIR" --silent

step "生成 .env（已存在则跳过）"
if [ ! -f "$REPO_DIR/.env" ]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo "已生成 $REPO_DIR/.env —— 记得填写 BRAIN_BASE_URL / BRAIN_API_KEY / BRAIN_MODEL"
else
  echo "$REPO_DIR/.env 已存在，跳过"
fi

step "合并 Claude Code hooks 到 ~/.claude/settings.json"
REPO_DIR="$REPO_DIR" python3 - <<'PY'
import json, os, sys
from pathlib import Path

repo = os.environ['REPO_DIR']
settings_path = Path.home() / '.claude' / 'settings.json'
settings_path.parent.mkdir(parents=True, exist_ok=True)

settings = {}
if settings_path.exists():
    try:
        settings = json.loads(settings_path.read_text())
    except json.JSONDecodeError:
        sys.exit(f'  {settings_path} 不是合法 JSON，请手工修复后重试')

hooks = settings.setdefault('hooks', {})
report_cmd = f'bash {repo}/hooks/report-event.sh PostToolUse'
stop_cmd = f'bash {repo}/hooks/stop-claude.sh'

def merge_hook(key, entry):
    entries = hooks.setdefault(key, [])
    exists = any(
        h.get('type') == 'command' and h.get('command') == entry['hooks'][0]['command']
        for e in entries if isinstance(e, dict)
        for h in e.get('hooks', [])
    )
    if not exists:
        entries.append(entry)

merge_hook('PostToolUse', {'matcher': '*', 'hooks': [{'type': 'command', 'command': report_cmd}]})
merge_hook('Stop', {'hooks': [{'type': 'command', 'command': stop_cmd}]})

settings_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + '\n')
print(f'  hooks 已写入 {settings_path}')
PY

step "注册 MCP server 到 Claude Code"
claude mcp add companion -s user -- node "$REPO_DIR/bin/companion-mcp.js" 2>/dev/null \
  && echo "  已注册（user 级）" \
  || echo "  已存在或 claude CLI 不可用，可手工执行: claude mcp add companion -s user -- node $REPO_DIR/bin/companion-mcp.js"

step "完成！接下来的步骤"
cat <<EOF

  1. 填写大脑配置:  vim $REPO_DIR/.env  （BRAIN_* 三项）
  2. 启动服务:      cd $REPO_DIR && pnpm start
  3. 装 AniCompanion: https://github.com/catsmice/AniCompanion/releases 下载 dmg
  4. AniCompanion → Settings → Agent backend → OpenAI-compatible
       Endpoint: $URL
       API Key:  随意填
  5. 打完一局 Claude Code，然后问她："今天看到我干什么了？"

  祝你们相处愉快。
EOF
