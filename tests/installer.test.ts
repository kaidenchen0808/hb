import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer, type Server } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(REPO, 'plugin/scripts/ensure-installed.sh')
const VERSION = '0.1.0-test'

// --- 本地下载源：serve 一个假 payload zip ---
let server: Server
let port = 0
let downloadCount = 0

function makePayloadZip(dir: string): string {
  const payloadDir = join(dir, 'payload')
  mkdirSync(join(payloadDir, 'persona'), { recursive: true })
  // 假 node：可执行脚本，识别自己
  writeFileSync(join(payloadDir, 'node'), '#!/bin/sh\necho fake-node\n')
  chmodSync(join(payloadDir, 'node'), 0o755)
  writeFileSync(join(payloadDir, 'brain.mjs'), '// fake brain\n')
  writeFileSync(join(payloadDir, 'brain-mcp.mjs'), '// fake mcp\n')
  writeFileSync(join(payloadDir, 'VERSION'), VERSION + '\n')
  writeFileSync(join(payloadDir, 'persona', 'persona.yaml'), 'name: test\n')
  writeFileSync(join(payloadDir, 'AniCompanion.app.zip'), 'fake-app-zip')
  const zip = join(dir, `payload-${VERSION}.zip`)
  execFileSync('zip', ['-q', '-r', zip, 'payload'], { cwd: dir })
  return zip
}

function zipSha256(zip: string): string {
  return execFileSync('shasum', ['-a', '256', zip]).toString().split(' ')[0]
}

/** 跑一次安装器（继承环境 + 测试 override）。
 * 必须用异步 spawn：本地下载源 server 跑在本进程，spawnSync 会阻塞事件循环导致 server 无法应答 → 死锁超时 */
function runInstaller(env: Record<string, string>, args: string[] = []) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn('bash', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    p.stdout.on('data', (c: Buffer) => (stdout += c))
    p.stderr.on('data', (c: Buffer) => (stderr += c))
    const killer = setTimeout(() => p.kill('SIGKILL'), 30_000)
    p.on('close', (code) => { clearTimeout(killer); resolve({ status: code, stdout, stderr }) })
  })
}

function testEnv(root: string, extra: Record<string, string> = {}) {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return {
    HOME: home, // launchd plist 写 $HOME/Library/LaunchAgents，defaults 同理
    COMPANION_ROOT,
    PAYLOAD_BASE: `http://127.0.0.1:${port}`,
    EXPECT_VERSION: VERSION,
    COMPANION_SKIP_APP: '1',
    COMPANION_SKIP_LAUNCHD: '1',
    COMPANION_SKIP_OPEN: '1',
    COMPANION_INSTALL_LOG: join(root, 'install.log'),
    ...extra,
  }
}

let COMPANION_ROOT: string

beforeAll(async () => {
  const staging = mkdtempSync(join(tmpdir(), 'companion-installer-test-'))
  COMPANION_ROOT = join(staging, 'root')
  const zip = makePayloadZip(staging)
  const sha = zipSha256(zip)
  server = createServer((req, res) => {
    if (req.url?.endsWith('.sha256')) {
      res.end(`${sha}  payload-${VERSION}.zip\n`)
      return
    }
    downloadCount++
    res.setHeader('content-type', 'application/zip')
    res.end(readFileSync(zip))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))
})

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

describe('ensure-installed.sh', () => {
  it('全新安装：部署 node/brain/persona，状态 installed，写 launchd plist', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 't-'))
    const res = await runInstaller(testEnv(fresh))
    expect(res.status).toBe(0)
    expect(existsSync(join(COMPANION_ROOT, 'node'))).toBe(true)
    expect(existsSync(join(COMPANION_ROOT, 'brain.mjs'))).toBe(true)
    expect(existsSync(join(COMPANION_ROOT, 'persona', 'persona.yaml'))).toBe(true)
    expect(readFileSync(join(COMPANION_ROOT, '.state'), 'utf8')).toContain(VERSION)
    // HOME 被 override，plist 应在该用例自己的假 HOME 下
    const fakePlist = join(fresh, 'home', 'Library', 'LaunchAgents', 'companion-layer.plist')
    expect(existsSync(fakePlist)).toBe(true)
    expect(readFileSync(fakePlist, 'utf8')).toContain('brain.mjs')
  })

  it('同版本快路径：不发下载请求，毫秒返回', async () => {
    const before = downloadCount
    const res = await runInstaller(testEnv(mkdtempSync(join(tmpdir(), 't-'))))
    expect(res.status).toBe(0)
    expect(downloadCount).toBe(before) // 注意：此用例复用同一 COMPANION_ROOT，state 已 installed
  })

  it('并发 5 实例：只下载一次，部署完整', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 't-'))
    const env = testEnv(fresh)
    rmSync(join(COMPANION_ROOT, '.state'), { force: true }) // 复位状态，模拟"未安装"起点
    const before = downloadCount
    const procs = await Promise.all(Array.from({ length: 5 }, () => runInstaller(env)))
    procs.forEach((p) => expect(p.status).toBe(0))
    expect(downloadCount).toBe(before + 1)
    expect(existsSync(join(COMPANION_ROOT, 'brain.mjs'))).toBe(true)
    expect(existsSync(COMPANION_ROOT + '.install.lock')).toBe(false) // 锁已释放
  })

  it('版本变更重装：data/companion.db 保留（她不失忆）', async () => {
    const db = join(COMPANION_ROOT, 'data', 'companion.db')
    mkdirSync(dirname(db), { recursive: true })
    writeFileSync(db, 'PRECIOUS MEMORY')
    const res = await runInstaller(testEnv(mkdtempSync(join(tmpdir(), 't-')), { EXPECT_VERSION: '0.2.0-test' }), ['--force-version'])
    expect(res.status).toBe(0)
    expect(readFileSync(db, 'utf8')).toBe('PRECIOUS MEMORY')
    expect(readFileSync(join(COMPANION_ROOT, 'VERSION'), 'utf8')).toBe('0.2.0-test\n')
  })

  it('过期锁被清理后可正常安装', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 't-'))
    const env = testEnv(fresh)
    mkdirSync(COMPANION_ROOT + '.install.lock', { recursive: true })
    // 把 mtime 改到 2000 年 → TTL 过期
    execFileSync('touch', ['-t', '200001010000', COMPANION_ROOT + '.install.lock'])
    const res = await runInstaller(env)
    expect(res.status).toBe(0)
    expect(existsSync(join(COMPANION_ROOT, 'node'))).toBe(true)
  })
})
