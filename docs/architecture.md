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

### 4. 附件路由（📎/拖拽，app 与 gateway 协作，2026-10-28 成型）

app 端 `ChatView.routeAttachment`（📎 与拖拽共用，重活在后台线程）六类路由：

| 类型 | 通路 |
|------|------|
| 图片 | data-URI 内嵌 → 网关按 `hasImages` 路由视觉模型（GLM-4.5V） |
| 文本/代码 | app 直接内联 `[文件 名]\n内容\n[文件结束]` 载荷 |
| 文字层 PDF | PDFKit 抽全文内联 |
| 扫描版 PDF | `PDFPage.thumbnail` 渲染前 4 页成图走视觉 OCR |
| docx/pptx/xlsx | 系统工具抽取全文内联（textutil / unzip 抽 slides XML·sharedStrings，固定参数无注入面） |
| 其他二进制 | 只发路径 → 网关失信兜底自动派 claude Read 代读；读不了如实回报 |

三个关键坑（都实测踩过）：**PDF 判定必须在 `NSImage(contentsOf:)` 之前**（macOS
的 NSImage 对 PDF 恒成功，产出单页低清栅格图吞掉文字层与文件名）；**拖拽 fileURL
优先**（`canLoadObject(NSImage)` 对 PDF provider 同样恒 true）；上下文组装时
**较早轮次的文件载荷压缩为 600 字摘要**（`ConversationHistory.contextMessages`，
全文每轮重发撑 token 且滑出窗口后她会"忘了"文件）。

UI 侧：输入区预览条（图片缩略图 + 文件卡片，可 ×）、消息气泡把载荷渲染为
附件胶囊（`MessageBubbleView.splitFilePayloads`，悬停 tooltip 预览）。

### 5. 代查管线（hybrid 二段，2026-10-27~28 成型）

聊天走 GLM 直连（她不能联网/无工具），需要外部信息时由协议转场：

```
她回复末尾带 [lookup] 查询词（LOOKUP_GUIDANCE 协议，流式感知）
  → lookupAndSay：spawn claude CLI（--tools 只读五件套 + --disallowedTools
    硬禁写类 + --strict-mcp-config 空 MCP——"她的手永远只读"）
  → 工具调用事件 onToolEvent 上抛 → 指示条实时文案（"她正在搜索：…"）
  → parseLookupResult 解析 {result, sources}（花括号平衡提取——GLM server
    工具轨迹会混进流里，取最后一个 "result": 键）
  → 结果经 outbox 主动开口 + 落 chat_history（下轮有痕）
```

两道保险：**vision 优先反例**（图片/内联文字她已直接看到，绝不转场——代查
通道收不到图）；**失信兜底** `detectUnfulfilledFileRead`（她回了"等我打开看看"
却没带标记 → 用户消息含路径 + 承诺式短转场话 + 无标记，三条件自动代派）。
代查 system 用精简指令而非聊天人格上下文（对话史会把 claude 带偏）。

### 6. 数据治理（pruneEvents）

三表滚动清理，挂 `/api/aggregate` 低频入口、进程内每日执行一次、双进程并发幂等：

- `raw_events` 留 30 天（聚合后即弃）
- `agent_events` 只删**已消费**的，留 90 天（未消费行是她的视野）
- `outbox` 只删**已投递**的，留 90 天

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
