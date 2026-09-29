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
  /** openai: /chat/completions；anthropic: /v1/messages（SSE 转换为 OpenAI chunk 输出） */
  apiFormat?: 'openai' | 'anthropic'
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
  if (opts.apiFormat === 'anthropic') {
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
