import type { CompanionDb } from '../db/database.ts'
import { extractDelta, streamChatCompletion, type ChatMessage } from '../brain/llmClient.ts'

export type FactKind = 'promise' | 'habit' | 'preference'
const FACT_KINDS: readonly FactKind[] = ['promise', 'habit', 'preference']

export interface Fact {
  id: number
  kind: FactKind
  content: string
  created_at: string
}

export interface ExtractedFact {
  kind: FactKind
  content: string
}

/** 注入 prompt 用：最近 N 条记忆，旧承诺优先保留（承诺比偏好更值得回望）。 */
export function recentFacts(db: CompanionDb, limit = 8): Fact[] {
  return db
    .prepare(
      `SELECT id, kind, content, created_at FROM facts
       ORDER BY CASE kind WHEN 'promise' THEN 0 WHEN 'habit' THEN 1 ELSE 2 END, id DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as Fact[]
}

/** 简单去重：同 kind 且内容前 24 字相同视为重复。 */
function isDuplicate(db: CompanionDb, kind: FactKind, content: string): boolean {
  const prefix = `${kind}:${content.slice(0, 24)}%`
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM facts WHERE ? LIKE kind || ':' || substr(content, 1, 24) || '%'`)
    .get(prefix) as { n: number }
  return row.n > 0
}

export function insertFacts(db: CompanionDb, facts: ExtractedFact[]): number {
  let inserted = 0
  const stmt = db.prepare(
    `INSERT INTO facts (kind, content, created_at) VALUES (?, ?, ?)`,
  )
  for (const f of facts) {
    if (!FACT_KINDS.includes(f.kind) || f.content.trim() === '') continue
    const content = f.content.trim().slice(0, 200)
    if (isDuplicate(db, f.kind, content)) continue
    stmt.run(f.kind, content, new Date().toISOString())
    inserted += 1
  }
  return inserted
}

const EXTRACT_SYSTEM = `你从一段对话中提取"关于用户的、值得女朋友长期记住的事实"。
只提取明天她还愿意主动提起的：承诺（说要早睡/周末要干嘛）、习惯（几点下班/用什么工具/口味偏好）、偏好（喜欢/讨厌什么）。
忽略：寒暄、临时性问题、与用户本人无关的技术内容。
没有可提取的就返回空数组。以 JSON 输出，格式：
{"facts":[{"kind":"promise|habit|preference","content":"用第三人称简述，如：主人说这周要早睡"}]}
不要输出 JSON 以外的任何内容。`

/** 校验提取结果 JSON，容错解析（模型偶尔包一层 markdown 代码块）。 */
export function parseExtractedFacts(raw: string): ExtractedFact[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const facts = (parsed as { facts?: unknown }).facts
  if (!Array.isArray(facts)) return []
  const out: ExtractedFact[] = []
  for (const f of facts) {
    const kind = (f as { kind?: unknown }).kind
    const content = (f as { content?: unknown }).content
    if (typeof kind === 'string' && FACT_KINDS.includes(kind as FactKind) && typeof content === 'string' && content.trim() !== '') {
      out.push({ kind: kind as FactKind, content: content.trim() })
    }
  }
  return out.slice(0, 5)
}

export interface BrainConfig {
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: 'openai' | 'anthropic'
}

/**
 * 对话结束后异步提取记忆。永不抛错（记忆提取失败不该影响聊天链路），
 * 通过 onExtracted 回调把结果交给调用方落库。
 */
export async function extractFacts(
  brain: BrainConfig,
  conversation: ChatMessage[],
  onExtracted: (facts: ExtractedFact[]) => void,
): Promise<void> {
  try {
    let full = ''
    for await (const data of streamChatCompletion({
      baseUrl: brain.baseUrl,
      apiKey: brain.apiKey,
      model: brain.model,
      apiFormat: brain.apiFormat,
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        ...conversation.slice(-12),
      ],
      temperature: 0,
    })) {
      full += extractDelta(data)
      if (full.length > 4000) break
    }
    onExtracted(parseExtractedFacts(full))
  } catch (err) {
    console.warn('[facts] 提取失败（不影响聊天）:', err instanceof Error ? err.message : err)
  }
}
