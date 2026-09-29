import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '../config.ts'
import { openDb } from '../db/database.ts'
import { buildMcpServer } from './server.ts'

// MCP stdio 入口：日志一律走 stderr，stdout 是协议通道
async function main(): Promise<void> {
  const config = loadConfig()
  const db = openDb(config.dbPath)
  const server = buildMcpServer(db)
  await server.connect(new StdioServerTransport())
  process.stderr.write(`[companion-mcp] ready (db: ${config.dbPath})\n`)
}

main().catch((err) => {
  process.stderr.write(`[companion-mcp] fatal: ${err instanceof Error ? err.message : err}\n`)
  process.exit(1)
})
