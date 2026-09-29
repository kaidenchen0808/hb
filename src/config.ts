import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

loadDotenv({ quiet: true })

export interface AppConfig {
  port: number
  dbPath: string
  personaPath: string
  brainBaseUrl: string
  brainApiKey: string
  brainModel: string
  brainApiFormat: 'openai' | 'anthropic'
  companionApiKey: string | null
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

/** 加载并校验配置。BRAIN_* 缺失时仅告警（可先跑通 hooks 链路再补大脑），聊天接口会返回明确错误。 */
export function loadConfig(): AppConfig {
  const cfg: AppConfig = {
    port: readInt('PORT', 8787),
    dbPath: resolve(readStr('DB_PATH', './data/companion.db')),
    personaPath: resolve(readStr('PERSONA_PATH', './persona/persona.yaml')),
    brainBaseUrl: readStr('BRAIN_BASE_URL').replace(/\/+$/, ''),
    brainApiKey: readStr('BRAIN_API_KEY'),
    brainModel: readStr('BRAIN_MODEL'),
    brainApiFormat: readStr('BRAIN_API_FORMAT', 'openai') === 'anthropic' ? 'anthropic' : 'openai',
    companionApiKey: readStr('COMPANION_API_KEY') || null,
  }

  if (!existsSync(cfg.personaPath)) {
    throw new Error(`人格文件不存在: ${cfg.personaPath}（可用 PERSONA_PATH 指定）`)
  }
  const missing = (['BRAIN_BASE_URL', 'BRAIN_API_KEY', 'BRAIN_MODEL'] as const).filter((k) => readStr(k) === '')
  if (missing.length > 0) {
    console.warn(`[config] 警告: 未配置 ${missing.join(', ')} —— 聊天接口不可用，请参考 .env.example 补齐后重启`)
  }
  return cfg
}
