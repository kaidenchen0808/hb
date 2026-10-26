# 豆包化聊天 P2 实现计划（历史持久化 JSONL）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 聊天历史持久化——重启不丢对话。JSONL 单一连续历史（无多会话），启动灌末尾 200 条 + 上翻加载，按天分组分隔线，可清空/单条删除。显示历史 ≠ 上下文（上下文仍 `maxContextMessages = 40`，token 成本不变）。

**Architecture:** 新增 `Models/HistoryStore.swift`（纯逻辑，TDD）；`ConversationHistory` 构造注入可选 HistoryStore，`add*`/`removeLastMessage`/`clear` 自动同步落盘——**所有写入点零改动自动覆盖**（sendMessage、流结束、P1 取消路径、通知 pipeline、proactive hidden 指令）。UI 侧 `ChatView` 按天分组 + 顶部翻页；`SettingsView` 清空入口。app JSONL 与 companion-layer chat_history（她的记忆）互不读，跨端不追求一致。

**关键事实（已侦查）：**
- `ChatMessage` 已 `Codable`（id/role/content/timestamp/isHidden 全可编码）。
- `ConversationHistory.contextMessages` 已是"末尾 40 条"窗口——messages 可无限增长作显示列表，无需拆分。
- `AppState.swift:235` 实例化 `ConversationHistory()`——启动灌载点。
- hidden 消息（proactive 指令）落 JSONL（保持上下文行为与内存一致；显示层已过滤）。

**Workspace:** `/Users/chenxuewei/hb/anicompanion`（分支 `v0.7.0-notifications`）。

---

### Task 1: HistoryStore（TDD）

**Files:**
- Create: `AniCompanion/Models/HistoryStore.swift`
- Test: `AniCompanionTests/HistoryStoreTests.swift`

**Step 1: 失败测试**（注入临时目录，测真文件 IO）

```swift
import XCTest
@testable import AniCompanion

@MainActor
final class HistoryStoreTests: XCTestCase {

    private var dir: URL!

    override func setUp() {
        super.setUp()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("history-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    private func msg(_ role: ChatMessage.Role, _ content: String, at date: Date? = nil) -> ChatMessage {
        ChatMessage(role: role, content: content, timestamp: date ?? Date(timeIntervalSince1970: 1_700_000_000))
    }

    func test_append_thenLoadLast_roundTrip() {
        let store = HistoryStore(fileURL: dir.appendingPathComponent("history.jsonl"))
        (0..<250).forEach { store.append(msg(.user, "m\($0)")) }
        XCTAssertEqual(store.loadLast(200).count, 200)
        XCTAssertEqual(store.loadLast(200).last?.content, "m249")
        XCTAssertEqual(store.loadLast(200).first?.content, "m50")   // 末尾 200 条 = m50..m249
    }

    func test_emptyOrMissingFile_returnsEmpty() {
        let store = HistoryStore(fileURL: dir.appendingPathComponent("history.jsonl"))
        XCTAssertEqual(store.loadLast(50), [])
    }

    func test_corruptLine_skippedNotFatal() {
        let url = dir.appendingPathComponent("history.jsonl"))
        // 第一行损坏、第二行完好
        try! "not-json\n".write(to: url, atomically: true, encoding: .utf8)
        let store = HistoryStore(fileURL: url)
        store.append(msg(.assistant, "好的"))
        XCTAssertEqual(store.loadLast(10).count, 1)
    }

    func test_removeLast() {
        let store = HistoryStore(fileURL: dir.appendingPathComponent("history.jsonl"))
        store.append(msg(.user, "a")); store.append(msg(.assistant, "b"))
        XCTAssertTrue(store.removeLast())
        XCTAssertEqual(store.loadLast(10).map(\.content), ["a"])
        XCTAssertFalse(store.removeLast())   // 再删一条（顺便验证可删空）
    }

    func test_removeById_rewritesFile() {
        let store = HistoryStore(fileURL: dir.appendingPathComponent("history.jsonl"))
        let keep = msg(.user, "keep"); let drop = msg(.assistant, "drop")
        store.append(keep); store.append(drop)
        XCTAssertTrue(store.remove(id: drop.id))
        XCTAssertEqual(store.loadLast(10).map(\.id), [keep.id])
        XCTAssertFalse(store.remove(id: drop.id))   // 已不存在
    }

    func test_clear_removesFile() {
        let url = dir.appendingPathComponent("history.jsonl")
        let store = HistoryStore(fileURL: url)
        store.append(msg(.user, "x"))
        store.clear()
        XCTAssertEqual(store.loadLast(10), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func test_loadBefore_olderThanAnchor() {
        let store = HistoryStore(fileURL: dir.appendingPathComponent("history.jsonl"))
        (0..<300).forEach { store.append(msg(.user, "m\($0)")) }
        let loaded = store.loadLast(100)                       // m200..m299
        let older = store.loadBefore(loaded.first!.id, limit: 50) // m150..m199
        XCTAssertEqual(older.count, 50)
        XCTAssertEqual(older.last?.content, "m199")
    }
}
```

**Step 2: 实现**（~130 行，主线程串行使用——ConversationHistory 是 @MainActor，无并发写）

- `loadLast(_ n:)`: 行数 ≤ n 时全读；否则流式只留末尾 n（避免大文件全载：按块从文件尾读，简化实现可先全读行再取suffix——文件量级每天几百行，全读可接受，注释说明）。
- `loadBefore(_ id: UUID, limit:)`: 找 id 所在行下标，取其前 limit 条。
- `append`: 单行 JSONEncoder + `\n` 追加（FileHandle seekToEnd；文件不存在先创建）。
- `removeLast`: 读全→丢末行→重写。
- `remove(id:)`: 读全→过滤→重写；返回是否删到。
- `clear`: 删文件。
- 损坏行（解码失败）跳过不致命。

**Step 3: xcodegen generate + 测试全过 → Commit** `feat: HistoryStore — JSONL 历史持久化存储`

---

### Task 2: ConversationHistory 自动落盘 + 启动灌载

**Files:**
- Modify: `AniCompanion/Models/ConversationHistory.swift`
- Modify: `AniCompanion/App/AppState.swift`（235 行附近）

**Step 1: ConversationHistory 注入 HistoryStore**

```swift
    /// Optional persistence sink — when present, every mutation is mirrored to JSONL.
    private let store: HistoryStore?

    init(maxContextMessages: Int = 40, store: HistoryStore? = nil) {
        self.maxContextMessages = maxContextMessages
        self.store = store
    }

    /// Reload display history from disk (call once at startup, before any mutation).
    func restoreFromStore(limit: Int = 200) {
        guard let store else { return }
        messages = store.loadLast(limit)
    }
```

- `addMessage`: `messages.append` + `store?.append(message)`
- `removeLastMessage`: `store?.removeLast()` + `messages.removeLast()`（对齐 P1 regenerate：删末条 assistant 重发——磁盘同步删）
- `clear`: `store?.clear()` + `messages.removeAll()`

**Step 2: AppState 启动接线**

```swift
        let historyStore = HistoryStore()   // 默认路径 ~/Library/Application Support/AniCompanion/history.jsonl
        self.conversationHistory = ConversationHistory(store: historyStore)
        conversationHistory.restoreFromStore(limit: 200)
```

HistoryStore 默认 init 用 `Application Support/AniCompanion/`（目录不存在则创建——与 VRMModelStore 同目录约定）。

**Step 3: 构建 + 全量测试 → Commit** `feat: 聊天历史落盘 — 重启恢复末尾 200 条`

---

### Task 3: 按天分组 + 顶部翻页

**Files:**
- Modify: `AniCompanion/Views/ChatView.swift`

**Step 1: 日期分隔线**

`ChatMessage` 便捷计算（放 ChatView 私有 extension）：`dayIdentifier`（`Calendar.current.startOfDay`）与 `dayLabel`（今天/昨天/`M 月 d 日`——随 AppLanguage 走 `DateFormatter`，今天/昨天用 `RelativeDateTimeFormatter` 或手动判断，UI 英文则 "Today"/"Yesterday"）。ForEach 改为：迭代时若当前消息的 day 与前一条不同，插 `daySeparatorView(label)`。

**Step 2: 顶部翻页**

- `@State private var historyPageSize = 200`（初始 restore 量）。
- LazyVStack 顶部 sentinel `Color.clear.frame(height: 1).onAppear { loadOlder() }`——滚到顶自动触发。
- `loadOlder()`: `store.loadBefore(最老已载消息.id, limit: 100)` → `conversationHistory.prepend(messages)`（需给 ConversationHistory 加 `func prepend(_ older: [ChatMessage])`——**只动内存显示，不落盘**）。
- 注意 prepend 后滚动位置跳变：LazyVStack 顶部插入会保持 anchor 在同 id？macOS SwiftUI 不保证。缓解：prepend 后用 ScrollViewReader scrollTo 原顶部消息 id（anchor: .top）。若体验仍跳，降级为顶部"Load earlier messages"按钮（手动点击）。**先做自动，手测跳变则降级**。
- ConversationHistory 需要 expose `loadOlder` 所需信息：最老消息 id（messages.first）与 prepend。store 引用 AppState 持有 → ChatView 通过 conversationHistory 访问（把 store 引用也放 ConversationHistory，prepend 语义内聚：`conversationHistory.loadOlder(store:limit:)` 返回 Bool 是否还有）。

**Step 3: 构建 + 全量测试 → Commit** `feat: 聊天历史按天分组 + 顶部翻页加载`

---

### Task 4: 清空聊天记录 + 单条删除

**Files:**
- Modify: `AniCompanion/Views/SettingsView.swift`（或 Settings 主面板合适分区）
- Modify: `AniCompanion/Views/ChatView.swift`（contextMenu 加删除）

**Step 1: Settings 加"Clear Chat History"**

- Section 放 Language 附近或独立 Chat 节；按钮红色字，点击弹 `.confirmationDialog`（二次确认："删除全部聊天记录？她的记忆（服务端）不受影响。"）→ `conversationHistory.clear()`（自动删文件）。
- SettingsView 拿 conversationHistory 引用（查现有注入方式——EnvironmentObject 或 AppState 传递）。

**Step 2: contextMenu 单条删除**

- MessageBubbleView contextMenu 追加 `Button(role: .destructive) { onDelete?() }`；ChatView 调 `conversationHistory.removeById(message.id)`（新增方法：`store?.remove(id:)` + `messages.removeAll { $0.id == id }`）。

**Step 3: 构建 + 全量测试 → Commit** `feat: 清空聊天记录（二次确认）+ 单条删除`

---

### Task 5: 回归 + 装机 + 手测清单

**Step 1:** 全量测试 + git status 干净。
**Step 2:** Release 构建替换 /Applications/AniCompanion.app 并拉起（companion-layer 无改动，不重打包）。
**Step 3: 手测清单（产品主人）**
- [ ] 聊几句 → 退出重开 app → 历史在（含代码块消息渲染正常），按天分隔线正确（今天）
- [ ] 发新消息后上下文仍连续（她记得重启前的对话——40 条窗口内）
- [ ] 制造 >200 条历史（或临时调小 restore 上限）→ 顶部滚动自动加载更早
- [ ] 右键删除单条生效且重启后确实没了
- [ ] 设置清空 → 二次确认 → 列表空、重启仍空
- [ ] 静隐模式下 proactive 指令不显示（hidden 消息过滤如常）

## 明确不做（P2 范围外）
- 多会话/搜索/导出（设计已拒多会话；搜索导出未排期）
- P3 输入框多行化（下一期）
