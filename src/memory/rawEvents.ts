import type { CompanionDb } from '../db/database.ts'

export const HOOK_TYPES = ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart', 'Notification'] as const
export type HookType = (typeof HOOK_TYPES)[number]

export interface RawEventInput {
  agent: string
  session_id: string
  hook_type: HookType
  tool_name?: string
  payload?: unknown
}

export function isHookType(v: unknown): v is HookType {
  return typeof v === 'string' && (HOOK_TYPES as readonly string[]).includes(v)
}

/** 归档一条 hook 原始事件（只进 raw_events，不进她的视野）。 */
export function recordRawEvent(db: CompanionDb, input: RawEventInput): void {
  db.prepare(
    `INSERT INTO raw_events (agent, session_id, hook_type, tool_name, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.agent,
    input.session_id,
    input.hook_type,
    input.tool_name ?? null,
    input.payload === undefined ? null : JSON.stringify(input.payload).slice(0, 4000),
    new Date().toISOString(),
  )
}

export interface RawEventRow {
  id: number
  agent: string
  session_id: string
  hook_type: string
  tool_name: string | null
  created_at: string
}

export function sessionEvents(db: CompanionDb, sessionId: string): RawEventRow[] {
  return db
    .prepare(`SELECT id, agent, session_id, hook_type, tool_name, created_at FROM raw_events WHERE session_id = ? ORDER BY id`)
    .all(sessionId) as unknown as RawEventRow[]
}
