# 豆包化聊天 P1 实现计划（停止 / 重新生成 / 复制 + 好感度去重）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 聊天界面补齐消息操作三件套——流式时发送按钮变停止（半截话保留入历史）、最后一条助手消息可重新生成（后端好感度短窗去重）、任意消息可复制；对标豆包体验。

**Architecture:** anicompanion 侧集中在 `ConversationController.swift`（取消路径入历史、`regenerate()`、与 sendMessage 共用 task 启动）和 `ChatView.swift`（发送按钮双态、hover 操作条 + contextMenu）；companion-layer 仅 `gateway.ts` 一处（settleChatTurn 前对相同 lastUser 短窗去重，~15 行）。设计文档:`docs/plans/2026-10-26-doubao-chat-design.md` P1 节。

**Tech Stack:** Swift 6 严格并发 / SwiftUI / vitest（companion-layer）。

**Workspace:** 直接在 `/Users/chenxuewei/hb/anicompanion`（分支 `v0.7.0-notifications`，已含 P0）开发；companion-layer 在 `/Users/chenxuewei/hb`（main）。

**构建命令：**

```bash
# anicompanion（新增 .swift 后必须 xcodegen generate）
cd /Users/chenxuewei/hb/anicompanion && xcodegen generate && \
  xcodebuild test -scheme AniCompanion -destination 'platform=macOS' -quiet
# companion-layer
cd /Users/chenxuewei/hb && pnpm test
```

**关键侦查结论（2026-10-26）：**
- `ConversationController.cancel()` 已存在（489 行）= cancelInternal + 清 lastError，停止按钮可直接用。
- **取消路径半截话不入历史**：`addAssistantMessage(rawResponse)` 在 token 循环之后，CancellationError 从 `try Task.checkCancellation()` 抛出会跳过它——这是 P1 要修的行为。
- `ConversationHistory.removeLastMessage()` 已有；`sendMessage` 的 generation/task/cleanup 模式可与 regenerate 共用。
- `displayContent`（剥情绪标签）即复制内容，直接用。
- gateway.ts：`settleAfterChat` 在 `finally` 里调 `settleChatTurn(db, {userRepliedToProactive, now})`；好感度每次 chatTurn 都加，重生成会重复结算——需去重。
- 后端断连兼容已确认（设计文档）：客户端停止后已生成部分照常结算，半截话在她的记忆里完整，零改动。

---

### Task 1: 停止生成 — 取消路径半截话入历史

**Files:**
- Modify: `AniCompanion/Pipeline/ConversationController.swift`（两条 pipeline 的 token 循环）

**Step 1: chat pipeline token 循环包 do-catch**

`runPipeline` 的 token 循环（~845 行 `for try await chunk in tokenStream`）包进：

```swift
        var response = ""
        do {
            for try await chunk in tokenStream {
                try Task.checkCancellation()
                response.append(chunk)
                streamThrottle.push(chunk)
                await Task.yield()
            }
        } catch is CancellationError {
            // 停止生成：半截话保留入历史（豆包同款），再向上抛给外层 catch flush 上屏。
            if !response.isEmpty { history.addAssistantMessage(response) }
            throw CancellationError()
        }
```

（`throw CancellationError()` 而非 `rethrow` 原 error：二者等价，均为 CancellationError。）

**Step 2: notification pipeline 同构改造**（~764 行 token 循环，同样三步）。

**Step 3: 构建 + 全量测试**

**Step 4: Commit** `feat: 停止生成后半截话保留入历史`

---

### Task 2: regenerate() + 与 sendMessage 共用 task 启动

**Files:**
- Modify: `AniCompanion/Pipeline/ConversationController.swift`

**Step 1: 抽公用启动方法**

把 `sendMessage` 里 generation 递增、task 创建、processingTask 赋值段抽成私有方法：

```swift
    /// Launch the chat pipeline task (shared by sendMessage and regenerate) with
    /// generation-based cleanup. Caller is responsible for history mutation first.
    private func startChatPipeline() async {
        cancelInternal()
        pipelineGeneration &+= 1
        let generation = pipelineGeneration
        lastError = nil
        isProcessing = true

        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.runPipeline()
            } catch is CancellationError {
                // Cancellation is expected; no error to report.
                // Flush the coalesced tail so the half-reply stays on screen (as before throttling).
                self.streamThrottle.flush()
            } catch {
                self.lastError = error
            }
            self.cleanupPipeline(generation: generation)
        }
        processingTask = task
        _ = await task.value
    }
```

`sendMessage` 改为：guard 非空 → `history.addUserMessage` → `await startChatPipeline()`。

**Step 2: 公开 regenerate()**

```swift
    /// Regenerate the last assistant reply: drop it and re-run the pipeline against
    /// the same context (the trailing user message stays — no duplicate append).
    /// 好感度去重由 companion-layer 网关处理（相同 lastUser 短窗跳过结算）。
    func regenerate() async {
        guard !isProcessing, !isStreaming else { return }
        guard history.messages.last?.role == .assistant else { return }
        history.removeLastMessage()
        await startChatPipeline()
    }
```

**Step 3: 构建 + 全量测试 → Commit** `feat: regenerate — 删末条助手消息携同上下文重发`

---

### Task 3: 发送按钮双态（发送 / 停止）

**Files:**
- Modify: `AniCompanion/Views/ChatView.swift`（Send button ~127 行）

**Step 1: 双态按钮**

```swift
                // Send / Stop button
                if conversationController.isStreaming {
                    Button {
                        conversationController.cancel()
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 24))
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    .buttonStyle(.plain)
                    .help("停止生成")
                    .transition(.scale.combined(with: .opacity))
                } else {
                    Button {
                        sendMessage()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 24))
                            .foregroundStyle(canSend ? .blue : .secondary.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .help("Send message")
                    .transition(.scale.combined(with: .opacity))
                }
```

（`isStreaming` 置 false 时消息气泡已就绪——P0 的 flush 保证无跳变。）

**Step 2: 构建 → Commit** `feat: 流式时发送按钮变停止`

---

### Task 4: 消息操作 — hover 操作条 + contextMenu（复制 / 重新生成）

**Files:**
- Modify: `AniCompanion/Views/ChatView.swift`（MessageBubbleView）

**Step 1: MessageBubbleView 加 hover 态与操作条**

- `@State private var hovering = false`，气泡 `.onHover { hovering = $0 }`。
- 助手消息 hover 时，气泡下方（timestamp 行右侧）浮现小操作条：`doc.on.doc`（复制）+ `arrow.clockwise`（重生成，仅当"是最后一条消息"）。
- `isLastAssistant` 由外部传入（ChatView 消息 ForEach 里 `message.id == messages.last?.id && role == .assistant` 计算），控制重生成按钮显隐。
- 复制动作：

```swift
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.displayContent, forType: .string)
```

- 重生成动作：`Task { await conversationController.regenerate() }`（MessageBubbleView 需要拿 controller——通过参数传闭包 `onRegenerate: () -> Void`，保持视图无 controller 依赖）。

**Step 2: contextMenu 兜底**

气泡 `.contextMenu { Button("复制") …; if isLastAssistant { Button("重新生成") … } }`。

**Step 3: 构建 + 全量测试 → Commit** `feat: 消息操作 — hover 复制/重生成 + 右键菜单`

---

### Task 5: companion-layer 好感度去重（重生成防重复结算）

**Files:**
- Modify: `src/http/gateway.ts`（settleAfterChat）
- Test: `tests/gateway.test.ts`（补用例）

**Step 1: 实现**

settleAfterChat 内、`settleChatTurn` 调用处加短窗去重（模块级 Map，进程内存即可，重启丢失可接受）：

```ts
/** 重生成防重复结算：相同 lastUser 在窗口内只结算一次好感度（落库照常，记忆完整保留）。 */
const REGEN_SETTLE_WINDOW_MS = 3 * 60_000
const recentSettles = new Map<string, number>()

// settleAfterChat 内，替换原 settleChatTurn 段：
const settleKey = input.lastUser ?? ''
const lastSettle = recentSettles.get(settleKey)
const isDuplicate = settleKey !== '' && lastSettle !== undefined &&
  input.now.getTime() - lastSettle < REGEN_SETTLE_WINDOW_MS
if (!isDuplicate) {
  const before = getRelationship(db).affinity
  settleChatTurn(db, { userRepliedToProactive: input.userRepliedToProactive, now: input.now })
  const after = getRelationship(db).affinity
  const transition = checkStageTransition(db, persona, before, after)
  if (transition !== null) { console.log(...) }
  recentSettles.set(settleKey, input.now.getTime())
}
// Map 无限增长防护：>200 条时清掉最旧一半
```

**Step 2: 测试**（tests/gateway.test.ts 补两个用例）
- 相同 lastUser 短窗内第二次请求 → 好感度只加一次（对比两次后 relationship）。
- 不同 lastUser → 正常各加一次。

**Step 3: `pnpm test` + `pnpm run typecheck` → Commit** `feat: 网关好感度去重 — 重生成不重复结算`

---

### Task 6: 回归 + 构建安装 + 手测清单

**Step 1:** anicompanion 全量测试 + companion-layer `pnpm test` 全绿；两端 git status 干净。

**Step 2:** Release 构建替换 `/Applications/AniCompanion.app`（退出旧实例 → ditto → open），companion-layer 服务跑 dev 版（`pnpm dev`）或重启 launchd 实例使 gateway 改动生效。

**Step 3: 手测清单（产品主人）**
- [ ] 流式中发送按钮变红色停止方块（样式以实现为准），点击后停止；半截话留在聊天列表
- [ ] 最后一条助手消息 hover 出现复制/重生成按钮；重生成后新回复流式出现，旧消息消失，用户消息不重复
- [ ] 重生成一次后好感度只结算一次（可通过 sqlite3 查 relationship 表验证前后差值）
- [ ] 复制粘贴出的内容无 `[happy]` 标签、Markdown 符号保留
- [ ] 右键菜单同功能可用；流式期间重生成按钮不出现
- [ ] 停止后立即再发新消息正常（无状态残留）

## 明确不做（P1 范围外）
- 历史持久化（P2）、输入框多行化与光标动画（P3）
- 通知 pipeline（右下角主动开口）的重生成——只针对聊天窗口的 user 轮
