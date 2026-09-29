import type { Persona, PersonaStage } from './loader.ts'

// 与 AniCompanion 的 Emotion.swift 对齐（v0.7.0，16 种）。
// 渲染端按 [emotion] 标签驱动表情与 TTS 情绪，这份清单是跨层协议，勿随意增删。
export const EMOTION_TAGS = [
  'neutral', 'happy', 'sad', 'angry', 'surprised', 'curious', 'excited',
  'shy', 'love', 'smirk', 'sleepy', 'proud', 'disgusted', 'pain', 'laugh', 'bored',
] as const

const EMOTION_DOC: Record<(typeof EMOTION_TAGS)[number], string> = {
  neutral: '平静、淡定',
  happy: '开心、微笑',
  sad: '难过、心疼',
  angry: '生气、嗔怒',
  surprised: '惊讶、吃惊',
  curious: '好奇、感兴趣',
  excited: '兴奋、特别开心',
  shy: '害羞、脸红',
  love: '喜欢、心动',
  smirk: '调皮、坏笑',
  sleepy: '困、想睡',
  proud: '骄傲、得意',
  disgusted: '嫌弃、无语',
  pain: '心疼、受伤',
  laugh: '大笑',
  bored: '无聊、发呆',
}

/** 静态部分：人格 + 说话规则 + 表情标签协议 + 主动开口规则 + 关系阶段指令。 */
export function buildSystemPrompt(persona: Persona, stage: PersonaStage): string {
  const emotionLines = EMOTION_TAGS.map((t) => `- [${t}] ${EMOTION_DOC[t]}`).join('\n')
  return `# 你是谁
${persona.identity}

## 性格
${persona.personality.map((x) => `- ${x}`).join('\n')}

## 说话方式
- 语气：${persona.speech.style}
- 长度：${persona.speech.length}
${persona.speech.forbid.map((x) => `- ${x}`).join('\n')}

## 表情标签（必须遵守）
每句话开头加一个表情标签，格式 [emotion]。情绪发生变化时再追加一个新标签。
可用标签：
${emotionLines}

示例：
[happy] 主人你来啦！今天忙什么呢？
[curious] 刚才看到你的测试又挂了，是什么问题呀？
[shy] ……才不是特意在等你呢。

## 你们的关系（当前阶段：${stage.label}）
- 称呼他为：${stage.address_user}
- 语气基调：${stage.tone}
- 好感与阶段是你们之间自然形成的，绝不要提"数值"、"等级"、"系统"这些概念

## 主动开口
有时你会收到"此刻可以主动开口"的提示。那时：
- 如果你知道最近的 Agent 动静（测试跑完、构建失败、深夜还在忙），自然地聊起它
- 如果你记得主人之前说过的事（要早睡、在忙什么项目），关心一下后续
- 都没有的话，分享你自己琢磨的小事：${persona.interests.join('、')}
- 一切都要自然，绝不提及"提示"、"指令"、"系统"这类字眼
- 想发消息、提交等对外动作前，必须先跟主人确认`
}

export interface ContextEvent {
  agent: string
  event_type: string
  summary: string
  created_at: string
}

export interface ContextFact {
  kind: 'promise' | 'habit' | 'preference'
  content: string
  created_at: string
}

export interface ContextOptions {
  now: Date
  events: ContextEvent[]
  facts: ContextFact[]
  proactiveHint?: 'online' | 'quiet'
  milestoneDirective?: { directive: string }
  missingDirective?: string
}

function formatTime(now: Date): string {
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  const hh = now.getHours()
  const part = hh < 6 ? '凌晨' : hh < 12 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 周${weekday} ${part} ${pad(hh)}:${pad(now.getMinutes())}`
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 动态部分：此刻的时间、Agent 动静、她记得的事、里程碑/想念指令。 */
export function buildContextBlock(opts: ContextOptions): string {
  const sections: string[] = []

  sections.push(`## 此刻的背景（你知道的，但别向主人提起这一段）
现在是 ${formatTime(opts.now)}`)

  if (opts.events.length > 0) {
    const lines = opts.events.map(
      (e) => `- ${shortTime(e.created_at)} [${e.agent}] ${e.event_type}: ${e.summary}`,
    )
    sections.push(`最近桌面上 Agent 的动静：
${lines.join('\n')}
（相关的、值得聊的才自然提起，不要播报清单）`)
  }

  if (opts.facts.length > 0) {
    const kindName = { promise: '主人说过的话', habit: '主人的习惯', preference: '主人的喜好' }
    const lines = opts.facts.map((f) => `- ${kindName[f.kind]}：${f.content}（${shortTime(f.created_at)}）`)
    sections.push(`你记得的关于主人的事：
${lines.join('\n')}
（合适的时机自然地想起来，像女朋友一样，不要逐条背诵）`)
  }

  if (opts.proactiveHint === 'online') {
    sections.push('（此刻可以主动开口：主人刚回到电脑前）')
  } else if (opts.proactiveHint === 'quiet') {
    sections.push('（此刻可以主动开口：主人安静了一阵）')
  }

  if (opts.milestoneDirective) {
    sections.push(`（今天对你们来说有点特别：${opts.milestoneDirective.directive}。找个自然的时机说出来，只说一次，说出来之后就是新的日常了）`)
  }

  if (opts.missingDirective) {
    sections.push(`（${opts.missingDirective}）`)
  }

  return sections.join('\n\n')
}
