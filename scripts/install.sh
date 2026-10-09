#!/usr/bin/env bash
# ============================================================
# companion 桌宠一键安装（离线 bundle 版，全程不需要 GitHub）
#
#   bash install.sh                    # 零配置（大脑=claude 登录态）
#   bash install.sh --glm <api-key>    # GLM 用户：hybrid 秒回模式
#   bash install.sh --brain <url> <key> <model>   # 其他 OpenAI 兼容端点
#   bash install.sh --local /path/hb   # 已有 companion-layer 仓库的机器
#
# 前置：本脚本与 companion-layer.zip、AniCompanion.app.zip 放在同一目录
# （即 bundle 解压后直接跑）。做完整套安装：解源码 → 装 App → defaults 写好
# app 后端 → claude mcp add → hooks 合并 → .env → launchd 常驻 → 健康检查
# ============================================================
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR=""
GLM_KEY=""
BRAIN_URL=""; BRAIN_KEY=""; BRAIN_MODEL=""
INSTALL_ROOT="$HOME/.companion-layer"
PORT=8787
URL="http://127.0.0.1:${PORT}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m错误: %s\033[0m\n' "$1" >&2; exit 1; }

# ---- 参数解析 ----
while [ $# -gt 0 ]; do
  case "$1" in
    --glm)   GLM_KEY="${2:-}"; shift 2 ;;
    --brain) BRAIN_URL="${2:-}"; BRAIN_KEY="${3:-}"; BRAIN_MODEL="${4:-}"; shift 4 ;;
    --local) REPO_DIR="${2:-}"; shift 2 ;;
    *) die "未知参数: $1（可用 --glm <key> / --brain <url> <key> <model> / --local <dir>）" ;;
  esac
done

step "检查环境"
command -v node >/dev/null || die "需要 node >= 23.6"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 23 ? 0 : 1)' || die "node 版本过低（需 >=23.6，当前 $(node --version)）"
command -v pnpm >/dev/null || die "请先: npm i -g pnpm"
command -v jq >/dev/null || die "请先: brew install jq"

# ---- 获取 companion-layer 源码 ----
step "安装 companion-layer"
if [ -n "$REPO_DIR" ]; then
  [ -d "$REPO_DIR/src" ] || die "--local 目录不像 companion-layer 仓库"
elif [ -d "$BUNDLE_DIR/src" ]; then
  # 从本仓库直接跑（开发者本机）
  REPO_DIR="$BUNDLE_DIR"
else
  # 从 bundle 解压到 ~/.companion-layer
  [ -f "$BUNDLE_DIR/companion-layer.zip" ] || die "当前目录没有 companion-layer.zip（请在 bundle 解压目录里运行本脚本，或用 --local 指定仓库）"
  rm -rf "$INSTALL_ROOT"; mkdir -p "$INSTALL_ROOT"
  unzip -q "$BUNDLE_DIR/companion-layer.zip" -d "$INSTALL_ROOT"
  REPO_DIR="$INSTALL_ROOT"
fi
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
echo "  位置: $REPO_DIR"
pnpm install --dir "$REPO_DIR" --silent

# ---- .env（大脑策略）----
step "生成 .env（大脑配置）"
if [ ! -f "$REPO_DIR/.env" ]; then
  {
    echo "PORT=${PORT}"
    echo "DB_PATH=$REPO_DIR/data/companion.db"
    echo "PERSONA_PATH=$REPO_DIR/persona/persona.yaml"
    if [ -n "$GLM_KEY" ]; then
      printf 'BRAIN_API_FORMAT=hybrid\nBRAIN_BASE_URL=https://open.bigmodel.cn/api/anthropic\nBRAIN_API_KEY=%s\nBRAIN_MODEL=GLM-5.3\n' "$GLM_KEY"
    elif [ -n "$BRAIN_URL" ]; then
      printf 'BRAIN_API_FORMAT=hybrid\nBRAIN_BASE_URL=%s\nBRAIN_API_KEY=%s\nBRAIN_MODEL=%s\n' "$BRAIN_URL" "$BRAIN_KEY" "$BRAIN_MODEL"
    else
      printf 'BRAIN_API_FORMAT=claude-code\nBRAIN_BASE_URL=\nBRAIN_API_KEY=\nBRAIN_MODEL=\n'
    fi
  } > "$REPO_DIR/.env"
  if [ -n "$GLM_KEY" ]; then echo "  大脑: hybrid（GLM 直连秒回 + claude 代查）"
  elif [ -n "$BRAIN_URL" ]; then echo "  大脑: hybrid（自定义端点）"
  else echo "  大脑: claude-code（零配置，复用 claude 登录态；想要秒回可 --glm <key>）"; fi
else
  echo "  .env 已存在，保留现有配置"
fi

# ---- AniCompanion（fork 补丁版，bundle 离线安装）----
step "安装 AniCompanion（带主动开口补丁的 fork）"
if [ -d /Applications/AniCompanion.app ] && pgrep -f "AniCompanion.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "  已安装且在运行，跳过"
else
  APP_ZIP="$BUNDLE_DIR/AniCompanion.app.zip"
  [ -f "$APP_ZIP" ] || die "当前目录没有 AniCompanion.app.zip（请在 bundle 解压目录里运行）"
  killall AniCompanion 2>/dev/null || true; sleep 1
  rm -rf /Applications/AniCompanion.app
  ditto -x -k "$APP_ZIP" /Applications/
  echo "  已安装（ad-hoc 签名：首次打开如被 Gatekeeper 拦截，右键 App → 打开）"
fi
# defaults 直接写好后端配置——用户不用点 Settings
defaults write com.anicompanion.app chat_backend openAICompatible
defaults write com.anicompanion.app chat_endpoint_openAICompatible "$URL"
defaults write com.anicompanion.app chat_api_key_openAICompatible ""
defaults write com.anicompanion.app tts_enabled 1
echo "  app 后端已自动指向 $URL"

# ---- Claude Code 接入（MCP + hooks）----
step "接入 Claude Code"
command -v claude >/dev/null && {
  claude mcp add companion -s user -- node "$REPO_DIR/bin/companion-mcp.js" 2>/dev/null \
    && echo "  MCP: companion 已注册" \
    || echo "  MCP: 已存在，跳过"
} || echo "  未检测到 claude CLI，跳过 MCP"

REPO_DIR="$REPO_DIR" python3 - <<'PY'
import json, os
from pathlib import Path
repo = os.environ['REPO_DIR']
settings_path = Path.home() / '.claude' / 'settings.json'
settings_path.parent.mkdir(parents=True, exist_ok=True)
settings = {}
if settings_path.exists():
    try: settings = json.loads(settings_path.read_text())
    except json.JSONDecodeError: raise SystemExit(f'  {settings_path} 不是合法 JSON，请修复后重试')
hooks = settings.setdefault('hooks', {})
def merge(key, entry):
    entries = hooks.setdefault(key, [])
    exists = any(h.get('command') == entry['hooks'][0]['command']
                 for e in entries if isinstance(e, dict) for h in e.get('hooks', []))
    if not exists: entries.append(entry)
merge('PostToolUse', {'matcher': '*', 'hooks': [{'type': 'command', 'command': f'bash {repo}/hooks/report-event.sh PostToolUse'}]})
merge('UserPromptSubmit', {'hooks': [{'type': 'command', 'command': f'bash {repo}/hooks/report-event.sh UserPromptSubmit'}]})
merge('SessionStart', {'hooks': [{'type': 'command', 'command': f'bash {repo}/hooks/report-event.sh SessionStart'}]})
merge('Stop', {'hooks': [{'type': 'command', 'command': f'bash {repo}/hooks/stop-claude.sh'}]})
settings_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + '\n')
print(f'  hooks 已写入 {settings_path}')
PY

# ---- launchd 常驻 ----
step "注册 launchd（开机自启 + 崩溃自动拉起）"
PLIST="$HOME/Library/LaunchAgents/companion-layer.plist"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>companion-layer</string>
  <key>ProgramArguments</key><array>
    <string>node</string><string>${REPO_DIR}/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/companion.log</string>
  <key>StandardErrorPath</key><string>/tmp/companion.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 2
curl -s -m 2 "$URL/health" | grep -q '"status":"ok"' && echo "  服务已常驻 $URL" || echo "  ⚠️ 服务未就绪，查看 /tmp/companion.log"

# ---- 完成 ----
step "安装完成 ✅"
cat <<EOF

  现在直接去干活——打开 Claude Code 写点什么。
  收工那一刻，她会自己开口。

  · 桌宠窗口: open -a AniCompanion（或让 Stop hook 自动拉起）
  · 全链路自检: bash $REPO_DIR/scripts/check.sh
  · 让她说话:  curl -X POST $URL/api/say -d '{"text":"[happy] 我在哦"}' -H 'Content-Type: application/json'
EOF
