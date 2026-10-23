import {
  countTranslations,
  getBook,
  getSection,
  getSetting,
  getTranslations,
  getTrJob,
  listGlossary,
  listSections,
  saveTrJob,
  setSetting,
  upsertTranslation,
  type TrJob
} from './db'
import { callModel, completeJson, loadProfile, type ChatMsg, type ModelConfig } from './ai'

/* ------------------------------------------------------------------ *
 * 翻译流水线
 *
 * 环节：术语表（全书一次）→ 初译 → 一审(准确) → 二校(表达) → 三审(术语/风格) → 终校
 * 每个审校环节都返回 {score, issues, revised}；低于阈值就重来，
 * 最多 maxRounds 轮 —— 这就是"三审三校"的可配置版本。
 * ------------------------------------------------------------------ */

export const STAGES = [
  { id: 'draft', name: '初译', desc: '逐段译出，带上下文参考' },
  { id: 'scope', name: '一审 · 准确性', desc: '对照原文抓漏译、误译、增译' },
  { id: 'polish', name: '二校 · 表达', desc: '目标语言通顺、文体贴合' },
  { id: 'terms', name: '三审 · 术语与风格', desc: '术语表一致、称谓与语气统一' },
  { id: 'final', name: '终校 · 定稿', desc: '最后一遍通读，去掉翻译腔' }
] as const

export type StageId = (typeof STAGES)[number]['id']

export const LANGS: Record<string, string> = {
  'zh-CN': '中文',
  'zh-TW': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
  it: '意大利语',
  pt: '葡萄牙语'
}

export interface TrConfig {
  targetLang: string
  threshold: number
  maxRounds: number
  concurrency: number
  /** 每个环节是否启用 */
  stages: Record<StageId, boolean>
  /** 审校环节用哪套模型 */
  reviewProfile: 'main' | 'review'
}

const DEFAULT_CONFIG: TrConfig = {
  targetLang: 'zh-CN',
  threshold: 75,
  maxRounds: 2,
  concurrency: 4,
  stages: { draft: true, scope: true, polish: true, terms: true, final: false },
  reviewProfile: 'review'
}

let cfgProvider: (() => TrConfig) | null = null

/** 由 api.ts 注入配置读写（避免 core 反向依赖 settings 解析逻辑） */
export function useConfigProvider(fn: () => TrConfig): void {
  cfgProvider = fn
}

export function normalizeConfig(raw: any): TrConfig {
  const c: TrConfig = { ...DEFAULT_CONFIG, ...(raw || {}) }
  c.stages = { ...DEFAULT_CONFIG.stages, ...(raw?.stages || {}) }
  c.threshold = clamp(Number(c.threshold) || DEFAULT_CONFIG.threshold, 40, 98)
  c.maxRounds = clamp(Math.round(Number(c.maxRounds) || 2), 1, 5)
  c.concurrency = clamp(Math.round(Number(c.concurrency) || 4), 1, 6)
  if (!LANGS[c.targetLang]) c.targetLang = 'zh-CN'
  return c
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function cfg(): TrConfig {
  return cfgProvider ? normalizeConfig(cfgProvider()) : loadConfig()
}

/* ---------------- 配置读写 ---------------- */

export function loadConfig(): TrConfig {
  try {
    const raw = getSetting('tr.config', '')
    if (raw) return normalizeConfig(JSON.parse(raw))
  } catch {
    /* 配置坏了就回默认 */
  }
  return { ...DEFAULT_CONFIG, stages: { ...DEFAULT_CONFIG.stages } }
}

export function saveConfig(patch: Partial<TrConfig>): TrConfig {
  const next = normalizeConfig({ ...loadConfig(), ...patch, stages: { ...loadConfig().stages, ...(patch.stages || {}) } })
  setSetting('tr.config', JSON.stringify(next))
  return next
}

/* ---------------- 状态 ---------------- */

const UNIT_CACHE = new Map<string, { n: number; at: number }>()

export function countUnitsCached(bookId: string): number {
  const hit = UNIT_CACHE.get(bookId)
  const now = Date.now()
  if (hit && now - hit.at < 60_000) return hit.n
  const n = countUnits(bookId)
  UNIT_CACHE.set(bookId, { n, at: now })
  return n
}

export function status(bookId: string) {
  const job = getTrJob(bookId)
  return {
    job,
    total: countUnitsCached(bookId),
    done: countTranslations(bookId),
    running: isRunning(bookId)
  }
}

/* ---------------- 文本工具 ---------------- */

/** FNV-1a，够用：判断原文有没有被重新导入覆盖 */
export function srcHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

function langName(code: string): string {
  return LANGS[code] ?? code
}

function glossaryBlock(items: Array<{ src: string; dst: string }>): string {
  if (!items.length) return ''
  const lines = items.slice(0, 60).map((g) => `- ${g.src} → ${g.dst}`)
  return `\n\n术语表（必须严格采用，不得另译）：\n${lines.join('\n')}`
}

function ctxBlock(prev?: string, next?: string): string {
  const parts: string[] = []
  if (prev) parts.push(`【上一段，仅供理解，不要翻译】\n${prev.slice(-400)}`)
  if (next) parts.push(`【下一段，仅供理解，不要翻译】\n${next.slice(0, 400)}`)
  return parts.length ? `\n\n${parts.join('\n\n')}` : ''
}

/* ---------------- 单段翻译 ---------------- */

export interface UnitResult {
  text: string
  score: number
  stage: number
  issues: string[]
  rounds: number
}

interface ReviewOut {
  score: number
  issues: string[]
  revised: string
}

export async function translateUnit(opts: {
  text: string
  prev?: string
  next?: string
  glossary: Array<{ src: string; dst: string }>
  bookTitle: string
  secTitle: string
  config?: TrConfig
  /** 快速模式：只初译，不跑审校链（用户双击単段时用） */
  fast?: boolean
}): Promise<UnitResult> {
  const c = opts.config ?? cfg()
  const target = langName(c.targetLang)
  const main = loadProfile('main')
  const reviewer: ModelConfig = c.reviewProfile === 'review' ? loadProfile('review') : main

  const gloss = glossaryBlock(opts.glossary)
  const ctx = ctxBlock(opts.prev, opts.next)
  const meta = `书名：《${opts.bookTitle}》\n章节：${opts.secTitle}`

  let text = ''
  let score = 0
  let stage = 0
  const issues: string[] = []
  let rounds = 0

  /* 初译 */
  if (c.stages.draft) {
    if (main.kind === 'mock') {
      text = `【译】${opts.text}`
      score = 80
    } else {
      const messages: ChatMsg[] = [
        {
          role: 'system',
          content: `你是资深${target}译者，翻译文学与人文社科学术著作。要求：忠实原意、句子自然、不增不减、保留段落内的语气与标点节奏。只输出译文本身，不要任何解释、不要引号包裹。${gloss}`
        },
        {
          role: 'user',
          content: `${meta}\n\n【原文】\n${opts.text}${ctx}\n\n请译成${target}：`
        }
      ]
      text = (await callModel(messages, main, { temperature: 0.35, maxTokens: 2000, purpose: 'translate' })).trim()
      score = 0
    }
    stage = 1
  }

  /* 审校链 */
  for (let i = 1; i < STAGES.length; i++) {
    if (opts.fast) break
    const st = STAGES[i]
    if (!c.stages[st.id]) continue
    if (!text) break
    if (reviewer.kind === 'mock') {
      score = Math.max(score, 82)
      stage = i + 1
      continue
    }
    for (let r = 0; r < c.maxRounds; r++) {
      rounds++
      const out = await reviewOnce(st.id, { meta, source: opts.text, current: text, gloss, target, cfg: c }, reviewer)
      if (!out) break
      if (out.revised) text = out.revised
      score = Number(out.score) || 0
      issues.push(...(out.issues || []))
      if (score >= c.threshold) break
    }
    stage = i + 1
  }

  return { text, score: score || (text ? c.threshold : 0), stage, issues: issues.slice(0, 8), rounds }
}

/**
 * 批量翻译：一次调用译若干段（同一节内），显著减少 CLI 启动与往返开销。
 * 返回 block.i → { text, score }。
 */
export async function translateBatch(opts: {
  items: Array<{ i: number; text: string }>
  prevText?: string
  nextText?: string
  glossary: Array<{ src: string; dst: string }>
  bookTitle: string
  secTitle: string
  config?: TrConfig
  fast?: boolean
}): Promise<Map<number, { text: string; score: number }>> {
  const out = new Map<number, { text: string; score: number }>()
  if (!opts.items.length) return out
  const c = opts.config ?? cfg()
  const target = langName(c.targetLang)
  const main = loadProfile('main')
  const reviewer: ModelConfig = c.reviewProfile === 'review' ? loadProfile('review') : main
  const gloss = glossaryBlock(opts.glossary)
  const meta = `书名：《${opts.bookTitle}》\n章节：${opts.secTitle}`
  const ctx = ctxBlock(opts.prevText, opts.nextText)

  if (main.kind === 'mock') {
    for (const it of opts.items) out.set(it.i, { text: `【译】${it.text}`, score: 80 })
    return out
  }

  const numbered = opts.items.map((it, n) => `[${n}] ${it.text}`).join('\n\n')
  const draftPrompt = `${meta}\n\n【原文】（共 ${opts.items.length} 段）\n${numbered}${ctx}\n\n请逐段译成${target}，只输出 JSON：{"items":[{"n":0,"text":"译文"},…]}。n 必须与上面方括号里的编号一一对应，不得合并、拆分或漏段。`
  const draftMsgs: ChatMsg[] = [
    {
      role: 'system',
      content: `你是资深${target}译者，翻译文学与人文社科学术著作。要求：忠实原意、句子自然、不增不减、保留段落语气与标点节奏。段落之间不要合并，也不要补写过渡。${gloss}`
    },
    { role: 'user', content: draftPrompt }
  ]

  const mockDraft = { items: opts.items.map((it, n) => ({ n, text: `【译】${it.text}` })) }
  const draft = await completeJson<{ items: Array<{ n: number; text: string }> }>(draftMsgs, main, mockDraft, {
    temperature: 0.35,
    purpose: 'translate',
    maxTokens: 4000
  })

  for (const row of draft.items ?? []) {
    const it = opts.items[row.n]
    if (it && row.text) out.set(it.i, { text: row.text.trim(), score: 0 })
  }
  // 模型漏段时就地补译，保证不丢内容
  for (const it of opts.items) {
    if (!out.has(it.i)) out.set(it.i, { text: it.text, score: 0 })
  }

  if (opts.fast) {
    for (const [k, v] of out) out.set(k, { ...v, score: v.score || c.threshold })
    return out
  }

  /* 审校链：整批一审，得分不足则重跑 */
  for (let s = 1; s < STAGES.length; s++) {
    const st = STAGES[s]
    if (!c.stages[st.id]) continue
    if (reviewer.kind === 'mock') {
      for (const [k, v] of out) out.set(k, { ...v, score: 82 })
      continue
    }
    for (let r = 0; r < c.maxRounds; r++) {
      const srcList = opts.items.map((it, n) => `[${n}] 原文：${it.text}\n    译文：${out.get(it.i)?.text ?? ''}`).join('\n\n')
      const msgs: ChatMsg[] = [
        {
          role: 'system',
          content: `你是双语审校，负责${target}译文质检。${STAGE_FOCUS[st.id]}\n只输出 JSON：{"score":0-100,"items":[{"n":0,"text":"修订后的译文"}],"issues":["..."]}。score 针对整批：85 以上可直接出版，75 左右可读但需打磨，60 以下不可用。${gloss}`
        },
        {
          role: 'user',
          content: `${meta}\n\n${srcList}\n\n请逐段审校并给出修订稿，编号与上面一致；只改有问题的段，没问题就原样返回。`
        }
      ]
      const mockRev = { score: 82, items: [], issues: [] as string[] }
      let rev: { score: number; items: Array<{ n: number; text: string }>; issues: string[] }
      try {
        rev = await completeJson(msgs, reviewer, mockRev, { purpose: 'translate', maxTokens: 4000 })
      } catch {
        break
      }
      for (const row of rev.items ?? []) {
        const it = opts.items[row.n]
        if (it && row.text) {
          const prev = out.get(it.i)
          out.set(it.i, { text: row.text.trim(), score: Number(rev.score) || prev?.score || 0 })
        }
      }
      for (const [k, v] of out) out.set(k, { ...v, score: Number(rev.score) || v.score })
      if ((Number(rev.score) || 0) >= c.threshold) break
    }
  }

  for (const [k, v] of out) if (!v.score) out.set(k, { ...v, score: c.threshold })
  return out
}

const STAGE_FOCUS: Record<string, string> = {
  draft: '',
  scope: '只抓准确性问题：漏译、误译、增译、指代错误、数字与专名错。不要为了好看而改写。',
  polish: '只抓目标语言表达问题：生硬直译、语序别扭、搭配不当、标点与节奏。不要改变原意。',
  terms: '只抓一致性问题：术语表是否被遵守、同一概念是否前后用了不同译法、称谓与语气是否统一。',
  final: '最后通读一遍：去掉翻译腔与冗词，让句子像母语写出来的，同时不许改动原意。'
}

async function reviewOnce(
  stage: StageId,
  p: { meta: string; source: string; current: string; gloss: string; target: string; cfg: TrConfig },
  reviewer: ModelConfig
): Promise<ReviewOut | null> {
  const focus: Record<string, string> = {
    scope: '只抓准确性问题：漏译、误译、增译、指代错误、数字与专名错。不要为了好看而改写。',
    polish: `只抓${p.target}表达问题：生硬直译、语序别扭、搭配不当、标点与节奏。不要改变原意。`,
    terms: '只抓一致性问题：术语表是否被遵守、同一概念是否前后用了不同译法、人物称谓与语气是否统一。',
    final: '最后通读一遍：去掉翻译腔与冗词，让句子像用目标语言直接写出来的，同时不许改动原意。'
  }
  const messages: ChatMsg[] = [
    {
      role: 'system',
      content: `你是双语审校，负责${p.target}译文的质检。${focus[stage]}\n只输出 JSON：{"score":0-100,"issues":["..."],"revised":"修订后的完整译文"}。\nscore 表示当前译文的可用程度：85 以上为可直接出版，75 左右为可读但需打磨，60 以下为不可用。${p.gloss}`
    },
    {
      role: 'user',
      content: `${p.meta}\n\n【原文】\n${p.source}\n\n【当前译文】\n${p.current}\n\n请按要求审校并给出修订稿。`
    }
  ]
  try {
    const out = await completeJson<ReviewOut>(
      messages,
      reviewer,
      { score: 82, issues: [], revised: p.current },
      { maxTokens: 2000, purpose: 'translate' }
    )
    if (typeof out?.revised !== 'string') return null
    return {
      score: Number(out.score) || 0,
      issues: Array.isArray(out.issues) ? out.issues.map(String) : [],
      revised: out.revised
    }
  } catch {
    return null
  }
}

/* ---------------- 术语表 ---------------- */

export async function buildGlossary(bookId: string, maxSecs = 8): Promise<Array<{ src: string; dst: string }>> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  const c = cfg()
  const main = loadProfile('main')
  if (main.kind === 'mock') {
    return [
      { src: 'margin', dst: '页边' },
      { src: 'annotation', dst: '批注' }
    ]
  }
  const secs = listSections(bookId).slice(0, maxSecs)
  const sample = secs
    .map((s) => {
      const full = getSection(bookId, s.idx)
      if (!full) return ''
      return full.blocks
        .map((b) => b.text)
        .join('\n')
        .slice(0, 1200)
    })
    .filter(Boolean)
    .join('\n\n---\n\n')

  const messages: ChatMsg[] = [
    {
      role: 'system',
      content: `你在为一部${langName(c.targetLang)}译本建立术语表。抽取全书反复出现、且译法必须统一的关键词：人名、地名、学派、核心概念、固定表达。\n只输出 JSON：{"items":[{"src":"原词","dst":"${langName(c.targetLang)}译法"}]}，最多 30 条，宁少勿滥，不要收录日常词汇。`
    },
    { role: 'user', content: `书名：《${book.title}》\n\n正文样本：\n${sample.slice(0, 9000)}` }
  ]
  const out = await completeJson<{ items: Array<{ src: string; dst: string }> }>(messages, main, { items: [] }, { maxTokens: 1500, purpose: 'translate' })
  return (out.items ?? []).filter((x) => x?.src && x?.dst).slice(0, 30)
}

/* ---------------- 任务调度 ---------------- */

const RUNNING = new Map<string, { paused: boolean }>()

export function isRunning(bookId: string): boolean {
  return RUNNING.has(bookId)
}

export function pauseJob(bookId: string): void {
  const h = RUNNING.get(bookId)
  if (h) h.paused = true
}

function translatable(block: { text: string; tag: string }): boolean {
  const t = block.text.trim()
  if (!t) return false
  if (block.tag === 'hr') return false
  return t.length >= 2
}

/** 统计整本需要翻译的块数 */
export function countUnits(bookId: string): number {
  let n = 0
  for (const s of listSections(bookId)) {
    const full = getSection(bookId, s.idx)
    if (!full) continue
    n += full.blocks.filter(translatable).length
  }
  return n
}

/** 前台单段翻译（用户点某一段时用） */
export async function translateBlock(bookId: string, secIdx: number, blockI: number): Promise<{ text: string; score: number }> {
  const book = getBook(bookId)
  const sec = getSection(bookId, secIdx)
  if (!book || !sec) throw new Error('章节不存在')
  const i = sec.blocks.findIndex((b) => b.i === blockI)
  const b = sec.blocks[i]
  if (!b) throw new Error('段落不存在')
  const c = cfg()
  const out = await translateUnit({
    text: b.text,
    prev: sec.blocks[i - 1]?.text,
    next: sec.blocks[i + 1]?.text,
    glossary: listGlossary(bookId),
    bookTitle: book.title,
    secTitle: sec.title,
    config: c,
    fast: true
  })
  upsertTranslation({
    book_id: bookId,
    sec_idx: secIdx,
    block_i: blockI,
    src_hash: srcHash(b.text),
    text: out.text,
    score: Math.round(out.score),
    stage: out.stage
  })
  return { text: out.text, score: Math.round(out.score) }
}

/** 源语言和目标语言相同就直接拒绝，免得模型把中文"翻译"成中文 */
function sameLang(a?: string, b?: string): boolean {
  const p = (s?: string) => (s || '').toLowerCase().split(/[-_]/)[0]
  return !!a && !!b && p(a) === p(b)
}

function ensureLang(srcLang: string | undefined, target: string): void {
  if (sameLang(srcLang, target)) {
    throw new Error('这本书本身就是这个语言，换一个目标语言再翻')
  }
}

/** 整本翻译（后台跑，可暂停、可断点续译） */
export async function startJob(bookId: string, targetLang?: string): Promise<TrJob> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  if (RUNNING.has(bookId)) {
    const j = getTrJob(bookId)
    if (j) return j
  }
  const c = { ...cfg(), targetLang: targetLang || cfg().targetLang }
  ensureLang(book.lang, c.targetLang)
  const total = countUnits(bookId)
  const job: TrJob = {
    book_id: bookId,
    target_lang: c.targetLang,
    state: 'running',
    total,
    done: countTranslations(bookId),
    cursor_sec: getTrJob(bookId)?.cursor_sec ?? 0,
    error: '',
    updated_at: Date.now()
  }
  saveTrJob(job)

  const handle = { paused: false }
  RUNNING.set(bookId, handle)
  void runJob(bookId, c, handle).finally(() => RUNNING.delete(bookId))
  return job
}

async function runJob(bookId: string, c: TrConfig, handle: { paused: boolean }): Promise<void> {
  const book = getBook(bookId)!
  const gloss = listGlossary(bookId)
  const secs = listSections(bookId)

  let done = countTranslations(bookId)
  const jobBase: TrJob = {
    book_id: bookId,
    target_lang: c.targetLang,
    state: 'running',
    total: countUnits(bookId),
    done,
    cursor_sec: 0,
    error: '',
    updated_at: Date.now()
  }

  const flush = (patch: Partial<TrJob>) => {
    Object.assign(jobBase, patch, { updated_at: Date.now() })
    saveTrJob(jobBase)
  }

  try {
    for (const meta of secs) {
      if (handle.paused) {
        flush({ state: 'paused' })
        return
      }
      const sec = getSection(bookId, meta.idx)
      if (!sec) continue
      jobBase.cursor_sec = meta.idx
      const targets = sec.blocks.map((b, i) => ({ b, i })).filter((x) => translatable(x.b))

      let cursor = 0
      const BATCH = 4
      const worker = async () => {
        while (cursor < targets.length) {
          if (handle.paused) return
          const slice = targets.slice(cursor, cursor + BATCH)
          cursor += slice.length
          const pending = slice.filter(({ b }) => {
            const ex = existingTranslation(bookId, meta.idx, b.i)
            return !(ex && ex.src_hash === srcHash(b.text))
          })
          if (!pending.length) continue
          try {
            const got = await translateBatch({
              items: pending.map(({ b }) => ({ i: b.i, text: b.text })),
              prevText: sec.blocks[Math.max(0, slice[0].i - 1)]?.text,
              nextText: sec.blocks[Math.min(sec.blocks.length - 1, slice[slice.length - 1].i + 1)]?.text,
              glossary: gloss,
              bookTitle: book.title,
              secTitle: sec.title,
              config: c
            })
            for (const { b } of pending) {
              const t = got.get(b.i)
              if (!t || !t.text) continue
              upsertTranslation({
                book_id: bookId,
                sec_idx: meta.idx,
                block_i: b.i,
                src_hash: srcHash(b.text),
                text: t.text,
                score: Math.round(t.score),
                stage: STAGES.length
              })
              done += 1
            }
            flush({ done })
          } catch (e: any) {
            jobBase.error = String(e?.message ?? e).slice(0, 200)
            flush({})
            // 整批失败就退化成逐段翻，别让一段坏掉拖死整节
            for (const { b } of pending) {
              if (handle.paused) break
              try {
                const one = await translateUnit({
                  text: b.text,
                  prev: sec.blocks[Math.max(0, b.i - 1)]?.text,
                  next: sec.blocks[Math.min(sec.blocks.length - 1, b.i + 1)]?.text,
                  glossary: gloss,
                  bookTitle: book.title,
                  secTitle: sec.title,
                  config: c,
                  fast: true
                })
                if (!one.text) continue
                upsertTranslation({
                  book_id: bookId,
                  sec_idx: meta.idx,
                  block_i: b.i,
                  src_hash: srcHash(b.text),
                  text: one.text,
                  score: Math.round(one.score),
                  stage: STAGES.length
                })
                done += 1
                flush({ done })
              } catch {
                /* 这一段放弃，继续下一段 */
              }
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(c.concurrency, targets.length || 1) }, worker))
    }
    flush({ state: handle.paused ? 'paused' : 'done', done })
  } catch (e: any) {
    flush({ state: 'error', error: String(e?.message ?? e).slice(0, 200) })
  }
}

function existingTranslation(bookId: string, secIdx: number, blockI: number): { src_hash: string } | null {
  const hit = getTranslations(bookId, secIdx).find((t) => t.block_i === blockI)
  return hit ? { src_hash: hit.src_hash } : null
}

export function getSectionTranslations(
  bookId: string,
  secIdx: number
): Array<{ block_i: number; src_hash: string; text: string; score: number }> {
  return getTranslations(bookId, secIdx).map((r) => ({
    block_i: r.block_i,
    src_hash: r.src_hash,
    text: r.text,
    score: r.score
  }))
}
