import type { IncomingMessage } from 'node:http'
import type { ServerType } from '@hono/node-server'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CompanionDb } from '../db/database.ts'
import { markDelivered, peekOutbox } from '../memory/outbox.ts'

/**
 * WebSocket 实时推送：AniCompanion 长连 /v1/ws，outbox 有新话 <500ms 推过去，
 * 替代 3s 轮询（轮询保留为回落通道）。
 *
 * 协议（server→client，带 type 前向兼容）：
 *   {type:"say", id, text, source}                — 她要说的话（含 [emotion] 标签）
 *   {type:"command", action, payload?}            — 指令（P4：setModel 等）
 * client→server：
 *   {type:"ack", id}                              — v1 收下不处理（at-most-once 保持不变）
 *
 * 跨进程可见性：MCP 是独立进程直写 SQLite，本进程不感知 → 500ms 定时扫描兜底；
 * 进程内入队点调 notifyEnqueued() 触发 ~50ms 去抖立即扫描（近乎零延迟）。
 */

export interface SayFrame {
  type: 'say'
  id: string
  text: string
  source: string
}

export interface CommandFrame {
  type: 'command'
  action: string
  payload?: Record<string, unknown>
}

export type ServerFrame = SayFrame | CommandFrame

const SCAN_INTERVAL_MS = 500 // 兜底轮询：覆盖 MCP 等跨进程直写
const NUDGE_DELAY_MS = 50 // 进程内入队后的去抖立即扫描
const WS_PATH = '/v1/ws'

export class RealtimeHub {
  private readonly clients = new Set<WebSocket>()
  private wss: WebSocketServer | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private nudgeTimer: NodeJS.Timeout | null = null
  private scanning = false

  constructor(
    private readonly db: CompanionDb,
    private readonly apiKey: string | null,
  ) {}

  /** 挂到 @hono/node-server 返回的原生 server 上（Hono app 不用动）。 */
  attach(server: ServerType): void {
    this.wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== WS_PATH) {
        socket.destroy() // 本服务只有这一个 WS 路径，其余升级请求一律拒绝
        return
      }
      if (!this.authorized(req, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws)
        ws.on('close', () => this.clients.delete(ws))
        ws.on('message', (data) => this.handleClientFrame(String(data)))
        this.scan() // 新连接立即扫一次：防消息落在断线窗口里被 500ms 兜底延迟
      })
    })
    this.scanTimer = setInterval(() => this.scan(), SCAN_INTERVAL_MS)
    this.scanTimer.unref()
  }

  /** 进程内 enqueueSay 后调用：去抖后立即扫描（无连接时是零开销 no-op）。 */
  notifyEnqueued(): void {
    if (this.clients.size === 0 || this.nudgeTimer !== null) return
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null
      this.scan()
    }, NUDGE_DELAY_MS)
    this.nudgeTimer.unref()
  }

  /** 核心：peek → 广播给全部连接 → 发送即标记 delivered（与轮询 at-most-once 一致）。 */
  scan(): void {
    if (this.scanning) return
    this.scanning = true
    try {
      if (this.clients.size === 0) return
      const messages = peekOutbox(this.db)
      if (messages.length === 0) return
      for (const m of messages) {
        const frame: SayFrame = { type: 'say', id: String(m.id), text: m.text, source: m.source }
        const raw = JSON.stringify(frame)
        for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(raw)
      }
      markDelivered(this.db, messages.map((m) => m.id))
    } finally {
      this.scanning = false
    }
  }

  /** 优雅关闭：停扫描定时器、断开全部客户端（测试与进程退出用）。 */
  stop(): void {
    if (this.scanTimer !== null) clearInterval(this.scanTimer)
    if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer)
    this.scanTimer = null
    this.nudgeTimer = null
    for (const ws of this.clients) ws.terminate()
    this.clients.clear()
    this.wss?.close()
    this.wss = null
  }

  /** 向全部连接广播指令（P4：切角色/换装的 setModel 等）。 */
  broadcastCommand(action: string, payload?: Record<string, unknown>): void {
    const frame: CommandFrame = { type: 'command', action, ...(payload !== undefined ? { payload } : {}) }
    const raw = JSON.stringify(frame)
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(raw)
  }

  get clientCount(): number {
    return this.clients.size
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (this.apiKey === null) return true
    const auth = req.headers.authorization ?? ''
    if (auth === `Bearer ${this.apiKey}`) return true
    return url.searchParams.get('key') === this.apiKey // 无 header 场景（部分客户端/浏览器）
  }

  private handleClientFrame(raw: string): void {
    try {
      const frame = JSON.parse(raw) as { type?: unknown }
      if (frame.type === 'ack') return // v1：at-most-once，ack 仅占位（未来 at-least-once 升级点）
    } catch {
      // 坏帧忽略：客户端协议错误不该影响推送
    }
  }
}

export function createRealtimeHub(db: CompanionDb, apiKey: string | null): RealtimeHub {
  return new RealtimeHub(db, apiKey)
}
