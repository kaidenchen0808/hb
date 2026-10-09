#!/usr/bin/env bash
# 懒启动：Claude Code 一干活就自动拉齐她的世界
#  · companion-layer 没跑 → 自动拉起（launchd 之外的双保险）
#  · AniCompanion 没跑   → Stop（收工）时拉起桌宠，10 分钟节流
# 由 report-event.sh / stop-claude.sh 调用：ensure-running.sh <layer|app|both>
set -u
COMPANION_URL="${COMPANION_URL:-http://127.0.0.1:8787}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP_DIR="/tmp/companion-ensure"
MODE="${1:-both}"

ensure_layer() {
  curl -s -m 1 "$COMPANION_URL/health" 2>/dev/null | grep -q '"status":"ok"' && return 0
  # 没跑：拉起（后台、不阻塞 hook）
  (cd "$REPO_DIR" && nohup node src/index.ts >> /tmp/companion.log 2>&1 &)
}

ensure_app() {
  pgrep -f "AniCompanion.app/Contents/MacOS" >/dev/null 2>&1 && return 0
  mkdir -p "$STAMP_DIR"
  [ -f /Applications/AniCompanion.app ] || return 0  # 没装就不多事
  # 10 分钟节流：避免反复打扰刚被手动关掉的用户
  STAMP="$STAMP_DIR/app-launch"
  [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -f %m "$STAMP") )) -lt 600 ] && return 0
  touch "$STAMP"
  open -a /Applications/AniCompanion.app 2>/dev/null || true
}

[ "$MODE" = "layer" ] || [ "$MODE" = "both" ] && ensure_layer
[ "$MODE" = "app" ] || [ "$MODE" = "both" ] && ensure_app
exit 0
