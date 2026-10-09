import type { CompanionDb } from '../db/database.ts'
import { insertEvent } from './eventStore.ts'
import { sessionEvents, type RawEventRow } from './rawEvents.ts'

// 工具名 → 她能听懂的说法；未列出的工具用原名，出现次数少的不提
const TOOL_LABELS: Record<string, string> = {
  Write: '改文件',
  Edit: '改文件',
  MultiEdit: '改文件',
  NotebookEdit: '改文件',
  Bash: '跑命令',
  Read: '查资料',
  Grep: '搜代码',
  Glob: '找文件',
  Task: '派小助手',
  Agent: '派小助手',
  WebSearch: '上网查',
  WebFetch: '上网查',
  TodoWrite: '列待办',
}

const MIN_MENTIONS = 3 // 单工具至少出现 3 次才值得提
const MIN_SESSION_EVENTS = 3 // 会话事件太少则不生成聚合（太琐碎）

export interface SessionStats {
  toolCounts: Array<{ label: string; count: number }>
  durationMs: number
  eventCount: number
}

/** 纯函数：从原始事件行统计出会话摘要数据。 */
export function summarizeSession(rows: RawEventRow[]): SessionStats | null {
  if (rows.length < MIN_SESSION_EVENTS) return null
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.hook_type !== 'PostToolUse' || r.tool_name === null) continue
    const label = TOOL_LABELS[r.tool_name] ?? r.tool_name
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const toolCounts = [...counts.entries()]
    .filter(([, n]) => n >= MIN_MENTIONS)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }))
  const first = new Date(rows[0].created_at).getTime()
  const last = new Date(rows[rows.length - 1].created_at).getTime()
  const durationMs = Number.isNaN(first) || Number.isNaN(last) ? 0 : Math.max(0, last - first)
  return { toolCounts, durationMs, eventCount: rows.length }
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 1) return '不到一分钟'
  if (min < 60) return `约 ${min} 分钟`
  const h = Math.floor(min / 60)
  return `约 ${h} 小时 ${min % 60} 分钟`
}

/** 纯函数：生成她说得出口的一句话总结。 */
export function buildSessionSummary(agent: string, stats: SessionStats, finalNote?: string): string {
  const parts: string[] = []
  if (stats.toolCounts.length > 0) {
    parts.push(stats.toolCounts.map((t) => `${t.label} ${t.count} 次`).join('、'))
  }
  if (stats.durationMs > 5 * 60 * 1000) {
    parts.push(formatDuration(stats.durationMs))
  }
  const head = parts.length > 0 ? `${agent} 干完了一轮活：${parts.join('，')}` : `${agent} 干完了一轮活`
  return finalNote !== undefined && finalNote.trim() !== '' ? `${head}。${finalNote.trim()}` : head
}

/**
 * Stop 时定稿：把整个 session 的原始事件折叠成一条聚合事件，进入她的视野。
 * 返回 summary 与统计数据（供反应引擎做工作量判断）；太琐碎返回 null。
 */
export function finalizeSession(
  db: CompanionDb,
  input: { agent: string; session_id: string; finalNote?: string },
): { summary: string; stats: SessionStats } | null {
  const rows = sessionEvents(db, input.session_id)
  const stats = summarizeSession(rows)
  if (stats === null) return null
  const summary = buildSessionSummary(input.agent, stats, input.finalNote)
  insertEvent(db, {
    agent: input.agent,
    event_type: 'session_completed',
    summary,
    details: JSON.stringify(stats),
  })
  return { summary, stats }
}
