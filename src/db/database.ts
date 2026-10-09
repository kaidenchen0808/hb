import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// node:sqlite（node >= 23.4 内置）替代 better-sqlite3：
// node 25 无对应预编译二进制，且零原生依赖对朋友军团分发更友好
export type CompanionDb = DatabaseSync

// 逐条 DDL（prepare 对单条 DDL 完全支持）
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS raw_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    hook_type TEXT NOT NULL,
    tool_name TEXT,
    payload TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_raw_events_session ON raw_events(session_id)`,

  `CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL,
    consumed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_events_unconsumed ON agent_events(consumed_at)`,

  `CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('promise', 'habit', 'preference')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_referenced_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS relationship (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    affinity INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'stranger',
    last_interaction_at TEXT,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS milestones (
    stage TEXT PRIMARY KEY,
    triggered_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS reaction_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
]

/** 打开（或创建）数据库，启用 WAL 支持与 HTTP 服务/MCP 进程的并发读写。幂等建表。 */
export function openDb(dbPath: string): CompanionDb {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  for (const ddl of SCHEMA_STATEMENTS) {
    db.prepare(ddl).run()
  }
  seedRelationship(db)
  return db
}

/** 确保 relationship 单行存在（幂等）。 */
function seedRelationship(db: CompanionDb): void {
  db.prepare(
    `INSERT OR IGNORE INTO relationship (id, affinity, stage, updated_at)
     VALUES (1, 0, 'stranger', ?)`,
  ).run(new Date().toISOString())
}
