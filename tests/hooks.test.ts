import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const P = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin/scripts')
const received: any[] = []
let server: Server, port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => { received.push({ url: req.url, body }); res.end('{}') })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

const hookInput = JSON.stringify({ session_id: 'sess-123', tool_name: 'Bash', tool_response: { exit_code: 1, stderr: 'boom' } })

/** 跑一个 hook 脚本（stdin 喂 hook JSON）。
 * 必须用异步 spawn：本地接收 server 跑在本进程，spawnSync 会阻塞事件循环导致 server 无法应答 → curl 全部超时 */
function runHook(script: string, extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hook-'))
  // 预置假 node/brain，让 ensure-running 的懒启动静默成功，不污染真实 /tmp 日志
  writeFileSync(join(root, 'node'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(root, 'node'), 0o755)
  writeFileSync(join(root, 'brain.mjs'), '// x\n')
  return new Promise<{ status: number | null }>((resolve) => {
    const p = spawn('bash', [join(P, script)], {
      env: { ...process.env, COMPANION_URL: `http://127.0.0.1:${port}`,
             COMPANION_ROOT: root,
             COMPANION_SKIP_INSTALLER: '1', ...extraEnv },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    p.stdin.write(hookInput)
    p.stdin.end()
    const killer = setTimeout(() => p.kill('SIGKILL'), 15_000)
    p.on('close', (code) => { clearTimeout(killer); resolve({ status: code }) })
  })
}

describe('hook 脚本（去 jq 化）', () => {
  it('report-event.sh: 上报事件 + 失败时额外上报 task_failed / report-failure', async () => {
    received.length = 0
    const res = await runHook('report-event.sh')
    expect(res.status).toBe(0)
    const urls = received.map((r) => r.url)
    expect(urls).toContain('/api/events')
    expect(urls).toContain('/api/report-failure')
    const evt = received.find((r) => r.url === '/api/events').body
    expect(evt).toContain('sess-123')
    expect(evt).toContain('Bash')
    expect(evt).toContain('"failed":true')
  })

  it('stop-claude.sh: 上报聚合事件', async () => {
    received.length = 0
    const res = await runHook('stop-claude.sh')
    expect(res.status).toBe(0)
    expect(received.find((r) => r.url === '/api/aggregate')).toBeTruthy()
  })
})
