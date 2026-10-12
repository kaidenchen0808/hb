# Companion Layer 架构

## 三层分工

```
┌─────────────────────────────────────────────────────────┐
│  Avatar 层 —— AniCompanion（fork：主动开口补丁 + WS 客户端）│
│  VRM 渲染 / TTS / STT / 唇同步 / 表情 / 桌宠 / proactive │
└───────────────────────────┬─────────────────────────────┘
                            │ 聊天：OpenAI 兼容 SSE（拉模式）
                            │ 她主动开口：WS 推送 /v1/ws（<0.5s，轮询兜底）
┌───────────────────────────┴─────────────────────────────┐
│  Companion Layer —— 本项目                               │
│  人格（persona.yaml）/ 工作感知 / 记忆 / 好感度           │
└──────┬──────────────────────────────┬───────────────────┘
       │ MCP stdio（手动兜底）          │ hooks（全自动）
┌──────┴──────────────────────────────┴───────────────────┐
│  Agent 层 —— Claude Code / OpenCode / Codex              │
└─────────────────────────────────────────────────────────┘
```

## 核心数据流

### 1. Agent 干活 → 她知道

```
Claude Code PostToolUse hook ──POST /api/events──→ raw_events（归档，不进视野）
Claude Code Stop hook ────────POST /api/aggregate─→ 聚合器折叠会话
                                                      "改文件 6 次、跑命令 47 次，约 25 分钟"
                                                        ↓
                                                   agent_events（她的视野）
MCP companion_report ─────────────────────────────→ agent_events（跳过聚合，Agent 主动汇报）
```

### 2. 她开口 → 消费动静

```
AniCompanion POST /v1/chat/completions
  1. 丢弃 app 自带人格 system（人格自持），检测 proactive 信号
  2. 组装：persona 人格 + [emotion] 表情协议 + 关系阶段语气
     + 未消费 agent_events + facts 记忆 + 里程碑/想念指令
  3. 代理到 BRAIN_BASE_URL（用户的 OpenAI 兼容网关），SSE 原样透传
  4. 流结束：事件标记已消费、对话落库、异步提取 facts、好感度结算
```

### 3. 好感度（完全隐藏）

行为信号（对话/回应主动开口/深夜在场/Agent 在场）→ affinity 累加 →
跨过 persona.yaml 阶段阈值（stranger→familiar→close→soulmate）→
记录 milestone → 下次开口注入告白指令 → 说出后清除。无 UI、无数值、不扣分；
≥3 天未互动注入"想念"语气。

## 关键协议

- **表情标签**：回复嵌 `[happy]` 等 16 种标签，协议对齐 AniCompanion v0.7.0 的
  `Emotion.swift`（`src/persona/promptBuilder.ts` 的 `EMOTION_TAGS`）。AniCompanion
  升级若调整标签集，需同步这里。
- **推送通道（WS 实时 + 轮询兜底）**：她的主动开口走 outbox。companion-layer
  起 `/v1/ws` WebSocket 长连（`src/realtime/hub.ts`）：有新话 <500ms 推送，
  进程内入队 ~50ms 去抖直达，500ms 定时扫描兜住 MCP 跨进程直写。AniCompanion
  先 3s 轮询 `/v1/notifications`，见响应头 `X-Companion-Realtime: 1` 即升级
  长连；断线自动回落轮询并指数退避重连（2s→30s）。协议帧带 `type` 前向兼容
  （`say` / `command`，后者为 P4 换装等指令预留）。Agent 事件本身仍是拉模式：
  事件落库后由她下次开口自然消费，即时性缺口由 `companion_notify`（macOS
  通知）补位。

## 存储

SQLite（node:sqlite，WAL）于 `data/companion.db`，双进程共享：
- HTTP 服务（`src/index.ts`）：聊天网关 + 事件入口
- MCP 进程（`bin/companion-mcp.js`）：companion_report / get_context / notify

WAL 模式保证一读一写并发安全，`busy_timeout=5000` 兜底。
