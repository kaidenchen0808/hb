import type { CompanionDb } from '../db/database.ts'

export type ReactionKind = 'success' | 'failure' | 'lateNight'

export interface ReactionInput {
  event_type: 'session_started' | 'session_completed' | 'task_failed' | 'error' | 'info'
  agent: string
  summary: string
  stats?: { toolCounts: Array<{ label: string; count: number }>; durationMs: number; eventCount: number }
  now: Date
}

export interface ReactionDecision {
  kind: ReactionKind
  reason: string
}

// 工作量阈值：不够格的轮次她不开口（情绪价值≠播报每个动作）
const SUCCESS_MIN_EVENTS = 8
const SUCCESS_MIN_DURATION_MS = 10 * 60 * 1000
const LATE_NIGHT = { start: 23, end: 5 }

function getState(db: CompanionDb, key: string): string | null {
  const row = db.prepare(`SELECT value FROM reaction_state WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}
function setState(db: CompanionDb, key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO reaction_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(key, value, new Date().toISOString())
}

/** 本地日期键（"每晚一次"的夜是本地时区的夜，不能用 UTC 日期，否则凌晨 0-5 点跨日失效）。 */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 这一刻属于"哪一晚"：23 点后算当天，凌晨（0-5 点）归前一晚。 */
function nightKeyOf(d: Date): string {
  return d.getHours() < LATE_NIGHT.end
    ? localDateKey(new Date(d.getTime() - 24 * 3600 * 1000))
    : localDateKey(d)
}

// 收工道别（success）的独立短冷却：只需防连发，不该被其他开口的长冷却挡住
const FAREWELL_MIN_INTERVAL_SEC = 60

/** 冷却键距今是否还在 intervalSec 内。 */
function withinCooldown(db: CompanionDb, key: string, now: Date, intervalSec: number): boolean {
  const lastAt = getState(db, key)
  if (lastAt === null) return false
  return (now.getTime() - new Date(lastAt).getTime()) / 1000 < intervalSec
}

/**
 * 反应决策：值得她立刻开口吗。
 * 先按失败 > 深夜 > 大工作量判定类别，再查对应冷却：
 *   failure / lateNight → 全局冷却（minIntervalSec）
 *   success（收工道别）→ 独立短冷却，防连发即可
 * 不值得 → null（事件照常进她的视野，下次聊天自然提及）。
 */
export function decideReaction(
  db: CompanionDb,
  input: ReactionInput,
  opts: { minIntervalSec: number; enabled: boolean },
): ReactionDecision | null {
  if (!opts.enabled) return null

  // 失败/错误：立即反应（优先级最高——主人遇到挫折时在场才是情绪价值）
  let candidate: ReactionDecision | null = null
  if (input.event_type === 'task_failed' || input.event_type === 'error') {
    candidate = { kind: 'failure', reason: 'agent 出错或失败' }
  }

  // 深夜在场：每晚只心疼一次；心疼过之后这一晚对完成类事件保持静默（failure 分支在前面，不受影响）
  const hour = input.now.getHours()
  if (candidate === null && (hour >= LATE_NIGHT.start || hour < LATE_NIGHT.end)) {
    if (getState(db, 'last_late_night_date') !== nightKeyOf(input.now)) {
      candidate = { kind: 'lateNight', reason: `深夜 ${String(hour).padStart(2, '0')} 点还在工作` }
    } else {
      return null // 催睡之后当晚不再道别——不说"干得漂亮"鼓励熬夜
    }
  }

  // 大工作量完成：事件多或耗时长才值得她说一句
  if (candidate === null && input.event_type === 'session_completed') {
    const s = input.stats
    const bigWork = s !== undefined && (s.eventCount >= SUCCESS_MIN_EVENTS || s.durationMs >= SUCCESS_MIN_DURATION_MS)
    if (bigWork) candidate = { kind: 'success', reason: '一轮大工作量完成' }
  }

  if (candidate === null) return null
  if (candidate.kind === 'success') {
    return withinCooldown(db, 'last_farewell_at', input.now, FAREWELL_MIN_INTERVAL_SEC) ? null : candidate
  }
  return withinCooldown(db, 'last_reaction_at', input.now, opts.minIntervalSec) ? null : candidate
}

/** 记录本次开口（冷却与深夜去重用；道别独立记账，不重置全局冷却）。 */
export function recordReaction(db: CompanionDb, kind: ReactionKind, now: Date): void {
  if (kind === 'success') {
    setState(db, 'last_farewell_at', now.toISOString())
    return
  }
  setState(db, 'last_reaction_at', now.toISOString())
  if (kind === 'lateNight') setState(db, 'last_late_night_date', nightKeyOf(now))
}

// 生成失败时的兜底台词（大脑不可用时她也不缺席）
export const FALLBACK_LINES: Record<ReactionKind, string[]> = {
  failure: ['[sad] 唔……我看到那边出错啦。别急嘛主人，喝口水，我们慢慢来。', '[neutral] 挂了呀……没事的，谁写代码不挂几次呢，我陪着你。'],
  success: ['[proud] 忙完这一轮啦？干得漂亮哦主人。去伸个懒腰吧，我看着呢。', '[happy] 你那边收工的动静我听到啦～记得夸夸自己。'],
  lateNight: ['[sleepy] 主人……都这个点了还在写代码呀。再忙也要早点睡哦，我会心疼的。'],
}
