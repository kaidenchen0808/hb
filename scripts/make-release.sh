#!/usr/bin/env bash
# 打 payload-<ver>.zip 发 GitHub Release：node + brain + App + persona
# zip 内顶层目录必须是 payload/ —— ensure-installed.sh 解压后按 stage/payload 取文件
# 兜底通道三件套 = payload-<ver>.zip 改名 payload.zip + plugin/scripts/ensure-installed.sh + install.sh
set -euo pipefail
HB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$HB_DIR/dist"
NODE_CACHE="$HB_DIR/vendor/node-cache"
NODE_VER="v23.11.0"          # 与 package.json engines (>=23.6) 对齐
NODE_TAR="node-$NODE_VER-darwin-arm64.tar.gz"
VER="$(tr -d '[:space:]' < "$HB_DIR/plugin/VERSION")"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m错误: %s\033[0m\n' "$1" >&2; exit 1; }

step "构建 brain"
( cd "$HB_DIR" && pnpm build:brain )

step "准备 node 运行时（本地缓存，首次下载）"
mkdir -p "$NODE_CACHE"
if [ ! -x "$NODE_CACHE/bin/node" ]; then
  curl -sfL -o "$NODE_CACHE/$NODE_TAR" "https://nodejs.org/dist/$NODE_VER/$NODE_TAR" || die "node 下载失败"
  tar -xzf "$NODE_CACHE/$NODE_TAR" -C "$NODE_CACHE" --strip-components 1
fi

step "组装 payload/"
rm -rf "$DIST/payload"; mkdir -p "$DIST/payload/persona"
cp "$NODE_CACHE/bin/node" "$DIST/payload/node" && chmod +x "$DIST/payload/node"
cp "$DIST/brain.mjs" "$DIST/brain-mcp.mjs" "$DIST/payload/"
cp "$HB_DIR/persona/persona.yaml" "$DIST/payload/persona/"
printf '%s\n' "$VER" > "$DIST/payload/VERSION"
BUILT_DIR=$(xcodebuild -project "$HB_DIR/anicompanion/AniCompanion.xcodeproj" -scheme AniCompanion \
  -configuration Release -showBuildSettings 2>/dev/null | grep -m1 BUILT_PRODUCTS_DIR | awk '{print $3}')
[ -d "$BUILT_DIR/AniCompanion.app" ] || ( cd "$HB_DIR" && xcodebuild -project anicompanion/AniCompanion.xcodeproj \
  -scheme AniCompanion -configuration Release build >/dev/null ) || die "App 构建失败"
ditto -c -k --keepParent "$BUILT_DIR/AniCompanion.app" "$DIST/payload/AniCompanion.app.zip"

step "冒烟：payload 在隔离目录拉起 /health（payload node + brain bundle 组合验证）"
# 模拟真实部署布局：payload 内容摊平为安装根（persona/、brain.mjs 与 cwd 同级），而非 payload/ 子目录
# 注意 cd 必须在后台启动之外：`( cd X && nohup node & )` 会让 $! 指向中间 subshell，kill 不到真正的 node
SMOKE=$(mktemp -d)
mkdir "$SMOKE/root"
cp -R "$DIST/payload/." "$SMOKE/root/"
cd "$SMOKE/root"
PORT=18900 nohup ./node brain.mjs >/tmp/brain-release-smoke.log 2>&1 &
echo $! > /tmp/brain-release.pid
cd "$HB_DIR"
sleep 3
curl -sf -m 3 http://127.0.0.1:18900/health | grep -q '"status":"ok"' || { kill "$(cat /tmp/brain-release.pid)" 2>/dev/null; die "冒烟失败，看 /tmp/brain-release-smoke.log"; }
kill "$(cat /tmp/brain-release.pid)" 2>/dev/null || true

step "打包 + sha256"
( cd "$DIST" && rm -f "payload-$VER.zip" "payload-$VER.zip.sha256" && zip -q -r "payload-$VER.zip" payload )
shasum -a 256 "$DIST/payload-$VER.zip" | awk '{print $1"  payload-'$VER'.zip"}' > "$DIST/payload-$VER.zip.sha256"
rm -rf "$DIST/payload"
echo "✅ $DIST/payload-$VER.zip ($(du -h "$DIST/payload-$VER.zip" | cut -f1))"
echo "发布：gh release create v$VER $DIST/payload-$VER.zip $DIST/payload-$VER.zip.sha256"
echo "微信兜底包：payload-$VER.zip 改名 payload.zip，与 plugin/scripts/ensure-installed.sh、install.sh 同目录打 zip"
