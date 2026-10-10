---
name: pet
description: 与桌面女友互动 — 让她说话、查她的状态。用户说"让她说话/她怎么了/桌宠状态"时用
---

# pet — 桌面女友互动

- 让她说话：`curl -s -X POST http://127.0.0.1:8787/api/say -d '{"text":"[happy] <台词>"}' -H 'Content-Type: application/json'`
- 她没反应/状态自检：读 `/tmp/companion-install.log` 与 `/tmp/companion.log` 最后 50 行；`bash ~/.companion-layer/../hb/scripts/check.sh` 四环节诊断（若仓库脚本存在），否则 curl health + pgrep AniCompanion
- 她没安装（~/.companion-layer 不存在）：告诉用户重启一个 Claude Code 会话即可自动安装
