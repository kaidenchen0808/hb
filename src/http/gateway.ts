import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { brainReady, type AppConfig } from '../config.ts'
import type { CompanionDb } from '../db/database.ts'
import type { Persona } from '../persona/loader.ts'
import { stageForAffinity } from '../persona/loader.ts'
import { buildContextBlock, buildSystemPrompt } from '../persona/promptBuilder.ts'
import { extractDelta, LlmUnavailableError, streamChatCompletion, wrapAsChunk, type ChatMessage } from '../brain/llmClient.ts'
import { unconsumedEvents, markAllConsumed } from '../memory/eventStore.ts'
import { recentFacts, extractFacts, insertFacts } from '../memory/facts.ts'
import {
  checkStageTransition,
  clearMilestone,
  getRelationship,
  missingDirective,
  pendingMilestone,
  settleChatTurn,
} from '../memory/relationship.ts'

// app 发来的 system 里带主动开口信号的迹象（AniCompanion en/zh-Hant prompt 均覆盖）
const PROACTIVE_PATTERNS: Array<{ re: RegExp; hint: 'online' | 'quiet' }> = [
  { re: /came online|just (?:came|got) (?:online|back)|上線|回到電腦/i, hint: 'online' },
  { re: /quiet|idle|silent|安靜|一陣子沒/i, hint: 'quiet' },
]

export interface GatewayDeps {
  db: CompanionDb
  config: AppConfig
  persona: Persona
}

interface IncomingMessage {
  role: string
  content: unknown
}

/** OpenAI content 兼容归一：字符串或 [{type:'text',text}] → 纯文本。 */
function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text?: string } => typeof p === 'object' && p !== null && 'text' in p)
      .map((p) => p.text ?? '')
      .join('')
  }
  return ''
}

export function handleChatCompletion(deps: GatewayDeps) {
  const { db, config, persona } = deps
  let lastRequestWasProactive = false

  return async (c: Context): Promise<Response> => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    const messages = body?.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: { message: 'messages 不能为空', type: 'invalid_request_error' } }, 400)
    }

    // 1) 丢弃 app 的人格 system，检测主动开口信号
    let proactiveHint: 'online' | 'quiet' | undefined
    const chatMessages: ChatMessage[] = []
    for (const m of messages as IncomingMessage[]) {
      const content = normalizeContent(m.content)
      if (m.role === 'system') {
        for (const p of PROACTIVE_PATTERNS) {
          if (p.re.test(content)) proactiveHint = proactiveHint ?? p.hint
        }
        continue // 人格替换：app 自带 prompt 一律不用
      }
      if (m.role === 'user' || m.role === 'assistant') {
        if (content.trim() !== '') chatMessages.push({ role: m.role, content })
      }
    }
    if (chatMessages.filter((m) => m.role === 'user').length === 0 && proactiveHint === undefined) {
      // 无用户消息也无主动信号：app 启动问候等场景，仍放行（她打个招呼）
      proactiveHint = 'online'
    }
    const userRepliedToProactive = lastRequestWasProactive && chatMessages.some((m) => m.role === 'user')
    const lastUser = [...chatMessages].reverse().find((m) => m.role === 'user')?.content ?? null

    // 2) 组装我们的 system：人格 + 关系阶段 + 此刻背景
    const now = new Date()
    const rel = getRelationship(db)
    const stage = stageForAffinity(persona, rel.affinity)
    const milestone = pendingMilestone(db, persona, stage.id)
    const missing = missingDirective(rel, now)
    const events = unconsumedEvents(db)
    const facts = recentFacts(db)
    const systemPrompt =
      buildSystemPrompt(persona, stage) +
      '\n\n' +
      buildContextBlock({
        now,
        events,
        facts,
        proactiveHint,
        milestoneDirective: milestone ?? undefined,
        missingDirective: missing ?? undefined,
      })

    const upstreamMessages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...chatMessages]

    // 3) 大脑未配置：明确告知而不是挂死
    if (!brainReady(config)) {
      const requestId = crypto.randomUUID()
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: wrapAsChunk(requestId, 'companion-layer', '[sad] 主人……我脑子还没接上，先帮我看看 .env 里的 BRAIN 配置好不好？') })
        await stream.writeSSE({ data: '[DONE]' })
      })
    }

    // 4) 代理上游并流式透传，结束后结算
    const requestId = crypto.randomUUID()
    let assistantText = ''
    lastRequestWasProactive = proactiveHint !== undefined

    return streamSSE(c, async (stream) => {
      try {
        for await (const data of streamChatCompletion({
          baseUrl: config.brainBaseUrl,
          apiKey: config.brainApiKey,
          model: config.brainModel,
          messages: upstreamMessages,
          signal: c.req.raw.signal,
          apiFormat: config.brainApiFormat,
        })) {
          assistantText += extractDelta(data)
          await stream.writeSSE({ data })
        }
      } catch (err) {
        const msg = err instanceof LlmUnavailableError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        console.error('[gateway] 上游失败:', msg)
        if (assistantText === '') {
          await stream.writeSSE({
            data: wrapAsChunk(requestId, 'companion-layer', '[sad] 唔……主人我脑子突然有点乱，等一下再聊好不好？'),
          })
        }
      } finally {
        await stream.writeSSE({ data: '[DONE]' })
        settleAfterChat(deps, { lastUser, assistantText, userRepliedToProactive, now, milestoneStage: milestone?.stage })
      }
    })
  }
}

/** 一轮对话的流后结算：落库、消费事件、清里程碑、好感度、异步记忆提取。结算失败不影响已发出的回复。 */
function settleAfterChat(
  deps: GatewayDeps,
  input: { lastUser: string | null; assistantText: string; userRepliedToProactive: boolean; now: Date; milestoneStage?: string },
): void {
  const { db, config, persona } = deps
  try {
    const insertChat = db.prepare(`INSERT INTO chat_history (role, content, created_at) VALUES (?, ?, ?)`)
    if (input.lastUser !== null) insertChat.run('user', input.lastUser, input.now.toISOString())
    if (input.assistantText.trim() !== '') {
      insertChat.run('assistant', input.assistantText.trim(), new Date().toISOString())
    }
    markAllConsumed(db)
    if (input.milestoneStage !== undefined) clearMilestone(db, input.milestoneStage)

    const before = getRelationship(db).affinity
    settleChatTurn(db, { userRepliedToProactive: input.userRepliedToProactive, now: input.now })
    const after = getRelationship(db).affinity
    const transition = checkStageTransition(db, persona, before, after)
    if (transition !== null) {
      console.log(`[relationship] 阶段跃迁 → ${transition.stage}（好感度 ${before} → ${after}），告白已排队`)
    }

    // 记忆提取走直连大脑（避免每次聊天额外 spawn 一次 claude）；未配直连则跳过
    const directBrainReady = config.brainBaseUrl !== '' && config.brainApiKey !== '' && config.brainModel !== ''
    if (input.lastUser !== null && input.assistantText.trim() !== '' && directBrainReady) {
      const conversation: ChatMessage[] = [
        ...(input.lastUser !== null ? [{ role: 'user' as const, content: input.lastUser }] : []),
        { role: 'assistant' as const, content: input.assistantText },
      ]
      void extractFacts(
        {
          baseUrl: config.brainBaseUrl,
          apiKey: config.brainApiKey,
          model: config.brainModel,
          // 直连格式按端点推断（anthropic 端点 ↔ GLM Coding Plan）
          apiFormat: config.brainBaseUrl.includes('anthropic') ? 'anthropic' : 'openai',
        },
        conversation,
        (facts) => {
          const n = insertFacts(db, facts)
          if (n > 0) console.log(`[facts] 新记忆 ${n} 条`)
        },
      )
    }
  } catch (err) {
    console.error('[gateway] 流后结算失败（不影响回复）:', err instanceof Error ? err.message : err)
  }
}
