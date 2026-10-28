import { Hono } from 'hono'
import type { AppConfig } from '../config.ts'
import type { CompanionDb } from '../db/database.ts'
import type { Persona } from '../persona/loader.ts'
import { handleChatCompletion, currentLookupStatus, cancelActiveLookup, type GatewayDeps } from './gateway.ts'
import { insertEvent, isEventType, pruneEvents, recentEvents } from '../memory/eventStore.ts'
import { isHookType, recordRawEvent, type RawEventInput } from '../memory/rawEvents.ts'
import { finalizeSession } from '../memory/aggregator.ts'
import { drainOutbox, enqueueSay } from '../memory/outbox.ts'
import { settleAgentPresence } from '../memory/relationship.ts'
import { decideTouch, isTouchPart } from '../memory/touch.ts'
import { decideReaction, recordReaction, FALLBACK_LINES, REACTION_ANIMATIONS, type ReactionInput } from '../memory/reactions.ts'
import { generateReactionLine } from '../brain/reactionGen.ts'
import type { RealtimeHub } from '../realtime/hub.ts'

export interface AppDeps extends GatewayDeps {
  // GatewayDeps 已含 db/config/persona
  /** WebSocket 实时推送（可选：测试环境不建 hub，生产 index.ts 注入）。 */
  hub?: RealtimeHub
}

/**
 * 情绪反应引擎入口：值得开口 → 生成台词 → 发件箱（她 3 秒内开口）。
 * 生成是异步的（不阻塞 hook 响应），返回决策标记给调用方。
 */
function maybeReact(deps: AppDeps, input: ReactionInput): string | null {
  const { db, config, persona } = deps
  const decision = decideReaction(db, input, {
    minIntervalSec: config.reactionMinIntervalSec,
    enabled: config.reactionsEnabled,
  })
  if (decision === null) return null
  recordReaction(db, decision.kind, input.now)
  console.log(`[reaction] ${decision.kind}：${decision.reason}`)
  const brainReadyDirect = config.brainBaseUrl !== '' && config.brainApiKey !== '' && config.brainModel !== ''
  if (!brainReadyDirect) {
    // 没配直连大脑：直接用兜底台词，她也不能缺席
    enqueueSay(db, FALLBACK_LINES[decision.kind][0], 'reaction', REACTION_ANIMATIONS[decision.kind])
    deps.hub?.notifyEnqueued()
    return decision.kind
  }
  void generateReactionLine(
    {
      baseUrl: config.brainBaseUrl,
      apiKey: config.brainApiKey,
      model: config.brainModel,
      apiFormat: config.brainBaseUrl.includes('anthropic') ? 'anthropic' : 'openai',
    },
    persona,
    decision,
    input,
  ).then((line) => {
    enqueueSay(db, line, 'reaction', REACTION_ANIMATIONS[decision.kind])
    deps.hub?.notifyEnqueued()
    console.log(`[reaction] 她说: ${line.slice(0, 60)}`)
  })
  return decision.kind
}

export function createApp(deps: AppDeps): Hono {
  const { db, config } = deps
  const app = new Hono()

  // 可选的 Bearer 校验：配置了 COMPANION_API_KEY 才启用
  app.use('/v1/*', async (c, next) => {
    if (config.companionApiKey !== null) {
      const auth = c.req.header('Authorization') ?? ''
      if (auth !== `Bearer ${config.companionApiKey}`) {
        return c.json({ error: { message: 'invalid api key', type: 'invalid_request_error' } }, 401)
      }
    }
    await next()
  })

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'companion-layer',
      brain: config.brainBaseUrl === '' ? 'unconfigured' : 'configured',
      persona: deps.persona.name,
    }),
  )

  app.post('/v1/chat/completions', handleChatCompletion(deps))

  // ---- hooks 上报入口（Claude Code / OpenCode） ----

  app.use('/api/*', async (c, next) => {
    if (config.companionApiKey !== null) {
      const auth = c.req.header('Authorization') ?? ''
      if (auth !== `Bearer ${config.companionApiKey}`) {
        return c.json({ error: { message: 'invalid api key' } }, 401)
      }
    }
    await next()
  })

  const validAgent = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]{1,32}$/.test(v)
  const validSession = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128

  // 原始事件：PostToolUse 等高频 hook 全量归档（只进 raw_events）
  app.post('/api/events', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (body === null || !validAgent(body.agent) || !validSession(body.session_id) || !isHookType(body.hook_type)) {
      return c.json({ error: { message: '需要 agent(\\w.-), session_id, hook_type(PreToolUse|PostToolUse|Stop|UserPromptSubmit|SessionStart|Notification)' } }, 400)
    }
    const input: RawEventInput = {
      agent: body.agent,
      session_id: body.session_id,
      hook_type: body.hook_type,
      tool_name: typeof body.tool_name === 'string' ? body.tool_name.slice(0, 64) : undefined,
      payload: body.payload,
    }
    recordRawEvent(db, input)

    // 任务开始感知：UserPromptSubmit（新 session 首个 prompt）→ session_started 进她的视野
    // 她知道"主人开始了新任务"——不单独开口（避免打扰），供下次聊天/proactive 自然提起
    if (body.hook_type === 'UserPromptSubmit') {
      const prompt = typeof (body.payload as { prompt?: unknown } | undefined)?.prompt === 'string'
        ? String((body.payload as { prompt?: string }).prompt).slice(0, 80)
        : ''
      insertEvent(db, {
        agent: body.agent,
        event_type: 'session_started',
        summary: prompt !== '' ? `开始了新任务：${prompt}` : '开始了新任务',
      })
    }
    return c.json({ ok: true })
  })

  // Stop 定稿：整个 session 折叠成一条聚合事件进入她的视野；值得的话触发她的情绪反应
  app.post('/api/aggregate', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (body === null || !validAgent(body.agent) || !validSession(body.session_id)) {
      return c.json({ error: { message: '需要 agent, session_id' } }, 400)
    }
    const finalNote = typeof body.final_note === 'string' ? body.final_note.slice(0, 200) : undefined
    const finalized = finalizeSession(db, {
      agent: body.agent,
      session_id: body.session_id,
      finalNote,
    })
    let reaction: string | null = null
    if (finalized !== null) {
      settleAgentPresence(db)
      pruneEvents(db)  // 聚合低频入口顺带滚动清理（进程内每日一次，见 eventStore 注释）
      reaction = maybeReact(deps, {
        event_type: 'session_completed',
        agent: body.agent,
        summary: finalized.summary,
        stats: finalized.stats,
        now: new Date(),
      })
    }
    return c.json({ ok: true, summary: finalized?.summary ?? null, reaction })
  })

  app.get('/api/events', (c) => {
    const limitRaw = c.req.query('limit')
    const limit = limitRaw === undefined ? 20 : Math.min(Math.max(Number.parseInt(limitRaw, 10) || 20, 1), 100)
    return c.json({ events: recentEvents(db, limit) })
  })

  // ---- 即时说话通道（AniCompanion 轮询消费） ----

  // 入队一条她立刻要说的话（终端 / Agent / 脚本调用；可选 animation 指定配套肢体动作）
  app.post('/api/say', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (body === null || typeof body.text !== 'string' || body.text.trim() === '') {
      return c.json({ error: { message: '需要 text（她要说的台词，可含 [emotion] 标签）' } }, 400)
    }
    const source = typeof body.source === 'string' ? body.source : 'api'
    const animation = typeof body.animation === 'string' ? body.animation : undefined
    const msg = enqueueSay(db, body.text, source, animation)
    deps.hub?.notifyEnqueued()
    return c.json({ ok: true, id: msg.id })
  })

  // 摸她/戳她（AniCompanion 点击角色上报）：人格台词反应，WS 秒推；
  // 冷却内连点静默（reacted=false），好感度随触摸轻加（日封顶，见 touch.ts）
  app.post('/api/touch', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    const part = isTouchPart(body?.part) ? body.part : null
    if (part === null) {
      return c.json({ error: { message: '需要 part: head（摸头）或 body（戳身体）' } }, 400)
    }
    const line = decideTouch(db, part, new Date())
    if (line !== null) {
      enqueueSay(db, line.text, 'touch', line.animation)
      deps.hub?.notifyEnqueued()
      console.log(`[touch] ${part === 'head' ? '摸头' : '戳身体'} → 她说: ${line.text.slice(0, 60)}`)
    }
    return c.json({ ok: true, reacted: line !== null })
  })

  // 失败直报（hooks 检测到工具失败时调用）：写 task_failed 并触发她的即时安慰
  app.post('/api/report-failure', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (body === null || typeof body.summary !== 'string' || body.summary.trim() === '') {
      return c.json({ error: { message: '需要 summary' } }, 400)
    }
    const agent = typeof body.agent === 'string' && /^[\w.-]{1,32}$/.test(body.agent) ? body.agent : 'claude-code'
    insertEvent(db, {
      agent,
      event_type: 'task_failed',
      summary: body.summary.trim().slice(0, 200),
    })
    settleAgentPresence(db)
    const reaction = maybeReact(deps, { event_type: 'task_failed', agent, summary: body.summary, now: new Date() })
    return c.json({ ok: true, reaction })
  })

  // AniCompanion 补丁轮询：返回待播消息（取出即投递，at-most-once）
  // WS 时代的回落通道：响应头广告实时能力，客户端据此升级长连（见 realtime/hub.ts）
  app.get('/v1/notifications', (c) => {
    const messages = drainOutbox(db)
    c.header('X-Companion-Realtime', '1')
    return c.json({
      activeLookup: currentLookupStatus(),
      notifications: messages.map((m) => ({
        id: String(m.id),
        text: m.text,
        source: m.source,
        ...(typeof m.animation === 'string' && m.animation !== '' ? { animation: m.animation } : {}),
      })),
    })
  })

  // 取消进行中的代查（app 指示条的 ✕）——没有进行中任务也是 200（幂等）
  app.post('/api/lookup/cancel', (c) => {
    const cancelled = cancelActiveLookup()
    return c.json({ ok: true, cancelled })
  })

  return app
}
