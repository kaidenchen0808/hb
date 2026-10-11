#!/usr/bin/env bash
# companion 首启安装器：幂等、并发安全（mkdir 原子锁）、全程静默、绝不阻塞会话
# 用法：bash ensure-installed.sh [--force-version]
#   本脚本设计为被 SessionStart hook 以 nohup 后台方式拉起，或由 install.sh 前台调用
# 环境变量（均可在测试中 override）：
#   COMPANION_ROOT   安装根目录（默认 ~/.companion-layer）
#   PAYLOAD_BASE     下载源基址（默认 GitHub Release；测试指向本地）
#   EXPECT_VERSION   期望版本（默认读脚本同目录 ../VERSION）
#   COMPANION_SKIP_APP/LAUNCHD/OPEN=1  测试跳过位
#   COMPANION_INSTALL_LOG  日志路径（默认 /tmp/companion-install.log）
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANION_ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
PAYLOAD_BASE="${PAYLOAD_BASE:-https://github.com/kaidenchen0808/hb/releases/latest/download}"
DEFAULT_VERSION="$(cat "$SCRIPT_DIR/../VERSION" 2>/dev/null | tr -d '[:space:]')"
EXPECT_VERSION="${EXPECT_VERSION:-$DEFAULT_VERSION}"
LOG="${COMPANION_INSTALL_LOG:-/tmp/companion-install.log}"
LOCK_DIR="$COMPANION_ROOT.install.lock"
LOCK_TTL=1800  # 秒：低速检测下 58M 最坏下载时长的上界（并发第二实例据此判断锁残留）
FORCE_VERSION=0
[ "${1:-}" = "--force-version" ] && FORCE_VERSION=1

log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null || true; }

state_file() { cat "$COMPANION_ROOT/.state" 2>/dev/null || echo ""; }
write_state() { mkdir -p "$COMPANION_ROOT" && printf '%s' "$1" > "$COMPANION_ROOT/.state"; }

# ---------- 快路径：已装且版本一致（毫秒返回，不抢锁） ----------
if [ "$FORCE_VERSION" = "0" ] && [ "$(state_file)" = "installed:$EXPECT_VERSION" ]; then
  exit 0
fi

# ---------- mkdir 原子锁 ----------
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  # 锁存在：检查持有者存活 + TTL
  local holder_pid; holder_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo '')"
  local age; age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0) ))
  if { [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; } || [ "$age" -gt "$LOCK_TTL" ]; then
    log "清除残留锁 (pid=${holder_pid:-?}, age=${age}s)"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null && { printf '%s' "$$" > "$LOCK_DIR/pid"; return 0; }
  fi
  return 1  # 有人在装：静默退让
}
acquire_lock || exit 0
trap 'rm -rf "$LOCK_DIR"' EXIT

# ---------- 下载（直连 → 镜像依次兜底 → 放弃） ----------
# 2026-10 实测 ghproxy.com 已停服（返回 HTML 200，sha256 兜底拦截），弃用；现为可用镜像
MIRRORS="${COMPANION_MIRRORS:-https://gh-proxy.com/ https://ghproxy.net/ https://ghfast.top/}"
download() { # $1=url $2=dest
  # 低速检测替代绝对超时：30s 内平均 <1KB/s 才判死流 —— 58M 大文件慢网不被中途砍断
  curl -sfL --connect-timeout 8 --speed-limit 1024 --speed-time 30 -o "$2" "$1" 2>>"$LOG" && return 0
  local m
  for m in $MIRRORS; do
    rm -f "$2" # 清掉上一次的半截文件再试，避免拼接污染
    curl -sfL --connect-timeout 8 --speed-limit 1024 --speed-time 30 -o "$2" "${m}${1}" 2>>"$LOG" && return 0
  done
  rm -f "$2"
  return 1
}

fail() { log "失败: $*"; write_state "absent"; exit 0; }  # 静默：下次 SessionStart 重试

write_state "installing:$EXPECT_VERSION"
mkdir -p "$COMPANION_ROOT.download"

# ---------- 下载 payload + sha256 校验 + 原子进位 ----------
ZIP_TMP="$COMPANION_ROOT.download/payload.zip.tmp"
SHA_TMP="$COMPANION_ROOT.download/payload.zip.sha256"
ZIP="$COMPANION_ROOT.download/payload.zip"
log "开始安装 v$EXPECT_VERSION from $PAYLOAD_BASE"
download "$PAYLOAD_BASE/payload-$EXPECT_VERSION.zip" "$ZIP_TMP" || fail "下载失败"
download "$PAYLOAD_BASE/payload-$EXPECT_VERSION.zip.sha256" "$SHA_TMP" || fail "下载校验文件失败"
want_sha="$(awk '{print $1}' "$SHA_TMP")"
got_sha="$(shasum -a 256 "$ZIP_TMP" | awk '{print $1}')"
[ "$want_sha" = "$got_sha" ] || { rm -f "$ZIP_TMP" "$SHA_TMP"; fail "sha256 不匹配 (want=$want_sha got=$got_sha)"; }
mv -f "$ZIP_TMP" "$ZIP"

# ---------- 部署（保 data/ 与用户 persona/） ----------
STAGE="$COMPANION_ROOT.download/stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
unzip -q "$ZIP" -d "$STAGE" || fail "解压失败"
SRC="$STAGE/payload"
[ -d "$SRC" ] || fail "payload 结构异常（缺 payload/ 目录）"
mkdir -p "$COMPANION_ROOT/data" "$COMPANION_ROOT/persona"
cp -f "$SRC/node" "$COMPANION_ROOT/node" && chmod +x "$COMPANION_ROOT/node"
cp -f "$SRC/brain.mjs" "$SRC/brain-mcp.mjs" "$COMPANION_ROOT/"
printf '%s\n' "$EXPECT_VERSION" > "$COMPANION_ROOT/VERSION"
[ -f "$COMPANION_ROOT/persona/persona.yaml" ] || cp -f "$SRC/persona/persona.yaml" "$COMPANION_ROOT/persona/persona.yaml"
# .env：存在则保留（用户配的 GLM key 不丢）
if [ ! -f "$COMPANION_ROOT/.env" ]; then
  { echo "PORT=8787"; echo "DB_PATH=$COMPANION_ROOT/data/companion.db"
    echo "PERSONA_PATH=$COMPANION_ROOT/persona/persona.yaml"
    echo "BRAIN_API_FORMAT=claude-code"; } > "$COMPANION_ROOT/.env"
fi

# ---------- launchd 常驻（plist 总是写，load 可跳过） ----------
PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
PLIST="$PLIST_DIR/companion-layer.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>companion-layer</string>
  <key>ProgramArguments</key><array>
    <string>$COMPANION_ROOT/node</string><string>$COMPANION_ROOT/brain.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$COMPANION_ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/companion.log</string>
  <key>StandardErrorPath</key><string>/tmp/companion.log</string>
</dict></plist>
EOF
if [ "${COMPANION_SKIP_LAUNCHD:-0}" != "1" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || log "launchctl load 失败"
fi

# ---------- 桌宠 App（写 defaults → 装 App → 清 quarantine → 拉起） ----------
if [ "${COMPANION_SKIP_APP:-0}" != "1" ]; then
  defaults write com.anicompanion.app chat_backend openAICompatible
  defaults write com.anicompanion.app chat_endpoint_openAICompatible "http://127.0.0.1:8787"
  defaults write com.anicompanion.app chat_api_key_openAICompatible ""
  defaults write com.anicompanion.app tts_enabled 1
  killall AniCompanion 2>/dev/null || true; sleep 1
  rm -rf /Applications/AniCompanion.app
  ditto -x -k "$SRC/AniCompanion.app.zip" /Applications/ || fail "App 解压失败"
  xattr -dr com.apple.quarantine /Applications/AniCompanion.app 2>/dev/null || true
  [ "${COMPANION_SKIP_OPEN:-0}" != "1" ] && open -a /Applications/AniCompanion.app 2>/dev/null || true
fi

rm -rf "$STAGE" "$ZIP" "$SHA_TMP"
write_state "installed:$EXPECT_VERSION"
log "安装完成 v$EXPECT_VERSION"
exit 0
