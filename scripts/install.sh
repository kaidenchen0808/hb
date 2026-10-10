#!/usr/bin/env bash
# 微信/AirDrop 兜底通道：payload.zip 随包分发，复用 plugin 安装器逻辑
#   bash install.sh [--glm <api-key>]
# 三件套同目录分发：payload.zip（make-release 产物改名）、ensure-installed.sh、本脚本
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
GLM_KEY=""
if [ "${1:-}" = "--glm" ]; then GLM_KEY="${2:?--glm 需要 key}"; fi

VER="$(unzip -p "$HERE/payload.zip" payload/VERSION 2>/dev/null | tr -d '[:space:]')"
[ -n "$VER" ] || { echo "错误: payload.zip 不在脚本同目录（兜底三件套需一起分发）" >&2; exit 1; }

# 本地文件当下载源：installer 按 URL 请求 /payload-$VER.zip 与 .sha256，链接/生成对应名字（python3 系统自带）
SRV_PORT=18901
ln -sf "$HERE/payload.zip" "$HERE/payload-$VER.zip"
shasum -a 256 "$HERE/payload.zip" | awk -v v="$VER" '{print $1"  payload-"v".zip"}' > "$HERE/payload-$VER.zip.sha256"
cd "$HERE"
python3 -m http.server $SRV_PORT --bind 127.0.0.1 >/dev/null 2>&1 &
SRV_PID=$!  # cd 已在后台启动之外，$! 直指 python3
cd - >/dev/null
trap 'kill "$SRV_PID" 2>/dev/null' EXIT
sleep 1

echo "==> 安装 companion v$VER"
PAYLOAD_BASE="http://127.0.0.1:$SRV_PORT" EXPECT_VERSION="$VER" \
  bash "$HERE/ensure-installed.sh" || true

# --glm：hybrid 秒回模式（.env 键存在则替换、缺失则追加——installer 写的 .env 没有这些行）
if [ -n "$GLM_KEY" ]; then
  ENV_FILE="$ROOT/.env"
  set_kv() { grep -q "^$1=" "$ENV_FILE" 2>/dev/null && sed -i '' "s|^$1=.*|$1=$2|" "$ENV_FILE" || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; }
  set_kv BRAIN_API_FORMAT hybrid
  set_kv BRAIN_BASE_URL "https://open.bigmodel.cn/api/anthropic"
  set_kv BRAIN_API_KEY "$GLM_KEY"
  set_kv BRAIN_MODEL "GLM-5.3"
fi

if [ "${COMPANION_SKIP_LAUNCHD:-0}" != "1" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/companion-layer.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/companion-layer.plist"
fi

STATE="$(cat "$ROOT/.state" 2>/dev/null || echo '')"
case "$STATE" in
  installed:*) echo "完成 ✅ 直接去干活，收工那一刻她会自己开口。" ;;
  *) echo "⚠️ 安装未完成（state=$STATE），查看 ${COMPANION_INSTALL_LOG:-/tmp/companion-install.log}" >&2; exit 1 ;;
esac
