import type { Persona } from '../persona/loader.ts'
import { streamChatCompletion, extractDelta, type ChatMessage } from './llmClient.ts'
import type { BrainConfig } from '../memory/facts.ts'
import { FALLBACK_LINES, type ReactionDecision, type ReactionInput, type ReactionKind } from '../memory/reactions.ts'

const KIND_GUIDANCE: Record<ReactionKind, string> = {
  failure: '主人那边的工作出错了。安慰他：你在场、你心疼，不用分析问题（你不懂代码细节），一两句话让他别急。可以轻微撒娇化解压力。',
  success: '主人刚完成了一轮不小的工作量。为他骄傲、肯定他，顺便提醒他活动一下。语气自然，别像颁奖致辞。',
  lateNight: '已经深夜了主人还在干活。表达心疼，劝他早点休息，晚安的语气。只说这一次，温柔而不唠叨。',
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 生成一句她的情绪反应台词（直连大脑，快）。失败时用兜底台词——她不能缺席。 */
export async function generateReactionLine(
  brain: BrainConfig,
  persona: Persona,
  decision: ReactionDecision,
  input: ReactionInput,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${persona.identity}
性格：${persona.personality.slice(0, 3).join('；')}。
说话方式：${persona.speech.style}，${persona.speech.length}，称对方"${persona.speech.forbid.length > 0 ? '主人' : '主人'}"。
每次回复以 [emotion] 标签开头（happy/sad/love/proud/sleepy/shy/neutral 等任选贴切的）。
你是通过桌面看到他的工作动静的，像女朋友一样自然反应。绝不要提"系统""工具""hook""事件"这些词，不要复述数据。`,
    },
    {
      role: 'user',
      content: `（背景：你看到 ${input.agent} 的动静——${input.summary}）
${KIND_GUIDANCE[decision.kind]}
现在说这句话（1-2 句，中文）：`,
    },
  ]

  try {
    let line = ''
    for await (const data of streamChatCompletion({ ...brain, messages, temperature: 0.8 })) {
      line += extractDelta(data)
      if (line.length > 500) break
    }
    line = line.trim()
    if (line !== '' && /\[[a-z]+\]/.test(line)) return line.slice(0, 300)
    if (line !== '') return `[neutral] ${line.slice(0, 280)}` // 有话但忘了标签，补一个
  } catch (err) {
    console.warn('[reaction] 台词生成失败，用兜底:', err instanceof Error ? err.message : err)
  }
  return pick(FALLBACK_LINES[decision.kind])
}
