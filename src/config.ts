import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

loadDotenv({ quiet: true })

export type BrainApiFormat = 'openai' | 'anthropic' | 'claude-code' | 'hybrid'

export interface AppConfig {
  port: number
  dbPath: string
  personaPath: string
  brainBaseUrl: string
  brainApiKey: string
  brainModel: string
  brainApiFormat: BrainApiFormat
  companionApiKey: string | null
}

/** 聊天大脑是否就绪：claude-code 只需本机 CLI；hybrid/直连需要完整 BRAIN_* 三项。 */
export function brainReady(c: AppConfig): boolean {
  if (c.brainApiFormat === 'claude-code') return true
  return c.brainBaseUrl !== '' && c.brainApiKey !== '' && c.brainModel !== ''
}

/** 直连格式推断（hybrid/facts 提取用）：anthropic 端点 ↔ GLM Coding Plan。 */
export function directFormat(c: AppConfig): 'openai' | 'anthropic' {
  return c.brainBaseUrl.includes('anthropic') ? 'anthropic' : 'openai'
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n <= 0 || n > 65535) {
    throw new Error(`环境变量 ${name} 不是合法端口: ${raw}`)
  }
  return n
}

function readStr(name: string, fallback = ''): string {
  const raw = process.env[name]
  return raw === undefined ? fallback : raw.trim()
}

function readBrainFormat(raw: string): BrainApiFormat {
  if (raw === 'anthropic' || raw === 'claude-code' || raw === 'hybrid') return raw
  return 'openai'
}

/** 加载并校验配置。BRAIN_* 缺失时仅告警（可先跑通 hooks 链路再补大脑），聊天接口会返回明确错误。 */
export function loadConfig(): AppConfig {
  const cfg: AppConfig = {
    port: readInt('PORT', 8787),
    dbPath: resolve(readStr('DB_PATH', './data/companion.db')),
    personaPath: resolve(readStr('PERSONA_PATH', './persona/persona.yaml')),
    brainBaseUrl: readStr('BRAIN_BASE_URL').replace(/\/+$/, ''),
    brainApiKey: readStr('BRAIN_API_KEY'),
    brainModel: readStr('BRAIN_MODEL'),
    brainApiFormat: readBrainFormat(readStr('BRAIN_API_FORMAT', 'openai')),
    companionApiKey: readStr('COMPANION_API_KEY') || null,
  }

  if (!existsSync(cfg.personaPath)) {
    throw new Error(`人格文件不存在: ${cfg.personaPath}（可用 PERSONA_PATH 指定）`)
  }
  const missing = (['BRAIN_BASE_URL', 'BRAIN_API_KEY', 'BRAIN_MODEL'] as const).filter((k) => readStr(k) === '')
  if (missing.length > 0 && cfg.brainApiFormat !== 'claude-code') {
    console.warn(`[config] 警告: 未配置 ${missing.join(', ')} —— 聊天接口不可用，请参考 .env.example 补齐后重启`)
  }
  if (cfg.brainApiFormat !== 'claude-code' && cfg.brainApiFormat !== 'hybrid' && missing.length > 0) {
    console.warn('[config] 提示: 该模式下 BRAIN_* 未配全，记忆提取(facts)将跳过（只影响长期记忆，不影响聊天）')
  }
  if (cfg.brainApiFormat === 'hybrid' && missing.length > 0) {
    throw new Error('hybrid 模式需要 BRAIN_* 直连配置（快速聊天通道），请补齐 .env')
  }
  return cfg
}
