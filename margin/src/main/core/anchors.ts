/**
 * 书内链接 / 脚注锚点解析。
 * 目标只有四种结果：外链、本行注释、另一节、找不到。
 * 找不到就说找不到，绝不猜。
 */
import * as db from './db'

export interface AnchorResult {
  kind: 'external' | 'note' | 'section' | 'none'
  url?: string
  secIdx?: number
  secTitle?: string
  /** 命中的注释/原文块文字（截断） */
  text?: string
}

/** 拼相对路径：base 是当前节的 href，rel 是链接里的路径 */
function resolvePath(base: string, rel: string): string {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const joined = rel.startsWith('/') ? rel.slice(1) : `${dir}/${rel}`
  const out: string[] = []
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export function resolveAnchor(bookId: string, secIdx: number, href: string): AnchorResult {
  const raw = String(href ?? '').trim()
  if (!raw) return { kind: 'none' }
  if (/^(https?:|mailto:)/i.test(raw)) return { kind: 'external', url: raw }
  if (raw.startsWith('javascript:')) return { kind: 'none' }

  const hashAt = raw.indexOf('#')
  const pathPart = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  let frag = ''
  if (hashAt >= 0) {
    try {
      frag = decodeURIComponent(raw.slice(hashAt + 1))
    } catch {
      frag = raw.slice(hashAt + 1)
    }
  }

  const cur = db.getSection(bookId, secIdx)
  let target = { idx: secIdx, title: cur?.title ?? '' }

  if (pathPart) {
    const paths = db.listSectionPaths(bookId)
    const resolved = resolvePath(cur?.href ?? '', pathPart)
    const hit = paths.find((p) => samePath(p.href, resolved)) ?? paths.find((p) => samePath(p.href, pathPart))
    if (!hit) return { kind: 'none' }
    target = { idx: hit.idx, title: hit.title }
  }

  if (!frag) return { kind: 'section', secIdx: target.idx, secTitle: target.title }

  const found = db.findBlockByAnchor(bookId, frag, target.idx)
  if (!found) return { kind: 'none' }
  const text = found.text.length > 600 ? `${found.text.slice(0, 600)}…` : found.text
  return { kind: 'note', secIdx: found.idx, secTitle: found.title, text }
}
