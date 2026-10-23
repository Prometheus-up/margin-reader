import type { Annotation } from '../api'

export interface ShareItem {
  quote: string
  note?: string
  secTitle: string
}

export interface ShareOptions {
  bookTitle: string
  author?: string
  items: ShareItem[]
  theme?: 'paper' | 'ink' | 'night'
}

const THEMES = {
  paper: { bg: '#fbf8f2', ink: '#2a2723', dim: '#7a7168', accent: '#8c3a2e', line: '#e3d9c8' },
  ink: { bg: '#20211f', ink: '#eeeae2', dim: '#9a948a', accent: '#d8a48f', line: '#3a3b37' },
  night: { bg: '#161a20', ink: '#dfe4ea', dim: '#8b95a3', accent: '#8fb6d9', line: '#2a313a' }
}

const FONT_SERIF = '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, Georgia, serif'
const FONT_SANS = '"Source Han Sans SC", "Microsoft YaHei", system-ui, sans-serif'

/** 生成分享图，返回 dataURL（PNG） */
export function renderShareImage(opts: ShareOptions): { dataUrl: string; width: number; height: number } {
  const t = THEMES[opts.theme ?? 'paper']
  const W = 1080
  const PAD = 88
  const MAX = W - PAD * 2
  const items = opts.items.slice(0, 8)

  // 先量文字，算高度
  const measure = document.createElement('canvas').getContext('2d')!
  const layout = items.map((it) => {
    measure.font = `34px ${FONT_SERIF}`
    const quoteLines = wrap(measure, `「${it.quote.trim()}」`, MAX)
    let noteLines: string[] = []
    if (it.note?.trim()) {
      measure.font = `26px ${FONT_SANS}`
      noteLines = wrap(measure, it.note.trim(), MAX - 36)
    }
    const h = quoteLines.length * 58 + 34 + noteLines.length * 44 + 34
    return { it, quoteLines, noteLines, h }
  })

  const headerH = 210
  const footerH = 170
  const bodyH = layout.reduce((s, b) => s + b.h, 0)
  const H = Math.max(980, headerH + bodyH + footerH)

  const c = document.createElement('canvas')
  const dpr = 2
  c.width = W * dpr
  c.height = H * dpr
  const ctx = c.getContext('2d')!
  ctx.scale(dpr, dpr)

  ctx.fillStyle = t.bg
  ctx.fillRect(0, 0, W, H)

  // 细边框
  ctx.strokeStyle = t.line
  ctx.lineWidth = 2
  ctx.strokeRect(28, 28, W - 56, H - 56)

  // 顶部：品牌 + 书名
  ctx.fillStyle = t.accent
  ctx.font = `600 26px ${FONT_SANS}`
  ctx.textBaseline = 'top'
  ctx.fillText('页 边 · M A R G I N', PAD, 76)

  ctx.fillStyle = t.ink
  ctx.font = `500 30px ${FONT_SERIF}`
  const bookLine = opts.author ? `《${opts.bookTitle}》 · ${opts.author}` : `《${opts.bookTitle}》`
  const bl = wrap(ctx, bookLine, MAX)
  ctx.fillText(bl[0] + (bl.length > 1 ? '…' : ''), PAD, 128)

  let y = headerH
  let lastSec = ''
  for (const b of layout) {
    ctx.fillStyle = t.ink
    ctx.font = `34px ${FONT_SERIF}`
    for (const line of b.quoteLines) {
      ctx.fillText(line, PAD, y)
      y += 58
    }
    y += 2
    if (b.it.secTitle && b.it.secTitle !== lastSec) {
      ctx.fillStyle = t.dim
      ctx.font = `22px ${FONT_SANS}`
      ctx.fillText(`—— ${b.it.secTitle}`, PAD + 2, y)
      lastSec = b.it.secTitle
    }
    y += 34

    if (b.noteLines.length) {
      const noteTop = y
      ctx.fillStyle = t.dim
      ctx.font = `26px ${FONT_SANS}`
      for (const line of b.noteLines) {
        ctx.fillText(line, PAD + 26, y)
        y += 44
      }
      ctx.fillStyle = t.accent
      ctx.fillRect(PAD, noteTop + 4, 4, Math.max(20, y - noteTop - 26))
      y += 30
    }
    y += 34
  }

  // 页脚
  const fy = H - 150
  ctx.strokeStyle = t.line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, fy)
  ctx.lineTo(W - PAD, fy)
  ctx.stroke()

  ctx.fillStyle = t.dim
  ctx.font = `20px ${FONT_SANS}`
  const d = new Date()
  ctx.fillText(`${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`, PAD, fy + 34)
  ctx.textAlign = 'right'
  ctx.fillText('读到这里，停了一下', W - PAD, fy + 34)
  ctx.textAlign = 'left'

  return { dataUrl: c.toDataURL('image/png'), width: W, height: H }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = []
  let line = ''
  for (const ch of Array.from(text)) {
    if (ch === '\n') {
      out.push(line)
      line = ''
      continue
    }
    const test = line + ch
    if (ctx.measureText(test).width > maxWidth && line) {
      // 行首避开标点
      if (/[，。、；：！？）」』”’]/.test(ch)) {
        out.push(test)
        line = ''
      } else {
        out.push(line)
        line = ch
      }
    } else {
      line = test
    }
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

/** 把一组划线拼成 Markdown 摘抄 */
export function toMarkdown(bookTitle: string, author: string, groups: Array<{ secTitle: string; items: Annotation[] }>): string {
  const lines: string[] = [`# 《${bookTitle}》摘抄`, '', author ? `> ${author}` : '', '']
  for (const g of groups) {
    if (!g.items.length) continue
    lines.push(`## ${g.secTitle}`, '')
    for (const a of g.items) {
      lines.push(`> ${a.quote.trim().replace(/\n+/g, ' ')}`, '')
      if (a.note?.trim()) lines.push(`批注：${a.note.trim()}`, '')
    }
  }
  lines.push('---', `导出时间：${new Date().toLocaleString('zh-CN')}`)
  return lines.join('\n')
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  triggerDownload(URL.createObjectURL(blob), filename)
}

export function downloadDataUrl(filename: string, dataUrl: string) {
  triggerDownload(dataUrl, filename)
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (href.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(href), 4000)
}
