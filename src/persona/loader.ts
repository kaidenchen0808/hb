import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

export interface PersonaStage {
  id: string
  label: string
  threshold: number
  address_user: string
  tone: string
}

export interface Persona {
  name: string
  identity: string
  personality: string[]
  speech: {
    style: string
    length: string
    forbid: string[]
  }
  interests: string[]
  stages: PersonaStage[]
  milestones: Record<string, string>
}

/**
 * 解析并校验 persona.yaml。任何字段缺失/不合法都在启动时抛错（fail fast），
 * 避免带着残缺人格上线。
 */
export function loadPersona(path: string): Persona {
  const raw = readFileSync(path, 'utf-8')
  const parsed: unknown = parse(raw)
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`人格文件不是合法 YAML 对象: ${path}`)
  }
  const p = parsed as Partial<Persona>

  const requireStr = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`persona 缺少必填字段: ${field}`)
    }
    return v.trim()
  }
  const requireList = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
      throw new Error(`persona.${field} 必须是非空字符串数组`)
    }
    return v as string[]
  }

  const stages = p.stages
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('persona.stages 必须是非空数组')
  }
  for (const [i, s] of stages.entries()) {
    if (typeof s?.id !== 'string' || typeof s?.threshold !== 'number' || typeof s?.address_user !== 'string' || typeof s?.tone !== 'string' || typeof s?.label !== 'string') {
      throw new Error(`persona.stages[${i}] 字段不完整（需要 id/label/threshold/address_user/tone）`)
    }
    if (i > 0 && s.threshold <= stages[i - 1].threshold) {
      throw new Error(`persona.stages[${i}].threshold 必须大于前一阶段`)
    }
  }

  return {
    name: requireStr(p.name, 'name'),
    identity: requireStr(p.identity, 'identity'),
    personality: requireList(p.personality, 'personality'),
    speech: {
      style: requireStr(p.speech?.style, 'speech.style'),
      length: requireStr(p.speech?.length, 'speech.length'),
      forbid: requireList(p.speech?.forbid, 'speech.forbid'),
    },
    interests: p.interests === undefined ? [] : requireList(p.interests, 'interests'),
    stages: stages.map((s) => ({ ...s })),
    milestones: p.milestones ?? {},
  }
}

/** 根据好感度返回当前所处阶段（stages 已保证 threshold 递增）。 */
export function stageForAffinity(persona: Persona, affinity: number): PersonaStage {
  let current = persona.stages[0]
  for (const s of persona.stages) {
    if (affinity >= s.threshold) current = s
    else break
  }
  return current
}
