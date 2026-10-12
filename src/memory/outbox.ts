import type { CompanionDb } from '../db/database.ts'

export interface OutboxMessage {
  id: number
  text: string
  source: string
  created_at: string
}

const MAX_TEXT_LENGTH = 2000
const MAX_BACKLOG = 50 // 超过的最旧未投递消息直接丢弃（防积压刷屏）

/** 入队一条"她立刻要说的话"（由 AniCompanion 轮询取走播放，带 [emotion] 标签驱动表情）。 */
export function enqueueSay(db: CompanionDb, text: string, source = 'api'): OutboxMessage {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('text 不能为空')
  const now = new Date().toISOString()
  const safeText = trimmed.slice(0, MAX_TEXT_LENGTH)
  const safeSource = source.slice(0, 32)
  const result = db
    .prepare(`INSERT INTO outbox (text, source, created_at) VALUES (?, ?, ?)`)
    .run(safeText, safeSource, now)
  trimBacklog(db)
  return { id: Number(result.lastInsertRowid), text: safeText, source: safeSource, created_at: now }
}

/** 查看全部未投递消息（不标记）。WS 推送用：先广播、发送成功后才 markDelivered。 */
export function peekOutbox(db: CompanionDb): OutboxMessage[] {
  return db
    .prepare(`SELECT id, text, source, created_at FROM outbox WHERE delivered_at IS NULL ORDER BY id`)
    .all() as unknown as OutboxMessage[]
}

/** 批量标记已投递（at-most-once 语义的"消费"动作）。 */
export function markDelivered(db: CompanionDb, ids: number[]): void {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  const stmt = db.prepare(`UPDATE outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`)
  for (const id of ids) stmt.run(now, id)
}

/** 取走全部未投递消息（at-most-once：取出即标记已投递），返回给 app 轮询端点。 */
export function drainOutbox(db: CompanionDb): OutboxMessage[] {
  const rows = peekOutbox(db)
  markDelivered(db, rows.map((r) => r.id))
  return rows
}

/** 未投递积压超过上限时丢弃最旧的（她不该一口气背 50 句库存）。 */
function trimBacklog(db: CompanionDb): void {
  db.prepare(
    `DELETE FROM outbox WHERE id IN (
       SELECT id FROM outbox WHERE delivered_at IS NULL ORDER BY id DESC LIMIT -1 OFFSET ?
     )`,
  ).run(MAX_BACKLOG)
}
