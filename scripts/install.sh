#!/usr/bin/env bash
# ============================================================
# companion 桌宠一键安装（面向 claude code / opencode 用户）
#
#   bash install.sh                    # 零配置（大脑=claude 登录态）
#   bash install.sh --glm <api-key>    # GLM 用户：hybrid 秒回模式
#   bash install.sh --brain <url> <key> <model>   # 其他 OpenAI 兼容端点
#   bash install.sh --local /path/hb   # 从本地仓库安装（未推 GitHub 时用）
#
# 做完的事：装 AniCompanion(fork 带"她主动开口"补丁) → defaults 写好 app 后端
#           → claude mcp add → hooks 合并 → .env → launchd 常驻 → 全链路自检
# ============================================================
set -euo pipefail

REPO_DIR=""
GLM_KEY=""
BRAIN_URL=""; BRAIN_KEY=""; BRAIN_MODEL=""
# 推到 GitHub 后改成你的仓库（GitHub release 挂补丁版 dmg）
GITHUB_REPO="YOUR_GITHUB_USERNAME/hb"
DMG_VERSION="0.7.0-notif"
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
command -v curl >/dev/null || die "缺少 curl"

# ---- 获取 companion-layer 源码 ----
step "安装 companion-layer"
if [ -n "$REPO_DIR" ]; then
  [ -d "$REPO_DIR/src" ] || die "--local 目录不像 companion-layer 仓库"
else
  REPO_DIR="$HOME/.companion-layer"
  if [ ! -d "$REPO_DIR/src" ]; then
    mkdir -p "$REPO_DIR"
    curl -fsSL "https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz" \
      | tar -xz --strip-components=1 -C "$REPO_DIR" \
      || die "下载失败：请先推仓库到 GitHub（或用 --local 本地安装）"
  fi
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
  [ -n "$GLM_KEY" ] && echo "  大脑: hybrid（GLM 直连秒回 + claude 代查）" \
    || { [ -n "$BRAIN_URL" ] && echo "  大脑: hybrid（自定义端点）" || echo "  大脑: claude-code（零配置，复用 claude 登录态；想要秒回可 --glm <key>）"; }
else
  echo "  .env 已存在，保留现有配置"
fi

# ---- AniCompanion（fork 补丁版）----
step "安装 AniCompanion（带主动开口补丁的 fork）"
if [ -d /Applications/AniCompanion.app ] && pgrep -f "AniCompanion.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "  已安装且在运行，跳过"
else
  DMG="/tmp/AniCompanion-${DMG_VERSION}.dmg"
  curl -fsSL -o "$DMG" "https://github.com/${GITHUB_REPO}/releases/download/v${DMG_VERSION}/AniCompanion-${DMG_VERSION}.dmg" \
    || die "下载补丁版 dmg 失败（请先构建并上传 Release，见 scripts/build-dmg-fork.md）"
  hdiutil attach -nobrowse -quiet "$DMG"
  VOL=$(ls /Volumes | grep -i "AniCompanion" | head -1)
  [ -n "$VOL" ] || die "挂载失败"
  killall AniCompanion 2>/dev/null || true; sleep 1
  rm -rf /Applications/AniCompanion.app
  ditto "/Volumes/$VOL/AniCompanion.app" /Applications/AniCompanion.app
  hdiutil detach -quiet "/Volumes/$VOL"
  rm -f "$DMG"
  echo "  已安装（ad-hoc 签名：首次打开如被拦，右键 App → 打开）"
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

REPO_DIR="$REPO_DIR" PORT="$PORT" python3 - <<'PY'
import json, os
from pathlib import Path
repo, port = os.environ['REPO_DIR'], os.environ['PORT']
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
