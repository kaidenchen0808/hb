import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type CompanionDb } from '../src/db/database.ts'
import { drainOutbox, enqueueSay, type OutboxMessage } from '../src/memory/outbox.ts'

let db: CompanionDb

beforeEach(() => {
  db = openDb(':memory:')
})

describe('enqueueSay', () => {
  it('空 text（含纯空白）抛错', () => {
    expect(() => enqueueSay(db, '', 'api')).toThrow('text 不能为空')
    expect(() => enqueueSay(db, '   \n\t ', 'api')).toThrow('text 不能为空')
  })

  it('超长文本截断到 2000 字符', () => {
    const msg = enqueueSay(db, '啊'.repeat(3000), 'api')
    expect(msg.text).toHaveLength(2000)
    const [row] = drainOutbox(db)
    expect(row.text).toHaveLength(2000)
  })

  it('source 截断到 32 字符', () => {
    const msg = enqueueSay(db, 'hi', 'x'.repeat(100))
    expect(msg.source).toBe('x'.repeat(32))
  })

  it('返回自增 id 与创建时间', () => {
    const a = enqueueSay(db, '第一句', 'api')
    const b = enqueueSay(db, '第二句', 'api')
    expect(b.id).toBeGreaterThan(a.id)
    expect(a.created_at).toBeTruthy()
  })
})

describe('drainOutbox', () => {
  it('空库返回空数组', () => {
    expect(drainOutbox(db)).toEqual([])
  })

  it('按 id 顺序返回全部未投递消息', () => {
    enqueueSay(db, '第一句', 'api')
    enqueueSay(db, '第二句', 'mcp')
    const rows = drainOutbox(db)
    expect(rows.map((r) => r.text)).toEqual(['第一句', '第二句'])
    expect(rows.map((r) => r.source)).toEqual(['api', 'mcp'])
  })

  it('at-most-once：取出即标记，二次 drain 为空', () => {
    enqueueSay(db, '只说一遍', 'api')
    expect(drainOutbox(db)).toHaveLength(1)
    expect(drainOutbox(db)).toHaveLength(0)
  })

  it('只取未投递：旧消息已投递后，drain 只返回新消息', () => {
    enqueueSay(db, '旧消息', 'api')
    drainOutbox(db)
    enqueueSay(db, '新消息', 'api')
    const rows: OutboxMessage[] = drainOutbox(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('新消息')
  })
})

describe('trimBacklog', () => {
  it('未投递积压超过 50 条时丢弃最旧的', () => {
    for (let i = 0; i < 55; i++) enqueueSay(db, `消息 ${i}`, 'api')
    const rows = drainOutbox(db)
    expect(rows).toHaveLength(50)
    expect(rows[0].text).toBe('消息 5') // 最旧 5 条被丢
    expect(rows[49].text).toBe('消息 54')
  })

  it('已投递消息不占积压额度', () => {
    for (let i = 0; i < 60; i++) {
      enqueueSay(db, `已消费 ${i}`, 'api')
      drainOutbox(db)
    }
    // 全部已投递 → 积压为 0，再入队 3 条应完整保留
    for (let i = 0; i < 3; i++) enqueueSay(db, `新 ${i}`, 'api')
    expect(drainOutbox(db)).toHaveLength(3)
  })
})
