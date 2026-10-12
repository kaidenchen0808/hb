import type { CompanionDb } from '../db/database.ts'
import type { Persona } from '../persona/loader.ts'
import { stageForAffinity } from '../persona/loader.ts'

export interface RelationshipState {
  affinity: number
  stage: string
  last_interaction_at: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 好感度增量权重：一次对话 2，回应主动开口 4，深夜在场 1（封顶 1/天），Agent 在场 0.5/轮（封顶 3/天）。 */
const WEIGHTS = {
  chatTurn: 2,
  proactiveReply: 4,
  lateNightPresent: 1,
  agentPresence: 0.5,
} as const

const LATE_NIGHT = { start: 23, end: 5 } as const

export function getRelationship(db: CompanionDb): RelationshipState {
  const row = db
    .prepare(`SELECT affinity, stage, last_interaction_at FROM relationship WHERE id = 1`)
    .get() as unknown as RelationshipState
  return row
}

function addAffinity(db: CompanionDb, delta: number): number {
  const now = new Date().toISOString()
  const result = db
    .prepare(`UPDATE relationship SET affinity = affinity + ?, last_interaction_at = ?, updated_at = ? WHERE id = 1`)
    .run(delta, now, now)
  if (result.changes !== 1) throw new Error('relationship 行丢失')
  return getRelationship(db).affinity
}

function isLateNight(now: Date): boolean {
  const h = now.getHours()
  return h >= LATE_NIGHT.start || h < LATE_NIGHT.end
}

/**
 * 一轮对话结束后的好感度结算。返回结算后的状态。
 * 信号全部来自真实行为，用户永远看不到数值。
 */
export function settleChatTurn(
  db: CompanionDb,
  signal: { userRepliedToProactive: boolean; now: Date },
): RelationshipState {
  let delta = signal.userRepliedToProactive ? WEIGHTS.proactiveReply : WEIGHTS.chatTurn
  if (isLateNight(signal.now)) delta += WEIGHTS.lateNightPresent
  addAffinity(db, delta)
  return getRelationship(db)
}

/** Agent 事件出现时她也"在场"。轻量加分，服务内聚。 */
export function settleAgentPresence(db: CompanionDb): void {
  addAffinity(db, WEIGHTS.agentPresence)
}

/** 触摸互动的每日好感度封顶（狂点摸头无增益——好感度靠真实陪伴积累）。 */
const TOUCH_AFFINITY_DAILY_CAP = 3
const TOUCH_AFFINITY_WEIGHT = 0.5
const TOUCH_MAX_TIMES_PER_DAY = TOUCH_AFFINITY_DAILY_CAP / TOUCH_AFFINITY_WEIGHT // = 6 次

/** 触摸互动的好感度结算：+0.5/次，本地日封顶 3 点好感度。计数存 reaction_state（key 带本地日期）。 */
export function settleTouchAffinity(db: CompanionDb, now: Date): void {
  const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  const countKey = `touch_affinity_count_${dateKey}`
  const row = db.prepare(`SELECT value FROM reaction_state WHERE key = ?`).get(countKey) as
    | { value: string }
    | undefined
  const count = row === undefined ? 0 : Number(row.value)
  if (count >= TOUCH_MAX_TIMES_PER_DAY) return
  const nowIso = now.toISOString()
  db.prepare(`INSERT OR REPLACE INTO reaction_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(countKey, String(count + 1), nowIso)
  addAffinity(db, TOUCH_AFFINITY_WEIGHT)
}

/** 阶段跃迁检查：若跨过新阈值则记录 milestone（只记一次），返回待告白指令。 */
export function checkStageTransition(
  db: CompanionDb,
  persona: Persona,
  before: number,
  after: number,
): { stage: string; directive: string } | null {
  const beforeStage = stageForAffinity(persona, before).id
  const afterStage = stageForAffinity(persona, after).id
  if (beforeStage === afterStage) return null

  const directive = persona.milestones[afterStage]
  if (directive === undefined) return null

  const inserted = db
    .prepare(`INSERT OR IGNORE INTO milestones (stage, triggered_at) VALUES (?, ?)`)
    .run(afterStage, new Date().toISOString())
  if (Number(inserted.changes) === 0) return null
  return { stage: afterStage, directive }
}

/** 未告白但已记录的 milestone（进程重启后也能找回）。milestones 行存在即待告白，告白后由 clearMilestone 删除。 */
export function pendingMilestone(
  db: CompanionDb,
  persona: Persona,
  currentStage: string,
): { stage: string; directive: string } | null {
  const row = db
    .prepare(`SELECT stage FROM milestones ORDER BY triggered_at DESC LIMIT 1`)
    .get() as { stage: string } | undefined
  if (row === undefined || row.stage !== currentStage) return null
  const directive = persona.milestones[row.stage]
  return directive === undefined ? null : { stage: row.stage, directive }
}

/** 里程碑已注入（告白完成），标记消费。 */
export function clearMilestone(db: CompanionDb, stage: string): void {
  db.prepare(`DELETE FROM milestones WHERE stage = ?`).run(stage)
}

/** 距上次互动 ≥ 3 天时返回"想念"指令，否则 null。不扣分——想念不是惩罚。 */
export function missingDirective(state: RelationshipState, now: Date): string | null {
  if (state.last_interaction_at === null) return null
  const days = (now.getTime() - new Date(state.last_interaction_at).getTime()) / DAY_MS
  if (days < 3) return null
  return `主人已经 ${Math.floor(days)} 天没和你说话了，你有点想他。开口时自然地表达想念，但绝不责备、不阴阳怪气`
}
