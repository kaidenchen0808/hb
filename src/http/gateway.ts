import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { brainReady, directFormat, type AppConfig } from '../config.ts'
import type { CompanionDb } from '../db/database.ts'
import type { Persona } from '../persona/loader.ts'
import { stageForAffinity } from '../persona/loader.ts'
import { buildContextBlock, buildSystemPrompt } from '../persona/promptBuilder.ts'
import { extractDelta, LlmUnavailableError, streamChatCompletion, TOOL_USE_PLACEHOLDER, wrapAsChunk, type ChatMessage } from '../brain/llmClient.ts'
import { unconsumedEvents, markAllConsumed } from '../memory/eventStore.ts'
import { recentFacts, extractFacts, insertFacts } from '../memory/facts.ts'
import { enqueueSay } from '../memory/outbox.ts'
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

// ---- hybrid 模式：[lookup] 标记的流式感知 ----

const LOOKUP_MARKER = '[lookup]'

/** hybrid 模式专属：告诉她遇到查资料类问题先转场，再由后台 claude 代查、经通知通道回报。 */
const LOOKUP_GUIDANCE = `

## 查资料的方式
你自己不能联网。当主人问需要外部信息的问题（天气、新闻、资料、他电脑里的内容）时：
1. 先回一句自然的简短转场话（比如"等我查一下哦～"），不要编造答案
2. 然后在回复的最末尾另起一行，原样输出：[lookup] 一句话写下要查的问题
之后会有人帮你查，你拿到结果会再告诉主人。不需要查资料时就正常回答，绝不要输出 [lookup]。`

/** s 的结尾是否是标记的不完整前缀（如 "[look"），返回该前缀长度（0 表示无）。 */
export function partialLookupMarkerLen(s: string): number {
  for (let i = Math.min(LOOKUP_MARKER.length, s.length); i > 0; i--) {
    if (LOOKUP_MARKER.startsWith(s.slice(-i))) return i
  }
  return 0
}

/** 从完整回复中分离播报内容与查询任务。 */
export function splitLookup(text: string): { reply: string; query: string | null } {
  const idx = text.indexOf(LOOKUP_MARKER)
  if (idx < 0) return { reply: text, query: null }
  const reply = text.slice(0, idx)
  const query = text
    .slice(idx + LOOKUP_MARKER.length)
    .replace(/\[[a-z]+\]/g, '') // 模型偶尔会在标记后补情绪标签，剥掉
    .trim()
  return { reply, query: query === '' ? null : query.slice(0, 200) }
}

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
      }) +
      (config.brainApiFormat === 'hybrid' ? LOOKUP_GUIDANCE : '')

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
    const chatApiFormat = config.brainApiFormat === 'hybrid' ? directFormat(config) : config.brainApiFormat

    return streamSSE(c, async (stream) => {
      // 流式透传 + [lookup] 标记感知（仅 hybrid 模式的回复会出现标记；非 hybrid 走同一逻辑零开销）
      let held = ''
      let markerFound = false
      try {
        for await (const data of streamChatCompletion({
          baseUrl: config.brainBaseUrl,
          apiKey: config.brainApiKey,
          model: config.brainModel,
          messages: upstreamMessages,
          signal: c.req.raw.signal,
          apiFormat: chatApiFormat,
        })) {
          const delta = extractDelta(data)
          if (delta === '') continue
          assistantText += delta
          if (markerFound) continue // 标记后的内容只累积不播出
          const combined = held + delta
          const idx = combined.indexOf(LOOKUP_MARKER)
          if (idx >= 0) {
            markerFound = true
            const before = combined.slice(0, idx)
            if (before !== '') await stream.writeSSE({ data: wrapAsChunk(requestId, config.brainModel, before) })
            continue
          }
          // 结尾若是 "[lookup" 的不完整前缀，hold 住等下一个 chunk，避免标记漏出到客户端
          const keep = partialLookupMarkerLen(combined)
          held = combined.slice(combined.length - keep)
          const emit = combined.slice(0, combined.length - keep)
          if (emit !== '') await stream.writeSSE({ data: wrapAsChunk(requestId, config.brainModel, emit) })
        }
        if (!markerFound && held !== '') {
          await stream.writeSSE({ data: wrapAsChunk(requestId, config.brainModel, held) })
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
        const { query: lookupQuery } = splitLookup(assistantText)
        settleAfterChat(deps, {
          lastUser,
          assistantText,
          userRepliedToProactive,
          now,
          milestoneStage: milestone?.stage,
          lookupQuery,
          systemPrompt,
        })
      }
    })
  }
}

/** 一轮对话的流后结算：落库、消费事件、清里程碑、好感度、异步记忆提取。结算失败不影响已发出的回复。 */
function settleAfterChat(
  deps: GatewayDeps,
  input: {
    lastUser: string | null
    assistantText: string
    userRepliedToProactive: boolean
    now: Date
    milestoneStage?: string
    lookupQuery?: string | null
    systemPrompt?: string
  },
): void {
  const { db, config, persona } = deps
  try {
    // 落库的回复剥掉 [lookup] 标记行（那是给网关的控制信号，不是她说的话）
    const { reply: cleanReply } = splitLookup(input.assistantText)
    const insertChat = db.prepare(`INSERT INTO chat_history (role, content, created_at) VALUES (?, ?, ?)`)
    if (input.lastUser !== null) insertChat.run('user', input.lastUser, input.now.toISOString())
    if (cleanReply.trim() !== '') {
      insertChat.run('assistant', cleanReply.trim(), new Date().toISOString())
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
    if (input.lastUser !== null && cleanReply.trim() !== '' && directBrainReady) {
      const conversation: ChatMessage[] = [
        { role: 'user', content: input.lastUser },
        { role: 'assistant', content: cleanReply },
      ]
      void extractFacts(
        {
          baseUrl: config.brainBaseUrl,
          apiKey: config.brainApiKey,
          model: config.brainModel,
          apiFormat: directFormat(config),
        },
        conversation,
        (facts) => {
          const n = insertFacts(db, facts)
          if (n > 0) console.log(`[facts] 新记忆 ${n} 条`)
        },
      )
    }

    // hybrid 二段：她答应去查 → 派 claude 代查 → 结果经通知通道让她主动说
    if (input.lookupQuery != null && input.lookupQuery !== '' && input.lastUser !== null && input.systemPrompt !== undefined) {
      void lookupAndSay(deps, { query: input.lookupQuery, userQuestion: input.lastUser, systemPrompt: input.systemPrompt })
    }
  } catch (err) {
    console.error('[gateway] 流后结算失败（不影响回复）:', err instanceof Error ? err.message : err)
  }
}

/** hybrid 二段查询：spawn claude 代查，结果入发件箱让她主动开口（失败也给一句人设化道歉）。 */
async function lookupAndSay(
  deps: GatewayDeps,
  input: { query: string; userQuestion: string; systemPrompt: string },
): Promise<void> {
  const { db, config } = deps
  console.log(`[lookup] 派 claude 代查: ${input.query}`)
  try {
    let result = ''
    for await (const data of streamChatCompletion({
      baseUrl: '',
      apiKey: '',
      model: config.brainModel,
      messages: [
        { role: 'system', content: input.systemPrompt },
        {
          role: 'user',
          content: `主人刚才问你："${input.userQuestion}"，你已经答应他去查了。现在把查到的结果用人设的语气告诉他：一到三句话，以 [emotion] 标签开头，不要提"工具""查询""系统"这些字眼，不要输出链接。要查的问题：${input.query}`,
        },
      ],
      apiFormat: 'claude-code',
    })) {
      result += extractDelta(data)
    }
    // 占位符是给聊天流防卡死的，outbox 一次性播出不需要，剥掉
    const text = splitLookup(result).reply.replace(TOOL_USE_PLACEHOLDER, '').trim()
    if (text !== '') {
      enqueueSay(db, text, 'lookup')
      console.log(`[lookup] 结果已入队: ${text.slice(0, 60)}`)
    }
  } catch (err) {
    console.warn('[lookup] 代查失败:', err instanceof Error ? err.message : err)
    enqueueSay(db, '[sad] 唔……刚才答应主人查的东西，我这边出了点小状况没查到，对不起嘛……', 'lookup-error')
  }
}
