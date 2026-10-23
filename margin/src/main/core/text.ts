import type { Document, Element } from 'linkedom'

export const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'blockquote', 'pre', 'figcaption', 'td', 'th', 'dt', 'dd'
])

const ALLOWED_TAGS = new Set([
  'a', 'em', 'i', 'b', 'strong', 'u', 's', 'code', 'br', 'span', 'sub', 'sup',
  'small', 'mark', 'ruby', 'rt', 'rp', 'q', 'cite'
])

export interface InlineLink {
  /** 在块内纯文本中的起始偏移 */
  start: number
  /** 结束偏移（不含） */
  end: number
  /** 原始 href：可以是 #锚点、相对路径（注释页），也可以是 http(s) */
  href: string
}

export interface Block {
  /** 块序号（章内） */
  i: number
  tag: string
  /** 纯文本（已归一化） */
  text: string
  /** 安全的内联 HTML */
  html: string
  /** 在本章规范文本中的起始偏移 */
  start: number
  /** 在本章规范文本中的结束偏移（不含） */
  end: number
  /** 该块自身的锚点 id（EPUB 里 <p id="fn1">…），用于被指向时精确定位 */
  anchor?: string
  /** 块内出现的链接（脚注引用、交叉引用、外链） */
  links?: InlineLink[]
}

export interface SectionText {
  blocks: Block[]
  /** 规范文本：各块以 \n 连接 */
  text: string
}

/**
 * 归一化空白：连续空白压成一个空格，去掉首尾空白。
 * 保留中文之间原有的无空格状态（不插入空格）。
 */
export function normalizeText(s: string): string {
  return s.replace(/[\s\u00a0]+/g, ' ').trim()
}

/**
 * 没有真目录时给这一节起的「临时名」：用正文第一句，而不是「第 N 节」。
 * 目录是给人看路标的，一句真实的开头总比编号强。
 */
export function snippetTitle(text: string, max = 16): string {  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const first = t.split(/[。！？；!?;\n]/)[0].trim() || t
  const s = first.replace(/^[「『“"'（(【\[]+/, '').replace(/[，、,：:]+$/, '').trim()
  if (s.length <= 2) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 从标题判断层级：部/卷/篇=1，章/回=2，节=3。
 * 中文书的目录大多是「部-章-节」三级，网络小说只有「章/回」一级。
 */
export function chapterLevel(title: string): number {
  const t = title.trim()
  if (/^第\s*[一二三四五六七八九十百千零〇0-9]+\s*[卷部篇]/.test(t)) return 1
  if (/^第\s*[一二三四五六七八九十百千零〇0-9]+\s*节/.test(t)) return 3
  if (/^第\s*[一二三四五六七八九十百千零〇0-9]+\s*[章回]/.test(t)) return 2
  return 1
}

/** 去掉危险标签与属性，只保留白名单内联标签 */export function sanitizeInline(root: Element, doc: Document): string {
  const walk = (node: any): string => {
    if (node.nodeType === 3) return escapeHtml(node.nodeValue ?? '')
    if (node.nodeType !== 1) return ''
    const tag = String(node.tagName || '').toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object') return ''
    const inner = Array.from(node.childNodes).map(walk).join('')
    if (!ALLOWED_TAGS.has(tag)) return inner
    if (tag === 'br') return '<br/>'
    const rawId = node.getAttribute?.('id')
    const idAttr = rawId ? ` id="${escapeAttr(String(rawId))}"` : ''
    if (tag === 'a') {
      // 原 href 放进 data-href（不直接写进 href，避免阅读器里误跳转），
      // 由渲染层决定是弹注释、跳章节还是开浏览器。
      const href = String(node.getAttribute?.('href') ?? '')
      return `<a href="#"${href ? ` data-href="${escapeAttr(href)}"` : ''}${idAttr}>${inner}</a>`
    }
    return `<${tag}${idAttr}>${inner}</${tag}>`
  }
  return Array.from(root.childNodes).map(walk).join('')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

const ENTITY: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** 反转义常见实体（注释文字与链接标题里常见 &amp; &#160;） */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X'
      const n = hex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITY[code.toLowerCase()] ?? m
  })
}

/**
 * 从已净化的内联 HTML 里扫出链接位置（块内字符偏移）。
 * 链接文字本身可能被拆成多个节点，按「去标签后的文字」在块文本里顺序查找。
 */
export function extractLinks(html: string, text: string): InlineLink[] {
  const out: InlineLink[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  let cursor = 0
  while ((m = re.exec(html))) {
    const attrs = m[1]
    const href = /data-href="([^"]*)"/.exec(attrs)?.[1] ?? '#'
    const label = normalizeText(unescapeHtml(m[2].replace(/<[^>]+>/g, '')))
    if (!label) continue
    const at = text.indexOf(label, cursor)
    if (at < 0) continue
    out.push({ start: at, end: at + label.length, href: unescapeHtml(href) })
    cursor = at + label.length
  }
  return out
}

/**
 * 把一章 XHTML 正文切成规范块序列。
 * 规则：取叶子块级元素（p、h1–h6、li 等），无块级子节点者；
 * 若一个块都没有（很多 EPUB 用 div + br），退化为按 br/换行切分。
 */
export function buildSectionText(body: Element): SectionText {
  const candidates = Array.from(body.querySelectorAll(Array.from(BLOCK_TAGS).join(','))) as Element[]
  const leaves = candidates.filter((el) => {
    const hasBlockChild = Array.from(el.querySelectorAll('*')).some((c: any) =>
      BLOCK_TAGS.has(String(c.tagName || '').toLowerCase())
    )
    return !hasBlockChild
  })

  const blocks: Block[] = []
  let cursor = 0

  const push = (tag: string, text: string, html: string, el?: Element) => {
    const t = normalizeText(text)
    if (!t) return
    const start = cursor
    const safeHtml = html || escapeHtml(t)
    const block: Block = { i: blocks.length, tag, text: t, html: safeHtml, start, end: start + t.length }
    const rawId = el?.getAttribute?.('id')
    if (rawId) block.anchor = String(rawId)
    const links = extractLinks(safeHtml, t)
    if (links.length) block.links = links
    blocks.push(block)
    cursor = start + t.length + 1 // +1 表示块间 \n
  }

  if (leaves.length > 0) {
    for (const el of leaves) {
      const tag = String(el.tagName || 'p').toLowerCase()
      push(tag, el.textContent ?? '', sanitizeInline(el, el.ownerDocument as any), el)
    }
  }

  if (blocks.length === 0) {
    // 退化路径：div 堆叠 + <br> 换行
    const html = String(body.innerHTML || '')
    const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d)>/gi, '\n')
    const textOnly = withBreaks.replace(/<[^>]+>/g, '')
    const pieces = textOnly.split(/\n+/)
    for (const piece of pieces) push('p', piece, escapeHtml(normalizeText(piece)))
  }

  const text = blocks.map((b) => b.text).join('\n')
  return { blocks, text }
}

/** 在块内定位：给定章内偏移，返回所属块与块内偏移 */
export function locate(section: SectionText, offsetInSection: number): { block: Block; offset: number } | null {
  for (const b of section.blocks) {
    if (offsetInSection >= b.start && offsetInSection <= b.end) {
      return { block: b, offset: offsetInSection - b.start }
    }
  }
  return null
}
