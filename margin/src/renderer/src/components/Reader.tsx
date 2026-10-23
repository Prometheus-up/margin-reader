import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Annotation, BiMode, Block, Mode, SectionMeta } from '../api'
import { COLORS, MODES } from '../api'

const PAGE_GAP = 56

interface Props {
  section: { idx: number; title: string; blocks: Block[] }
  meta: SectionMeta
  annotations: Annotation[]
  onAnnotate: (payload: { start: number; end: number; quote: string }, mode: Mode) => void
  onHighlight: (payload: { start: number; end: number; quote: string }, color: string, withNote: boolean) => void
  onOpenAnnotation: (a: Annotation) => void
  focusRange?: { start: number; end: number } | null
  initialScroll?: number
  onScrollPos?: (ratio: number) => void
  /** 分页阅读 */
  paged?: boolean
  /** 换页指令（nonce 变化才生效） */
  turn?: { dir: 1 | -1; nonce: number } | null
  onPageInfo?: (page: number, total: number) => void
  /** 切换章节后是否从最后一页开始（往回翻时用） */
  startLast?: boolean
  /** 已经到本节第一页/最后一页时，再翻就交给外层切换章节 */
  onEdge?: (dir: 1 | -1) => void
  /** 排版参数指纹，变化时重新分页 */
  layoutKey?: string
  /** 本节译文：block.i → 译文 */
  translation?: Record<number, string>
  /** 对照模式 */
  bi?: BiMode
  /** 双击某段请求翻译 */
  onTranslateBlock?: (blockI: number) => void
  /** 查词：选中一个词时问 AI 在句中的意思 */
  onLookup?: (word: string, sentence: string) => void
  /** 书内链接 / 脚注引用被点击 */
  onLink?: (href: string) => void
  footer?: ReactNode
}

interface Draft {
  start: number
  end: number
  quote: string
  rect: DOMRect
}

export default function Reader({
  section,
  annotations,
  onAnnotate,
  onHighlight,
  onOpenAnnotation,
  focusRange,
  initialScroll,
  onScrollPos,
  paged = false,
  turn,
  onPageInfo,
  onEdge,
  startLast = false,
  layoutKey = '',
  translation,
  bi = 'off',
  onTranslateBlock,
  onLookup,
  onLink,
  footer
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [page, setPage] = useState(0)
  const [pages, setPages] = useState(1)
  const [vw, setVw] = useState(0)
  const wheelLock = useRef(0)

  // 恢复上次读到的地方（仅滚动模式）
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !initialScroll || paged) return
    const max = el.scrollHeight - el.clientHeight
    if (max > 0) el.scrollTop = max * Math.min(1, Math.max(0, initialScroll))
  }, [section.idx, initialScroll, paged])

  const relayout = useCallback(() => {
    const view = viewRef.current
    const track = trackRef.current
    if (!paged || !view || !track) return
    const w = Math.max(320, view.clientWidth)
    const h = Math.max(240, view.clientHeight)
    track.style.columnWidth = `${w}px`
    track.style.height = `${h}px`
    setVw(w)
    const total = Math.max(1, Math.round((track.scrollWidth + PAGE_GAP) / (w + PAGE_GAP)))
    setPages(total)
    setPage((p) => (startLast ? total - 1 : Math.max(0, Math.min(p, total - 1))))
  }, [paged, startLast])

  useLayoutEffect(() => {
    relayout()
  }, [relayout, section.idx, layoutKey])

  useEffect(() => {
    if (!paged || !viewRef.current) return
    const ro = new ResizeObserver(() => relayout())
    ro.observe(viewRef.current)
    return () => ro.disconnect()
  }, [paged, relayout])

  useEffect(() => {
    onPageInfo?.(page, pages)
  }, [page, pages, onPageInfo])

  // 换页指令
  const turnRef = useRef(turn)
  useEffect(() => {
    if (!turn || turnRef.current === turn) return
    turnRef.current = turn
    const next = page + turn.dir
    if (next < 0) {
      onEdge?.(-1)
      return
    }
    if (next >= pages) {
      onEdge?.(1)
      return
    }
    setPage(next)
  }, [turn, page, pages, onEdge])

  const go = useCallback(
    (dir: 1 | -1) => {
      setPage((p) => {
        const next = p + dir
        if (next < 0) {
          onEdge?.(-1)
          return p
        }
        if (next >= pages) {
          onEdge?.(1)
          return p
        }
        return next
      })
    },
    [pages, onEdge]
  )

  // 划线高亮
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    unwrapAll(root)
    const local = annotations.filter((a) => a.sec_idx === section.idx)
    for (const a of local) {
      for (const b of section.blocks) {
        if (a.char_end <= b.start || a.char_start >= b.end) continue
        const el = root.querySelector(`[data-i="${b.i}"]`) as HTMLElement | null
        if (!el) continue
        const from = Math.max(0, a.char_start - b.start)
        const to = Math.min(b.text.length, a.char_end - b.start)
        if (to > from) wrapTextRange(el, from, to, a.id, activeColor(a), `margin-hl${a.note ? ' has-note' : ''}`)
      }
    }
    if (paged) relayout()
  }, [section, annotations, paged, relayout])

  // 书内链接 / 脚注引用：把带 href 的片段包成可点的 <a class="doc-link">
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    for (const b of section.blocks) {
      if (!b.links?.length) continue
      const el = root.querySelector(`[data-i="${b.i}"]`) as HTMLElement | null
      if (!el) continue
      wrapLinks(el, b.links)
    }
    if (paged) relayout()
  }, [section, paged, relayout])

  // 检索命中：临时高亮并滚到位置
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    unwrapClass(root, 'mark.search-hit')
    if (!focusRange) return
    for (const b of section.blocks) {
      if (focusRange.end <= b.start || focusRange.start >= b.end) continue
      const el = root.querySelector(`[data-i="${b.i}"]`) as HTMLElement | null
      if (!el) continue
      const from = Math.max(0, focusRange.start - b.start)
      const to = Math.min(b.text.length, focusRange.end - b.start)
      if (to <= from) continue
      wrapTextRange(el, from, to, 'focus', 'yellow', 'margin-hl search-hit')
      if (!paged) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      else {
        // 分页模式下翻到命中所在的页
        const track = trackRef.current
        const view = viewRef.current
        if (track && view) {
          const w = view.clientWidth
          const left = el.getBoundingClientRect().left - track.getBoundingClientRect().left
          setPage(Math.max(0, Math.round(left / (w + PAGE_GAP))))
        }
      }
      break
    }
  }, [section, focusRange, paged])

  const blocks = section.blocks.filter(
    (b, i) => !(i === 0 && /^h[1-3]$/i.test(b.tag) && b.text.trim() === section.title.trim())
  )

  const handleMouseUp = () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !rootRef.current) {
      setDraft(null)
      return
    }
    if (!rootRef.current.contains(sel.anchorNode)) return
    const range = sel.getRangeAt(0)
    const startEl = closestBlock(sel.anchorNode)
    const endEl = closestBlock(sel.focusNode)
    if (!startEl || !endEl) return

    const startOff = offsetInBlock(startEl, range.startContainer, range.startOffset)
    const endOff = offsetInBlock(endEl, range.endContainer, range.endOffset)
    if (startOff === null || endOff === null) return
    const quote = sel.toString()
    if (!quote.trim()) return

    const si = Number(startEl.dataset.i)
    const ei = Number(endEl.dataset.i)
    const bs = section.blocks[si]
    const be = section.blocks[ei]
    const start = si <= ei ? bs.start + startOff : be.start + endOff
    const end = si <= ei ? be.start + endOff : bs.start + startOff
    if (end <= start) return
    setDraft({ start, end, quote, rect: range.getBoundingClientRect() })
  }

  const content = (
    <div
      className={`reader-page${bi === 'side' ? ' side' : ''}`}
      ref={rootRef}
      onMouseUp={handleMouseUp}
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest('a.doc-link') as HTMLAnchorElement | null
        if (link) {
          e.preventDefault()
          e.stopPropagation()
          onLink?.(link.dataset.href ?? '')
          return
        }
        const mark = (e.target as HTMLElement).closest('mark.margin-hl') as HTMLElement | null
        if (mark?.dataset.annId) {
          const a = annotations.find((x) => x.id === mark.dataset.annId)
          if (a) onOpenAnnotation(a)
        }
      }}
    >
      <h2 className="section-title">{section.title}</h2>
      {blocks.map((b) => {
        const Tag = (b.tag as any) || 'p'
        const tr = bi !== 'off' ? translation?.[b.i] : undefined
        const inner = (
          <>
            <Tag
              data-i={b.i}
              className={`blk blk-${b.tag}${bi === 'only' ? ' blk-src-hidden' : ''}`}
              onDoubleClick={() => onTranslateBlock?.(b.i)}
              onClick={(e: any) => {
                const mark = (e.target as HTMLElement).closest('mark.margin-hl') as HTMLElement | null
                if (mark?.dataset.annId) {
                  const a = annotations.find((x) => x.id === mark.dataset.annId)
                  if (a) onOpenAnnotation(a)
                }
              }}
            >
              {b.text}
            </Tag>
            {tr && (
              <div className="blk-tr" data-tr={b.i}>
                {tr}
              </div>
            )}
          </>
        )
        return bi === 'side' ? (
          <div className="blk-pair" key={b.i}>
            {inner}
          </div>
        ) : (
          <Fragment key={b.i}>{inner}</Fragment>
        )
      })}
    </div>
  )

  return (
    <div className={`reader-body ${paged ? 'paged' : ''}`} ref={viewRef}>
      {paged ? (
        <div
          className="paged-track"
          ref={trackRef}
          style={{ transform: `translateX(${-page * (vw + PAGE_GAP)}px)` }}
          onWheel={(e) => {
            const now = Date.now()
            if (now - wheelLock.current < 320) return
            const dy = e.deltaY + e.deltaX
            if (Math.abs(dy) < 8) return
            wheelLock.current = now
            go(dy > 0 ? 1 : -1)
          }}
        >
          {content}
          {footer && <div className="reader-foot">{footer}</div>}
        </div>
      ) : (
        <div
          className="reader-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            setDraft(null)
            const el = e.currentTarget
            const max = el.scrollHeight - el.clientHeight
            onScrollPos?.(max > 0 ? el.scrollTop / max : 0)
          }}
        >
          {content}
          {footer && <div className="reader-foot">{footer}</div>}
        </div>
      )}

      {paged && (
        <>
          <button className="page-arrow left" onClick={() => go(-1)} disabled={page <= 0 && !onEdge} aria-label="上一页">
            ‹
          </button>
          <button className="page-arrow right" onClick={() => go(1)} disabled={page >= pages - 1 && !onEdge} aria-label="下一页">
            ›
          </button>
        </>
      )}

      {draft && (
        <div
          className="sel-bubble"
          style={{
            left: Math.max(12, Math.min(draft.rect.left + draft.rect.width / 2 - 190, window.innerWidth - 400)),
            top: Math.min(draft.rect.bottom + 8, window.innerHeight - 108)
          }}
        >
          <div className="sel-colors">
            {COLORS.map((c) => (
              <button
                key={c.key}
                className="dot"
                style={{ background: c.hex }}
                title={`标为${c.label}`}
                onClick={() => {
                  onHighlight({ start: draft.start, end: draft.end, quote: draft.quote }, c.key, false)
                  setDraft(null)
                  window.getSelection()?.removeAllRanges()
                }}
              />
            ))}
            <span className="sel-divider" />
            <button
              className="sel-note-btn"
              onClick={() => {
                onHighlight({ start: draft.start, end: draft.end, quote: draft.quote }, 'yellow', true)
                setDraft(null)
                window.getSelection()?.removeAllRanges()
              }}
            >
              写想法
            </button>
            {onLookup && draft.quote.trim().length > 0 && draft.quote.trim().length <= 12 && (
              <button
                className="sel-note-btn"
                onClick={() => {
                  const b = blocks.find((x) => x.start <= draft.start && x.end >= draft.end)
                  onLookup(draft.quote.trim(), b?.text ?? draft.quote)
                  setDraft(null)
                  window.getSelection()?.removeAllRanges()
                }}
              >
                查词
              </button>
            )}
          </div>
          <div className="sel-ai">
            <span className="sel-ai-label">和 AI 聊</span>
            {MODES.map((m) => (
              <button
                key={m.key}
                className="sel-mode"
                title={m.hint}
                onClick={() => {
                  onAnnotate({ start: draft.start, end: draft.end, quote: draft.quote }, m.key)
                  setDraft(null)
                  window.getSelection()?.removeAllRanges()
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function activeColor(a: Annotation): string {
  return a.color || 'yellow'
}

function closestBlock(node: Node | null): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    if (n instanceof HTMLElement && n.dataset && n.dataset.i !== undefined) return n
    n = n.parentNode
  }
  return null
}

function offsetInBlock(blockEl: HTMLElement, container: Node, offset: number): number | null {
  try {
    const r = document.createRange()
    r.selectNodeContents(blockEl)
    r.setEnd(container, offset)
    return r.toString().length
  } catch {
    return null
  }
}

function unwrapAll(root: HTMLElement) {
  unwrapClass(root, 'mark.margin-hl')
}

function unwrapClass(root: HTMLElement, selector: string) {
  root.querySelectorAll(selector).forEach((m) => {
    const parent = m.parentNode
    if (!parent) return
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    parent.normalize()
  })
}

/** 在块的纯文本中，把 [from,to) 包成 <mark>，支持跨多个文本节点 */
function wrapLinks(el: HTMLElement, links: Array<{ start: number; end: number; href: string }>) {
  if (el.querySelector('a.doc-link')) return
  for (let i = links.length - 1; i >= 0; i--) {
    const { start, end, href } = links[i]
    if (end <= start) continue
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let pos = 0
    let n: Node | null
    while ((n = walker.nextNode())) {
      const t = n as Text
      const len = t.nodeValue?.length ?? 0
      const s = pos
      const e = pos + len
      pos = e
      if (e <= start) continue
      if (s >= end) break
      const from = Math.max(start, s) - s
      const to = Math.min(end, e) - s
      let target = t
      if (from > 0) target = target.splitText(from)
      target.splitText(to - from)
      const a = document.createElement('a')
      a.className = 'doc-link'
      a.dataset.href = href
      a.setAttribute('href', '#')
      target.parentNode?.insertBefore(a, target)
      a.appendChild(target)
    }
  }
}

function wrapTextRange(el: HTMLElement, from: number, to: number, annId: string, color: string, cls = 'margin-hl') {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const targets: Array<{ node: Text; start: number; end: number }> = []
  let pos = 0
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    const len = t.nodeValue?.length ?? 0
    const start = pos
    const end = pos + len
    pos = end
    if (end <= from) continue
    if (start >= to) break
    targets.push({ node: t, start: Math.max(from, start) - start, end: Math.min(to, end) - start })
  }

  for (let i = targets.length - 1; i >= 0; i--) {
    const { node, start, end } = targets[i]
    let target = node
    if (start > 0) target = target.splitText(start)
    target.splitText(end - start)
    const mark = document.createElement('mark')
    mark.className = cls
    mark.dataset.annId = annId
    mark.dataset.color = color
    target.parentNode?.insertBefore(mark, target)
    mark.appendChild(target)
  }
}
