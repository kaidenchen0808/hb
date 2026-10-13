import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { CompanionDb } from '../db/database.ts'
import { insertEvent, isEventType, recentEvents } from '../memory/eventStore.ts'
import { enqueueSay } from '../memory/outbox.ts'
import { settleAgentPresence } from '../memory/relationship.ts'
import { decideReaction, recordReaction, FALLBACK_LINES } from '../memory/reactions.ts'

const REACTION_MIN_INTERVAL_SEC = 900

const AGENT_NAME_MAX = 32

export function buildMcpServer(db: CompanionDb): McpServer {
  const server = new McpServer({ name: 'companion-layer', version: '0.3.1' })

  server.registerTool(
    'companion_report',
    {
      title: '向桌面角色汇报',
      description:
        '把你（coding agent）刚完成/失败的任务告诉桌面上的她。summary 用一句自然语言（会被她听到）。任务完成、失败、重要节点时调用。',
      inputSchema: {
        event_type: z.enum(['session_started', 'session_completed', 'task_failed', 'error', 'info']).describe('事件类型'),
        summary: z.string().min(1).max(500).describe('一句话汇报，例如"跑完了全部测试，都过了"'),
        agent: z.string().max(AGENT_NAME_MAX).optional().describe('你的名字，如 claude-code / codex / opencode'),
        details: z.string().max(2000).optional().describe('可选补充细节'),
      },
    },
    async (args: { event_type: string; summary: string; agent?: string; details?: string }) => {
      const summary = (args.summary ?? '').trim()
      if (summary === '') return { content: [{ type: 'text', text: 'summary 不能为空' }], isError: true }
      if (!isEventType(args.event_type)) return { content: [{ type: 'text', text: `event_type 必须是 session_started|session_completed|task_failed|error|info` }], isError: true }
      const agent = (args.agent ?? 'agent').replace(/[^\w.-]/g, '').slice(0, AGENT_NAME_MAX) || 'agent'
      insertEvent(db, {
        agent,
        event_type: args.event_type,
        summary,
        details: args.details,
      })
      settleAgentPresence(db)
      // 失败/错误类上报触发她的即时反应（MCP 进程无大脑配置，用兜底台词保证她不缺席）
      const decision = decideReaction(
        db,
        { event_type: args.event_type, agent, summary, now: new Date() },
        { minIntervalSec: REACTION_MIN_INTERVAL_SEC, enabled: true },
      )
      if (decision !== null && (decision.kind === 'failure' || decision.kind === 'lateNight')) {
        recordReaction(db, decision.kind, new Date())
        enqueueSay(db, FALLBACK_LINES[decision.kind][0], 'reaction')
      }
      return { content: [{ type: 'text', text: `已告诉她：${summary}` }] }
    },
  )

  server.registerTool(
    'companion_get_context',
    {
      title: '查看桌面角色知道的 Agent 动静',
      description: '读取最近的 Agent 活动事件。用户问"刚才谁在干活/干了什么"时调用。',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 10，最大 50'),
      },
    },
    async (args: { limit?: number }) => {
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 10), 1), 50)
      const events = recentEvents(db, limit)
      if (events.length === 0) {
        return { content: [{ type: 'text', text: '最近没有任何 Agent 活动记录' }] }
      }
      const text = events
        .map((e) => `${e.created_at.slice(5, 16).replace('T', ' ')} [${e.agent}] ${e.event_type}: ${e.summary}`)
        .join('\n')
      return { content: [{ type: 'text', text }] }
    },
  )

  server.registerTool(
    'companion_speak',
    {
      title: '让她立刻开口',
      description:
        '让桌面上的她立刻把一段话说出来（语音+表情，AniCompanion 轮询即时播放）。text 是她的台词本身，可含 [emotion] 标签（happy/shy/love/laugh 等）。仅用于需要她马上开口的时刻；一般工作汇报用 companion_report。',
      inputSchema: {
        text: z.string().min(1).max(500).describe('她的台词，例如"[happy] 主人，Codex 跑完测试啦，全过了哦"'),
        source: z.string().max(32).optional().describe('来源标记，如 claude-code'),
      },
    },
    async (args: { text: string; source?: string }) => {
      const msg = enqueueSay(db, args.text, args.source ?? 'mcp')
      return { content: [{ type: 'text', text: `已入队（#${msg.id}），她马上会说：${args.text.slice(0, 60)}` }] }
    },
  )

  server.registerTool(
    'companion_notify',
    {
      title: '发桌面通知',
      description: '发送一条 macOS 桌面通知（即时可见，不经过她说话）。仅用于需要立刻被主人看到的重要信息。',
      inputSchema: {
        title: z.string().min(1).max(100).describe('通知标题'),
        message: z.string().min(1).max(200).describe('通知内容'),
      },
    },
    async (args: { title: string; message: string }) => {
      const title = (args.title ?? '').trim().slice(0, 100)
      const message = (args.message ?? '').trim().slice(0, 200)
      if (title === '' || message === '') {
        return { content: [{ type: 'text', text: 'title 和 message 不能为空' }], isError: true }
      }
      try {
        await notify(title, message)
        return { content: [{ type: 'text', text: '通知已发送' }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `通知失败: ${err instanceof Error ? err.message : err}` }], isError: true }
      }
    },
  )

  return server
}

/** AppleScript 字符串转义（execFile 直传 argv，无 shell 注入面；这里只防 AppleScript 语法破坏）。 */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function notify(title: string, message: string): Promise<void> {
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" sound name "Glass"`
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err) => (err === null ? resolve() : reject(err)))
  })
}
