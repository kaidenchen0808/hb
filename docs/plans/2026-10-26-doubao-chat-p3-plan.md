# 豆包化聊天 P3 实现计划（输入框多行化 + 质感打磨）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 聊天输入框多行化（1~6 行自适应、Enter 发送 / Shift+Enter 换行），流式光标与消息入场动画，对齐 macOS 豆包观感。豆包化收官期。

**Scope:** 全部改动集中在 `AniCompanion/Views/ChatView.swift`。发送按钮双态 P1 已完成，不涉及。

**Key decisions:**
- TextField → TextEditor；高度用 `NSAttributedString.boundingRect` 计算（组件内闭环，无幽灵视图），clamp 36~132pt。
- Enter/Shift+Enter 用 `.onKeyPress(.return, phases: .down)`（macOS 14+）：无 shift → send 并 `.handled`，有 shift → `.ignored` 放行换行。**已知风险**：中文 IME 候选确认的 Enter 可能被拦截直接发送——手测验证，若中招降级为仅按钮发送。
- 流式光标：AssistantProcessingView 气泡底部右侧闪烁竖条（Markdown 块级布局无法精确接行尾，底右不遮内容）。
- 入场动画：LazyVStack `.animation(value: messages.last?.id)`（prepend 翻页/中间删除不触发）+ 气泡 `.transition(.opacity + .move(bottom))`。
- TextEditor 无占位符：空文本时 overlay 灰字 placeholder。

### Task 1: 多行输入框（自适应 + Enter/Shift+Enter）
### Task 2: 流式光标 + 入场动画
### Task 3: 回归 + 装机 + 手测清单（含 IME 验证重点项）
