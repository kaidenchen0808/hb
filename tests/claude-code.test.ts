import { describe, expect, it } from 'vitest'
import { claudeLineHasToolUse, extractClaudeAssistantText } from '../src/brain/llmClient.ts'

describe('claude-code stream-json 解析', () => {
  it('assistant 文本行 → 提取文本', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '[happy] 查到啦，深圳今天 28 度～' }] },
    })
    expect(extractClaudeAssistantText(line)).toBe('[happy] 查到啦，深圳今天 28 度～')
  })

  it('system/result/垃圾行 → null', () => {
    expect(extractClaudeAssistantText(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull()
    expect(extractClaudeAssistantText(JSON.stringify({ type: 'result', result: 'x' }))).toBeNull()
    expect(extractClaudeAssistantText('not json')).toBeNull()
  })

  it('纯 tool_use 行（无文本）→ null 文本但 hasToolUse 为真', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: {} }] },
    })
    expect(extractClaudeAssistantText(line)).toBeNull()
    expect(claudeLineHasToolUse(line)).toBe(true)
  })

  it('普通文本行 hasToolUse 为假', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '你好' }] },
    })
    expect(claudeLineHasToolUse(line)).toBe(false)
  })

  it('混合块（文本+tool_use）都能识别', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '我去查查' }, { type: 'tool_use', id: 't2', name: 'WebSearch', input: {} }] },
    })
    expect(extractClaudeAssistantText(line)).toBe('我去查查')
    expect(claudeLineHasToolUse(line)).toBe(true)
  })
})
