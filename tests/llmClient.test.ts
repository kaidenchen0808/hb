import { describe, expect, it } from 'vitest'
import { accessSync, constants } from 'node:fs'
import { resolveClaudeCli, extractClaudeThinking, extractClaudeAssistantText, wrapAsReasoningChunk } from '../src/brain/llmClient.ts'

describe('resolveClaudeCli', () => {
  it('返回 null 或一个真实可执行路径（不变量：绝不返回不存在的路径）', () => {
    const resolved = resolveClaudeCli()
    if (resolved === null) return // 无 claude 的环境（CI）允许 null
    // 'claude'（PATH 命中）或绝对路径都可，但必须真实可执行
    if (resolved !== 'claude') {
      expect(() => accessSync(resolved, constants.X_OK)).not.toThrow()
      expect(resolved.startsWith('/')).toBe(true)
    }
  })
})

describe('claude thinking 透传', () => {
  const assistantLine = (blocks: { type: string; text?: string; thinking?: string }[]) =>
    JSON.stringify({ type: 'assistant', message: { content: blocks } })

  it('extractClaudeThinking: thinking 块整块抽出（字段名是 thinking 非 text）', () => {
    const line = assistantLine([
      { type: 'thinking', thinking: '先分析一下问题。' },
      { type: 'text', text: '答案是 42。' },
    ])
    expect(extractClaudeThinking(line)).toBe('先分析一下问题。')
    expect(extractClaudeAssistantText(line)).toBe('答案是 42。')
  })

  it('extractClaudeThinking: 无 thinking 块返回 null（普通回复不误报）', () => {
    const line = assistantLine([{ type: 'text', text: '你好呀' }])
    expect(extractClaudeThinking(line)).toBeNull()
  })

  it('wrapAsReasoningChunk: delta.reasoning_content 形状，content 消费者不受扰', () => {
    const chunk = JSON.parse(wrapAsReasoningChunk('id1', 'm', '推理中'))
    expect(chunk.choices[0].delta).toEqual({ reasoning_content: '推理中' })
    // 传统消费者视角：delta.content 不存在 → 忽略
    expect(chunk.choices[0].delta.content).toBeUndefined()
  })
})
