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
let upstreamBodies: Array<{ messages: Array<{ role: string; content: string }> }> = []

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
    brainApiFormat: 'openai' as const,
    companionApiKey: null,
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
