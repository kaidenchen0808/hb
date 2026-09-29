import type { CompanionDb } from '../db/database.ts'
import type { ContextEvent } from '../persona/promptBuilder.ts'

export const EVENT_TYPES = [
  'session_started',
  'session_completed',
  'task_failed',
  'error',
  'info',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export interface AgentEvent {
  id: number
  agent: string
  event_type: EventType
  summary: string
  details: string | null
  created_at: string
  consumed_at: string | null
}

export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v)
}

/** 写入一条聚合事件（进入她的视野）。summary 必须是一句人能读懂的话。 */
export function insertEvent(
  db: CompanionDb,
  input: { agent: string; event_type: EventType; summary: string; details?: string },
): AgentEvent {
  const now = new Date().toISOString()
  if (input.summary.trim() === '') throw new Error('事件 summary 不能为空')
  const result = db
    .prepare(
      `INSERT INTO agent_events (agent, event_type, summary, details, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.agent, input.event_type, input.summary.trim(), input.details ?? null, now)
  return { ...input, details: input.details ?? null, id: Number(result.lastInsertRowid), created_at: now, consumed_at: null }
}

/** 取最近 N 条（默认 20）。 */
export function recentEvents(db: CompanionDb, limit = 20): AgentEvent[] {
  return db
    .prepare(`SELECT * FROM agent_events ORDER BY id DESC LIMIT ?`)
    .all(limit) as unknown as AgentEvent[]
}

/** 未消费事件（她还没聊过的动静），按时间正序给 prompt。 */
export function unconsumedEvents(db: CompanionDb, limit = 20): ContextEvent[] {
  const rows = db
    .prepare(
      `SELECT agent, event_type, summary, created_at FROM agent_events
       WHERE consumed_at IS NULL ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as unknown as ContextEvent[]
  return rows.reverse()
}

/** 一轮对话结束后调用：她"聊过"这些动静了。 */
export function markAllConsumed(db: CompanionDb): number {
  const result = db.prepare(`UPDATE agent_events SET consumed_at = ? WHERE consumed_at IS NULL`).run(new Date().toISOString())
  return Number(result.changes)
}
