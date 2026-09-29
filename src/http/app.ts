import { Hono } from 'hono'
import type { AppConfig } from '../config.ts'
import type { CompanionDb } from '../db/database.ts'
import type { Persona } from '../persona/loader.ts'
import { handleChatCompletion, type GatewayDeps } from './gateway.ts'
import { isEventType, recentEvents } from '../memory/eventStore.ts'
import { isHookType, recordRawEvent, type RawEventInput } from '../memory/rawEvents.ts'
import { finalizeSession } from '../memory/aggregator.ts'
import { drainOutbox, enqueueSay } from '../memory/outbox.ts'
import { settleAgentPresence } from '../memory/relationship.ts'

export interface AppDeps extends GatewayDeps {
  // GatewayDeps 已含 db/config/persona
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
    return c.json({ ok: true })
  })

  // Stop 定稿：整个 session 折叠成一条聚合事件进入她的视野
  app.post('/api/aggregate', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (body === null || !validAgent(body.agent) || !validSession(body.session_id)) {
      return c.json({ error: { message: '需要 agent, session_id' } }, 400)
    }
    const finalNote = typeof body.final_note === 'string' ? body.final_note.slice(0, 200) : undefined
    const summary = finalizeSession(db, {
      agent: body.agent,
      session_id: body.session_id,
      finalNote,
    })
    if (summary !== null) settleAgentPresence(db)
    return c.json({ ok: true, summary })
  })

  app.get('/api/events', (c) => {
    const limitRaw = c.req.query('limit')
    const limit = limitRaw === undefined ? 20 : Math.min(Math.max(Number.parseInt(limitRaw, 10) || 20, 1), 100)
    return c.json({ events: recentEvents(db, limit) })
  })

  // ---- 即时说话通道（AniCompanion 轮询消费） ----

  // 入队一条她立刻要说的话（终端 / Agent / 脚本调用）
  app.post('/api/say', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (body === null || typeof body.text !== 'string' || body.text.trim() === '') {
      return c.json({ error: { message: '需要 text（她要说的台词，可含 [emotion] 标签）' } }, 400)
    }
    const source = typeof body.source === 'string' ? body.source : 'api'
    const msg = enqueueSay(db, body.text, source)
    return c.json({ ok: true, id: msg.id })
  })

  // AniCompanion 补丁轮询：返回待播消息（取出即投递，at-most-once）
  app.get('/v1/notifications', (c) => {
    const messages = drainOutbox(db)
    return c.json({
      notifications: messages.map((m) => ({ id: String(m.id), text: m.text, source: m.source })),
    })
  })

  return app
}
