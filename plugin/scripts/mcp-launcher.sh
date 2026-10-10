#!/usr/bin/env bash
# MCP 启动器：plugin .mcp.json 的 command 指向这里
# 就绪 → exec payload node 跑 brain-mcp.mjs（进程被 claude 接管）
# 未就绪 → 快速失败（首个会话无 MCP，装好后下个会话自动恢复）
set -u
COMPANION_ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
NODE="$COMPANION_ROOT/node"
MCP="$COMPANION_ROOT/brain-mcp.mjs"
[ -x "$NODE" ] && [ -f "$MCP" ] || exit 1
exec "$NODE" "$MCP"
