import { parseHTML } from 'linkedom'
import { buildSectionText, snippetTitle, chapterLevel } from './text'
import type { ParsedBook, ParsedSection } from './epub'

const CHAPTER_RE = /^\s*(第[零一二三四五六七八九十百千万0-9]+[章节卷回篇部]|Chapter\s+[0-9IVXLC]+|序言?|自序|前言|引子|楔子|后记|尾声|终章)/i

/**
 * 纯文本 / Markdown 解析：
 * 先按章节标题切分，切不到就按约 5000 字一块。
 */
export function parsePlainText(raw: string, fileName: string, format: 'txt' | 'md'): ParsedBook {
  const text = raw.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const meta = splitNameAuthor(fileName)

  const marks: Array<{ line: number; title: string }> = []
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t || t.length > 40) return
    if (CHAPTER_RE.test(t)) marks.push({ line: i, title: t })
  })

  const sections: ParsedSection[] = []
  const pushRange = (from: number, to: number, secTitle: string) => {
    const slice = lines.slice(from, to).join('\n')
    if (!slice.trim()) return
    const { document } = parseHTML(`<html><body>${toHtml(slice, format)}</body></html>`)
    const built = buildSectionText(document.body as any)
    if (!built.text.trim()) return
    sections.push({
      idx: sections.length,
      title: secTitle,
      level: chapterLevel(secTitle),
      href: `#sec-${sections.length}`,
      blocks: built.blocks,
      text: built.text
    })
  }

  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].line
      const end = i + 1 < marks.length ? marks[i + 1].line : lines.length
      pushRange(start, end, marks[i].title)
    }
  } else {
    const CHUNK = 5000
    let from = 0
    let idx = 0
    while (from < lines.length) {
      let to = from
      let size = 0
      while (to < lines.length && size < CHUNK) {
        size += lines[to].length + 1
        to++
      }
      pushRange(from, to, snippetTitle(lines.slice(from, to).join(' ')) || `正文 ${++idx}`)
      from = to
    }
  }

  // 正文开头常有「书名：X / 作者：Y」，优先用它补齐元数据
  const headLines = lines.slice(0, 12).map((l) => l.trim()).filter(Boolean)
  let title = meta.title
  let author = meta.author
  for (const l of headLines) {
    const mTitle = /^(?:书名|作品名|标题)[:：]\s*(.+)$/.exec(l)
    if (mTitle && !title) title = mTitle[1].trim()
    const mAuthor = /^(?:作者|作\s*者)[:：]\s*(.+)$/.exec(l)
    if (mAuthor && !author) author = mAuthor[1].trim()
  }

  return { title, author, lang: '', sections }
}

/** 从文件名里拆书名与作者：「绝世唐门 作者：唐家三少」「《X》- 某人」 */
export function splitNameAuthor(name: string): { title: string; author: string } {
  let s = name.trim()
  s = s.replace(/\.(txt|md|markdown|epub|pdf|docx|mobi|azw3?|azw)$/i, '')

  const byAuthor = /^(.*?)\s*作者[:：]\s*(.+)$/.exec(s)
  if (byAuthor) return { title: clean(byAuthor[1]), author: clean(byAuthor[2]) }

  const bookQuote = /^《(.+?)》\s*(?:作者[:：]\s*)?(.+)?$/.exec(s)
  if (bookQuote) return { title: clean(bookQuote[1]), author: clean(bookQuote[2] ?? '') }

  const dash = /^(.+?)\s+[-—–]{1,2}\s+(.+)$/.exec(s)
  if (dash && dash[2].length <= 24) return { title: clean(dash[1]), author: clean(dash[2]) }

  return { title: clean(s), author: '' }
}

function clean(s: string): string {
  return s.replace(/[《》]/g, '').replace(/\s+/g, ' ').trim()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toHtml(text: string, format: 'txt' | 'md'): string {
  const lines = text.split('\n')
  const paras: string[] = []

  for (const rawLine of lines) {
    const line = rawLine.replace(/[\s\u3000]+$/, '')
    if (!line.trim()) continue
    const indented = /^[\u3000\s]{1,4}/.test(line)
    const body = line.replace(/^[\u3000\s]+/, '')
    const prev = paras[paras.length - 1]

    // 硬换行的文本：上一行没说完（无句末标点）且本行不是新段缩进，就接回去
    const prevOpen = prev && !/[。！？；…—：:」』”"’）)\]】]$/.test(prev) && prev.length >= 18
    if (prev && prevOpen && !indented) {
      paras[paras.length - 1] = prev + body
    } else {
      paras.push(body)
    }
  }

  if (format === 'md') {
    return paras
      .map((p) => {
        const h = /^(#{1,6})\s+(.*)$/.exec(p)
        if (h) return `<h${h[1].length}>${escapeHtml(h[2])}</h${h[1].length}>`
        return `<p>${escapeHtml(p)}</p>`
      })
      .join('\n')
  }
  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')
}
