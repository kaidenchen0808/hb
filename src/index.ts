import { serve } from '@hono/node-server'
import { loadConfig } from './config.ts'
import { openDb } from './db/database.ts'
import { loadPersona } from './persona/loader.ts'
import { createApp } from './http/app.ts'
import { createRealtimeHub } from './realtime/hub.ts'

function main(): void {
  const config = loadConfig()
  const persona = loadPersona(config.personaPath)
  const db = openDb(config.dbPath)
  const hub = createRealtimeHub(db, config.companionApiKey)
  const app = createApp({ db, config, persona, hub })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`companion-layer 已启动: http://127.0.0.1:${info.port}`)
    console.log(`  人格: ${persona.name}（${persona.stages.length} 个关系阶段）`)
    console.log(`  大脑: ${config.brainApiFormat === 'claude-code' ? 'claude-code 子进程（只读工具）' : config.brainBaseUrl === '' ? '未配置（聊天不可用，见 .env.example）' : `${config.brainBaseUrl} · ${config.brainModel}`}`)
    console.log(`\nAniCompanion 接入：Settings → Agent backend → OpenAI-compatible`)
    console.log(`  Endpoint: http://127.0.0.1:${config.port}`)
    console.log(`  API Key:  ${config.companionApiKey === null ? '（未启用校验，随意填）' : '填 COMPANION_API_KEY 的值'}\n`)
  })
  // WS 实时推送挂载点：/v1/ws（say 帧 <500ms 推送，3s 轮询降级为回落通道）
  hub.attach(server)
  // 端口占用等启动错误要明确报错退出，而不是 unhandled crash
  server.on('error', (err) => {
    console.error(`[fatal] HTTP 服务启动失败: ${err.message}`)
    console.error(`  若是端口被占用（EADDRINUSE），先执行: pkill -f "node src/index.ts"`)
    process.exit(1)
  })
}

main()
