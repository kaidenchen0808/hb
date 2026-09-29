import { serve } from '@hono/node-server'
import { loadConfig } from './config.ts'
import { openDb } from './db/database.ts'
import { loadPersona } from './persona/loader.ts'
import { createApp } from './http/app.ts'

function main(): void {
  const config = loadConfig()
  const persona = loadPersona(config.personaPath)
  const db = openDb(config.dbPath)
  const app = createApp({ db, config, persona })

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`companion-layer 已启动: http://127.0.0.1:${info.port}`)
    console.log(`  人格: ${persona.name}（${persona.stages.length} 个关系阶段）`)
    console.log(`  大脑: ${config.brainBaseUrl === '' ? '未配置（聊天不可用，见 .env.example）' : `${config.brainBaseUrl} · ${config.brainModel}`}`)
    console.log(`\nAniCompanion 接入：Settings → Agent backend → OpenAI-compatible`)
    console.log(`  Endpoint: http://127.0.0.1:${config.port}`)
    console.log(`  API Key:  ${config.companionApiKey === null ? '（未启用校验，随意填）' : '填 COMPANION_API_KEY 的值'}\n`)
  })
}

main()
