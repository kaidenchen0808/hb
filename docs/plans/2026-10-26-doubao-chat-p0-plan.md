# 豆包化聊天 P0 实现计划(Markdown 渲染 + 流式节流 + TTS 剥离)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AniCompanion 助手消息以 Markdown 渲染(代码块+复制按钮),流式输出按 ~120ms 节流防卡,TTS 不再朗读 Markdown 符号。

**Architecture:** 新增三个纯逻辑组件(`MarkdownStripper` / `StreamThrottle` / `MarkdownView`),改动集中在 `ChatView.swift` 与 `ConversationController.swift` 的两条 pipeline(chat + notification)。关键洞察:TTS 的 `SentenceParser` 虽然被流式 feed,但其产出的消费全部发生在流结束后 —— 因此改为"流结束后对完整 rawResponse 先 strip 再一次性喂",剥离从跨 chunk 正则变为整文本一次剥。

**Tech Stack:** Swift 6(严格并发 `SWIFT_STRICT_CONCURRENCY: complete`)、SwiftUI、MarkdownUI 0.5.2(项目首个 SPM 依赖)、XCTest、xcodegen。

**Worktree:** `/Users/chenxuewei/worktrees/anicompanion-doubao-chat`(分支 `doubao-chat`,基于 `2cc9fff`)。所有文件路径均相对 worktree 根。设计文档:`/Users/chenxuewei/hb/docs/plans/2026-10-26-doubao-chat-design.md`。

**构建/测试命令**(每 Task 通用):

```bash
cd /Users/chenxuewei/worktrees/anicompanion-doubao-chat
xcodegen generate          # 改 project.yml 后必须跑
xcodebuild build -scheme AniCompanion -destination 'platform=macOS' -quiet
xcodebuild test -scheme AniCompanion -destination 'platform=macOS' -quiet
```

**注意:** 项目是深色 UI(气泡上白字),新视图配色跟随;Swift 6 严格并发下新类型必须显式标注隔离(`@MainActor` / 无隔离 enum);MarkdownUI 的 codeBlock 主题 API 若与计划代码签名不符,以库源码为准调整,构建必须过。

---

### Task 1: SPM 集成 MarkdownUI(空集成冒烟)

设计文档风险点:"首个 SPM 依赖先跑通空集成"。本任务只接依赖不写代码。

**Files:**
- Modify: `project.yml`(顶层加 `packages:`;AniCompanion target 的 `dependencies:` 追加 package 项)

**Step 1: 编辑 project.yml**

顶层(第 13 行 `settings:` 之前)插入:

```yaml
packages:
  MarkdownUI:
    url: https://github.com/gonzalezreal/swift-markdown-ui
    from: "0.5.2"
```

AniCompanion target 的 `dependencies:`(现 93-97 行,framework 项之后)追加:

```yaml
      - package: MarkdownUI
```

**Step 2: 重新生成工程并构建**

```bash
cd /Users/chenxuewei/worktrees/anicompanion-doubao-chat
xcodegen generate
xcodebuild build -scheme AniCompanion -destination 'platform=macOS' -quiet
```

Expected: SPM resolve 成功拉取 MarkdownUI(swift-cmark 一并),BUILD SUCCEEDED。若 resolve 卡住(网络),终端需代理:`export https_proxy=http://127.0.0.1:7897`。

**Step 3: Commit**

```bash
git add project.yml AniCompanion.xcodeproj
git commit -m "chore: add MarkdownUI SPM dependency (first SPM package)"
```

---

### Task 2: MarkdownStripper(TDD)

**Files:**
- Create: `AniCompanion/Models/MarkdownStripper.swift`
- Test: `AniCompanionTests/MarkdownStripperTests.swift`

**Step 1: 写失败测试**

```swift
import XCTest
@testable import AniCompanion

final class MarkdownStripperTests: XCTestCase {

    func test_fencedCodeBlock_becomesSpokenPlaceholder() {
        let input = "看这段：\n```swift\nprint(1)\nlet x = 2\n```\n就这样"
        XCTAssertTrue(MarkdownStripper.strip(input).contains("看这段"))
        XCTAssertFalse(MarkdownStripper.strip(input).contains("print"))
        XCTAssertTrue(MarkdownStripper.strip(input).contains("代码"))
    }

    func test_unclosedFence_dropped() {
        let input = "我来写：\n```python\ndef a(): pass"   // 流式中断的半截围栏
        let out = MarkdownStripper.strip(input)
        XCTAssertFalse(out.contains("def"))
        XCTAssertTrue(out.contains("我来写"))
    }

    func test_inlineCode_unwrapped() {
        XCTAssertEqual(MarkdownStripper.strip("用 `npm test` 跑"), "用 npm test 跑")
    }

    func test_boldItalicStrikethrough_unmarked() {
        XCTAssertEqual(MarkdownStripper.strip("**重要**的话"), "重要的话")
        XCTAssertEqual(MarkdownStripper.strip("*斜体*和__下划线__"), "斜体和下划线")
        XCTAssertEqual(MarkdownStripper.strip("~~删掉~~保留"), "删掉保留")
    }

    func test_headingsAndQuotes_prefixRemoved() {
        XCTAssertEqual(MarkdownStripper.strip("## 标题"), "标题")
        XCTAssertEqual(MarkdownStripper.strip("### 三级"), "三级")
        XCTAssertEqual(MarkdownStripper.strip("> 引用的话"), "引用的话")
    }

    func test_links_keepTextOnly() {
        XCTAssertEqual(MarkdownStripper.strip("见[文档](https://x.com/y)说明"), "见文档说明")
    }

    func test_images_keepAlt() {
        XCTAssertEqual(MarkdownStripper.strip("图![截图](https://a.com/b.png)结束"), "图截图结束")
    }

    func test_listMarkers_removed() {
        XCTAssertEqual(MarkdownStripper.strip("- 第一项"), "第一项")
        XCTAssertEqual(MarkdownStripper.strip("* 第二"), "第二")
        XCTAssertEqual(MarkdownStripper.strip("3. 第三"), "第三")
    }

    func test_table_separatorsDropped_cellsJoined() {
        let input = "| 命令 | 作用 |\n|---|---|\n| `ls` | 列目录 |"
        let out = MarkdownStripper.strip(input)
        XCTAssertFalse(out.contains("---"))
        XCTAssertFalse(out.contains("|"))
        XCTAssertTrue(out.contains("命令"))
        XCTAssertTrue(out.contains("ls"))
        XCTAssertTrue(out.contains("列目录"))
    }

    func test_emotionTags_preserved() {
        XCTAssertEqual(MarkdownStripper.strip("[happy] 你好呀"), "[happy] 你好呀")
    }

    func test_realWorldMix() {
        let input = """
        [happy] 好哦主人！步骤如下：
        1. 打开 `Terminal`
        2. 运行 **pnpm test**
        
        详情看[文档](https://example.com)，代码是：
        ```bash
        pnpm install
        ```
        """
        let out = MarkdownStripper.strip(input)
        XCTAssertTrue(out.hasPrefix("[happy]"))
        XCTAssertTrue(out.contains("打开 Terminal"))
        XCTAssertTrue(out.contains("pnpm test"))
        XCTAssertFalse(out.contains("**"))
        XCTAssertFalse(out.contains("文档](https"))
        XCTAssertFalse(out.contains("pnpm install"))
    }

    func test_excessBlankLines_collapsed() {
        XCTAssertEqual(MarkdownStripper.strip("a\n\n\n\nb"), "a\n\nb")
    }
}
```

**Step 2: 跑测试确认失败**

```bash
xcodegen generate && xcodebuild test -scheme AniCompanion -destination 'platform=macOS' -quiet
```

Expected: 编译失败 `cannot find 'MarkdownStripper' in scope`。

**Step 3: 实现**

```swift
import Foundation

/// Strips Markdown syntax so TTS reads natural spoken text.
/// Emotion tags ([happy] …) are NOT touched — SentenceParser extracts them downstream.
enum MarkdownStripper {

    static func strip(_ text: String) -> String {
        var s = text
        // Fenced code blocks (closed) → short spoken placeholder; keep language-free.
        s = s.replacingOccurrences(of: #"(?s)```[^\n`]*\n.*?```"#, with: "\n（代码）\n", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?s)~~~[^\n]*\n.*?~~~"#, with: "\n（代码）\n", options: .regularExpression)
        // Unclosed fence (stream cut mid-block): drop from the fence to the end.
        s = s.replacingOccurrences(of: #"(?s)```[^\n]*\n?.*\z"#, with: "", options: .regularExpression)

        // Images → alt text; links → link text (must run BEFORE generic bracket rules).
        s = s.replacingOccurrences(of: #"!\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)

        // Emphasis / strikethrough markers.
        s = s.replacingOccurrences(of: #"\*\*([^*\n]+)\*\*"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"__([^_\n]+)__"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?<!\*)\*([^*\n]+)\*(?!\*)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?<!_)_([^_\n]+)_(?!_)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"~~([^~\n]+)~~"#, with: "$1", options: .regularExpression)

        // Inline code (after emphasis so `**` inside backticks is already gone).
        s = s.replacingOccurrences(of: #"`([^`\n]+)`"#, with: "$1", options: .regularExpression)

        // Tables: drop separator rows, then join cells with a spoken comma.
        s = s.replacingOccurrences(of: #"^\s*\|?[\s:\-|]+\|?\s*$"#, with: "", options: [.regularExpression, .anchorsMatchLines])
        s = s.replacingOccurrences(of: #"\s*\|\s*"#, with: "，", options: .regularExpression)

        // Line prefixes: headings, blockquotes, list bullets, ordered markers, task boxes.
        s = s.replacingOccurrences(of: #"^\s{0,3}#{1,6}\s+"#, with: "", options: [.regularExpression, .anchorsMatchLines])
        s = s.replacingOccurrences(of: #"^\s{0,3}>\s?"#, with: "", options: [.regularExpression, .anchorsMatchLines])
        s = s.replacingOccurrences(of: #"^\s*[-*+]\s+"#, with: "", options: [.regularExpression, .anchorsMatchLines])
        s = s.replacingOccurrences(of: #"^\s*\d+[.、)]\s+"#, with: "", options: [.regularExpression, .anchorsMatchLines])
        s = s.replacingOccurrences(of: #"^\s*\[[ xX]\]\s+"#, with: "", options: [.regularExpression, .anchorsMatchLines])

        // Horizontal rules and blank-line runs.
        s = s.replacingOccurrences(of: #"^\s{0,3}(?:[-*_]\s*){3,}$"#, with: "", options: [.regularExpression, .anchorsMatchLines])
        s = s.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
```

注意:`test_table_...` 断言 `!out.contains("|")` 要求表格替换后再无竖线 —— 上面的 `，` 连接已保证。若某正则在 macOS NSRegularExpression 下不支持 lookbehind(`(?<!\*)` 支持,NSRegularExpression 基于 ICU,支持)。

**Step 4: 跑测试确认全过**

Expected: 12 个用例 PASS。

**Step 5: Commit**

```bash
git add Anicompanion/Models/MarkdownStripper.swift AniCompanionTests/MarkdownStripperTests.swift
git commit -m "feat: MarkdownStripper — TTS 不再朗读 Markdown 符号"
```

(路径以实际为准:`AniCompanion/Models/...`,注意大小写。)

---

### Task 3: StreamThrottle(TDD)

**Files:**
- Create: `AniCompanion/Pipeline/StreamThrottle.swift`
- Test: `AniCompanionTests/StreamThrottleTests.swift`

**Step 1: 写失败测试**

```swift
import XCTest
@testable import AniCompanion

@MainActor
final class StreamThrottleTests: XCTestCase {

    func test_burstPushes_coalesceIntoTwoEmits() {
        var emissions: [String] = []
        let throttle = StreamThrottle { emissions.append($0) }
        // 10 次同步 push 远小于 120ms 节拍:第 1 次立即发射,后 9 次缓冲,
        // 测试同步跑完(不等 pending 定时器),flush 再发 1 次。
        (0..<10).forEach { _ in throttle.push("a") }
        throttle.flush()
        XCTAssertEqual(emissions.count, 2)
        XCTAssertEqual(emissions.joined(), String(repeating: "a", count: 10))
    }

    func test_flushPreservesTail() {
        var emissions: [String] = []
        let throttle = StreamThrottle { emissions.append($0) }
        throttle.push("你好")
        throttle.push("呀")
        throttle.flush()
        XCTAssertEqual(emissions.joined(), "你好呀")
    }

    func test_resetClearsState() {
        var emissions: [String] = []
        let throttle = StreamThrottle { emissions.append($0) }
        throttle.push("x")
        throttle.reset()
        throttle.flush()               // reset 后 buffer 已空,flush 是 no-op
        XCTAssertEqual(emissions, ["x"])
    }

    func test_longText_switchesToSlowInterval() {
        let throttle = StreamThrottle { _ in }
        XCTAssertEqual(throttle.currentInterval, StreamThrottle.baseInterval)
        throttle.push(String(repeating: "字", count: 4001))
        XCTAssertEqual(throttle.currentInterval, StreamThrottle.longTextInterval)
    }
}
```

**Step 2: 跑测试确认失败**

Expected: 编译失败 `cannot find 'StreamThrottle' in scope`。

**Step 3: 实现**

```swift
import Foundation

/// Coalesces high-frequency token deltas into low-frequency UI updates.
/// Purely a UI-layer concern: callers keep their own full text (rawResponse);
/// only the streamed display text flows through here. `flush()` guarantees no tail loss.
@MainActor
final class StreamThrottle {

    static let baseInterval: TimeInterval = 0.12
    static let longTextInterval: TimeInterval = 0.24
    /// Beyond this many characters, widen the interval so late-stream re-parses stay smooth.
    static let longTextThreshold = 4000

    private let onEmit: (String) -> Void
    private var buffer = ""
    private var lastEmit: Date?
    private var pending: Task<Void, Never>?
    private var totalLength = 0

    var currentInterval: TimeInterval { totalLength > Self.longTextThreshold ? Self.longTextInterval : Self.baseInterval }

    init(onEmit: @escaping (String) -> Void) {
        self.onEmit = onEmit
    }

    func push(_ delta: String) {
        guard !delta.isEmpty else { return }
        buffer += delta
        totalLength += delta.count
        if let last = lastEmit, Date().timeIntervalSince(last) < currentInterval {
            guard pending == nil else { return }
            let delay = currentInterval
            pending = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return } // cancelled → bail
                self?.pending = nil
                self?.emit()
            }
        } else {
            emit()
        }
    }

    /// Emit whatever is buffered right now — call when the stream ends or is cancelled.
    func flush() {
        pending?.cancel()
        pending = nil
        emit()
    }

    /// Reset for the next turn.
    func reset() {
        pending?.cancel()
        pending = nil
        buffer = ""
        lastEmit = nil
        totalLength = 0
    }

    private func emit() {
        guard !buffer.isEmpty else { return }
        let out = buffer
        buffer = ""
        lastEmit = Date()
        onEmit(out)
    }
}
```

**Step 4: 跑测试确认全过**

Expected: 4 个用例 PASS。

**Step 5: Commit**

```bash
git add AniCompanion/Pipeline/StreamThrottle.swift AniCompanionTests/StreamThrottleTests.swift
git commit -m "feat: StreamThrottle — 流式 token 合并为低频 UI 更新"
```

---

### Task 4: TTS 链路接入剥离(改两条 pipeline 的 parser 喂法)

先读 `AniCompanion/Pipeline/SentenceParser.swift` 确认 `feed`/`finish` 语义(是否可一次喂大文本 —— 预期 feed 只是 append 到内部 buffer,finish 后吐尽,一次喂入安全)。

**Files:**
- Modify: `AniCompanion/Pipeline/ConversationController.swift`(chat pipeline ~853-895、notification pipeline ~763-798)

**Step 1: chat pipeline 改造(runPipeline,~820 行起)**

1. `let parser = SentenceParser()`(820 行)删除 —— parser 移到流结束后构造。
2. token 循环中 `await parser.feed(chunk)`(857 行)删除(保留 `rawResponse.append` / `streamingText.append` —— 后者 Task 6 才换 throttle)。
3. 流结束、`runTTSPlayback` 调用处(890-895 行)改为:

```swift
        // TTS + playback (non-fatal, skip when TTS is disabled).
        let speakable = MarkdownStripper.strip(rawResponse)
        if ttsEnabled {
            let parser = SentenceParser()
            await parser.feed(speakable)
            await parser.finish()
            try await runTTSPlayback(parser: parser, audioQueue: audioQueue, charController: charController)
        } else if !rawResponse.isEmpty {
            // No audio to sync to — page the reply sentence-by-sentence in the pet bubble.
            pageSpeechBubble(speakable)
        }
```

**Step 2: notification pipeline 同构改造(~763-798 行)**

同样三步:删流式 feed、流结束后 strip → 新 parser 一次性喂 → `runTTSPlayback`;`pageSpeechBubble(rawResponse)` → `pageSpeechBubble(speakable)`。

**Step 3: 构建 + 全量测试**

```bash
xcodegen generate && xcodebuild build -scheme AniCompanion -destination 'platform=macOS' -quiet && xcodebuild test -scheme AniCompanion -destination 'platform=macOS' -quiet
```

Expected: BUILD SUCCEEDED,既有测试 + Task 2/3 测试全 PASS。若 SentenceParser.feed 一次喂大文本有异常行为(如内部按 chunk 假设),改为按 512 字符分段循环 feed。

**Step 4: Commit**

```bash
git add AniCompanion/Pipeline/ConversationController.swift
git commit -m "refactor: TTS 分句改为流结束后整体剥离 Markdown 再喂 SentenceParser"
```

---

### Task 5: MarkdownView 组件(含代码块复制按钮)

**Files:**
- Create: `AniCompanion/Views/MarkdownView.swift`

**Step 1: 实现**

```swift
import SwiftUI
import MarkdownUI

/// Renders assistant chat content as Markdown, themed for the dark chat bubbles.
struct MarkdownView: View {

    let text: String
    var textSelectionEnabled: Bool = true

    var body: some View {
        Markdown(text)
            .markdownTheme(.aniCompanion)
            .textSelection(textSelectionEnabled ? .enabled : .disabled)
    }
}

// MARK: - Theme

extension Theme {
    static let aniCompanion: Theme = Theme()
        .text {
            FontSize(14)
            ForegroundColor(.white)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(12.5)
            ForegroundColor(.white.opacity(0.92))
        }
        .codeBlock { block in
            block.label = { code, _ in CodeBlockView(code: code) }
        }
        .listItem { item in
            item.paragraphSpacing(4)
        }
}

// MARK: - Code block with copy button

/// Dark code block with a monospaced scroll view and a copy button (Doubao-style).
struct CodeBlockView: View {

    let code: String
    @State private var copied = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.92))
                    .textSelection(.enabled)
                    .padding(12)
            }
            .padding(.trailing, 36)

            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                copied = true
                Task {
                    try? await Task.sleep(nanoseconds: 1_200_000_000)
                    copied = false
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(copied ? 0.95 : 0.55))
                    .padding(6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(copied ? "已复制" : "复制代码")
            .padding(6)
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.45)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.1), lineWidth: 1))
    }
}
```

**Step 2: 构建**

Expected: BUILD SUCCEEDED。⚠️ MarkdownUI 0.5.x 的 `.codeBlock`/`.text`/`.code` 主题 API 签名若与此不符(如 `block.label` 不可写),打开 `.build/checkouts/swift-markdown-ui/Source/MarkdownUI/Theme` 对照实际 API 调整 —— 语义不变:正文 14pt 白字、代码块深色圆角+复制按钮。

**Step 3: Commit**

```bash
git add AniCompanion/Views/MarkdownView.swift
git commit -m "feat: MarkdownView — 深色主题 Markdown 渲染 + 代码块复制按钮"
```

---

### Task 6: ChatView 与 ConversationController 接入

**Files:**
- Modify: `AniCompanion/Views/ChatView.swift`(MessageBubbleView ~218、AssistantProcessingView ~304)
- Modify: `AniCompanion/Pipeline/ConversationController.swift`(streamingText 三处 append / 三处清空)

**Step 1: MessageBubbleView 助手气泡换 MarkdownView**(218 行)

```swift
                if isUser {
                    Text(message.displayContent)
                        .font(.system(size: 14))
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 16)
                                .fill(Color.blue.opacity(0.6))
                        )
                } else {
                    MarkdownView(text: message.displayContent)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 16)
                                .fill(Color.white.opacity(0.1))
                        )
                }
```

**Step 2: AssistantProcessingView 流式文本换 MarkdownView**(304 行)

`Text(cleanedText)...` 整块替换为:

```swift
                MarkdownView(text: cleanedText, textSelectionEnabled: false)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 16)
                            .fill(Color.white.opacity(0.1))
                    )
```

**Step 3: ConversationController 接 StreamThrottle**

1. 存储属性(与 `streamingText` 声明相邻处):

```swift
    /// UI-only: coalesces token deltas so Markdown re-parses stay smooth mid-stream.
    private lazy var streamThrottle = StreamThrottle { [weak self] delta in
        self?.streamingText += delta
    }
```

2. 两条 pipeline 的 run 开始处(`isStreaming = true` 附近)加 `streamThrottle.reset()`。
3. token 循环两处 `streamingText.append(chunk)` → `streamThrottle.push(chunk)`。
4. 所有 `streamingText = ""` 之前(共三处:notification 789、chat 878 suppress、chat 886)加 `streamThrottle.flush()`;CancellationError 的 catch 分支同样加 flush(在 throw 之前,半截话立即上屏 —— 数据正确性由 rawResponse 保证,UI 不丢尾)。

**Step 4: 构建 + 全量测试**

Expected: BUILD SUCCEEDED,全部测试 PASS。

**Step 5: Commit**

```bash
git add AniCompanion/Views/ChatView.swift AniCompanion/Pipeline/ConversationController.swift
git commit -m "feat: 聊天界面接入 Markdown 渲染与流式节流"
```

---

### Task 7: 回归与手测清单

**Step 1: 全量测试 + 构建干净**

```bash
xcodebuild test -scheme AniCompanion -destination 'platform=macOS' -quiet
git status --short   # 应干净
```

**Step 2: 真机手测清单**(需要产品主人参与;service 拉起:`bash /Users/chenxuewei/hb/scripts/check.sh`)

- [ ] 让她写一段含代码块的回复(如"教我写一个 swift hello world")→ 气泡内代码块深色渲染 + 右上角复制按钮可用,复制内容正确
- [ ] 流式期间打字机顺滑、无每-token 卡顿;长回复(>4000 字)末期不掉帧
- [ ] 流结束瞬间消息无跳变(节流 flush 后与最终渲染一致)
- [ ] TTS 开启时,同样回复**不朗读**"井号/星号/反引号",代码块念作"代码"
- [ ] TTS 关闭时气泡分句翻页同样无 Markdown 符号
- [ ] 情绪标签(`[happy]`)不显示在气泡中,表情仍正常切换
- [ ] 用户消息仍是纯文本蓝泡,行为不变
- [ ] 语音输入链路(STT → sendMessage)不受影响

**Step 3: 收尾**

手测通过后:worktree 分支 `doubao-chat` 留待合并(或产品主人直接 merge 到 `v0.7.0-notifications` 后跑 `make-release` 流程,不在本计划范围)。

---

## 明确不做(P0 范围外)

- 语法高亮(Highlightr)—— 后续增强
- 停止/重生成/复制消息(P1)、历史持久化(P2)、多行输入框与光标动画(P3)
- companion-layer 任何改动(好感度去重是 P1 的事)
