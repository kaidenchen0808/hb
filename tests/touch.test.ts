import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type CompanionDb } from '../src/db/database.ts'
import { loadPersona } from '../src/persona/loader.ts'
import { createApp } from '../src/http/app.ts'
import type { AppConfig } from '../src/config.ts'
import { decideTouch, TOUCH_LINES, TOUCH_ANIMATIONS, type TouchPart } from '../src/memory/touch.ts'
import { getRelationship } from '../src/memory/relationship.ts'
import { drainOutbox } from '../src/memory/outbox.ts'

let db: CompanionDb

const NOON = new Date('2026-10-12T12:00:00') // 固定白天时刻，避开深夜逻辑干扰
const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  personaPath: 'unused',
  brainBaseUrl: '',
  brainApiKey: '',
  brainModel: '',
    brainVisionModel: '',
  brainApiFormat: 'openai' as const,
  companionApiKey: null,
  reactionsEnabled: false,
  reactionMinIntervalSec: 900,
}

beforeEach(() => {
  db = openDb(':memory:')
})

describe('decideTouch（触摸反应决策）', () => {
  it('摸头：返回台词池中带表情标签的一句 + 动画候选', () => {
    const line = decideTouch(db, 'head', NOON)
    expect(line).not.toBeNull()
    expect(TOUCH_LINES.head).toContain(line!.text)
    expect(line!.text).toMatch(/^\[\w+\]/)
    expect(TOUCH_ANIMATIONS.head).toContain(line!.animation)
  })

  it('戳身体：台词池与摸头不同，动画独立', () => {
    const line = decideTouch(db, 'body', NOON)
    expect(line).not.toBeNull()
    expect(TOUCH_LINES.body).toContain(line!.text)
    expect(TOUCH_ANIMATIONS.body).toContain(line!.animation)
    expect(TOUCH_LINES.head).not.toContain(line!.text)
    const headLine = decideTouch(db, 'head', new Date(NOON.getTime() + 10_000))
    expect(line!.text).not.toBe(headLine!.text)
  })

  it('冷却内连点静默（防刷屏）', () => {
    expect(decideTouch(db, 'head', NOON)).not.toBeNull()
    expect(decideTouch(db, 'head', new Date(NOON.getTime() + 2000))).toBeNull()
    expect(decideTouch(db, 'body', new Date(NOON.getTime() + 4000))).toBeNull()
  })

  it('冷却过后可再反应', () => {
    decideTouch(db, 'head', NOON)
    expect(decideTouch(db, 'head', new Date(NOON.getTime() + 5001))).not.toBeNull()
  })

  it('好感度：触摸 +0.5，每日封顶 3（狂点无增益）', () => {
    const before = getRelationship(db).affinity
    decideTouch(db, 'head', NOON)
    expect(getRelationship(db).affinity).toBeCloseTo(before + 0.5)
    // 7 次有效触摸（间隔 6s 过冷却）：前 6 次加满 3 点，第 7 次封顶不再加
    for (let i = 1; i < 7; i++) decideTouch(db, i % 2 === 0 ? 'body' : 'head', new Date(NOON.getTime() + i * 6000))
    expect(getRelationship(db).affinity).toBeCloseTo(before + 3)
  })

  it('台词冷却静默时好感度也不加（连点完全无收益）', () => {
    const before = getRelationship(db).affinity
    decideTouch(db, 'head', NOON)
    decideTouch(db, 'head', new Date(NOON.getTime() + 1000)) // 冷却内：静默且不加好感度
    expect(getRelationship(db).affinity).toBeCloseTo(before + 0.5)
  })

  it('好感度封顶按本地日期重置', () => {
    const day1 = new Date('2026-10-12T12:00:00')
    for (let i = 0; i < 5; i++) decideTouch(db, 'head', new Date(day1.getTime() + i * 6000))
    const afterDay1 = getRelationship(db).affinity
    const day2 = new Date('2026-10-13T12:00:00')
    decideTouch(db, 'head', day2)
    expect(getRelationship(db).affinity).toBeCloseTo(afterDay1 + 0.5)
  })
})

describe('POST /api/touch（路由）', () => {
  async function post(body: unknown): Promise<Response> {
    const persona = loadPersona(new URL('../persona/persona.yaml', import.meta.url).pathname)
    const app = createApp({ db, config, persona })
    return app.request('/api/touch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('合法 part：入 outbox（source=touch，带动画）并返回 reacted true', async () => {
    const res = await post({ part: 'head' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, reacted: true })
    const [msg] = drainOutbox(db)
    expect(msg.source).toBe('touch')
    expect(TOUCH_LINES.head).toContain(msg.text)
    expect(TOUCH_ANIMATIONS.head).toContain(msg.animation)
  })

  it('非法/缺失 part 返回 400', async () => {
    expect((await post({ part: 'tail' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect((await post(null)).status).toBe(400)
  })

  it('冷却内连点返回 reacted false，outbox 不新增', async () => {
    await post({ part: 'head' })
    const res = await post({ part: 'head' })
    expect(await res.json()).toEqual({ ok: true, reacted: false })
    expect(drainOutbox(db)).toHaveLength(1)
  })

  it('两种 part 都是合法输入', async () => {
    const part: TouchPart = 'body'
    expect((await post({ part })).status).toBe(200)
  })
})
