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

/** 中文字符 2-gram 集合（短文本取单字），用于语义近似的重复判断。 */
function charBigrams(s: string): Set<string> {
  const grams = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2))
  if (grams.size === 0 && s.length > 0) grams.add(s)
  return grams
}

/** Jaccard 相似度（2-gram）+ 包含性判定：同 kind 时满足任一视为重复——
 *  前缀法对"同义不同长"无效（真实案例："要去深圳湾看月亮" vs
 *  "要去深圳湾看月亮，至今还没确认去了没有"，Jaccard 仅 0.4 但短文 bigram
 *  全被长文包含）。包含性要求短文 ≥4 个 bigram（≥5 字），防两字短词误伤。
 *  facts 表量级小（几十条），全表扫可接受。 */
function isDuplicate(db: CompanionDb, kind: FactKind, content: string): boolean {
  const rows = db
    .prepare(`SELECT content FROM facts WHERE kind = ?`)
    .all(kind) as { content: string }[]
  const newGrams = charBigrams(content)
  for (const row of rows) {
    const old = charBigrams(row.content)
    let overlap = 0
    for (const g of newGrams) if (old.has(g)) overlap += 1
    const union = newGrams.size + old.size - overlap
    if (union > 0 && overlap / union > 0.55) return true
    const shorter = Math.min(newGrams.size, old.size)
    if (shorter >= 4 && overlap === shorter) return true
  }
  return false
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

const EXTRACT_SYSTEM_BASE = `你从一段对话中提取"关于用户的、值得女朋友长期记住的事实"。
只提取明天她还愿意主动提起的：承诺（说要早睡/周末要干嘛）、习惯（几点下班/用什么工具/口味偏好）、偏好（喜欢/讨厌什么）。
忽略：寒暄、临时性问题、与用户本人无关的技术内容。
没有可提取的就返回空数组。以 JSON 输出，格式：
{"facts":[{"kind":"promise|habit|preference","content":"用第三人称简述，如：主人说这周要早睡"}]}
不要输出 JSON 以外的任何内容。`

/** 提取 prompt：带上已有记忆清单——用户复述/上下文再次出现同一事实时，模型
 *  知道那是旧的，不再当新记忆提取（第一层去重；插入层的相似度去重是第二层）。 */
export function buildExtractSystem(existingFacts: string[]): string {
  if (existingFacts.length === 0) return EXTRACT_SYSTEM_BASE
  const list = existingFacts.map((f) => `- ${f}`).join('\n')
  return `${EXTRACT_SYSTEM_BASE}

她已经记住以下事实（**不要重复提取语义相同的事实**，哪怕用户又提了一遍；只有出现明显的新信息才提取）：
${list}`
}

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
  existingFacts: string[] = [],
): Promise<void> {
  try {
    let full = ''
    for await (const data of streamChatCompletion({
      baseUrl: brain.baseUrl,
      apiKey: brain.apiKey,
      model: brain.model,
      apiFormat: brain.apiFormat,
      messages: [
        { role: 'system', content: buildExtractSystem(existingFacts) },
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
