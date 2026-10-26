import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  temperature?: number
  /** openai: /chat/completions；anthropic: /v1/messages；claude-code: spawn claude -p 子进程（带只读工具） */
  apiFormat?: 'openai' | 'anthropic' | 'claude-code'
}

export class LlmUnavailableError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'LlmUnavailableError'
    this.status = status
  }
}

/** 统一入口：按 apiFormat 分发。输出恒为 OpenAI chunk JSON 字符串（真流式）。 */
export async function* streamChatCompletion(opts: StreamChatOptions): AsyncGenerator<string> {
  if (opts.apiFormat === 'claude-code') {
    yield* streamClaudeCode(opts)
  } else if (opts.apiFormat === 'anthropic') {
    yield* streamAnthropic(opts)
  } else {
    yield* streamOpenai(opts)
  }
}

async function startUpstream(url: string, headers: Record<string, string>, body: string, signal?: AbortSignal): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      signal,
    })
  } catch (err) {
    throw new LlmUnavailableError(`无法连接大脑网关 ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok || res.body === null) {
    const text = res.body === null ? '' : await res.text().catch(() => '')
    throw new LlmUnavailableError(`大脑网关返回 ${res.status}: ${text.slice(0, 300)}`, res.status)
  }
  return res
}

/** SSE 行迭代器：yield 每条 data 载荷（无共享状态，天然支持并发流）。 */
async function* sseDataLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '').trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue // event:/注释行与 data 的配对不需要：载荷 JSON 自描述
        const data = line.slice(5).trim()
        if (data !== '') yield data
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** OpenAI 兼容：原始 data 载荷直接透传（已是 OpenAI chunk 格式）。 */
async function* streamOpenai(opts: StreamChatOptions): AsyncGenerator<string> {
  const res = await startUpstream(
    `${opts.baseUrl}/chat/completions`,
    { Authorization: `Bearer ${opts.apiKey}` },
    JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    opts.signal,
  )
  for await (const data of sseDataLines(res)) {
    if (data !== '[DONE]') yield data
  }
}

/** Anthropic 兼容：/v1/messages 的 content_block_delta 转成 OpenAI chunk。 */
async function* streamAnthropic(opts: StreamChatOptions): AsyncGenerator<string> {
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))
  const res = await startUpstream(
    `${opts.baseUrl}/v1/messages`,
    { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
    JSON.stringify({
      model: opts.model,
      system: system === '' ? undefined : system,
      messages: rest,
      max_tokens: 2048,
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    opts.signal,
  )
  const id = crypto.randomUUID()
  for await (const data of sseDataLines(res)) {
    try {
      const evt = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
        yield wrapAsChunk(id, opts.model, evt.delta.text)
      }
    } catch {
      // 非 JSON 载荷忽略
    }
  }
}

// ---- claude-code 子进程模式（她的"手"）----

/** 只读工具白名单：她能看能查，但不能改、不能删、不能跑任意命令。 */
const CLAUDE_CODE_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
const CLAUDE_CODE_TIMEOUT_MS = 120_000
/** 工具调用期间的流式提示语（只插一次，防止长时间无输出像卡死）。 */
export const TOOL_USE_PLACEHOLDER = '（等我查一下哦…）'

/** 解析 claude -p --output-format stream-json 的一行，返回 assistant 文本；无文本返回 null。纯函数可测。 */
export function extractClaudeAssistantText(line: string): string | null {
  let evt: unknown
  try {
    evt = JSON.parse(line)
  } catch {
    return null
  }
  const e = evt as { type?: string; message?: { content?: unknown } }
  if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return null
  const text = (e.message!.content as { type: string; text?: string }[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
  return text === '' ? null : text
}

/** 解析同上的一行，返回 assistant 的 thinking（推理过程）块文本；无则 null。纯函数可测。
 *  claude 的 stream-json 里 thinking 整块到达（非 token 流）；块的字段名是 `thinking`
 *  （实测键：type/thinking/signature——不是 text 块的 text）。 */
export function extractClaudeThinking(line: string): string | null {
  let evt: unknown
  try {
    evt = JSON.parse(line)
  } catch {
    return null
  }
  const e = evt as { type?: string; message?: { content?: unknown } }
  if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return null
  const thinking = (e.message!.content as { type: string; thinking?: string }[])
    .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '')
    .map((b) => b.thinking)
    .join('\n\n')
  return thinking === '' ? null : thinking
}

/** 该行是否含 tool_use 块（用于插入"查一下"占位）。纯函数可测。 */
export function claudeLineHasToolUse(line: string): boolean {
  try {
    const e = JSON.parse(line) as { type?: string; message?: { content?: { type: string }[] } }
    return e.type === 'assistant' && Array.isArray(e.message?.content) && e.message!.content.some((b) => b.type === 'tool_use')
  } catch {
    return false
  }
}

/** 把 messages 组装成喂给 claude -p 的 stdin（system 已通过 --system-prompt 传入）。 */
function buildConversationPrompt(messages: ChatMessage[]): string {
  const rest = messages.filter((m) => m.role !== 'system')
  if (rest.length === 0) return '（主动跟主人打个招呼吧）'
  const lines = rest.map((m) => `${m.role === 'user' ? '主人' : '你'}：${m.content}`)
  return `${lines.join('\n\n')}\n\n（请以"你"的身份自然回应最后一条消息）`
}

/** claude CLI 的常见安装位置（launchd 环境的 PATH 不含用户级 bin，spawn 'claude' 会 ENOENT）。
 * 顺序即优先级；找不到返回 null，由调用方走原 PATH spawn（保留旧错误形状）。 */
export function resolveClaudeCli(): string | null {
  const home = homedir()
  const candidates = [
    'claude', // PATH 命中（交互启动的服务进程）
    `${home}/.claude/local/claude`,
    `${home}/.npm-global/bin/claude`,
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch {
      // 继续探测下一个
    }
  }
  return null
}

/** claude-code 模式专属：让模型知道自己有工具可用（人格 prompt 里没有这段）。 */
const TOOL_GUIDANCE = `

## 你还有一双"手"
你可以使用这些工具：Read（读文件）、Glob/Grep（搜代码）、WebSearch（联网搜索）、WebFetch（抓网页）。
当主人问需要外部信息的问题（天气、新闻、资料、他电脑里的内容）时，先悄悄用工具查，
再用一两句人话把结果讲给他听——就像你本来就知道一样，不用说"我调用了工具"。
查不到就说查不到，不要编造。
回复是语音播报的：绝不要输出链接、URL、"Sources"列表或 markdown 格式，来源用"天气网上说"这类口语自然带过。`

/** claude-code 模式：spawn claude -p 子进程，流式解析 JSONL 输出转 OpenAI chunk。 */
async function* streamClaudeCode(opts: StreamChatOptions): AsyncGenerator<string> {
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const prompt = buildConversationPrompt(opts.messages)
  const id = crypto.randomUUID()

  // launchd 拉起的服务进程 PATH 不含用户级 bin（~/.npm-global 等），裸 'claude' 会 ENOENT
  // —— 逐个常见安装位置探测出绝对路径；同时把它的目录补进子进程 PATH（claude 自身还要 node）。
  const claudeBin = resolveClaudeCli()
  if (claudeBin === null) {
    throw new LlmUnavailableError('claude CLI 启动失败（是否已安装并在 PATH?）: 所有常见安装位置均未找到')
  }
  const child = spawn(
    claudeBin,
    [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--system-prompt', (system === '' ? 'You are a helpful assistant.' : system) + TOOL_GUIDANCE,
      '--allowedTools', CLAUDE_CODE_ALLOWED_TOOLS.join(','),
    ],
    {
      cwd: homedir(),
      env: { ...process.env, PATH: `${dirname(claudeBin)}:${process.env.PATH ?? ''}` },
      stdio: ['pipe', 'pipe', 'pipe'] as const,
    },
  )

  let stderrText = ''
  child.stderr.on('data', (d: Buffer) => {
    stderrText += d.toString()
    if (stderrText.length > 2000) stderrText = stderrText.slice(-2000)
  })
  child.stdin.on('error', () => {}) // spawn 失败时的 EPIPE 由 error 分支统一处理

  const timedOut = { value: false }
  const timer = setTimeout(() => {
    timedOut.value = true
    child.kill('SIGKILL')
  }, CLAUDE_CODE_TIMEOUT_MS)
  const onAbort = () => child.kill('SIGKILL')
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  let exited: { code: number | null } | null = null
  // 对象包装：闭包内赋值的原始类型 let 会被 CFA 窄化为 never（timedOut 同理）
  const spawnError = { err: null as Error | null }
  const exitedPromise = new Promise<{ code: number | null }>((resolve) => {
    child.on('error', (err) => {
      spawnError.err = err
      resolve({ code: null })
    })
    child.on('close', (code) => {
      exited = { code }
      resolve({ code })
    })
  })

  child.stdin.write(prompt)
  child.stdin.end()

  let placeholderSent = false
  try {
    const rl = createInterface({ input: child.stdout })
    for await (const line of rl) {
      if (placeholderSent === false && claudeLineHasToolUse(line)) {
        placeholderSent = true
        yield wrapAsChunk(id, opts.model === '' ? 'claude-code' : opts.model, TOOL_USE_PLACEHOLDER)
      }
      // 推理过程（thinking 块整块先于正文到达）→ reasoning_content chunk，app 端折叠展示
      const thinking = extractClaudeThinking(line)
      if (thinking !== null) yield wrapAsReasoningChunk(id, opts.model === '' ? 'claude-code' : opts.model, thinking)
      const text = extractClaudeAssistantText(line)
      if (text !== null) yield wrapAsChunk(id, opts.model === '' ? 'claude-code' : opts.model, text)
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    clearTimeout(timer)
  }

  const result = exited ?? (await exitedPromise)
  if (timedOut.value) throw new LlmUnavailableError('claude-code 超时（120s）')
  if (spawnError.err !== null) {
    throw new LlmUnavailableError(`claude CLI 启动失败（是否已安装并在 PATH?）: ${spawnError.err.message}`)
  }
  if (result.code !== 0) {
    throw new LlmUnavailableError(`claude CLI 退出码 ${result.code}: ${stderrText.slice(-300)}`)
  }
}

/** 从一条 SSE data 载荷里取增量文本；无法解析或无内容时返回空串。 */
export function extractDelta(dataPayload: string): string {
  try {
    const obj = JSON.parse(dataPayload) as {
      choices?: { delta?: { content?: string }; text?: string }[]
    }
    const choice = obj.choices?.[0]
    return choice?.delta?.content ?? choice?.text ?? ''
  } catch {
    return ''
  }
}

/** 抽 chunk 的推理增量（delta.reasoning_content）；非 reasoning chunk 返回空串。 */
export function extractReasoning(dataPayload: string): string {
  try {
    const obj = JSON.parse(dataPayload) as {
      choices?: { delta?: { reasoning_content?: string } }[]
    }
    return obj.choices?.[0]?.delta?.reasoning_content ?? ''
  } catch {
    return ''
  }
}

/** 组装一条标准的 OpenAI 流式 chunk。 */
export function wrapAsChunk(id: string, model: string, content: string): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })
}

/** 推理过程 chunk（DeepSeek 通行标准 delta.reasoning_content）。只读 delta.content 的
 *  传统消费者（facts/reactionGen 的 extractDelta）拿到 undefined 自然忽略——零破坏。 */
export function wrapAsReasoningChunk(id: string, model: string, reasoning: string): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
  })
}
