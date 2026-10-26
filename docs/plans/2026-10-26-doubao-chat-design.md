# 设计:聊天界面豆包化(Markdown 渲染 / 消息操作 / 历史持久化)

- 日期:2026-10-26
- 状态:设计已确认(brainstorm 逐段过审),待实现
- 范围:渲染端 `anicompanion/` 为主;companion-layer 仅一处可选小改(好感度去重,~10 行)

## 背景与目标

用户想把 AniCompanion 窗口里的对话输入框改造为"AI SSE 对话,对标豆包聊天"。调研后发现 **SSE 流式对话已经存在**(`HTTPChatService.swift:394` 用 `URLSession.bytes` 消费 companion-layer `/v1/chat/completions` 的 SSE,逐 token 渲染进 `streamingText`),真正的差距在体验层:

| 豆包体验 | 现状 |
|---|---|
| SSE 流式输出 | ✅ 已有 |
| 气泡列表+输入框 | ✅ 已有,但输入框是单行 `TextField` |
| Markdown 渲染(代码块/表格/复制) | ❌ 纯 `Text`,零渲染 |
| 消息操作(停止/重生成/复制) | ❌ 无 |
| 历史持久化 | ❌ 内存态,退出即丢 |
| TTS 播报 | ✅ 已有且强于豆包(本体能力) |

目标:把已有的流式管线包装成豆包级聊天体验。**TTS 必须与 Markdown 联动改造**——否则渲染越好看、语音越滑稽(现状 `SentenceParser` 会把 `##`、`**`、代码块原样读出)。

## 现状调研结论

- 聊天 UI 在 `AniCompanion/Views/ChatView.swift`:气泡列表(`MessageBubbleView`)+ 内联单行输入栏;流式期间 `AssistantProcessingView` 实时显示
- 链路:`ChatView.sendMessage` → `Pipeline/ConversationController.swift:229` → `runPipeline`(804)→ `HTTPChatService.streamChat`(394)SSE → token 级 `streamingText.append`,流结束才写入 `ConversationHistory`(纯内存,滑动窗口 `maxContextMessages = 40`)
- 情绪标签协议:回复含 `[happy]` 等 16 种标签,`ChatMessage.displayContent` 已有剥离正则
- app 端无 SQLite/SwiftData/CoreData(全库 grep 零命中);companion-layer 侧有 `chat_history` 表(她的记忆视角,无会话概念)
- companion-layer 网关(`src/http/gateway.ts`):人格注入、SSE 透传、流后 `finally` 结算(落库/好感度/facts 提取)。**客户端断连时已生成部分仍会结算**——停止生成的半截话在她的记忆里是完整的
- anicompanion 至今零 SPM 依赖(sherpa-onnx 为预编译 dylib 内嵌);改 `project.yml` 后须 `xcodegen generate`;独立 git 仓库

## 决策记录(brainstorm 问答确定)

| 问题 | 决定 | 备注 |
|---|---|---|
| 核心诉求 | 全都要:Markdown 渲染 + 消息操作三件套 + 历史持久化 + UI 质感 | 分期交付 |
| 界面形态 | 升级现有右侧面板(VRM 左/聊天右 40%) | 独立聊天窗口被拒(与桌宠演化方向冲突);面板+可展开留作远期 |
| 会话模型 | 单一连续历史,按天分组 | 多会话列表被拒(助手心智 ≠ 陪伴心智,女友不"新建会话") |
| MD 渲染 | swift-markdown-ui 库 | **项目首个 SPM 依赖,打破零包先例**(用户知情选择);原生 AttributedString 不支持代码块/表格;自研工作量不值 |
| 语法高亮 | 首期不做:深色代码块 + 复制按钮 | 避免再拖 Highlightr 依赖 |
| 流式节拍 | ~120ms 合并渲染(打字机轻微顿挫换性能) | 长文本自动放宽到 240ms |
| 停止生成行为 | 半截话保留入历史 | 豆包同款;后端 finally 结算天然兼容 |
| 重新生成好感度 | 后端对相同 lastUser 短时去重(唯一中间层改动) | 防重复结算,~10 行 |
| 历史存储 | JSONL 追加写,启动只灌末尾 200 条 + 上翻加载 | SwiftData 被拒(单一场景不值得 Model Container);显示历史 ≠ 上下文(上下文仍 40 条) |
| 聊天记录归属 | app JSONL(UI 历史)与她侧 chat_history(她的记忆)解耦,互不读 | |

## 详细设计

### 总体架构与分期

四期独立可交付,按价值密度排序:

```
P0  Markdown 渲染 + 流式节流 + TTS 剥离     ← 体验差距最大
P1  消息操作三件套(停止/重生成/复制)
P2  历史持久化(JSONL 单一连续历史)
P3  输入框多行化 + 质感打磨
```

改造后数据流(⭐ 为新增):

```
输入框 ─→ sendMessage ─→ HTTPChatService(SSE,不动)
                              ↓ token
                     ⭐ StreamThrottle 节流(~120ms 合并)
                              ↓
                     streamingText ─→ ⭐ MarkdownView 流式渲染
                              ↓ 流结束
                完整消息 ─┬→ ⭐ HistoryStore 追加写 JSONL
                          └→ ⭐ MarkdownStripper ─→ TTS 管线(不动)
```

新增文件 4 个:`Views/MarkdownView.swift`、`Pipeline/StreamThrottle.swift`、`Models/HistoryStore.swift`、`Models/MarkdownStripper.swift`(暂定,均 <200 行);改动集中在 `ChatView.swift`、`ConversationController.swift`。

### P0:Markdown 渲染与流式节流

- 依赖:SPM 添加 `gonzalezreal/swift-markdown-ui`(改 `project.yml` + `xcodegen generate`)
- `MarkdownView`(新,~150 行):
  - 助手消息 `Markdown(...)` + 自定义主题;代码块 = 深色背景 + 等宽 + 右上角复制按钮(`codeBlock` 主题钩子 + 自定义 `CodeBlockView`)
  - 用户消息保持纯 `Text`(用户输入不渲染,YAGNI)
  - 渲染前剥情绪标签,复用 `displayContent` 正则
  - 语法高亮留作后续增强
- `StreamThrottle`(新,~60 行):token 更新合并到 120ms 节拍再触发渲染;流结束立刻 flush 保证结尾不缺字;文本 >4000 字节拍放宽 240ms 防末期掉帧
- `MarkdownStripper`(新):TTS 前剥离——代码块整块跳过(或读"这是一段代码")、表格剥符号、行内 `**`/`` ` ``/链接取文本、列表项转自然句;接入 `runTTSPlayback` 的 `SentenceParser` 之前
- 容错:swift-markdown-ui 对非法 Markdown 当纯文本,无需额外降级

### P1:停止生成 / 重新生成 / 复制

- **停止**:streaming 时发送按钮变停止方块;`ConversationController` 加 `cancelStreaming()`(暴露流任务句柄);cancel 后已收部分照常作为完整消息入历史。后端 `finally` 结算断连兼容,零改动
- **重新生成**:仅最后一条助手消息可用(hover/右键);删除内存中最后一条 assistant 后携同样上下文重发,不重复 append user;P2 落地后同步删持久化记录
- **好感度去重(唯一中间层改动)**:`gateway.ts` 的 `settleAfterChat` 对相同 `lastUser` + 短时间窗口跳过 `settleChatTurn`,~10 行,`pnpm test` 补用例
- **复制**:`MessageBubbleView` 加 `contextMenu` + hover 操作条,复制剥情绪标签后的 Markdown 原文(`NSPasteboard`)

### P2:历史持久化(JSONL 单一连续历史)

- `HistoryStore`(新,~120 行):
  - 路径 `~/Library/Application Support/AniCompanion/history.jsonl`,一行一条消息
  - 写入时机:user 发送即落一行;assistant 流结束落一行(停止的半截话同样落)——与 P1 入历史时机对齐
  - 加载:启动读末尾 200 条注入 `ConversationHistory`;顶部滚到头翻页加载更早(`LazyVStack` + loadMore)
- 按天分组:日期分隔线("今天/昨天/10 月 24 日")由 timestamp 派生;滚动定位保持 `ScrollViewReader` 到底
- `maxContextMessages = 40` 不动:持久化的是显示历史,发给大脑的上下文仍 40 条,token 成本不变
- 清理:设置页"清空聊天记录"(删文件+清内存+二次确认);单条右键删除
- 解耦:app JSONL 与 companion-layer `chat_history`(她的记忆)互不读,跨端不追求一致

### P3:输入框多行化 + 质感打磨

- 单行 `TextField` → `TextEditor` 自适应容器,1~6 行自动长高,超过内滚;**Enter 发送,Shift+Enter 换行**
- 发送按钮 streaming 时切停止方块(与 P1 联动)
- 质感:流式结尾闪烁光标 `▌`;消息入场淡入 + 位移 8pt;气泡圆角/留白对齐 macOS 豆包观感;助手 sparkles 头像沿用

### 错误处理

- 流中断(网络/后端挂):已收部分保留入历史 + 尾部灰字"连接中断" + 重试按钮(复用重新生成管线)
- 大脑未配置/上游失败:companion-layer 已发人设化 `[sad]` 消息 + `[DONE]`,app 端复用现有降级,无需特判
- Markdown 解析:库自身容错

## 风险与开放问题

- **首个 SPM 依赖**:xcodegen 的 `packages:` 配置与既有 dylib 链接共存需验证(P0 第一步先跑通空集成)
- **重新生成好感度重复结算**:去重方案实现时验证 `settleChatTurn` 实际行为,若每日封顶已覆盖则可免改
- **长回复流式性能**:节流 + 自适应节拍兜底;若仍卡,后续可只渲染可见部分
- 情绪标签 `[happy]` 在 CommonMark 中保留原样,且渲染前已剥,无冲突

## 测试与验收

- XCTest 单测(纯逻辑组件全覆盖):`MarkdownStripper` 剥离规则、`HistoryStore` 读写/翻页/清空、`StreamThrottle` 节拍与 flush
- companion-layer(若做去重):`pnpm test` 补 gateway 用例
- 全链路验收:`bash scripts/check.sh` 四环节 + 真机走查:流式渲染/停止/重生成/复制/重启加载历史/TTS 不读符号
