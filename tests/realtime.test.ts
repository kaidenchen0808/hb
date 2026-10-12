import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { openDb, type CompanionDb } from '../src/db/database.ts'
import { loadPersona } from '../src/persona/loader.ts'
import { createApp } from '../src/http/app.ts'
import type { AppConfig } from '../src/config.ts'
import { enqueueSay, drainOutbox } from '../src/memory/outbox.ts'
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub.ts'

let db: CompanionDb
let server: ServerType
let hub: RealtimeHub
let port = 0
const socketsToClose: WebSocket[] = []

interface Frame {
  type: string
  id?: string
  text?: string
  source?: string
  action?: string
  payload?: Record<string, unknown>
}

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(async () => {
  for (const ws of socketsToClose.splice(0)) {
    try { ws.close() } catch { /* already closed */ }
  }
  hub.stop()
  await new Promise<void>((r) => server.close(() => r()))
})

async function startServer(companionApiKey: string | null = null): Promise<string> {
  const config: AppConfig = {
    port: 0,
    dbPath: ':memory:',
    personaPath: 'unused',
    brainBaseUrl: '',
    brainApiKey: '',
    brainModel: '',
    brainApiFormat: 'openai' as const,
    companionApiKey,
    reactionsEnabled: false,
    reactionMinIntervalSec: 900,
  }
  const persona = loadPersona(new URL('../persona/persona.yaml', import.meta.url).pathname)
  hub = createRealtimeHub(db, companionApiKey)
  const app = createApp({ db, config, persona, hub })
  server = serve({ fetch: app.fetch, port: 0 })
  await new Promise<void>((r) => server.once('listening', r))
  port = (server.address() as { port: number }).port
  hub.attach(server)
  return `ws://127.0.0.1:${port}/v1/ws`
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => { socketsToClose.push(ws); resolve(ws) }
    ws.onerror = () => reject(new Error('ws connect failed'))
    setTimeout(() => reject(new Error('ws connect timeout')), 3000)
  })
}

function connectExpectFailure(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onerror = () => resolve() // 预期失败：握手被拒
    ws.onopen = () => { ws.close(); reject(new Error('should not connect')) }
    setTimeout(() => reject(new Error('ws timeout')), 3000)
  })
}

function nextFrame(ws: WebSocket): Promise<Frame> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage as EventListener)
      throw new Error('frame timeout')
    }, 3000)
    const onMessage = (ev: MessageEvent) => {
      clearTimeout(timer)
      resolve(JSON.parse(String(ev.data)) as Frame)
    }
    ws.addEventListener('message', onMessage as EventListener)
  })
}

describe('realtime hub（/v1/ws）', () => {
  it('say 帧推送：入队 → notifyEnqueued → 客户端收到，库内标记已投递', async () => {
    const url = await startServer()
    const ws = await connect(url)
    const framePromise = nextFrame(ws)
    enqueueSay(db, '[happy] 测试推送', 'test')
    // 500ms 兜底扫描兜住（notifyEnqueued 未直调也能到，只是稍慢）
    const frame = await framePromise
    expect(frame.type).toBe('say')
    expect(frame.text).toBe('[happy] 测试推送')
    expect(frame.source).toBe('test')
    // 推送即标记：轮询通道不会再取到
    await new Promise((r) => setTimeout(r, 100))
    expect(drainOutbox(db)).toHaveLength(0)
  })

  it('notifyEnqueued 让进程内入队 ~50ms 到帧（快于 500ms 兜底）', async () => {
    const url = await startServer()
    const ws = await connect(url)
    const framePromise = nextFrame(ws)
    const t0 = Date.now()
    enqueueSay(db, '快速通道', 'test')
    hub.notifyEnqueued() // /api/say 路由内就是这么调的
    const frame = await framePromise
    expect(frame.text).toBe('快速通道')
    // 去抖 50ms + 网络往返，远小于 500ms 兜底间隔
    expect(Date.now() - t0).toBeLessThan(450)
  })

  it('多客户端广播：两个连接收到同一条（比轮询先到先得更公平）', async () => {
    const url = await startServer()
    const ws1 = await connect(url)
    const ws2 = await connect(url)
    const p1 = nextFrame(ws1)
    const p2 = nextFrame(ws2)
    enqueueSay(db, '大家都听到', 'test')
    const [f1, f2] = await Promise.all([p1, p2])
    expect(f1.id).toBe(f2.id)
    expect(f1.text).toBe('大家都听到')
  })

  it('新连接立即扫积压：断线窗口期的消息不丢', async () => {
    const url = await startServer()
    enqueueSay(db, '你不在时我说的', 'test') // 无连接时入队
    const ws = await connect(url) // 连上后 attach 回调里 scan()
    const frame = await nextFrame(ws)
    expect(frame.text).toBe('你不在时我说的')
  })

  it('command 帧广播（P4 的 setModel 通道）', async () => {
    const url = await startServer()
    const ws = await connect(url)
    const framePromise = nextFrame(ws)
    hub.broadcastCommand('setModel', { filename: 'AliciaSolid.vrm' })
    const frame = await framePromise
    expect(frame.type).toBe('command')
    expect(frame.action).toBe('setModel')
    expect(frame.payload).toEqual({ filename: 'AliciaSolid.vrm' })
  })

  it('鉴权：配置 COMPANION_API_KEY 后无凭证握手被拒', async () => {
    const url = await startServer('secret-key')
    await connectExpectFailure(url)
  })

  it('轮询回落通道带能力广告头', async () => {
    await startServer()
    const res = await fetch(`http://127.0.0.1:${port}/v1/notifications`)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Companion-Realtime')).toBe('1')
  })
})
