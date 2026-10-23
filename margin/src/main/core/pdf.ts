import type { ParsedBook, ParsedSection } from './epub'
import type { Block } from './text'
import { chapterLevel } from './text'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ocrPdfFile, type OcrPage } from './ocr'

/** pdfjs 需要 cmaps / standard_fonts 才能正确解码中文 CID 字体，否则会缺字 */
function findAssetDir(name: 'cmaps' | 'standard_fonts'): string {
  let here = process.cwd()
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    /* CJS 打包后没有 import.meta */
  }
  const cands = [
    join((process as any).resourcesPath ?? '', 'app', name),
    join(process.cwd(), name),
    join(process.cwd(), 'node_modules', 'pdfjs-dist', name),
    join(here, '..', '..', name),
    join(here, '..', '..', 'node_modules', 'pdfjs-dist', name)
  ]
  return cands.find((d) => existsSync(d)) ?? ''
}

/**
 * PDF 解析：取文字层 → 按行重建段落 → 用书里自带的书签（outline）分节。
 * 没有书签时用「字号明显变大 + 短行」识别章节标题，再不行才按页分组。
 * 扫描件（无文字层）会明确报错，等 OCR 环节再补。
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const CJK = '\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef'

/** 「第 X 章 / 序 / 前言」这类真章节标题 */
const CHAPTER_TITLE_RE =
  /^(第\s*[一二三四五六七八九十百千零〇0-9]+\s*[章节卷篇回部]|序言?|自序|前言|引言|楔子|后记|尾声|结语|附录|致谢|参考文献)/

/** OCR 文字层常见：汉字之间、数字之间被塞进空格 */
function squeeze(s: string): string {
  let t = s.replace(/\u00a0|\u3000/g, ' ')
  t = t.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1')
  t = t.replace(/(\d)\s+(?=\d)/g, '$1')
  t = t.replace(/([A-Za-z])\s+(?=[A-Za-z]{2,})/g, '$1 ')
  t = t.replace(/\s{2,}/g, ' ')
  return t.trim()
}

interface Line {
  y: number
  x: number
  w: number
  text: string
  size: number
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const a = [...xs].sort((p, q) => p - q)
  return a[Math.floor(a.length / 2)]
}

/** 标题里可能混着上标角标的私有标记（\u0001）和零宽/控制符，落到目录会显示成怪字符 */
function cleanTitle(s: string): string {
  return s
    .replace(/[\u0000-\u001f]/g, '')
    // 有些国产排版软件把书签里的括号写成 PDF 字符串转义形式「补充\(一\)」，要还原
    .replace(/\\([()\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 目录页里的一行：「第三章 国家……45」「附录 87」 */
const TOC_LINE_RE = /^(.*?)[\s.．·…。。\-—_]{0,}\s*(\d{1,4})\s*$/

/** 纯页码行：「— 23 —」「 46」「· 12 ·」 */
const PAGE_NO_RE = /^[\s\-—–·.]{0,3}(\d{1,4})[\s\-—–·.]{0,3}$/

interface TocEntry {
  title: string
  printed: number
}

/** 排查目录页解析问题时用：set MARGIN_DEBUG_TOC=1 */
const MARGIN_TOC_DEBUG = process.env.MARGIN_DEBUG_TOC === '1'

/**
 * 从「印刷目录页」里读章节表。
 *
 * 很多书没有 PDF 书签（或者书签粗到只有「前言 / 后记」两条），但它的正文前面
 * 明明印着目录。这份目录就在正文里，OCR/文字层都已经拿到手，不用它去分节
 * 等于白扔——读者打开目录看到「前言（含 1–1300 页）」当然会骂人。
 *
 * 返回的页码是 PDF 的物理页（已用页码偏移换算），调用方若不信可以自己再校验一遍。
 */
function readPrintedToc(
  pages: { paras: { text: string; tag: string }[] }[],
  total: number
): { title: string; from: number; to: number }[] | null {
  if (total < 20) return null
  const lineOf = (p: number) =>
    (pages[p - 1]?.paras ?? []).map((x) => x.text.replace(/\s+/g, ' ').trim()).filter(Boolean)

  // 目录页的页码常单独占一行（`5`、`·18`、`...35`），标题还带着点引导符
  const NUM_ONLY = /^[\s.．·…—–\-—_()（）]{0,8}(\d{1,4})[\s.．·…—–\-—_()（）]{0,8}$/
  const DOT_TAIL = /[\s.．·…。。\-—_]+$/
  const LEAD_NUM = /^[\s.．·…—–\-_]*\d{1,4}[\s.．·…—–\-_]*/
  const LEAD_NUM_JUNK = /^[\s.．·…—–\-_]{1,12}(\d{1,4})[\s.．·…—–\-_]{0,12}(?=[\u4e00-\u9fff])/

  // 1) 找目录页：页码行密集，或页首写着「目录」。合订本可能有不止一套目录
  //    （上卷一份、下卷一份），所以全书都扫，最多收 6 段
  const isTocPage = (p: number) => {
    const lines = lineOf(p)
    const numHits = lines.filter((l) => NUM_ONLY.test(l)).length
    const marked = /目\s*录|目\s*次|contents/i.test(lines.slice(0, 3).join(' '))
    return lines.length >= 5 && (numHits >= 4 || (marked && numHits >= 2))
  }
  const tocRuns: number[][] = []
  for (let p = 1; p <= total && tocRuns.length < 6; p++) {
    if (!isTocPage(p)) continue
    const run = [p]
    while (p + 1 <= total && isTocPage(p + 1)) {
      p++
      run.push(p)
    }
    tocRuns.push(run)
  }
  if (!tocRuns.length) return null

  // 2) 按「章序号」切条目：一/二/二十一 开头的行是章，`（一）`开头的是节（丢弃）
  const entries: TocEntry[] = []
  const CN_NUM = /^[一二三四五六七八九十百]{1,4}(?=[\u4e00-\u9fff])/
  const parseRun = (run: number[]): void => {
    // 章首页码：OCR 常把小节页码和章首页码搅在一起（111 被认成 11、521 被认成 54），
    // 所以先收集候选，再挑「比上一章大」里面最小的那个
    let cur: { title: string; cands: number[] } | null = null
    let lastPrinted = 0
    const flush = () => {
      if (cur && cur.title && cur.cands.length) {
        const ahead = cur.cands.filter((n) => n > lastPrinted).sort((a, b) => a - b)
        const printed = ahead.length ? ahead[0] : Math.max(...cur.cands)
        if (printed > 0) {
          entries.push({ title: cur.title, printed })
          lastPrinted = printed
        }
      }
      cur = null
    }
    for (const p of run) {
      for (const l of lineOf(p)) {
        const numOnly = NUM_ONLY.exec(l)
        if (numOnly) {
          if (cur) cur.cands.push(Number(numOnly[1]))
          continue
        }
        if (/^[（(]/.test(l)) {
          // 小节标题被 OCR 和页码粘成一行时，这个页码其实还是章首页
          const pm = /[\s.．·…\-—_]{1,}(\d{1,4})$/.exec(l)
          if (pm && cur) cur.cands.push(Number(pm[1]))
          continue
        }
        const lead = LEAD_NUM_JUNK.exec(l)
        let body = cleanTitle((lead ? l.slice(lead[0].length) : l).replace(DOT_TAIL, ''))
        if (!body) continue
        if (/^(目\s*录|目\s*次|contents)$/i.test(body)) continue
        let inlinePage = 0
        const ip = /^(.*?)[\s.．·…\-—_]{1,}(\d{1,4})$/.exec(body)
        if (ip && /[\u4e00-\u9fffA-Za-z]/.test(ip[1])) {
          body = ip[1]
          inlinePage = Number(ip[2])
        }
        const t = cleanTitle(body.replace(/[.．·…]{2,}/g, ''))
        if (t.length < 2 || t.length > 48 || !/[\u4e00-\u9fffA-Za-z]/.test(t)) continue
        if (!CN_NUM.test(t) && cur) continue // 章标题的折行
        flush()
        cur = { title: t, cands: inlinePage ? [inlinePage] : [] }
      }
    }
    flush()
  }
  for (const run of tocRuns) parseRun(run)
  if (MARGIN_TOC_DEBUG)
    console.log('[toc] pages', tocRuns.map((r) => r.join('+')).join(' / '), 'entries', entries.length)
  if (entries.length < 4) return null

  // 3) 定位每章在正文里的实际页。原先靠「页脚页码」投票换算，但页眉页脚清理
  //    早把那些纯数字行删了，而且合订本上下卷各算一套页码，换算本身就不可靠。
  //    改成：从上一章之后开始，找「章标题出现在页首几行」的那一页。
  const tocEnd = tocRuns[0][tocRuns[0].length - 1]
  const flat = (s: string) => s.replace(/[\s\p{P}]/gu, '')
  const headKey = (title: string) =>
    flat(title.replace(/^[（(]?[一二三四五六七八九十百\d]+[）)、.\s]+/, '')).slice(0, 6)
  const findFrom = (title: string, from: number): number | null => {
    const key = headKey(title)
    if (key.length < 3) return null
    const end = Math.min(total, from + 400)
    for (let p = from; p <= end; p++) {
      if (flat(lineOf(p).slice(0, 6).join('')).includes(key)) return p
    }
    return null
  }
  const marks: { title: string; page: number }[] = []
  let lastPage = tocEnd
  for (const e of entries) {
    const page = findFrom(e.title, lastPage + 1)
    if (!page) continue
    lastPage = page
    marks.push({ title: e.title, page })
  }
  if (MARGIN_TOC_DEBUG) console.log('[toc] marks', marks.map((m) => `${m.page}:${m.title}`).join(' | '))
  if (marks.length < 4) return null

  const plans: { title: string; from: number; to: number }[] = []
  if (marks[0].page > 1) plans.push({ title: '', from: 1, to: marks[0].page - 1 })
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].page
    const to = i + 1 < marks.length ? marks[i + 1].page - 1 : total
    if (to >= from) plans.push({ title: marks[i].title, from, to })
  }
  return plans.length >= 4 ? plans : null
}

/** 把一页的行拼成段落 */
function pageToParas(lines: Line[]): { paras: string[]; headings: Set<number>; bodySize: number } {
  if (!lines.length) return { paras: [], headings: new Set(), bodySize: 0 }
  const sizeCount = new Map<number, number>()
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2
    sizeCount.set(k, (sizeCount.get(k) ?? 0) + l.text.length)
  }
  const bodySize = [...sizeCount.entries()].sort((a, b) => b[1] - a[1])[0][0] || 10

  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const g = Math.abs(lines[i - 1].y - lines[i].y)
    if (g > 0 && g < bodySize * 2.6) gaps.push(g)
  }
  const lg = median(gaps) || bodySize * 1.35

  const maxRight = Math.max(...lines.map((l) => l.x + l.w))
  const minX = Math.min(...lines.map((l) => l.x))
  const textWidth = Math.max(1, maxRight - minX)

  const paras: string[] = []
  const headings = new Set<number>()
  let cur = ''
  let curHeading = false
  let prev: Line | null = null

  for (const line of lines) {
    const text = squeeze(line.text)
    if (!text) continue
    const gap = prev ? Math.abs(prev.y - line.y) : 0
    const indent = line.x - minX
    const prevShort = prev ? prev.x + prev.w < maxRight - textWidth * 0.18 : false
    const sizeJump = Math.abs(line.size - bodySize) > bodySize * 0.18
    const isHeading = line.size > bodySize * 1.15 && text.length <= 40

    const startNew =
      !cur ||
      (prev !== null &&
        (gap > lg * 1.45 ||
          sizeJump ||
          prevShort ||
          (indent > line.size * 1.1 && !curHeading) ||
          isHeading !== curHeading))

    if (startNew && cur) {
      paras.push(cur)
      cur = ''
    }
    if (!cur) curHeading = isHeading
    const prevChar = cur.slice(-1)
    const needSpace =
      !!cur && !new RegExp(`[${CJK}]$`).test(prevChar) && !/^[，。、；：？！）》」』”’]/.test(text)
    cur += (needSpace ? ' ' : '') + text
    prev = line
  }
  if (cur) paras.push(cur)

  const idx = paras.length - 1
  if (idx >= 0 && lines.length && lines[0].size > bodySize * 1.15) headings.add(0)
  return { paras, headings, bodySize }
}

interface OutlineEntry {
  title: string
  page: number
}

async function readOutline(doc: any): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = []
  try {
    const raw: any[] | null = await doc.getOutline()
    if (!raw) return out
    const walk = async (items: any[]) => {
      for (const it of items) {
        let page = 0
        try {
          const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest
          if (Array.isArray(dest) && dest.length) {
            const ref = dest[0]
            page = typeof ref === 'number' ? ref + 1 : (await doc.getPageIndex(ref)) + 1
          }
        } catch {
          /* 单个书签解析失败忽略 */
        }
        const title = squeeze(String(it.title ?? '')).replace(/\s+/g, ' ')
        if (page > 0 && title) out.push({ title, page })
        if (it.items?.length) await walk(it.items)
      }
    }
    await walk(raw)
  } catch {
    /* 没有书签 */
  }
  return out.sort((a, b) => a.page - b.page)
}

/** OCR 结果 → 行（y 翻成 pdfjs 那样「从页底往上」，并认出上标角标） */
function ocrRows(p: OcrPage): Line[] {
  const rows: Line[] = []
  for (const l of p.lines) {
    const words = (l.words ?? []).filter((w) => w.t && w.t.trim())
    if (!words.length) continue
    const hs = words
      .map((w) => w.h)
      .filter((h) => h > 0)
      .sort((a, b) => a - b)
    const size = (hs.length ? hs[Math.floor(hs.length / 2)] : 0) || 10
    const left = Math.min(...words.map((w) => w.x))
    const right = Math.max(...words.map((w) => w.x + w.w))
    const bottom = Math.max(...words.map((w) => w.y + w.h))
    let cur = ''
    for (const w of words) {
      const t = w.t.trim()
      if (!t) continue
      // 上标角标：字高明显比本行小、且基线抬高了的小数字 / ①-⑳
      const isSup = words.length > 2 && w.h < size * 0.82 && bottom - (w.y + w.h) > size * 0.12
      if (isSup && /^([0-9]{1,3}|[①-⑳])$/.test(t)) {
        cur += `\u0001${t}\u0001`
        continue
      }
      const needSpace = !!cur && /[A-Za-z0-9]$/.test(cur) && /^[A-Za-z0-9]/.test(t)
      cur += (needSpace ? ' ' : '') + t
    }
    if (!cur.trim()) continue
    rows.push({ y: p.h - bottom, x: left, w: Math.max(1, right - left), text: cur, size })
  }
  return mergeFragments(rows)
}

/**
 * 封面、印章、美术字常被 OCR 拆成几个碎块（「商」「务印书」「馆」），
 * 前后顺序也会乱。同一行基线上的纯汉字碎块按 x 拼回一整行。
 */
function mergeFragments(rows: Line[]): Line[] {
  if (rows.length < 2) return rows
  const allCjk = (s: string) => /^[\u4e00-\u9fff]+$/.test(s)
  const sorted = [...rows].sort((a, b) => b.y - a.y || a.x - b.x)
  const out: Line[] = []
  let group: Line[] = []
  const flush = () => {
    if (!group.length) return
    const total = group.reduce((n, g) => n + g.text.length, 0)
    if (group.length >= 2 && total <= 12 && group.every((g) => allCjk(g.text) && g.text.length <= 4)) {
      const parts = [...group].sort((a, b) => a.x - b.x)
      const left = Math.min(...parts.map((g) => g.x))
      const right = Math.max(...parts.map((g) => g.x + g.w))
      out.push({
        y: Math.max(...parts.map((g) => g.y)),
        x: left,
        w: right - left,
        text: parts.map((g) => g.text).join(''),
        size: Math.max(...parts.map((g) => g.size))
      })
    } else {
      out.push(...group)
    }
    group = []
  }
  for (const r of sorted) {
    if (group.length && Math.abs(group[0].y - r.y) > Math.max(4, r.size * 0.4)) flush()
    group.push(r)
  }
  flush()
  return out
}

export async function parsePdf(
  buf: Uint8Array,
  opts2: { onProgress?: (done: number, total: number) => void } = {}
): Promise<ParsedBook> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdfjs 会把传进去的缓冲区 detach 掉；扫描件稍后还要用原始字节跑 OCR，所以这里给它一份拷贝
  const opts: any = {
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0
  }
  const cmapDir = findAssetDir('cmaps')
  if (cmapDir) {
    opts.cMapUrl = cmapDir + '/'
    opts.cMapPacked = true
  }
  const fontDir = findAssetDir('standard_fonts')
  if (fontDir) opts.standardFontDataUrl = fontDir + '/'
  const doc = await (async () => {
    try {
      return await pdfjs.getDocument(opts).promise
    } catch (e) {
      // 有些 PDF 的 xref 表坏了，手机阅读器能容错打开，pdfjs 却直接拒绝；
      // 用 pdf-lib 读一遍再另存（它会重写 xref），然后重试。
      const { PDFDocument } = await import('pdf-lib')
      const fixed = await PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
      opts.data = await fixed.save()
      return await pdfjs.getDocument(opts).promise
    }
  })()

  let title = ''
  let author = ''
  try {
    const meta = await doc.getMetadata()
    const info: any = meta?.info ?? {}
    title = String(info.Title ?? '').trim()
    author = String(info.Author ?? '').trim()
  } catch {
    /* 元数据缺失不影响阅读 */
  }

  const total = doc.numPages
  // 先把每页的段落准备好（也用于判断文字层是否存在）
  const pages: { paras: { text: string; tag: string }[]; bodySize: number }[] = []
  let totalText = 0

  /** 把一页的行拼成段落、挂到 pages 上（文字层与 OCR 两条路共用） */
  const finishPage = (rows: Line[], pageH: number, isOcr = false) => {
    rows.sort((a, b) => b.y - a.y || a.x - b.x)
    const built = pageToParas(rows)
    const bodySize = built.bodySize || 10
    // 页码：只在页面上下边缘的纯数字孤行，混进正文就会变成「……也就够了 202」这种脏尾巴
    const isPageNo = (r: Line) =>
      /^[\s·—\-–]*(?:\d{1,4}|[ivxlcdm]{1,6})[\s·—\-–]*$/i.test(squeeze(r.text))
    const clean = pageH
      ? rows.filter((r) => !(isPageNo(r) && (r.y > pageH * 0.86 || r.y < pageH * 0.14)))
      : rows
    // 页底小字才是脚注。OCR 的「字号」是词框高度估出来的，同一行正文能在 0.86–1.0 倍之间
    // 乱跳，用 0.9 倍去卡会把正文整段当成脚注抽走（「……并不是一个可怕的」后面就断了），
    // 所以 OCR 这条路要求更严：字号明显更小，而且行首必须是脚注序号。
    const isFoot = (r: Line) => {
      if (!pageH || r.y >= pageH * 0.28) return false
      if (isOcr) {
        return r.size < bodySize * 0.78 && /^\s*(\d{1,3}|[①-⑳])/.test(squeeze(r.text)) && squeeze(r.text).length > 6
      }
      return r.size < bodySize * 0.9
    }
    const footRows = pageH ? clean.filter(isFoot) : []
    const footText = footRows.map((r) => squeeze(r.text)).filter(Boolean).join('')
    const bodyRows = pageH ? clean.filter((r) => !footRows.includes(r)) : clean
    const paras = pageToParas(bodyRows).paras
      .filter((t) => !/^\d{1,4}$/.test(t))
      .map((text) => ({ text, tag: 'p' }))
    if (footText.trim().length > 8) paras.push({ text: footText, tag: 'blockquote' })
    // 跨页续段：上一页最后一段没写完（不以句末标点收尾）且下一页开头不是新标题时接回去
    const prevPage = pages[pages.length - 1]
    if (prevPage && paras.length) {
      // 上一页末尾可能是脚注（blockquote），要往前找真正的正文末段
      let prevLast: { text: string; tag: string } | undefined
      for (let k = prevPage.paras.length - 1; k >= 0; k--) {
        if (prevPage.paras[k].tag === 'p') {
          prevLast = prevPage.paras[k]
          break
        }
      }
      const first = paras[0]
      if (
        prevLast &&
        first.tag === 'p' &&
        prevLast.text.length > 15 &&
        !/[。！？…；：”’』」）】!?;:]$/.test(prevLast.text) &&
        !CHAPTER_TITLE_RE.test(first.text.trim())
      ) {
        prevLast.text += first.text
        paras.shift()
      }
    }
    pages.push({ paras, bodySize })
    totalText += paras.reduce((n, x) => n + x.text.length, 0)
  }

  for (let p = 1; p <= total; p++) {
    const page = await doc.getPage(p)
    const viewport = page.getViewport({ scale: 1 })
    const pageH = Number(viewport?.height) || 0
    const content = await page.getTextContent()
    const rows: Line[] = []
    let cur: Line | null = null
    for (const item of content.items as any[]) {
      const str: string = item.str ?? ''
      const y = item.transform?.[5] ?? 0
      const x = item.transform?.[4] ?? 0
      const size = Math.abs(item.transform?.[3] ?? 10) || 10
      const w = Number(item.width) || 0
      // 上标角标：字号小且明显高于当前行基线的小数字 / ①-⑳ —— 先打上私有标记，稍后转成可点击的脚注链接
      if (cur && /^([0-9]{1,3}|[①-⑳])$/.test(str.trim()) && y - cur.y > size * 0.25) {
        cur.text += `\u0001${str.trim()}\u0001`
        cur.w += w
        continue
      }
      if (!str.trim()) {
        // pdf.js 用 hasEOL 标出「这一行到此结束」，比只看 y 更可靠（上下标、行内不同字号）
        if (item.hasEOL && cur) {
          rows.push(cur)
          cur = null
        }
        continue
      }
      if (cur && Math.abs(cur.y - y) < size * 0.5) {
        const needSpace = /[A-Za-z0-9]$/.test(cur.text) && /^[A-Za-z0-9]/.test(str)
        cur.text += (needSpace ? ' ' : '') + str
        cur.w += w + (needSpace ? size * 0.3 : 0)
      } else {
        if (cur) rows.push(cur)
        cur = { y, x, w, text: str, size }
      }
      if (item.hasEOL && cur) {
        rows.push(cur)
        cur = null
      }
    }
    if (cur) rows.push(cur)
    page.cleanup()

    finishPage(rows, pageH)
  }

  // 扫描件（没有文字层，或文字层只剩零星几个字）→ 走 Windows 自带的离线 OCR
  const scanned = !totalText || totalText < Math.max(40, total * 8)
  if (scanned) {
    const tmp = join(tmpdir(), `margin-ocr-${process.pid}-${Date.now()}.pdf`)
    try {
      writeFileSync(tmp, buf)
      const ocrPages = await ocrPdfFile(tmp, { onProgress: opts2.onProgress })
      pages.length = 0
      totalText = 0
      for (const op of ocrPages) {
        const rows = ocrRows(op)
        if (!rows.length) {
          // 空白页也要占位，否则后续按页码取节会整体错位
          pages.push({ paras: [], bodySize: 10 })
          continue
        }
        finishPage(rows, op.h, true)
      }
    } finally {
      try {
        unlinkSync(tmp)
      } catch {
        /* 临时文件删不掉不影响结果 */
      }
    }
  }

  // 页眉/页脚（书名、「第三章 国家」这类刊头）会在每页的首行或末行重复出现，
  // 落到正文里就是「……无政府状态 巴枯宁认为」这种断不掉的脏东西，按频次清掉
  {
    const norm = (s: string) => s.replace(/\d+/g, '#').replace(/[\s\p{P}]/gu, '')
    const freq = new Map<string, number>()
    for (const pg of pages) {
      for (const c of [pg.paras[0], pg.paras[pg.paras.length - 1]]) {
        if (!c || c.text.length > 40) continue
        const k = norm(c.text)
        if (k.length >= 4) freq.set(k, (freq.get(k) ?? 0) + 1)
      }
    }
    const limit = Math.max(3, Math.floor(total * 0.25))
    for (const pg of pages) {
      if (pg.paras.length < 2) continue
      const first = pg.paras[0]
      const last = pg.paras[pg.paras.length - 1]
      const drop = new Set<string>()
      for (const c of [first, last]) {
        if (c.text.length > 40) continue
        // 页眉/页脚多是十几个字（书名、篇名）：大部头按 25% 频次卡根本卡不住
        //（1300 页的书要重复 325 次），短行重复 3 次就足够可疑
        const need = c.text.length <= 15 ? 3 : limit
        if ((freq.get(norm(c.text)) ?? 0) >= need) drop.add(c.text)
      }
      if (drop.size) pg.paras = pg.paras.filter((c) => !drop.has(c.text))
    }
  }

  const outline = await readOutline(doc)
  await doc.destroy()

  // 书里印着的目录页：书签缺失/太粗时的救命稻草
  const tocPlans = readPrintedToc(pages, total)

  if (!totalText) {
    throw new Error('这个 PDF 既没有文字层，OCR 也没能识别出内容')
  }

  const sections: ParsedSection[] = []
  const pushSection = (name: string, range: number[], href: string) => {
    const items: { text: string; tag: string }[] = []
    for (let p = range[0]; p <= range[1]; p++) {
      const pg = pages[p - 1]
      if (pg) items.push(...pg.paras)
    }
    // 断段后处理：前一块没有以句末标点收尾（说明是被页码/分栏/换页硬切开的），
    // 就把下一块接回去。页内错断和跨页错断都靠这一步兜住。
    const merged: { text: string; tag: string }[] = []
    // 只看「上一块原始段落」的长度。若拿拼接后变长的结果继续判断，版权页那种
    // 一行一句的短行会被一路粘成一大坨，商务印书馆就变成了「馆 商 务印书」的乱账
    let lastLen = 0
    for (const it of items) {
      const prev = merged[merged.length - 1]
      const openEnded =
        !!prev &&
        prev.tag === 'p' &&
        it.tag === 'p' &&
        lastLen > 20 &&
        it.text.length >= 12 &&
        !/[。！？…；：”’」』）】!?;:.]$/.test(prev.text)
      if (openEnded) {
        const a = prev.text.slice(-1)
        const b = it.text.slice(0, 1)
        prev.text += (/[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b) ? ' ' : '') + it.text
      } else {
        merged.push({ ...it })
      }
      lastLen = it.text.length
    }
    const strip = (s: string) => s.replace(/\u0001/g, '')
    const toHtml = (tag: string, raw: string) => {
      if (tag === 'blockquote') {
        const m = /^\s*([0-9]{1,3}|[①-⑳])\s*/.exec(raw)
        const anchor = m ? `<a id="fn-${m[1]}"></a>` : ''
        return anchor + escapeHtml(strip(raw))
      }
      return escapeHtml(raw).replace(
        /\u0001([0-9]{1,3}|[①-⑳])\u0001/g,
        (_m, n: string) => `<a class="fn-ref" href="#fn-${n}" title="脚注 ${n}"><sup>${n}</sup></a>`
      )
    }
    const text = merged.map((x) => strip(x.text)).join('\n')
    if (!text.trim()) return
    let cursor = 0
    const blocks: Block[] = merged.map((it, i) => {
      const plain = strip(it.text)
      const start = cursor
      cursor += plain.length + 1
      return { i, tag: it.tag, text: plain, html: toHtml(it.tag, it.text), start, end: start + plain.length }
    })
    sections.push({ idx: sections.length, title: cleanTitle(name), level: chapterLevel(name), href, blocks, text })
  }

  /** 一条分节计划落到 sections（无名的「前置桶」用页首像标题的短行来命名） */
  const pushPlan = (plan: { title: string; from: number; to: number }) => {
    if (plan.title) {
      pushSection(plan.title, [plan.from, plan.to], `#page-${plan.from}`)
      return
    }
    const blocks = pages
      .slice(plan.from - 1, plan.to)
      .flatMap((p) => p.paras)
      .map((x) => x.text.trim())
      .filter(Boolean)
    if (!blocks.length) return
    // 第一个书签之前通常是封面/序。优先用「像标题的短行」，否则取首句前半截；
    // 首句常是「★」「扉页」这类单个符号，要跳过
    const head = blocks.find(
      (t) => t.length >= 2 && t.length <= 20 && /[\u4e00-\u9fffA-Za-z]/.test(t)
    )
    const fallback = blocks[0].replace(/\s+/g, ' ').split(' ')[0]
    let pick = head ?? fallback
    // 封面书名常被劈成两行（「若干重大决策与」/「事件的回顾」），接上下一行才是完整书名
    if (head && !/[。！？：；，、]/.test(head)) {
      const next = blocks[blocks.indexOf(head) + 1]
      if (next && next.length <= 14 && !/[。！？：；]/.test(next)) pick = head + next
    }
    const name = pick.slice(0, 30)
    if (name) pushSection(name, [plan.from, plan.to], `#page-${plan.from}`)
  }

  if (outline.length >= 2) {
    // 书签里常混有「封面/书名/版权/目录」和纯页码（有些 PDF 每页一个数字书签），
    // 这些不是章节；同名连续书签（序 / 序 / 序）也只算一个分界，否则同一段内容会出现好几节
    const junkTitle =
      /^(\d{1,4}|封面|封底|书名页?|扉页|内封|版权页?|目录页?|前言页|插页|contents|[★☆※·\-—._]+)$/i
    const marks: OutlineEntry[] = []
    for (const o of outline) {
      if (o.page < 1 || o.page > total) continue
      // 书签名里常夹着零宽/控制符（扫描件 OCR 出来的目录尤其常见），
      // 先洗一遍再判断，否则「版权页\u0000」会漏过垃圾过滤器变成一节
      const name = cleanTitle(o.title)
      if (!name || junkTitle.test(name)) continue
      const prev = marks[marks.length - 1]
      if (prev && o.page <= prev.page) continue
      if (prev && prev.title === name) continue
      marks.push({ ...o, title: name })
    }
    if (marks.length >= 2) {
      const plans: { title: string; from: number; to: number }[] = []
      // 第一个书签之前的页（扉页、序）不能丢，否则读者会觉得「缺字少字」
      if (marks[0].page > 1) plans.push({ title: '', from: 1, to: marks[0].page - 1 })
      for (let i = 0; i < marks.length; i++) {
        const from = marks[i].page
        const to = i + 1 < marks.length ? marks[i + 1].page - 1 : total
        if (to >= from) plans.push({ title: marks[i].title, from, to })
      }
      // 书签只有寥寥几条（或一条书签吞掉大半本）时，书签就是个摆设：
      // 这时改用书里印着的目录页，别让读者对着「前言（1–1300 页）」发呆
      const maxSpan = plans.reduce((m, p) => Math.max(m, p.to - p.from), 0)
      if (tocPlans && (marks.length < 3 || maxSpan > total * 0.5)) {
        plans.length = 0
        plans.push(...tocPlans)
      }
      for (const plan of plans) {
        // 书签太粗（一节跨几十页）时，在节内部再按「第 X 章」标题切，别让目录只有寥寥几条
        if (plan.to - plan.from >= 30) {
          const inner: { title: string; page: number }[] = []
          for (let p = plan.from; p <= plan.to; p++) {
            const pg = pages[p - 1]
            if (!pg?.paras.length) continue
            for (const t of pg.paras.slice(0, 3)) {
              const s = t.text.replace(/\s+/g, ' ').trim()
              if (s.length <= 40 && CHAPTER_TITLE_RE.test(s)) {
                inner.push({ title: s, page: p })
                break
              }
            }
          }
          if (inner.length >= 3) {
            // 页眉会在每页重复出现（「第一章 …」），按前 10 字统计，出现 >2 次的当页眉丢掉
            const key = (s: string) => s.replace(/[\s\p{P}]/gu, '').slice(0, 10)
            const freq = new Map<string, number>()
            for (const m of inner) freq.set(key(m.title), (freq.get(key(m.title)) ?? 0) + 1)
            const marks2 = inner.filter((m) => (freq.get(key(m.title)) ?? 0) <= 2)
            const use = marks2.length >= 3 ? marks2 : inner
            for (let i = 0; i < use.length; i++) {
              const from = use[i].page
              const to = i + 1 < use.length ? use[i + 1].page - 1 : plan.to
              if (to >= from) pushSection(use[i].title, [from, to], `#page-${from}`)
            }
            continue
          }
        }
        // 书签太粗（一节几十上百页）又识别不出「第 X 章」时，试试用「字号变大的短行」当小标题。
        // 只在「书签本来就极粗（≤3 条）」且不是扫描件时启用：扫描件的字号是 OCR 估出来的，
        // 拿它猜标题只会造出「的全俄罗斯沙皇的鞭子去拯救他们！」这种假章节。
        if (plan.to - plan.from >= 60 && !scanned && plans.length <= 3) {
          const heads: { title: string; page: number }[] = []
          for (let p = plan.from; p <= plan.to; p++) {
            const pg = pages[p - 1]
            if (!pg?.paras.length) continue
            const first = pg.paras[0].text.replace(/\s+/g, ' ').trim()
            const longest = Math.max(...pg.paras.map((t) => t.text.length))
            if (
              first.length >= 2 &&
              first.length <= 24 &&
              first.length < longest * 0.6 &&
              /[\u4e00-\u9fff]/.test(first) &&
              !/[，。；：、,.;:]$/.test(first)
            ) {
              heads.push({ title: first, page: p })
            }
          }
          const freq = new Map<string, number>()
          for (const h of heads) freq.set(h.title, (freq.get(h.title) ?? 0) + 1)
          const marks = heads.filter((h) => (freq.get(h.title) ?? 0) <= 2)
          if (marks.length >= 4) {
            for (let i = 0; i < marks.length; i++) {
              const from = marks[i].page
              const to = i + 1 < marks.length ? marks[i + 1].page - 1 : plan.to
              if (to >= from) pushSection(marks[i].title, [from, to], `#page-${from}`)
            }
            continue
          }
        }
        // 书签就是原书的目录，读者认的是它。以前这里还按 25 页硬切过一遍，
        // 结果一个「导论」被拆成「导论·第 9–33 页」九条假目录，纯属自作主张，已删掉
        pushPlan(plan)
      }
    } else {
      outline.length = 0
    }
  }
  if (!sections.length) {
    // 没有书签（或书签太粗被上面判掉）：先看印刷目录页
    if (tocPlans) for (const plan of tocPlans) pushPlan(plan)
  }
  if (!sections.length) {
    // 还没有，就看每页开头是不是「第 X 章 / 序 / 前言」这种真标题
    const chapterMarks: { title: string; page: number }[] = []
    for (let p = 1; p <= total; p++) {
      const pg = pages[p - 1]
      if (!pg?.paras.length) continue
      for (const t of pg.paras.slice(0, 3)) {
        const s = t.text.replace(/\s+/g, ' ').trim()
        if (s.length <= 40 && CHAPTER_TITLE_RE.test(s)) {
          chapterMarks.push({ title: s, page: p })
          break
        }
      }
    }
    if (chapterMarks.length >= 3) {
      for (let i = 0; i < chapterMarks.length; i++) {
        const from = chapterMarks[i].page
        const to = i + 1 < chapterMarks.length ? chapterMarks[i + 1].page - 1 : total
        if (to < from) continue
        pushSection(chapterMarks[i].title, [from, to], `#page-${from}`)
      }
    }
  }
  if (!sections.length) {
    // 再退一步：用「字号变大的短行」当章节标题
    const heads: { title: string; page: number }[] = []
    for (let p = 1; p <= total; p++) {
      const pg = pages[p - 1]
      if (!pg || !pg.paras.length) continue
      const first = pg.paras[0].text
      const bodySize = pg.bodySize || 10
      const longest = Math.max(...pages[p - 1].paras.map((t) => t.text.length))
      if (first.length <= 30 && first.length < longest * 0.6) {
        heads.push({ title: first.replace(/\s+/g, ' ').trim(), page: p })
      }
    }
    if (heads.length >= 3) {
      // 页眉/刊名会在每页首行重复出现，别把它当章节标题
      const freq = new Map<string, number>()
      for (const h of heads) freq.set(h.title, (freq.get(h.title) ?? 0) + 1)
      const marks = heads.filter((h) => (freq.get(h.title) ?? 0) <= 2)
      if (marks.length >= 3) {
        for (let i = 0; i < marks.length; i++) {
          const from = marks[i].page
          const to = i + 1 < marks.length ? Math.max(from, marks[i + 1].page - 1) : total
          pushSection(marks[i].title, [from, to], `#page-${from}`)
        }
      }
    }
  }
  if (!sections.length) {
    // 连标题都认不出来：整本作为一节，用第一行像标题的字当名字。
    // 宁可只有一条目录，也不编「第 1–8 页」这种假章节
    const blocks = pages.flatMap((p) => p.paras).map((x) => x.text.trim()).filter(Boolean)
    if (blocks.length) {
      const head = blocks.find((t) => t.length >= 2 && t.length <= 20 && /[\u4e00-\u9fffA-Za-z]/.test(t))
      pushSection((head ?? blocks[0]).slice(0, 30), [1, total], '#page-1')
    }
  }

  if (!sections.length) throw new Error('这个 PDF 解析不出正文，可能只有图片')

  // 同名相邻节合并：书签里「序 / 序 / 序」、或 OCR 把同一章标题认成几种写法时，
  // 不该在目录里出现一串一模一样的条目
  const titleKey = (s: string) => s.replace(/[\s\p{P}]/gu, '').slice(0, 10)
  const merged: ParsedSection[] = []
  for (const s of sections) {
    const prev = merged[merged.length - 1]
    if (prev && titleKey(prev.title) === titleKey(s.title)) {
      const blocks = [...prev.blocks, ...s.blocks]
      let cursor = 0
      const re: Block[] = blocks.map((b, i) => {
        const start = cursor
        cursor += b.text.length + 1
        return { ...b, i, start, end: start + b.text.length }
      })
      merged[merged.length - 1] = { ...prev, blocks: re, text: re.map((b) => b.text).join('\n') }
      continue
    }
    merged.push(s)
  }
  merged.forEach((s, i) => (s.idx = i))

  // 元数据和书签首项常是「封面 / 序 / Microsoft Word - xxx.doc」这类垃圾，交给文件名兜底
  const junkTitle = /^(封面|封底|书名页?|版权页?|目录|序言?|前言|引言|正文|附录|Microsoft Word|PowerPoint|Untitled|无标题)/i
  const okMeta = title && !junkTitle.test(title.trim()) && title.trim().length >= 2 ? title.trim() : ''
  return {
    title: okMeta,
    author,
    lang: '',
    sections: merged
  }
}
