// OCR 错字纠正（词典约束）
//
// 思路和 pycorrector / FASPell 这类中文文本纠错一脉相承：OCR 认错的字通常是「字形相近的常用字」，
// 而正式出版物里几乎不出现生造词。于是把「识别出来的字」放回词里检查：
// 若某个字所在的 2–4 字窗口不在词典里（词频 0），而换成 CTC 第二/第三候选字后变成常见词
// （词典词频 ≥ 阈值），且不会破坏旁边本来就成立的词，就认定前者是认错的。
//
// 例：贵任编辑 → 责任编辑（贵任 不在词典，责任 词频 2000+）
//     王容井大街 → 王府井大街（王容井 0，王府井 是词）
//     即张 8 1/4 → 印张 8 1/4（即张 0，印张 是词）
//     字数195干 → 字数195千（干/千 同形近字，千字 是词）
//
// 只改「CTC 置信度低、且候选字本身就是模型第二猜测」的位置，正常字不会被牵连。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CharCand {
  /** 该字在整行文本里的下标 */
  i: number
  /** 备选字（不含原字） */
  c: string[]
  /** 对应 CTC 概率 */
  p: number[]
}

let lex: Map<string, number> | null = null

function dictCandidates(): string[] {
  let here = ''
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    here = __dirname
  }
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath
  const out: string[] = []
  if (process.env.MARGIN_OCR_MODELS) out.push(join(process.env.MARGIN_OCR_MODELS, 'dict.txt'))
  if (res) out.push(join(res, 'app', 'models', 'dict.txt'))
  out.push(join(process.cwd(), 'models', 'dict.txt'))
  out.push(join(here, '..', '..', '..', 'models', 'dict.txt'))
  out.push(join(here, '..', '..', '..', '..', 'models', 'dict.txt'))
  return out
}

/** 词典（词 → 词频）；格式 word|flag|freq，只收 2–4 字、词频 ≥5 的词，省内存 */
export function loadLex(): Map<string, number> {
  if (lex) return lex
  lex = new Map<string, number>()
  const file = dictCandidates().find((f) => existsSync(f))
  if (!file) return lex
  const raw = readFileSync(file, 'utf8')
  for (const line of raw.split('\n')) {
    const a = line.indexOf('|')
    if (a < 2) continue
    const w = line.slice(0, a)
    if (w.length < 1 || w.length > 4) continue
    const b = line.lastIndexOf('|')
    const f = parseInt(line.slice(b + 1), 10)
    if (!Number.isFinite(f) || f < 5) continue
    lex.set(w, f)
  }
  return lex
}

export function lexSize(): number {
  return loadLex().size
}

const WINDOW = /^[\u4e00-\u9fff]+$/
const isCjk = (ch: string): boolean => ch !== undefined && /[\u4e00-\u9fff]/.test(ch)

/** 换掉之后整行「词典得分」至少要涨这么多才动手（log 尺度） */
const MIN_GAIN = Number(process.env.MARGIN_OCR_MIN_GAIN ?? 8)
/** 候选字本身至少要有这么高的 CTC 概率，才算「模型也这么想过」 */
const MIN_CAND_P = 0.0005
const DEBUG = !!process.env.MARGIN_OCR_DEBUG

// 常用虚词/单字词：中文里本来就会单独成词，不能因为它们「只有一个字」就判成错字
const FUNC = new Set(
  '的了是在和与有他她它你我您们不然也就都而及或但很太最再又还被把给让从向对为以于之其且则因由等个这那哪谁什么着过上下中大小多少好可能要会想使做啊吧呢吗嘛哦呀吧啦呗咯已经将要会能可需就算只更没别得地'
)

/**
 * 词典得分：把整行按最长 4 字窗口切分，取总分最高的一种切法。
 * 词库里有的词拿 log(词频)，孤零零的单字（不是虚词）扣分，切不出词的连续汉字重罚。
 * 这比「某个 2–3 字窗口是不是词」稳得多：前者会被「王玉」「别字」这种偶然成词骗过去。
 */
function scoreOf(text: string, L: Map<string, number>): number {
  const n = text.length
  const dp = new Float64Array(n + 1)
  for (let i = 1; i <= n; i++) dp[i] = -1e9
  for (let i = 1; i <= n; i++) {
    for (let len = 1; len <= 4 && len <= i; len++) {
      const w = text.slice(i - len, i)
      let c: number
      if (WINDOW.test(w)) {
        const f = L.get(w) ?? 0
        if (f > 0) c = Math.log(f)
        else if (len === 1) c = -1.5
        else c = -9
        if (len === 1 && f > 0 && !FUNC.has(w)) c -= 2
        if (len === 1 && FUNC.has(w)) c = 0
      } else {
        c = len === 1 ? -0.5 : -6
      }
      const v = dp[i - len] + c
      if (v > dp[i]) dp[i] = v
    }
  }
  return dp[n]
}

/** 半角标点夹在汉字中间时换回全角（排印书里的「总之,凡是」都是 OCR 把「，」认成了「,」） */
export function fixPunct(text: string): string {
  return text
    .replace(/([\u4e00-\u9fff]),/g, '$1，')
    .replace(/,([\u4e00-\u9fff])/g, '，$1')
    .replace(/([\u4e00-\u9fff]):/g, '$1：')
    .replace(/:([\u4e00-\u9fff])/g, '：$1')
    .replace(/([\u4e00-\u9fff]);/g, '$1；')
    .replace(/;([\u4e00-\u9fff])/g, '；$1')
    .replace(/([\u4e00-\u9fff])\?/g, '$1？')
    .replace(/\?([\u4e00-\u9fff])/g, '？$1')
    .replace(/([\u4e00-\u9fff])!/g, '$1！')
    .replace(/!([\u4e00-\u9fff])/g, '！$1')
}

export interface FixLog {
  from: string
  to: string
}

/** 这个字是不是「孤零零一个字」：和左右都拼不成词 */
function isolated(text: string, j: number, L: Map<string, number>): boolean {
  for (const [a, b] of [
    [j - 2, j],
    [j - 1, j],
    [j, j + 1],
    [j, j + 2],
    [j - 1, j + 1]
  ]) {
    if (a < 0 || b >= text.length) continue
    const w = text.slice(a, b + 1)
    if (WINDOW.test(w) && (L.get(w) ?? 0) > 0) return false
  }
  return true
}

/**
 * 按词典约束纠正一行文本。cands 由 PP-OCR 解码时给出（每个字都有第二/第三候选）。
 * 判据：把这个字换成候选字后，整行的词典得分明显变高（原本切不出词的烂片段变成常见词）。
 */
export function fixText(text: string, cands?: CharCand[], log?: FixLog[]): string {
  if (!cands?.length || !text) return text
  const L = loadLex()
  if (!L.size) return text

  let base = scoreOf(text, L)
  for (const cand of cands) {
    const i = cand.i
    const cur = text[i]
    if (!isCjk(cur ?? '')) continue
    // 连着三个以上「拼不成词的孤字」基本都是人名、地名（巴枯宁、马骧聪），只靠词典会把它们改坏，
    // 这种连着的一串不碰；真正认错的字通常是夹在词中间的孤字（贵任编辑 → 责任编辑）
    if (isolated(text, i, L)) {
      let run = 1
      for (let j = i - 1; j >= 0 && isCjk(text[j]) && isolated(text, j, L); j--) run++
      for (let j = i + 1; j < text.length && isCjk(text[j]) && isolated(text, j, L); j++) run++
      if (run >= 3) continue
    }
    let best = ''
    let bestDelta = 0
    for (let k = 0; k < cand.c.length; k++) {
      const c = cand.c[k]
      const p = cand.p[k] ?? 0
      if (p < MIN_CAND_P || !isCjk(c) || c === cur) continue
      const next = text.slice(0, i) + c + text.slice(i + 1)
      const d = scoreOf(next, L) - base
      if (d > bestDelta) {
        bestDelta = d
        best = c
      }
    }
    if (best && bestDelta >= MIN_GAIN) {
      if (DEBUG) console.error(`[fix] ${text.slice(Math.max(0, i - 3), i + 4)} ${cur}->${best} @${bestDelta.toFixed(1)}`)
      log?.push({ from: text.slice(Math.max(0, i - 2), i + 3), to: text.slice(Math.max(0, i - 2), i).concat(best, text.slice(i + 1, i + 3)) })
      text = text.slice(0, i) + best + text.slice(i + 1)
      base += bestDelta
    }
  }
  return text
}
