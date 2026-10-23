import { unzipSync, strFromU8 } from 'fflate'
import { parseHTML } from 'linkedom'
import { buildSectionText } from './text'
import type { ParsedBook, ParsedSection } from './epub'

/** 只取 word/document.xml 的段落文本，不需要完整 OOXML 支持 */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface RawPara {
  text: string
  style: string
  outline: number | null
}

function readParagraphs(xml: string): RawPara[] {
  const out: RawPara[] = []
  const paras = xml.split(/<w:p[\s>]/).slice(1)
  for (const chunk of paras) {
    const body = chunk.split(/<\/w:p>/)[0] ?? chunk
    const style = /<w:pStyle[^>]*w:val="([^"]+)"/.exec(body)?.[1] ?? ''
    const outline = /<w:outlineLvl[^>]*w:val="([0-9]+)"/.exec(body)?.[1]
    let text = ''
    // 按出现顺序处理 t / tab / br
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body))) {
      if (m[1] !== undefined) text += decodeXml(m[1])
      else if (m[0].startsWith('<w:tab')) text += '\t'
      else text += '\n'
    }
    out.push({ text, style, outline: outline ? Number(outline) : null })
  }
  return out
}

export function parseDocx(buf: Uint8Array): ParsedBook {
  const files = unzipSync(buf)
  const docFile = files['word/document.xml']
  if (!docFile) throw new Error('不是有效的 DOCX（缺少 word/document.xml）')
  const xml = strFromU8(docFile)

  const paras = readParagraphs(xml)
  const core = files['docProps/core.xml'] ? strFromU8(files['docProps/core.xml']) : ''
  const title = decodeXml(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] ?? '').trim()
  const author = decodeXml(/<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(core)?.[1] ?? '').trim()

  const headingLevel = (p: RawPara): number => {
    if (p.outline !== null && p.outline < 9) return p.outline + 1
    const s = p.style.toLowerCase()
    if (/^heading\s*([1-9])$/.test(s)) return Number(/^heading\s*([1-9])$/.exec(s)![1])
    if (/^标题\s*([1-9])$/.test(p.style)) return Number(/^标题\s*([1-9])$/.exec(p.style)![1])
    return 0
  }

  // 组装 HTML：标题级别的段落变成 h1-h3，其余段落用 p
  const blocks: string[] = []
  const marks: Array<{ blockIndex: number; title: string }> = []
  for (const p of paras) {
    const t = p.text.trim()
    if (!t) continue
    const h = headingLevel(p)
    const html = t
      .split('\n')
      .map((line) => escapeHtml(line))
      .join('<br/>')
    if (h >= 1 && h <= 3) {
      blocks.push(`<h${h}>${html}</h${h}>`)
      marks.push({ blockIndex: blocks.length - 1, title: t })
    } else {
      blocks.push(`<p>${html}</p>`)
    }
  }

  const sections: ParsedSection[] = []
  const pushRange = (from: number, to: number, secTitle: string) => {
    const slice = blocks.slice(from, to).join('\n')
    if (!slice.trim()) return
    const { document } = parseHTML(`<html><body>${slice}</body></html>`)
    const built = buildSectionText(document.body as any)
    if (!built.text.trim()) return
    sections.push({
      idx: sections.length,
      title: secTitle,
      href: `#docx-${sections.length}`,
      blocks: built.blocks,
      text: built.text
    })
  }

  // 一级标题切章；没有一级标题就按字数切
  const chapters = marks.filter((m) => /^<h1>/.test(blocks[m.blockIndex]))
  if (chapters.length >= 2) {
    for (let i = 0; i < chapters.length; i++) {
      const start = chapters[i].blockIndex
      const end = i + 1 < chapters.length ? chapters[i + 1].blockIndex : blocks.length
      pushRange(start, end, chapters[i].title)
    }
    if (chapters[0].blockIndex > 0) {
      // 第一章之前的序言单独成节
      const head: ParsedSection[] = []
      const slice = blocks.slice(0, chapters[0].blockIndex).join('\n')
      const { document } = parseHTML(`<html><body>${slice}</body></html>`)
      const built = buildSectionText(document.body as any)
      if (built.text.trim()) head.push({ idx: 0, title: '开头', href: '#docx-0', blocks: built.blocks, text: built.text })
      sections.unshift(...head.map((s, i) => ({ ...s, idx: i })))
      sections.forEach((s, i) => (s.idx = i))
    }
  } else {
    const CHUNK = 12000
    let from = 0
    let idx = 0
    while (from < blocks.length) {
      let to = from
      let size = 0
      while (to < blocks.length && size < CHUNK) {
        size += blocks[to].length
        to++
      }
      pushRange(from, to, `第 ${++idx} 节`)
      from = to
    }
  }

  if (!sections.length) throw new Error('这个 DOCX 里没有可读文本（可能全是图片或文本框）')
  return { title: title || '未命名文档', author, lang: '', sections }
}
