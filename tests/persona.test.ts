import { describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { loadPersona, stageForAffinity } from '../src/persona/loader.ts'
import { buildContextBlock, buildSystemPrompt, EMOTION_TAGS } from '../src/persona/promptBuilder.ts'

const PERSONA_PATH = new URL('../persona/persona.yaml', import.meta.url).pathname

describe('persona loader', () => {
  it('加载真实 persona.yaml 并通过校验', () => {
    const p = loadPersona(PERSONA_PATH)
    expect(p.name).toBe('小满')
    expect(p.stages.length).toBeGreaterThanOrEqual(2)
    expect(p.stages.map((s) => s.id)).toEqual(['stranger', 'familiar', 'close', 'soulmate'])
  })

  it('阈值乱序时 fail fast', () => {
    const bad = `
name: 测试
identity: 测试角色
personality: ["温柔"]
speech: { style: 自然, length: 简短, forbid: ["禁止"] }
stages:
  - { id: a, label: 一, threshold: 100, address_user: 主人, tone: x }
  - { id: b, label: 二, threshold: 50, address_user: 主人, tone: x }
milestones: {}
`
    const tmp = `/tmp/persona-bad-${process.pid}.yaml`
    writeFileSync(tmp, bad)
    try {
      expect(() => loadPersona(tmp)).toThrow(/threshold/)
    } finally {
      rmSync(tmp)
    }
  })
})

describe('stageForAffinity', () => {
  const p = loadPersona(PERSONA_PATH)
  it('按阈值返回当前阶段', () => {
    expect(stageForAffinity(p, 0).id).toBe('stranger')
    expect(stageForAffinity(p, 149).id).toBe('stranger')
    expect(stageForAffinity(p, 150).id).toBe('familiar')
    expect(stageForAffinity(p, 400).id).toBe('close')
    expect(stageForAffinity(p, 99999).id).toBe('soulmate')
  })
})

describe('promptBuilder', () => {
  const p = loadPersona(PERSONA_PATH)
  const stage = stageForAffinity(p, 0)

  it('system prompt 含人格、表情协议与阶段指令', () => {
    const s = buildSystemPrompt(p, stage)
    expect(s).toContain('小满')
    expect(s).toContain(stage.tone)
    for (const tag of EMOTION_TAGS) {
      expect(s).toContain(`[${tag}]`)
    }
  })

  it('上下文块：事件、记忆、里程碑、想念各自成段', () => {
    const block = buildContextBlock({
      now: new Date('2026-09-29T22:30:00'),
      events: [{ agent: 'claude-code', event_type: 'session_completed', summary: '跑完了测试', created_at: '2026-09-29T13:10:00Z' }],
      facts: [{ kind: 'promise', content: '主人说这周要早睡', created_at: '2026-09-28T00:00:00Z' }],
      proactiveHint: 'quiet',
      milestoneDirective: { directive: '自然表达你们更熟了' },
      missingDirective: '主人 3 天没说话了，你有点想他',
    })
    expect(block).toContain('claude-code')
    expect(block).toContain('跑完了测试')
    expect(block).toContain('主人说这周要早睡')
    expect(block).toContain('主动开口')
    expect(block).toContain('自然表达你们更熟了')
    expect(block).toContain('主人 3 天没说话了，你有点想他')
  })

  it('无事件与记忆时不输出空段', () => {
    const block = buildContextBlock({ now: new Date(), events: [], facts: [] })
    expect(block).not.toContain('Agent 的动静')
    expect(block).not.toContain('关于主人的事')
  })
})
