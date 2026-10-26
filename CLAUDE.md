# CLAUDE.md

本仓库是 **companion-layer**：Agent 事件感知 + 人格 + 记忆 + 好感度的桌面角色中间层（她的"灵魂"），对接 AniCompanion 渲染端（她的"身体"）。产品形态是给 Claude Code 装一个住在桌面上的 3D 女友。

## 常用命令

```bash
pnpm test            # vitest 跑全部测试（改动后必须跑通）
pnpm run typecheck   # tsc --noEmit
pnpm start           # 启动服务（node 原生跑 TS，需 Node >= 23.6）
pnpm run dev         # --watch 开发模式
pnpm run build:brain # esbuild bundle 出 dist/brain.mjs + dist/brain-mcp.mjs（分发用）

bash scripts/check.sh          # 四环节自检（她没反应时排查）
bash scripts/make-release.sh   # 打 Release payload（产品主人执行，含隔离冒烟）
tail -f /tmp/companion.log     # 运行时服务日志
```

包管理用 **pnpm**（仓库是 pnpm-lock.yaml）。

## 架构（详见 docs/architecture.md）

```
AniCompanion（Swift 渲染端，fork 于 anicompanion/）◄─WS 实时推送 /v1/ws（3s 轮询兜底）─┐
                                                                                    │
companion-layer（本仓库 src/）─ OpenAI 兼容 SSE 网关 ─────────────────────────────────┘
       ▲ hooks（全自动）/ MCP stdio（兜底）
Agent（Claude Code / OpenCode / Codex）
```

核心数据流：
- **Agent 干活 → 她知道**：PostToolUse hook `POST /api/events` → raw_events（归档）；Stop hook `POST /api/aggregate` → 聚合器折叠成 agent_events（她的视野）；MCP `companion_report` 直进 agent_events。
- **她开口**：AniCompanion `POST /v1/chat/completions` → 丢弃 app 自带 system、组装 persona + 表情协议 + 关系阶段语气 + 未消费事件 + facts 记忆 → 代理到 BRAIN_BASE_URL，SSE 原样透传 → 流结束后结算好感度、异步提取 facts。
- **好感度**：完全隐藏（无 UI 无数值不扣分），行为信号累加跨 persona.yaml 阶段阈值（stranger→familiar→close→soulmate），里程碑注入告白指令；≥3 天未互动注入"想念"。**去重**：相同 lastUser 3 分钟窗口内只结算一次（gateway.ts 的 `recentAffinitySettles`——客户端"重新生成"原样重发同一句话不重复加分；落库/记忆照常）。

## 目录结构

```
src/
├── index.ts          # HTTP 服务入口（Hono + @hono/node-server，端口 8787）
├── config.ts         # .env 配置加载
├── http/app.ts       # 路由：/api/events、/api/aggregate、/api/say 等
├── http/gateway.ts   # /v1/chat/completions OpenAI 兼容网关（SSE 透传）
├── brain/llmClient.ts      # 大脑客户端（openai / anthropic / claude-code 三模式）
├── brain/reactionGen.ts    # 反应引擎（任务完成/报错安慰/深夜劝睡，带冷却）
├── memory/           # eventStore / aggregator / reactions / relationship / facts / outbox / touch
├── realtime/         # WebSocket hub（/v1/ws 实时推送 <500ms，轮询兜底）
├── persona/          # loader（persona.yaml）+ promptBuilder（EMOTION_TAGS 16 种表情）
├── mcp/              # MCP server（companion_report / get_context / notify）
└── db/database.ts    # node:sqlite，WAL，busy_timeout=5000
plugin/               # Claude plugin 分发体（hooks/MCP/skill/ensure-installed.sh）
scripts/              # check.sh / install.sh / make-release.sh / ensure-running.sh
anicompanion/         # Swift 渲染端 fork — 有自己的 CLAUDE.md，见下
persona/persona.yaml  # 名字/性格/关系阶段阈值 — 改后重启服务生效
data/companion.db     # SQLite（开发环境；用户安装位是 ~/.companion-layer）
tests/                # vitest：gateway / hooks / installer / memory / persona / mcp-launcher
```

## 关键约定

- **零编译开发**：ESM + Node ≥23.6 原生跑 `.ts`，无 tsc 构建步骤；分发时才 esbuild bundle。
- **双进程共享 SQLite**：HTTP 服务与 MCP 进程（`bin/companion-mcp.js`）同库并发，依赖 WAL，改动数据库代码须保持两入口兼容。
- **表情标签协议**：回复嵌 `[happy]` 等 16 种标签（`src/persona/promptBuilder.ts` 的 `EMOTION_TAGS`），与 AniCompanion 的 `Emotion.swift` 对齐，两端需同步改。
- **大脑三种模式**（`.env` 的 `BRAIN_API_FORMAT`）：`openai` / `anthropic`（OpenAI 兼容网关、GLM 等）/ `claude-code`（spawn `claude -p` 只读工具白名单：Read/Glob/Grep/WebSearch/WebFetch——能查不能改）。安全边界：她的"手"永远只读。
- **防骚扰设计**：反应引擎有小工作量静默、15 分钟冷却、深夜劝睡每晚一次。触摸交互（`/api/touch`，AniCompanion 点击角色）独立短冷却 5s 连点静默、好感度每日封顶 3 点。测试涉及时间敏感逻辑时注意 23-5 点 lateNight 反应会盖过期望值（tests 里有固定白天时刻的先例）。
- **台词+动画联合决策**：outbox 消息与 WS say 帧带可选 `animation`（AniCompanion 的 clip 名，缺 clip 客户端静默忽略）。触摸/情绪反应的动画映射见 `touch.ts` / `reactions.ts`；26 动作全集清单在 anicompanion 的 `docs/animations.md`。
- **分发链路**：`plugin/`（秒装）→ SessionStart hook 后台 `ensure-installed.sh` 下载 GitHub Release payload（sha256 校验 + 镜像加速）→ 原子部署 `~/.companion-layer`。改 plugin/ 或安装脚本后跑 `tests/installer.test.ts`。
- **重装不丢记忆**：`data/` 与 `.env` 在升级时保留，安装器逻辑不能动这两处。

## 子项目：anicompanion/

Swift 6 / SwiftUI 的 macOS 渲染端（VRM + TTS + STT + 桌宠），是上游项目的 fork、带主动开口补丁。**有自己的 `anicompanion/CLAUDE.md`**（英文，含构建命令、流式管线、VRM 渲染、VPIO 全双工等大量坑点），改 Swift 代码前先读它。根目录的日常开发（TypeScript 中间层）一般不需要动它。

## 运维速查

- 她没反应：`bash scripts/check.sh` 四环节诊断（服务/大脑/人格/渲染端）。
- 服务日志：`/tmp/companion.log`；安装日志：`/tmp/companion-install.log`。
- 常驻状态：`launchctl list | grep companion-layer`。
- 换名字/性格：编辑 `persona/persona.yaml` 后重启服务。
