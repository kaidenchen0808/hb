#!/usr/bin/env bash
# 打一个可分发的好友安装包：dist/companion-bundle.zip
#   朋友收到 → 解压 → bash install.sh [--glm <key>] 即装完，全程不需要 GitHub
# 内容：companion-layer 源码（干净档）+ 补丁版 AniCompanion.app(zip) + install.sh
set -euo pipefail
HB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$HB_DIR/dist"
BUNDLE_SRC="$DIST/companion-layer"
APP_ZIP="$DIST/AniCompanion.app.zip"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m错误: %s\033[0m\n' "$1" >&2; exit 1; }

step "收集 companion-layer 源码（git archive 干净档）"
rm -rf "$DIST"; mkdir -p "$BUNDLE_SRC"
git -C "$HB_DIR" archive HEAD | tar -x -C "$BUNDLE_SRC"
echo "  $(find "$BUNDLE_SRC" -type f | wc -l | tr -d ' ') 个文件"

step "打包补丁版 AniCompanion.app"
BUILT_DIR=$(xcodebuild -project "$HB_DIR/anicompanion/AniCompanion.xcodeproj" -scheme AniCompanion \
  -configuration Release -showBuildSettings 2>/dev/null | grep -m1 "BUILT_PRODUCTS_DIR" | awk '{print $3}')
APP="$BUILT_DIR/AniCompanion.app"
[ -d "$APP" ] || die "构建产物不存在：$APP（先构建 anicompanion）"
ditto -c -k --keepParent "$APP" "$APP_ZIP"
echo "  $(du -h "$APP_ZIP" | awk '{print $1}') → $APP_ZIP"

step "复制 install.sh 并生成 bundle"
cp "$HB_DIR/scripts/install.sh" "$DIST/install.sh"
(cd "$DIST" && ditto -c -k -X companion-layer companion-layer.zip && rm -rf companion-layer)
(cd "$DIST" && zip -q -r companion-bundle.zip install.sh companion-layer.zip AniCompanion.app.zip)
SIZE=$(du -h "$DIST/companion-bundle.zip" | awk '{print $1}')
echo "  ✅ $DIST/companion-bundle.zip（${SIZE}）"
echo
echo "发给朋友后，对方只需："
echo "  unzip companion-bundle.zip && bash install.sh           # 零配置"
echo "  unzip companion-bundle.zip && bash install.sh --glm <key>  # GLM 秒回版"
