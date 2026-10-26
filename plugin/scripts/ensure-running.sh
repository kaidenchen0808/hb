#!/usr/bin/env bash
# 懒启动：Claude Code 一干活就自动拉齐她的世界（plugin 版：node/brain 来自 payload 安装目录）
#  · companion-layer 没跑 → 自动拉起（launchd 之外的双保险）
#  · AniCompanion 没跑   → Stop（收工）时拉起桌宠，10 分钟节流
# 由 report-event.sh / stop-claude.sh 调用：ensure-running.sh <layer|app|both>
set -u
COMPANION_URL="${COMPANION_URL:-http://127.0.0.1:8787}"
COMPANION_ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
STAMP_DIR="/tmp/companion-ensure"
MODE="${1:-both}"

ensure_layer() {
  curl -s -m 1 "$COMPANION_URL/health" 2>/dev/null | grep -q '"status":"ok"' && return 0
  # 没跑：拉起（后台、不阻塞 hook）。node 决策与 ensure-installed 一致：
  # payload node 优先，被猎杀/损坏（--version 失败）时回落系统 node。
  local node_bin="$COMPANION_ROOT/node"
  if ! "$node_bin" --version >/dev/null 2>&1; then
    SYS_NODE="$(command -v node || true)"
    [ -n "$SYS_NODE" ] && "$SYS_NODE" --version >/dev/null 2>&1 && node_bin="$SYS_NODE"
  fi
  (cd "$COMPANION_ROOT" && nohup "$node_bin" "$COMPANION_ROOT/brain.mjs" >> /tmp/companion.log 2>&1 &)
}

ensure_app() {
  pgrep -f "AniCompanion.app/Contents/MacOS" >/dev/null 2>&1 && return 0
  mkdir -p "$STAMP_DIR"
  [ -d /Applications/AniCompanion.app ] || return 0  # .app 是目录：没装就不多事（-f 对目录恒假，曾致永不拉起）
  # 10 分钟节流：避免反复打扰刚被手动关掉的用户
  STAMP="$STAMP_DIR/app-launch"
  [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -f %m "$STAMP") )) -lt 600 ] && return 0
  touch "$STAMP"
  # 拉起 + 确认重试（后台执行，不占 hook 10s 时长）：open 偶发静默失败
  # （LaunchServices 上下文问题），3 秒未存活重试一次，结果落日志可查
  (
    LOG="$STAMP_DIR/app-launch.log"
    if ! open -a /Applications/AniCompanion.app 2>>"$LOG"; then
      echo "$(date '+%m-%d %H:%M:%S') open 调用失败" >>"$LOG"
    fi
    sleep 3
    if ! pgrep -f "AniCompanion.app/Contents/MacOS" >/dev/null 2>&1; then
      echo "$(date '+%m-%d %H:%M:%S') 首次拉起未存活，重试" >>"$LOG"
      open -a /Applications/AniCompanion.app 2>>"$LOG" || true
    fi
  ) >/dev/null 2>&1 &
}

[ "$MODE" = "layer" ] || [ "$MODE" = "both" ] && ensure_layer
[ "$MODE" = "app" ] || [ "$MODE" = "both" ] && ensure_app
exit 0
