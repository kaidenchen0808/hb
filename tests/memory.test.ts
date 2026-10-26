import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type CompanionDb } from '../src/db/database.ts'
import { finalizeSession, summarizeSession, buildSessionSummary, type SessionStats } from '../src/memory/aggregator.ts'
import { recordRawEvent, type RawEventRow } from '../src/memory/rawEvents.ts'
import { insertEvent, recentEvents, unconsumedEvents, markAllConsumed } from '../src/memory/eventStore.ts'
import { insertFacts, parseExtractedFacts, recentFacts } from '../src/memory/facts.ts'
import { decideReaction, recordReaction } from '../src/memory/reactions.ts'
import {
  checkStageTransition,
  clearMilestone,
  getRelationship,
  missingDirective,
  pendingMilestone,
  settleAgentPresence,
  settleChatTurn,
} from '../src/memory/relationship.ts'
import { loadPersona, stageForAffinity } from '../src/persona/loader.ts'

let db: CompanionDb
const persona = loadPersona(new URL('../persona/persona.yaml', import.meta.url).pathname)

beforeEach(() => {
  db = openDb(':memory:')
})

describe('aggregator', () => {
  it('事件不足时返回 null（太琐碎不打扰她）', () => {
    expect(summarizeSession([rawRow(1, 'PostToolUse', 'Bash')])).toBeNull()
  })

  it('低频工具被阈值过滤，高频保留', () => {
    const rows = [
      rawRow(1, 'PostToolUse', 'Read'),
      rawRow(2, 'PostToolUse', 'Write'),
      rawRow(3, 'PostToolUse', 'Write'),
      rawRow(4, 'PostToolUse', 'Write'),
    ]
    const stats = summarizeSession(rows)
    expect(stats).not.toBeNull()
    expect(stats!.toolCounts).toEqual([{ label: '改文件', count: 3 }]) // Read 1 次被过滤
  })

  it('buildSessionSummary 输出人话', () => {
    const stats: SessionStats = { toolCounts: [{ label: '改文件', count: 6 }, { label: '跑命令', count: 47 }], durationMs: 25 * 60000, eventCount: 53 }
    expect(buildSessionSummary('claude-code', stats)).toBe('claude-code 干完了一轮活：改文件 6 次、跑命令 47 次，约 25 分钟')
    expect(buildSessionSummary('claude-code', stats, '修好了登录 bug')).toContain('修好了登录 bug')
  })

  it('finalizeSession 落一条聚合事件并进入她的视野', () => {
    for (let i = 0; i < 4; i++) {
      recordRawEvent(db, { agent: 'claude-code', session_id: 's1', hook_type: 'PostToolUse', tool_name: 'Bash' })
    }
    const finalized = finalizeSession(db, { agent: 'claude-code', session_id: 's1' })
    expect(finalized?.summary).toContain('跑命令 4 次')
    expect(finalized?.stats.eventCount).toBe(4)
    expect(unconsumedEvents(db)).toHaveLength(1)
  })
})

describe('eventStore', () => {
  it('写入、读取、消费闭环', () => {
    insertEvent(db, { agent: 'codex', event_type: 'task_failed', summary: '构建失败' })
    insertEvent(db, { agent: 'claude-code', event_type: 'session_completed', summary: '测试全过' })
    expect(unconsumedEvents(db)).toHaveLength(2)
    expect(markAllConsumed(db)).toBe(2)
    expect(unconsumedEvents(db)).toHaveLength(0)
    expect(recentEvents(db, 10)).toHaveLength(2) // 消费后仍可查历史
  })
})

describe('facts', () => {
  it('解析正常 JSON / markdown 包裹 / 垃圾输入', () => {
    expect(parseExtractedFacts('{"facts":[{"kind":"promise","content":"主人说这周要早睡"}]}')).toEqual([
      { kind: 'promise', content: '主人说这周要早睡' },
    ])
    expect(parseExtractedFacts('```json\n{"facts":[{"kind":"habit","content":"主人常在深夜写代码"}]}\n```')).toEqual([
      { kind: 'habit', content: '主人常在深夜写代码' },
    ])
    expect(parseExtractedFacts('我觉得没什么好记的')).toEqual([])
    expect(parseExtractedFacts('{"facts":[{"kind":"unknown","content":"x"}]}')).toEqual([])
  })

  it('写入去重：同 kind 相似内容只记一次', () => {
    insertFacts(db, [{ kind: 'promise', content: '主人说这周要早睡' }])
    insertFacts(db, [{ kind: 'promise', content: '主人说这周要早睡觉啦' }]) // 前 24 字相同
    insertFacts(db, [{ kind: 'habit', content: '主人说这周要早睡' }]) // kind 不同不算重复
    expect(recentFacts(db, 10)).toHaveLength(2)
  })

  it('写入去重：语义近似但长短不同的变体也拦截（2026-10-26 真实案例形状）', () => {
    insertFacts(db, [{ kind: 'promise', content: '主人说要去深圳湾看月亮' }])
    // 真实案例：旧记忆带后续状态尾巴，新提取是短版——前缀法漏，2-gram 拦得住
    insertFacts(db, [{ kind: 'promise', content: '主人说要去深圳湾看月亮，至今还没确认去了没有' }])
    // 完全不同的事实正常入库
    insertFacts(db, [{ kind: 'preference', content: '主人喜欢吃辣' }])
    expect(recentFacts(db, 10)).toHaveLength(2)
  })
})

describe('relationship', () => {
  it('普通对话 +2，回应主动开口 +4', () => {
    const noon = new Date('2026-09-29T14:00:00')
    settleChatTurn(db, { userRepliedToProactive: false, now: noon })
    expect(getRelationship(db).affinity).toBe(2)
    settleChatTurn(db, { userRepliedToProactive: true, now: noon })
    expect(getRelationship(db).affinity).toBe(6)
  })

  it('深夜在场额外 +1', () => {
    settleChatTurn(db, { userRepliedToProactive: false, now: new Date('2026-09-29T23:30:00') })
    expect(getRelationship(db).affinity).toBe(3)
  })

  it('Agent 在场 +0', () => {
    settleAgentPresence(db)
    expect(getRelationship(db).affinity).toBe(0.5)
  })

  it('跨阈值跃迁记录 milestone，且只记一次', () => {
    // stranger(0) → familiar(150)
    expect(checkStageTransition(db, persona, 0, 100)).toBeNull()
    const t1 = checkStageTransition(db, persona, 100, 150)
    expect(t1?.stage).toBe('familiar')
    const t2 = checkStageTransition(db, persona, 100, 180) // 重复跃迁被 OR IGNORE 挡住
    expect(t2).toBeNull()
  })

  it('pendingMilestone 找回未告白里程碑，告白后清除', () => {
    checkStageTransition(db, persona, 0, 200)
    expect(pendingMilestone(db, persona, 'familiar')?.stage).toBe('familiar')
    expect(pendingMilestone(db, persona, 'close')).toBeNull() // 阶段不匹配
    clearMilestone(db, 'familiar')
    expect(pendingMilestone(db, persona, 'familiar')).toBeNull()
  })

  it('3 天未互动触发想念指令，不满 3 天不触发', () => {
    const state = { affinity: 10, stage: 'stranger', last_interaction_at: '2026-09-25T00:00:00Z' }
    expect(missingDirective(state, new Date('2026-09-28T00:00:00Z'))).toContain('想念')
    expect(missingDirective({ ...state, last_interaction_at: '2026-09-27T00:00:00Z' }, new Date('2026-09-28T00:00:00Z'))).toBeNull()
  })
})

function rawRow(id: number, hookType: string, toolName: string): RawEventRow {
  return {
    id,
    agent: 'claude-code',
    session_id: 's1',
    hook_type: hookType,
    tool_name: toolName,
    created_at: new Date(Date.now() - (100 - id) * 60000).toISOString(),
  }
}


describe('reaction engine 决策', () => {
  it('失败事件立即反应', () => {
    const d = decideReaction(db, { event_type: 'task_failed', agent: 'codex', summary: '构建失败', now: new Date('2026-09-29T14:00:00') }, { minIntervalSec: 900, enabled: true })
    expect(d?.kind).toBe('failure')
  })

  it('小工作量完成不反应（默默记账）', () => {
    const d = decideReaction(db, { event_type: 'session_completed', agent: 'claude-code', summary: '改了 2 个文件', stats: { toolCounts: [], durationMs: 60000, eventCount: 3 }, now: new Date('2026-09-29T14:00:00') }, { minIntervalSec: 900, enabled: true })
    expect(d).toBeNull()
  })

  it('大工作量完成反应 success', () => {
    const d = decideReaction(db, { event_type: 'session_completed', agent: 'claude-code', summary: '大活', stats: { toolCounts: [], durationMs: 60000, eventCount: 20 }, now: new Date('2026-09-29T14:00:00') }, { minIntervalSec: 900, enabled: true })
    expect(d?.kind).toBe('success')
  })

  it('全局冷却期内沉默', () => {
    const now = new Date('2026-09-29T14:00:00Z')
    decideReaction(db, { event_type: 'task_failed', agent: 'x', summary: '失败', now }, { minIntervalSec: 900, enabled: true })
    recordReaction(db, 'failure', now)
    const d2 = decideReaction(db, { event_type: 'task_failed', agent: 'x', summary: '又失败', now: new Date('2026-09-29T14:05:00Z') }, { minIntervalSec: 900, enabled: true })
    expect(d2).toBeNull()
  })

  it('收工道别不受全局冷却影响（failure 刚开口也能道别）', () => {
    const failAt = new Date('2026-09-29T14:00:00Z')
    decideReaction(db, { event_type: 'task_failed', agent: 'x', summary: '失败', now: failAt }, { minIntervalSec: 900, enabled: true })
    recordReaction(db, 'failure', failAt)
    // 5 分钟后收工：全局冷却还在，但道别走独立通道
    const d = decideReaction(db, { event_type: 'session_completed', agent: 'x', summary: '大活', stats: { toolCounts: [], durationMs: 60000, eventCount: 20 }, now: new Date('2026-09-29T14:05:00Z') }, { minIntervalSec: 900, enabled: true })
    expect(d?.kind).toBe('success')
  })

  it('收工道别自身有短冷却（防连续道别）', () => {
    const t1 = new Date('2026-09-29T14:00:00Z')
    decideReaction(db, { event_type: 'session_completed', agent: 'x', summary: '大活', stats: { toolCounts: [], durationMs: 60000, eventCount: 20 }, now: t1 }, { minIntervalSec: 900, enabled: true })
    recordReaction(db, 'success', t1)
    const within = decideReaction(db, { event_type: 'session_completed', agent: 'x', summary: '又一个大活', stats: { toolCounts: [], durationMs: 60000, eventCount: 20 }, now: new Date('2026-09-29T14:00:30Z') }, { minIntervalSec: 900, enabled: true })
    expect(within).toBeNull()
    const after = decideReaction(db, { event_type: 'session_completed', agent: 'x', summary: '又一个大活', stats: { toolCounts: [], durationMs: 60000, eventCount: 20 }, now: new Date('2026-09-29T14:02:00Z') }, { minIntervalSec: 900, enabled: true })
    expect(after?.kind).toBe('success')
  })

  it('深夜反应每晚只一次', () => {
    const night1 = new Date('2026-09-29T23:30:00')
    const d1 = decideReaction(db, { event_type: 'session_completed', agent: 'x', summary: '深夜活', stats: { toolCounts: [], durationMs: 0, eventCount: 10 }, now: night1 }, { minIntervalSec: 60, enabled: true })
    expect(d1?.kind).toBe('lateNight')
    recordReaction(db, 'lateNight', night1)
    const d2 = decideReaction(db, { event_type: 'session_completed', agent: 'x', summary: '深夜活', stats: { toolCounts: [], durationMs: 0, eventCount: 10 }, now: new Date('2026-09-30T00:30:00') }, { minIntervalSec: 60, enabled: true })
    expect(d2).toBeNull()
  })
})
