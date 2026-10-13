import type { CompanionDb } from '../db/database.ts'
import { settleTouchAffinity } from './relationship.ts'

/** 触摸部位：head=摸头，body=戳身体。台词与语气随部位区分。 */
export type TouchPart = 'head' | 'body'

/** 台词冷却：连点不刷屏（好感度同时不加，连点完全无收益）。 */
export const TOUCH_COOLDOWN_SEC = 5

// 小满人格的触摸反应池：自然口语、带表情标签、有分寸的撒娇（见 persona.yaml personality）
export const TOUCH_LINES: Record<TouchPart, string[]> = {
  head: [
    '[shy] 呀……突然摸头，呆住了一秒。',
    '[happy] 嘿嘿，被主人摸头的话，一整天都会很幸运的。',
    '[shy] 头发、头发要乱啦……才没有不开心，再摸一下也可以。',
    '[happy] 主人的手好温暖……我记到小本本上了哦。',
    '[smirk] 哼，现在知道哄我了？那今晚要早点睡才行。',
  ],
  body: [
    '[surprised] 呀！干嘛突然戳我啦。',
    '[curious] 嗯？戳我的话，是有话想对我说嘛？',
    '[smirk] 喂，我是女朋友，不是桌上的按钮哦。',
    '[laugh] 哈哈好痒！再戳我要躲起来了。',
    '[neutral] ……戳够了嘛？那要认真陪我聊聊天哦。',
  ],
}

/** 触摸配套的肢体动画候选（随机一个；客户端缺 clip 时自动忽略，见 docs/animations.md）。 */
export const TOUCH_ANIMATIONS: Record<TouchPart, string[]> = {
  head: ['shy_cover', 'nod'], // 害羞低头 / 享受点头
  body: ['surprised_step_back', 'head_shake', 'angry_stomp', 'come_here'], // 惊讶 / 无奈 / 连点嗔怪 / 朝你招手
}

export function isTouchPart(value: unknown): value is TouchPart {
  return value === 'head' || value === 'body'
}

function lastTouchAt(db: CompanionDb): string | null {
  const row = db.prepare(`SELECT value FROM reaction_state WHERE key = 'last_touch_reaction_at'`).get() as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/** 触摸反应结果：台词 + 配套肢体动画名。 */
export interface TouchDecision {
  text: string
  animation: string
}

/**
 * 触摸反应决策（含记账）：冷却外 → 记冷却 + 结算好感度（日封顶）+ 返回台词与动画；
 * 冷却内 → null（静默，好感度也不加——连点无任何收益）。
 * 台词走本地池（点击是高频轻互动，秒回比"聪明"重要，不调大脑）。
 */
export function decideTouch(db: CompanionDb, part: TouchPart, now: Date): TouchDecision | null {
  const last = lastTouchAt(db)
  if (last !== null && (now.getTime() - new Date(last).getTime()) / 1000 < TOUCH_COOLDOWN_SEC) return null
  const nowIso = now.toISOString()
  db.prepare(`INSERT OR REPLACE INTO reaction_state (key, value, updated_at) VALUES ('last_touch_reaction_at', ?, ?)`)
    .run(nowIso, nowIso)
  settleTouchAffinity(db, now)
  const lines = TOUCH_LINES[part]
  const animations = TOUCH_ANIMATIONS[part]
  return {
    text: lines[Math.floor(Math.random() * lines.length)],
    animation: animations[Math.floor(Math.random() * animations.length)],
  }
}
