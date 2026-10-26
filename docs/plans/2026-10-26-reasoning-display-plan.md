# SSE 推理过程透传与展示（thinking → 折叠面板）

**已确认事实（2026-10-26 实测）：** `claude -p --output-format stream-json` 的 assistant
消息 content 含 `type:'thinking'` 块（字段 `text`，**整块到达**非 token 流）；随后才是
`type:'text'` 正文块。thinking_tokens system 事件仅有计数（V1 不透传）。

**架构决策：**
- hb：`streamClaudeCode` 遇 thinking 块 yield `delta.reasoning_content` chunk
  （DeepSeek 通行标准）。生成器签名不变（yield SSE data 行）；facts/reactionGen 的
  `extractDelta` 只抽 `delta.content`，reasoning chunk 被自然忽略——**零破坏**。
- Swift：`WSIncoming` 加 `.reasoning(ref, content)` case；handleEvent 路由到新
  `@Published thinkingText`（整块到达，不经 StreamThrottle）；**不进** tokenContinuation。
- `ChatMessage` 加 `let thinking: String?`（Codable synthesized 对 Optional 用
  decodeIfPresent——旧 JSONL 兼容）。
- UI：`ThinkingPanel` 折叠面板（流式中"思考中…"/完成后"思考过程"，深色配灰字）；
  流式挂 AssistantProcessingView 上方，完成挂 MessageBubbleView 上方。
- 天然隔离：TTS（strip rawResponse）、apiMessage、复制 displayContent 均不含 thinking。

**Tasks:**
1. hb：wrapAsReasoningChunk + streamClaudeCode thinking 解析 + 单测 → 部署 + curl 验证
2. Swift：ChatMessage.thinking / History / WSIncoming.reasoning / HTTPChatService 解析 /
   controller thinkingText / 两条 pipeline 结算传 thinking
3. Swift UI：ThinkingPanel + 两处挂载
4. 回归 + 0.10.1 装机 + 真机验证（检查 SSE 与 UI 内容）+ v0.4.2 release
