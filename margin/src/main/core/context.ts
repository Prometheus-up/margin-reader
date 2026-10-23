import type { Block } from './text'

export interface SectionLite {
  idx: number
  title: string
  charStart: number
  charEnd: number
  blocks: Block[]
  text: string
}

export interface PriorNote {
  pos: number
  quote: string
  note: string
}

export interface RetrievedChunk {
  secIdx: number
  start: number
  end: number
  text: string
}

/** 读者在这本书上以前说过的话（跨划线、跨讨论，长期记忆） */
export interface Utterance {
  text: string
  at: number
}

export interface BuildInput {
  sections: SectionLite[]
  /** 划线起点：全书字符偏移 */
  globalPos: number
  quote: string
  notes?: PriorNote[]
  retrieved?: RetrievedChunk[]
  /** 读者在这本书上以前说过的话 */
  utterances?: Utterance[]
  /** 各章摘要（可选，长书用） */
  chapterSummaries?: Map<number, string>
  budgetChars?: number
}

export interface Source {
  label: string
  secIdx: number
  start: number
  end: number
}

export interface BuildResult {
  contextText: string
  sources: Source[]
  stats: {
    totalChars: number
    priorSections: number
    windowBlocks: number
    /** 本章已读部分的字符数（未截断前） */
    retrieved: number
    notes: number
    /** 注入的往日思考条数 */
    memory: number
    percent: number
  }
}

export class ContextLeakError extends Error {
  constructor(public readonly detail: string) {
    super(`上下文泄漏：${detail}`)
  }
}

/**
 * 组装"读到此处为止"的上下文。
 * 铁律：任何片段的字符区间必须满足 end <= globalPos（划线原文本身除外）。
 */
export function buildContext(input: BuildInput): BuildResult {
  const { sections, globalPos, quote } = input
  const budget = input.budgetChars ?? 7000
  const sorted = [...sections].sort((a, b) => a.charStart - b.charStart)

  const current = sorted.find((s) => globalPos >= s.charStart && globalPos <= s.charEnd)
  if (!current) throw new Error('划线位置不在任何章节内')
  const localOffset = globalPos - current.charStart

  const sources: Source[] = []
  const parts: string[] = []
  const totalLen = sorted[sorted.length - 1].charEnd || 1
  const percent = Math.min(100, Math.round((globalPos / totalLen) * 100))

  /* ---- 头部：位置 ---- */
  parts.push(
    `【你此刻的位置】${current.title}（全书约 ${percent}%）\n` +
      `用户划线处之后的内容（本书后文）不可用，也不要提及。`
  )

  /* ---- L3：前文脉络 ---- */
  const priorSections = sorted.filter((s) => s.charEnd <= globalPos)
  const priorChars = priorSections.reduce((n, s) => n + s.text.length, 0)
  const wholePrior = priorChars <= budget * 0.55

  if (wholePrior && priorChars > 0) {
    const chunks: string[] = []
    let used = 0
    for (const s of priorSections) {
      const remain = Math.floor(budget * 0.55) - used
      if (remain <= 0) break
      const t = s.text.length > remain ? s.text.slice(0, remain) + '……' : s.text
      chunks.push(`〔${s.title}〕\n${t}`)
      used += t.length
      sources.push({ label: `前文·${s.title}`, secIdx: s.idx, start: s.charStart, end: s.charStart + Math.min(s.text.length, remain) })
    }
    parts.push(`【本书到这里为止的内容】\n${chunks.join('\n\n')}`)
  } else if (priorSections.length > 0) {
    const lines = priorSections.map((s) => {
      const summary = input.chapterSummaries?.get(s.idx)
      if (summary) return `- ${s.title}：${summary}`
      const head = s.text.slice(0, 110).replace(/\n/g, ' ')
      const tail = s.text.slice(-40).replace(/\n/g, ' ')
      return `- ${s.title}：${head}……（结尾）${tail}`
    })
    parts.push(`【前文脉络（逐章概要）】\n${lines.join('\n')}`)
    for (const s of priorSections) {
      sources.push({ label: `前文·${s.title}`, secIdx: s.idx, start: s.charStart, end: Math.min(s.charEnd, Math.min(s.text.length, 110) + s.charStart) })
    }
  }

  /* ---- L2：本章已读部分（从章首到划线处） ---- */
  const inChapter = current.text.slice(0, localOffset)
  if (inChapter.trim()) {
    const cap = Math.min(3000, Math.floor(budget * 0.35))
    const clipped = inChapter.length > cap ? '……' + inChapter.slice(-cap) : inChapter
    parts.push(`【本章已读部分】\n${clipped}`)
    sources.push({
      label: `本章已读·${current.title}`,
      secIdx: current.idx,
      start: current.charStart + (inChapter.length - clipped.length),
      end: globalPos
    })
  }

  /* ---- 划线原文 ---- */
  parts.push(`【划线原文】\n「${quote}」`)
  sources.push({ label: '划线原文', secIdx: current.idx, start: globalPos, end: globalPos + quote.length })

  /* ---- L4：前文检索 ---- */
  const retrieved = (input.retrieved ?? []).filter((r) => r.end <= globalPos).slice(0, 5)
  if (retrieved.length) {
    const blocks = retrieved.map((r, i) => {
      sources.push({ label: `前文检索 ${i + 1}`, secIdx: r.secIdx, start: r.start, end: r.end })
      return `[前文检索 ${i + 1}]\n${r.text.slice(0, 500)}`
    })
    parts.push(`【前文中与此相关的段落】\n${blocks.join('\n\n')}`)
  }

  /* ---- L5：用户自己之前的想法 ---- */
  const notes = (input.notes ?? []).filter((n) => n.pos <= globalPos).slice(-5)
  if (notes.length) {
    parts.push(
      `【用户此前在这本书里写下的想法】\n` +
        notes.map((n) => `- 「${n.quote.slice(0, 40)}」→ ${n.note.slice(0, 120)}`).join('\n')
    )
  }

  /* ---- L6：读者在这本书上以前说过的话（长期记忆） ---- */
  const memory = (input.utterances ?? []).filter((u) => u.text.trim()).slice(-8)
  if (memory.length) {
    parts.push(
      `【读者在这本书上此前的思考（他自己说过的话，可以接着往下谈）】\n` +
        memory.map((u) => `- ${u.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')
    )
  }

  /* ---- 装配后断言 ---- */
  for (const s of sources) {
    if (s.end > globalPos + quote.length) {
      throw new ContextLeakError(`${s.label} 结束于 ${s.end}，超过划线位置 ${globalPos}`)
    }
  }

  const contextText = parts.join('\n\n')
  return {
    contextText,
    sources,
    stats: {
      totalChars: contextText.length,
      priorSections: priorSections.length,
      windowBlocks: inChapter.length,
      retrieved: retrieved.length,
      notes: notes.length,
      memory: memory.length,
      percent
    }
  }
}
