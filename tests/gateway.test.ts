import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Hono } from 'hono'
import { openDb, type CompanionDb } from '../src/db/database.ts'
import { loadPersona } from '../src/persona/loader.ts'
import { createApp } from '../src/http/app.ts'
import type { AppConfig } from '../src/config.ts'
import { insertEvent } from '../src/memory/eventStore.ts'
import { getRelationship } from '../src/memory/relationship.ts'

let db: CompanionDb
let upstream: Server
let upstreamPort = 0
let upstreamBodies: Array<{ model?: string; messages: Array<{ role: string; content: string }> }> = []

// mock 大脑：记录收到的 messages，回放固定 SSE
beforeEach(async () => {
  db = openDb(':memory:')
  upstreamBodies = []
  upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      upstreamBodies.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '[happy] ' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '主人你来啦！' } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = (upstream.address() as { port: number }).port
})

afterEach(async () => {
  await new Promise<void>((r) => upstream.close(() => r()))
})

function makeApp(brainReady: boolean): Hono {
  const config: AppConfig = {
    port: 0,
    dbPath: ':memory:',
    personaPath: 'unused',
    brainBaseUrl: brainReady ? `http://127.0.0.1:${upstreamPort}/v1` : '',
    brainApiKey: brainReady ? 'test-key' : '',
    brainModel: brainReady ? 'test-model' : '',
    brainVisionModel: 'GLM-4.5V',
    brainApiFormat: 'openai' as const,
    companionApiKey: null,
    reactionsEnabled: false, // 测试里关掉，避免 mock 上游被反应生成调用
    reactionMinIntervalSec: 900,
  }
  const persona = loadPersona(new URL('../persona/persona.yaml', import.meta.url).pathname)
  return createApp({ db, config, persona })
}

describe('chat gateway', () => {
  it('人格替换：app 的 system 被丢弃，注入小满人格与工作上下文', async () => {
    insertEvent(db, { agent: 'claude-code', event_type: 'session_completed', summary: '测试全过' })
    const app = makeApp(true)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'whatever',
        stream: true,
        messages: [
          { role: 'system', content: 'You are 小光 (Xiaoguang), a virtual girl... 17 years old' },
          { role: 'user', content: '在吗' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    await res.text() // 消费完整 SSE 流，确保上游请求与流后结算完成

    const upstreamMsgs = upstreamBodies[0].messages
    expect(upstreamMsgs[0].role).toBe('system')
    expect(upstreamMsgs[0].content).toContain('小满')
    expect(upstreamMsgs[0].content).not.toContain('Xiaoguang')
    expect(upstreamMsgs[0].content).toContain('测试全过') // 未消费事件被注入
    expect(upstreamMsgs.some((m) => m.role === 'user' && m.content === '在吗')).toBe(true)
  })

  it('SSE 透传：data 行 + [DONE]，结算后事件被消费、好感度上涨', async () => {
    insertEvent(db, { agent: 'codex', event_type: 'task_failed', summary: '构建失败' })
    const app = makeApp(true)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        stream: true,
        messages: [{ role: 'user', content: '干嘛呢' }],
      }),
    })
    const text = await res.text()
    expect(text).toContain('data: ')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(text).toContain('主人你来啦')

    // 流后结算（同步部分立即生效）
    const consumed = db.prepare(`SELECT COUNT(*) AS n FROM agent_events WHERE consumed_at IS NULL`).get() as { n: number }
    expect(consumed.n).toBe(0)
    expect(getRelationship(db).affinity).toBeGreaterThan(0)
    const chat = db.prepare(`SELECT COUNT(*) AS n FROM chat_history`).get() as { n: number }
    expect(chat.n).toBe(2) // user + assistant
  })

  it('重生成去重：相同 lastUser 短窗内好感度只结算一次，落库照常', async () => {
    const app = makeApp(true)
    const body = JSON.stringify({
      model: 'x',
      stream: true,
      messages: [{ role: 'user', content: '这题怎么写' }],
    })
    const first = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    await first.text()
    const afterFirst = getRelationship(db).affinity

    // 客户端"重新生成"：同一句 lastUser 原样重发
    const second = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    await second.text()
    const afterSecond = getRelationship(db).affinity

    expect(afterFirst).toBeGreaterThan(0)
    expect(afterSecond).toBe(afterFirst) // 好感度未重复结算
    // 但她的记忆里两轮都在（重生成不是没发生）
    const chat = db.prepare(`SELECT COUNT(*) AS n FROM chat_history WHERE role = 'user'`).get() as { n: number }
    expect(chat.n).toBe(2)
  })

  it('好感度去重不影响不同消息：各结算一次', async () => {
    const app = makeApp(true)
    for (const content of ['第一句', '第二句']) {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content }] }),
      })
      await res.text()
    }
    expect(getRelationship(db).affinity).toBeGreaterThan(1) // 两轮都加了
  })

  it('大脑未配置：降级回复且带情绪标签', async () => {
    const app = makeApp(false)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: '在吗' }] }),
    })
    const text = await res.text()
    expect(text).toContain('[sad]')
    expect(text).toContain('[DONE]')
  })

  it('非法请求体：400', async () => {
    const app = makeApp(true)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('hybrid [lookup] 标记处理', () => {
  it('splitLookup 分离回复与查询', async () => {
    const { splitLookup } = await import('../src/http/gateway.ts')
    expect(splitLookup('[happy] 等我查一下哦～\n[lookup] 深圳今天天气')).toEqual({
      reply: '[happy] 等我查一下哦～\n',
      query: '深圳今天天气',
    })
    expect(splitLookup('[happy] 普通回复')).toEqual({ reply: '[happy] 普通回复', query: null })
    expect(splitLookup('转场\n[lookup]  [curious] 查一下股票')).toEqual({ reply: '转场\n', query: '查一下股票' })
    expect(splitLookup('只有标记 [lookup]')).toEqual({ reply: '只有标记 ', query: null })
  })

  it('partialLookupMarkerLen 识别不完整前缀', async () => {
    const { partialLookupMarkerLen } = await import('../src/http/gateway.ts')
    expect(partialLookupMarkerLen('你好[look')).toBe(5)
    expect(partialLookupMarkerLen('[')).toBe(1)
    expect(partialLookupMarkerLen('abc')).toBe(0)
    expect(partialLookupMarkerLen('xx[lookup]yy')).toBe(0) // 完整标记已出现，由 indexOf 分支处理
  })
})

describe('skills 注入', () => {
  it('parseSkills：合法条目通过、坏条目跳过、合计截断', async () => {
    const { parseSkills, buildSkillSection } = await import('../src/http/gateway.ts')
    expect(parseSkills(null)).toEqual([])
    expect(parseSkills([{ name: 'a', content: '方法论' }])).toEqual([{ name: 'a', content: '方法论' }])
    // name 缺失 / content 空 / 非对象 → 跳过
    expect(parseSkills([{ content: 'x' }, { name: 'b' }, 'junk', { name: 'b', content: 'y' }]))
      .toEqual([{ name: 'b', content: 'y' }])
    // 单技能截 4000
    const long = parseSkills([{ name: 'big', content: '字'.repeat(9000) }])
    expect(long[0].content.length).toBe(4000)
    // 合计截 8000：第二个技能只剩 4000 额度
    const two = parseSkills([
      { name: 'a', content: 'x'.repeat(4000) },
      { name: 'b', content: 'y'.repeat(5000) },
    ])
    expect(two[1].content.length).toBe(4000)
    // 段拼装
    expect(buildSkillSection([])).toBe('')
    expect(buildSkillSection([{ name: 't', content: 'c' }])).toContain('### t')
  })

  it('带 skills 的请求：技能进大脑 system、不落 chat_history', async () => {
    const app = makeApp(true)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        stream: true,
        messages: [{ role: 'user', content: '技能轮测试' }],
        skills: [{ name: 'translate', content: '中英互译方法论' }],
      }),
    })
    await res.text()
    // 技能文本不出现在她的记忆里（只进大脑 system）
    const leaked = db.prepare(`SELECT COUNT(*) AS n FROM chat_history WHERE content LIKE '%方法论%'`).get() as { n: number }
    expect(leaked.n).toBe(0)
    // 大脑确实收到了技能段
    const sys = upstreamBodies[upstreamBodies.length - 1].messages.find((m) => m.role === 'system')
    expect(sys?.content).toContain('### translate')
  })
})

describe('代查结果 JSON 解析（引用来源）', () => {
  it('parseLookupResult：标准 JSON 拆 result + sources', async () => {
    const { parseLookupResult, formatSourcesBlock } = await import('../src/http/gateway.ts')
    const raw = '{"result": "[happy] 今天上海晴 24 度", "sources": [{"title": "天气网", "url": "https://t.com/a"}, {"title": "新闻", "url": "https://n.com/b"}]}'
    const parsed = parseLookupResult(raw)
    expect(parsed.result).toBe('[happy] 今天上海晴 24 度')
    expect(parsed.sources).toHaveLength(2)
    expect(formatSourcesBlock(parsed.sources)).toContain('[天气网](https://t.com/a)')
  })

  it('容错：markdown 代码块包裹 / 纯文本 / 无 sources / 坏 URL 过滤 / 超 5 条截断', async () => {
    const { parseLookupResult } = await import('../src/http/gateway.ts')
    // markdown 包裹
    const wrapped = '```json\n{"result": "结论", "sources": []}\n```'
    expect(parseLookupResult(wrapped).result).toBe('结论')
    // 纯文本兜底（永不丢内容）
    expect(parseLookupResult('就是一句普通回复')).toEqual({ result: '就是一句普通回复', sources: [] })
    // 坏条目过滤：非 http URL 跳过、title 缺省用 URL
    const dirty = parseLookupResult('{"result": "r", "sources": [{"url": "ftp://x"}, {"url": "https://ok.com/1"}, {"title": "t", "url": "javascript:alert(1)"}]}')
    expect(dirty.sources).toEqual([{ title: 'https://ok.com/1', url: 'https://ok.com/1' }])
    // 超 5 条截断
    const many = parseLookupResult('{"result": "r", "sources": ' + JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, url: `https://x.com/${i}` }))
    ) + '}')
    expect(many.sources).toHaveLength(5)
  })
})

describe('贴图多模态路由', () => {
  it('extractContentImages：data-URI 抽取/上限4/非图过滤', async () => {
    const { extractContentImages } = await import('../src/http/gateway.ts')
    const parts = [
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      { type: 'image_url', image_url: { url: 'https://not-data.com/a.png' } },  // 非 data-URI 忽略
    ]
    expect(extractContentImages(parts)).toEqual([{ mediaType: 'image/png', data: 'QUJD' }])
    expect(extractContentImages('普通字符串')).toEqual([])
    expect(extractContentImages([{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,WA==' } }]))
      .toEqual([{ mediaType: 'image/jpeg', data: 'WA==' }])
  })

  it('带图请求路由到视觉模型（upstream 收到 vision model + image block）', async () => {
    const app = makeApp(true)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'x', stream: true,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          { type: 'text', text: '图里是什么' },
        ] }],
      }),
    })
    await res.text()
    const body = upstreamBodies[upstreamBodies.length - 1]
    expect(body.model).toBe('GLM-4.5V')
  })
})

describe('代查过程可视化（onToolEvent → 指示条文案）', () => {
  it('toolStatusText：工具调用译成人话，长输入截断', async () => {
    const { toolStatusText } = await import('../src/http/gateway.ts')
    expect(toolStatusText('WebSearch', { query: '深圳天气' })).toBe('她正在搜索：深圳天气')
    expect(toolStatusText('WebFetch', { url: 'https://example.com/a' })).toBe('她正在读网页：https://example.com/a')
    expect(toolStatusText('Read', { file_path: '/tmp/a.md' })).toBe('她正在读文件：/tmp/a.md')
    expect(toolStatusText('Glob', { pattern: '*.pptx' })).toBe('她正在找文件：*.pptx')
    expect(toolStatusText('Grep', { pattern: 'foo' })).toBe('她正在搜内容：foo')
    expect(toolStatusText('Unknown', {})).toBe('她正在查资料…')
    const long = 'x'.repeat(60)
    expect(toolStatusText('WebSearch', { query: long })).toBe(`她正在搜索：${'x'.repeat(40)}…`)
  })

  it('toolStatusText：非字符串输入不炸（空串兜底）', async () => {
    const { toolStatusText } = await import('../src/http/gateway.ts')
    expect(toolStatusText('WebSearch', { query: 123 })).toBe('她正在搜索：')
  })

  it('lookupFailText：超时/故障两态 + 问题截断 30 字', async () => {
    const { lookupFailText } = await import('../src/http/gateway.ts')
    expect(lookupFailText('大盘', 'claude-code 超时（300s）')).toContain('查了太久也没等到结果')
    expect(lookupFailText('大盘', 'claude CLI 退出码 1: xxx')).toContain('查询管道出了点故障')
    expect(lookupFailText('大盘', 'x')).toContain('「大盘」')
    const longQ = '问'.repeat(50)
    expect(lookupFailText(longQ, '超时')).not.toContain('问'.repeat(31))
  })
})

describe('extractClaudeToolUse（stream-json 工具事件提取）', () => {
  it('完整 assistant 块提取 name+input', async () => {
    const { extractClaudeToolUse } = await import('../src/brain/llmClient.ts')
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '' }, { type: 'tool_use', name: 'WebSearch', input: { query: 'A股收盘' } }] },
    })
    expect(extractClaudeToolUse(line)).toEqual({ name: 'WebSearch', input: { query: 'A股收盘' } })
  })

  it('非工具调用行/坏 JSON/缺 name 均返回 null', async () => {
    const { extractClaudeToolUse } = await import('../src/brain/llmClient.ts')
    expect(extractClaudeToolUse(JSON.stringify({ type: 'result', result: 'ok' }))).toBeNull()
    expect(extractClaudeToolUse('not json')).toBeNull()
    expect(extractClaudeToolUse(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: {} }] } }))).toBeNull()
  })
})
