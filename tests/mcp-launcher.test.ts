import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin/scripts/mcp-launcher.sh')

describe('mcp-launcher.sh', () => {
  it('未就绪（无 node/brain-mcp）: 1 秒内退出，非零', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-'))
    const res = spawnSync('bash', [SCRIPT], { env: { ...process.env, COMPANION_ROOT: root }, encoding: 'utf8', timeout: 3000 })
    expect(res.status).not.toBe(0)
  })

  it('就绪：exec payload node 跑 brain-mcp.mjs（用假 node 打标验证）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-'))
    writeFileSync(join(root, 'node'), '#!/bin/sh\necho "LAUNCHED $@"\n')
    chmodSync(join(root, 'node'), 0o755)
    writeFileSync(join(root, 'brain-mcp.mjs'), '// x\n')
    const res = spawnSync('bash', [SCRIPT], { env: { ...process.env, COMPANION_ROOT: root }, encoding: 'utf8' })
    expect(res.stdout).toContain('LAUNCHED')
    expect(res.stdout).toContain('brain-mcp.mjs')
    expect(res.status).toBe(0)
  })
})
