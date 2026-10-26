import { describe, expect, it } from 'vitest'
import { accessSync, constants } from 'node:fs'
import { resolveClaudeCli } from '../src/brain/llmClient.ts'

describe('resolveClaudeCli', () => {
  it('返回 null 或一个真实可执行路径（不变量：绝不返回不存在的路径）', () => {
    const resolved = resolveClaudeCli()
    if (resolved === null) return // 无 claude 的环境（CI）允许 null
    // 'claude'（PATH 命中）或绝对路径都可，但必须真实可执行
    if (resolved !== 'claude') {
      expect(() => accessSync(resolved, constants.X_OK)).not.toThrow()
      expect(resolved.startsWith('/')).toBe(true)
    }
  })
})
