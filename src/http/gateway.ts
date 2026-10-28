import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { brainReady, directFormat, type AppConfig } from '../config.ts'
import type { CompanionDb } from '../db/database.ts'
import type { Persona } from '../persona/loader.ts'
import { stageForAffinity } from '../persona/loader.ts'
import { buildContextBlock, buildSystemPrompt } from '../persona/promptBuilder.ts'
import { extractDelta, extractReasoning, LlmUnavailableError, streamChatCompletion, TOOL_USE_PLACEHOLDER, wrapAsChunk, type ChatMessage } from '../brain/llmClient.ts'
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

// ---- 好感度结算去重（进程内存即可，重启丢失可接受：只影响重生成场景的 3 分钟窗口） ----

const AFFINITY_SETTLE_WINDOW_MS = 3 * 60_000
const RECENT_SETTLES_MAX = 200
const recentAffinitySettles = new Map<string, number>()

// ---- hybrid 模式：[lookup] 标记的流式感知 ----

const LOOKUP_MARKER = '[lookup]'

/** hybrid 模式专属：告诉她遇到查资料类问题先转场，再由后台 claude 代查、经通知通道回报。 */
const LOOKUP_GUIDANCE = `

## 查资料的方式
你自己不能联网、也打不开文件。当主人问需要外部信息的问题（天气、新闻、资料、找图片、他电脑里的内容），或发来一个文件路径让你看（.docx/.pptx/.xlsx/.pdf/截图等你打不开的文件）时：
1. 先回一句自然的简短转场话（比如"等我查一下哦～"），不要编造答案
2. 然后在回复的最末尾另起一行，原样输出：[lookup] 一句话写下要查的问题或文件路径
之后会有人帮你查/帮你读文件，你拿到结果会再告诉主人。转场了就必须带 [lookup]，说了"我去看看"却不带标记，主人会永远等不到下文。不需要查资料时就正常回答，绝不要输出 [lookup]。
**能看到就直接答**：主人发来的图片、内联的文件文字你都直接看得见——绝不要转场代查，直接基于看到的内容回答（代查通道收不到你看到的图片，转场只会丢信息）。[lookup] 只用于你确实看不到的东西。`

/** hybrid 模式专属：思考过程主人能看到，必须中文（与 claude-code 模式的 TOOL_GUIDANCE 对齐）。 */
const THINKING_LANGUAGE_GUIDANCE = `

## 思考的语言
你的思考过程（thinking）主人是能看到的：始终用中文思考，像自言自语一样自然。`

/** 排版指引（闲聊口语/知识结构化分流——渲染层已全面支持，无指引时模型输出大白话）。 */
const FORMATTING_GUIDANCE = `

## 排版
主人的界面能完整渲染 Markdown（标题/列表/加粗/表格/公式/代码高亮/图片）。日常闲聊保持口语自然就好；
但知识性、结构化的内容（分析、教程、对比、总结、方案）请用 Markdown 排版——标题分节、要点列表、
关键结论加粗、数据用表格，公式用 $$…$$，不要输出大段无结构的文字。`

/** 请求体 skills 字段解析：[{name, content}]。name/content 必填非空；
 *  单技能截 4000 字、合计截 8000（superpowers 类超长技能不吃满上下文）。 */
export function parseSkills(raw: unknown): Array<{ name: string; content: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ name: string; content: string }> = []
  let total = 0
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const name = String((item as { name?: unknown }).name ?? '').trim()
    const content = String((item as { content?: unknown }).content ?? '').trim()
    if (name === '' || content === '') continue
    const capped = content.slice(0, Math.min(4000, Math.max(0, 8000 - total)))
    if (capped === '') break
    out.push({ name, content: capped })
    total += capped.length
    if (total >= 8000) break
  }
  return out
}

/** 技能注入段：拼在人格 system 之后。空技能返回空串（零开销）。 */
export function buildSkillSection(skills: Array<{ name: string; content: string }>): string {
  if (skills.length === 0) return ''
  const parts = skills.map((s) => `### ${s.name}\n${s.content}`).join('\n\n')
  return `\n\n## 本轮启用的技能\n主人从技能面板选中了以下技能，本轮对话请按这些技能的方法论与口吻回答：\n\n${parts}`
}

/** 代查结果解析：约定 JSON {result, sources:[{title,url}]}。容错——解析失败整段当
 *  result、来源空（模型偶尔包 markdown 代码块或输出纯文本，永不因格式丢内容）。 */
export function parseLookupResult(raw: string): { result: string; sources: Array<{ title: string; url: string }> } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  // 前置路径：GLM 的 server 工具（webReader 等）执行轨迹会作为 text 混在最终 JSON 前面
  // （轨迹自带 {"url":…} 等 JSON 片段，甚至可能含字面 {"result":…} 前置对象），旧的
  // "首个 { 到最后一个 }"会剖出跨段坏片解析失败、回落成把工具转储当台词（2026-10-27
  // e2e 实测）。改为定位**最后一个** "result": 键（matchAll 取尾——首匹配会在转储含
  // {"result": 前缀对象时剖错，review M1），从其所在 { 起做花括号平衡扫描（正确处理
  // 字符串内的 {} 与转义），天然跳过前置转储。
  let keyedIndex = -1
  for (const m of text.matchAll(/\{\s*"result"\s*:/g)) keyedIndex = m.index ?? keyedIndex
  if (keyedIndex >= 0) {
    const parsed = parseResultShape(sliceBalancedObject(text, keyedIndex))
    if (parsed !== null) return parsed
  }
  // 兜底路径：老格式容错（"result" 键缺失时不丢内容）
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const parsed = parseResultShape(text.slice(start, end + 1))
    if (parsed !== null) return parsed
  }
  return { result: text, sources: [] }
}

/** 从 start（必须是 '{'）起截出第一个花括号平衡的完整对象（null=扫不到闭合）。字符串内的
 *  括号与反斜杠转义不参与计数。 */
function sliceBalancedObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 解析 {result, sources} 形状（null=不是该形状/解析失败）。sources 条目校验 http(s) URL、
 *  title 缺省用 URL、最多 5 条。 */
function parseResultShape(json: string | null): { result: string; sources: Array<{ title: string; url: string }> } | null {
  if (json === null) return null
  let parsed: { result?: unknown; sources?: unknown }
  try {
    parsed = JSON.parse(json) as { result?: unknown; sources?: unknown }
  } catch {
    return null
  }
  const result = typeof parsed.result === 'string' ? parsed.result.trim() : ''
  if (result === '') return null
  const sources = Array.isArray(parsed.sources)
    ? parsed.sources
        .map((s) => s as { title?: unknown; url?: unknown })
        .filter((s) => typeof s.url === 'string' && /^https?:\/\//.test(s.url))
        .map((s) => ({ title: typeof s.title === 'string' && s.title !== '' ? s.title : String(s.url), url: String(s.url) }))
        .slice(0, 5)
    : []
  return { result, sources }
}

/** 来源列表附在补说文本末尾的固定格式。app 端：Markdown 渲染可点；TTS 前由
 *  MarkdownStripper 之后的处理剥掉 "---- 来源 ----" 起的整段（URL 不朗读）。 */
export function formatSourcesBlock(sources: Array<{ title: string; url: string }>): string {
  if (sources.length === 0) return ''
  const lines = sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n')
  return `\n\n---- 来源 ----\n${lines}`
}

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
  /** WebSocket 实时推送（可选：测试环境不建 hub，生产注入；代查状态帧经此广播）。 */
  hub?: import('../realtime/hub.ts').RealtimeHub
}

interface IncomingMessage {
  role: string
  content: unknown
}

/** 从 content parts 抽图片（data:image/...;base64,xxx）→ anthropic base64 block 形态。
 *  app 贴图经 WSOutgoing.chat 的 images 字段走 encodeMessages 的 content-parts。 */
export function extractContentImages(content: unknown): Array<{ mediaType: string; data: string }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ mediaType: string; data: string }> = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const url = (part as { image_url?: { url?: unknown } }).image_url?.url
    if (typeof url !== 'string' || !url.startsWith('data:image/')) continue
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(url)
    if (m === null) continue
    out.push({ mediaType: m[1].toLowerCase(), data: m[2] })
    if (out.length >= 4) break  // 每轮最多 4 图（体积与注意力平衡）
  }
  return out
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
      return c.json({ error: { message: 'messages 不能为空', type: 'invalid_request_error' } }, 400 )
    }
    // 客户端 / 技能选择器随轮携带的技能（prompt 注入；不进消息序列/落库）
    const skills = parseSkills(body?.skills)
    // 思考开关（默认开；快问快答场景关闭，GLM 端点原生 disabled 2.8s→1.1s）
    const disableThinking = body?.thinking === false

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
        if (content.trim() !== '') {
          if (m.role === 'user') {
            const images = extractContentImages(m.content)
            chatMessages.push(images.length > 0 ? { role: m.role, content, images } : { role: m.role, content })
          } else {
            chatMessages.push({ role: m.role, content })
          }
        }
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
      (config.brainApiFormat === 'hybrid' ? LOOKUP_GUIDANCE + THINKING_LANGUAGE_GUIDANCE + FORMATTING_GUIDANCE : '') +
      buildSkillSection(skills)

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
    // 多模态路由：带图轮次切视觉模型（GLM-5.3 收图但看不了；GLM-4.5V 实测可看）
    const hasImages = chatMessages.some((m) => m.images !== undefined && m.images.length > 0)
    const turnModel = hasImages && config.brainVisionModel !== '' ? config.brainVisionModel : config.brainModel

    return streamSSE(c, async (stream) => {
      // 流式透传 + [lookup] 标记感知（仅 hybrid 模式的回复会出现标记；非 hybrid 走同一逻辑零开销）
      let held = ''
      let markerFound = false
      try {
        for await (const data of streamChatCompletion({
          baseUrl: config.brainBaseUrl,
          apiKey: config.brainApiKey,
          model: turnModel,
          messages: upstreamMessages,
          signal: c.req.raw.signal,
          apiFormat: chatApiFormat,
          disableThinking,
        })) {
          // 推理过程 chunk：原样透传（不参与 [lookup] 标记感知，也不计入 assistantText 结算）
          if (extractReasoning(data) !== '') {
            await stream.writeSSE({ data })
            continue
          }
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
          hadImages: hasImages,  // vision 轮她已经直接看到图，兜底代读只会丢信息（review H1）
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
    hadImages?: boolean
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

    // 好感度短窗去重：客户端"重新生成"会原样重发同一句 lastUser（app 端删末条 assistant 后重跑
    // pipeline），若无去重她会对同一句话重复积累好感。相同 lastUser 在窗口内只结算一次；
    // 落库/记忆提取照常（她的记忆里两轮回答都在，只有好感度不重复算）。
    const settleKey = input.lastUser ?? ''
    const lastSettleAt = recentAffinitySettles.get(settleKey)
    const isDuplicateTurn =
      settleKey !== '' && lastSettleAt !== undefined && input.now.getTime() - lastSettleAt < AFFINITY_SETTLE_WINDOW_MS
    if (!isDuplicateTurn) {
      const before = getRelationship(db).affinity
      settleChatTurn(db, { userRepliedToProactive: input.userRepliedToProactive, now: input.now })
      const after = getRelationship(db).affinity
      const transition = checkStageTransition(db, persona, before, after)
      if (transition !== null) {
        console.log(`[relationship] 阶段跃迁 → ${transition.stage}（好感度 ${before} → ${after}），告白已排队`)
      }
      recentAffinitySettles.set(settleKey, input.now.getTime())
      if (recentAffinitySettles.size > RECENT_SETTLES_MAX) {
        // 防膨胀：清掉最旧一半（Map 迭代序 = 插入序）
        const keepFrom = Math.ceil(recentAffinitySettles.size / 2)
        const keys = [...recentAffinitySettles.keys()]
        keys.slice(0, keys.length - keepFrom).forEach((k) => recentAffinitySettles.delete(k))
      }
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
        recentFacts(db, 12).map((f) => f.content),  // 已有记忆注入 prompt，防复述重复提取
      )
    }

    // hybrid 二段：她答应去查 → 派 claude 代查 → 结果经通知通道让她主动说。
    // 失信兜底：转场了却没带标记时自动代读（detectUnfulfilledFileRead 注释里有实测背景）。
    // hybrid 守卫：[lookup] 协议只在 hybrid 注入，openai/anthropic 纯直连（可能没装 claude
    // CLI）与 claude-code 主聊天（她有工具自己能读）都不该派——review M2。
    // vision 轮跳过兜底：图她已直接看到，代读只会丢信息（review H1）。
    const fallbackQuery = config.brainApiFormat !== 'hybrid'
      ? null
      : (input.lookupQuery ?? (input.hadImages === true ? null : detectUnfulfilledFileRead(input.lastUser ?? '', input.assistantText)))
    if (fallbackQuery !== null && fallbackQuery !== '' && input.lastUser !== null && input.systemPrompt !== undefined) {
      if (input.lookupQuery === null) console.log(`[lookup] 失信兜底：转场无标记，自动代读 ${fallbackQuery}`)
      void lookupAndSay(deps, { query: fallbackQuery, userQuestion: input.lastUser, systemPrompt: input.systemPrompt })
    }
  } catch (err) {
    console.error('[gateway] 流后结算失败（不影响回复）:', err instanceof Error ? err.message : err)
  }
}

/** hybrid 二段查询：spawn claude 代查，结果入发件箱让她主动开口（失败也给一句人设化道歉）。 */
// ---- 代查任务状态（消灭等待黑洞：app 端常驻指示条）----

let activeLookupText: string | null = null
let activeLookupAbort: AbortController | null = null

/** 当前代查状态（轮询兜底通道用：无 WS 时 app 从 /v1/notifications 响应读取）。 */
export function currentLookupStatus(): string | null {
  return activeLookupText
}

/** 取消进行中的代查（app 指示条 ✕）。返回是否有可取消的任务。 */
export function cancelActiveLookup(): boolean {
  if (activeLookupAbort === null) return false
  activeLookupAbort.abort()
  return true
}

function setLookupStatus(deps: GatewayDeps, text: string | null): void {
  activeLookupText = text
  deps.hub?.broadcastLookupStatus(text)
}

/** 工具调用 → 指示条人话（代查过程可视化）。长输入截断防撑爆指示条。 */
export function toolStatusText(tool: string, input: Record<string, unknown>): string {
  const clip = (v: unknown, max = 40): string => {
    const s = typeof v === 'string' ? v : ''
    return s.length > max ? `${s.slice(0, max)}…` : s
  }
  switch (tool) {
    case 'WebSearch':
      return `她正在搜索：${clip(input.query)}`
    case 'WebFetch':
      return `她正在读网页：${clip(input.url)}`
    case 'Read':
      return `她正在读文件：${clip(input.file_path ?? input.path)}`
    case 'Glob':
      return `她正在找文件：${clip(input.pattern)}`
    case 'Grep':
      return `她正在搜内容：${clip(input.pattern)}`
    default:
      return '她正在查资料…'
  }
}

/** lookup 结果/失败落对话史：聊天窗有痕，她下一轮拿得到事实、不再瞎编"忘了查"。 */
function recordLookupTurn(db: CompanionDb, content: string): void {
  db.prepare(`INSERT INTO chat_history (role, content, created_at) VALUES (?, ?, ?)`).run(
    'assistant',
    content,
    new Date().toISOString(),
  )
}

/** 代查失败文案：原因译成人话（超时/故障），带上原问题让她和主人对得上号。 */
export function lookupFailText(query: string, reason: string): string {
  const shortReason = reason.includes('超时') ? '查了太久也没等到结果' : '查询管道出了点故障'
  return `[sad] 唔……刚才答应主人查的「${query.slice(0, 30)}」，${shortReason}，对不起嘛……`
}

/** 失信兜底：她回了转场话（"等我打开看看"）却没带 [lookup] 标记——GLM 对协议的遵循
 *  不稳（2026-10-27 实测文件路径场景连续两轮失信），主人会永远等不到下文。三条件兜底自动
 *  代派：用户消息含文件路径 + 她的回复是**承诺式短转场话** + 无标记。承诺式词表 +
 *  80 字长度约束把误伤压到最低（"打开/看看"是完整正常回答里的高频口语——review 实测
 *  咨询解答与 vision 直答轮都含，但它们都不是短转场话）。拒绝类话术不命中。 */
export function detectUnfulfilledFileRead(lastUser: string, assistantText: string): string | null {
  if (lastUser === '' || assistantText.includes(LOOKUP_MARKER)) return null
  const PROMISE_WORDS = /等我查|我去查|等我看看|我去看看|等我读|我去读|等我打开|我去打开|等我瞧|我去瞧/
  if (!PROMISE_WORDS.test(assistantText) || assistantText.length > 80) return null
  return looksLikeFilePath(lastUser)
}

/** 提取文本里的第一个本地文件路径（null=没有）。先剥掉 http(s) URL（域内 /photo.png
 *  形态与路径无法区分，必须整体移除），再匹配 ~ 或 / 起头的路径；排除中英文引号/括号。
 *  供失信兜底与代查 Read 引导共用（此前两处正则不一致有边界分歧——review L1）。 */
export function looksLikeFilePath(s: string): string | null {
  const m = s.replace(/https?:\/\/\S+/g, '').match(/(?:~|\/)[^\s，。；？！、）】【""()"'《》]*\.[A-Za-z0-9]{2,4}/)
  return m?.[0] ?? null
}

async function lookupAndSay(
  deps: GatewayDeps,
  input: { query: string; userQuestion: string; systemPrompt: string },
): Promise<void> {
  const { db, config, persona } = deps
  console.log(`[lookup] 派 claude 代查: ${input.query}`)
  const abort = new AbortController()
  activeLookupAbort = abort
  setLookupStatus(deps, '她正在查资料…')
  try {
    let raw = ''
    for await (const data of streamChatCompletion({
      baseUrl: '',
      apiKey: '',
      model: config.brainModel,
      signal: abort.signal,
      messages: [
        // 精简代查指令（不用聊天 systemPrompt——含对话史/事件会把代查带偏，
        // 2026-10-27 实测：query 是简历截图、claude 顺着上下文回了天气）
        { role: 'system', content: `你是${persona.name}，正在替主人查一件小事。无论上下文提到过什么，只完成当前这一个查询任务，输出人设化的口语结论。` },
        {
          role: 'user',
          content: `主人刚才问你："${input.userQuestion}"。你已经查到了，把结果告诉主人。${looksLikeFilePath(input.query) !== null ? '问题里是文件路径：先用 Read 工具读取该文件（Read 支持 txt/md/json/代码等纯文本；.docx/.xlsx 等二进制格式读不了就如实说明）。' : ''}**严格按 JSON 输出**，不要输出 JSON 以外的任何内容：
{"result": "一到三句口语化结论（数字/事实要具体，以 [emotion] 标签开头；查到相关图片可在末尾用 ![描述](图片URL) 嵌入）", "sources": [{"title": "来源标题", "url": "真实抓到的来源URL"}]}
规则：result 正文不要纯文本链接；sources 给 1~5 条你真正查过的出处（WebSearch/WebFetch 实际访问过的 URL），**绝不编造**；没有可靠来源就给空数组。不要提"工具""查询""系统"这些字眼。要查的问题：${input.query}`,
        },
      ],
      apiFormat: 'claude-code',
      timeoutMs: 300_000,  // 搜图等多轮 WebSearch/WebFetch 常超 120s（2026-10-26 实测超时）
      onToolEvent: ({ tool, input }) => {
        setLookupStatus(deps, toolStatusText(tool, input))
      },
    })) {
      raw += extractDelta(data)
    }
    const { result, sources } = parseLookupResult(raw)
    // 占位符是给聊天流防卡死的，outbox 一次性播出不需要，剥掉
    const text = result.replace(TOOL_USE_PLACEHOLDER, '').trim() + formatSourcesBlock(sources)
    if (text.trim() !== '') {
      enqueueSay(db, text, 'lookup')
      recordLookupTurn(db, text)
      console.log(`[lookup] 结果已入队: ${text.slice(0, 60)}（来源 ${sources.length} 条）`)
    }
    // 归属校验：并发代查时新任务已覆盖 activeLookupAbort/指示条，旧任务不得清它们
    // （review H2：旧 finally 抹掉新 abort 会让指示条 ✕ 失效、任务在跑指示条却消失）
    if (activeLookupAbort === abort) setLookupStatus(deps, null)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn('[lookup] 代查失败:', reason)
    // 用户主动取消不算失败安抚场景（已说了要停）
    if (abort.signal.aborted) {
      if (activeLookupAbort === abort) setLookupStatus(deps, null)
      return
    }
    const text = lookupFailText(input.query, reason)
    enqueueSay(db, text, 'lookup-error')
    recordLookupTurn(db, text)
    setLookupStatus(deps, '查询失败了')
    setTimeout(() => {
      if (activeLookupText === '查询失败了') setLookupStatus(deps, null)
    }, 2_000)
  } finally {
    if (activeLookupAbort === abort) activeLookupAbort = null
  }
}
