import { useEffect, useMemo, useState } from 'react'
import api, { type Book, type GlobalHit, type ReadingStats } from '../api'

interface Props {
  books: Book[]
  busy: boolean
  kbCount: number
  dueCount?: number
  cardCount?: number
  stats?: ReadingStats | null
  onReview?: () => void
  onOpenHit?: (h: GlobalHit) => void
  onOpen: (id: string) => void
  onImport: () => void
  onRemove: (b: Book) => void
  onKb: () => void
  onSettings: () => void
}

type Filter = 'reading' | 'all' | 'done'

export default function Bookshelf({ books, busy, kbCount, dueCount = 0, cardCount = 0, stats, onOpen, onImport, onRemove, onKb, onReview, onSettings, onOpenHit }: Props) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [hits, setHits] = useState<GlobalHit[]>([])
  const [searching, setSearching] = useState(false)

  // 全书检索：书名筛的是书架，正文检索走全库
  useEffect(() => {
    const key = q.trim()
    if (key.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      api.book
        .searchAll(key, 20)
        .then((r) => setHits(r))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 260)
    return () => window.clearTimeout(timer)
  }, [q])

  const shown = useMemo(() => {
    const key = q.trim().toLowerCase()
    return books.filter((b) => {
      if (key && !`${b.title} ${b.author}`.toLowerCase().includes(key)) return false
      const pct = b.progress_pct ?? 0
      if (filter === 'reading') return pct > 0 && pct < 100
      if (filter === 'done') return pct >= 100
      return true
    })
  }, [books, q, filter])

  const reading = books.filter((b) => (b.progress_pct ?? 0) > 0 && (b.progress_pct ?? 0) < 100).length
  const done = books.filter((b) => (b.progress_pct ?? 0) >= 100).length

  return (
    <div className="shelf">
      <header className="shelf-top">
        <div className="brand">
          <span className="brand-mark">页边</span>
          <span className="brand-sub">Margin</span>
        </div>

        {stats && stats.total > 0 && (
          <div className="shelf-stats" title="按分钟累计的阅读时长">
            连续 {stats.streak} 天 · 今天 {Math.max(1, Math.round(stats.today / 60))} 分钟
          </div>
        )}

        <div className="shelf-search-wrap">
          <input
            className="shelf-search"
            placeholder="搜书名或作者"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="shelf-actions">
          {cardCount > 0 && (
            <button className="text-btn review-entry" onClick={onReview}>
              复习
              {dueCount > 0 ? <span className="due-dot">{dueCount}</span> : null}
            </button>
          )}
          <button className="text-btn" onClick={onKb}>
            知识库{kbCount > 0 ? ` ${kbCount}` : ''}
          </button>
          <button className="text-btn" onClick={onSettings}>
            设置
          </button>
          <button className="primary-btn slim" onClick={onImport} disabled={busy}>
            {busy ? '导入中…' : '导入书籍'}
          </button>
        </div>
      </header>

      <div className="shelf-body">
        <div className="shelf-tabs">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            全部 {books.length}
          </button>
          <button className={filter === 'reading' ? 'on' : ''} onClick={() => setFilter('reading')}>
            在读 {reading}
          </button>
          <button className={filter === 'done' ? 'on' : ''} onClick={() => setFilter('done')}>
            读完 {done}
          </button>
        </div>

        {books.length === 0 && (
          <div className="shelf-empty">
            <p className="shelf-empty-title">书架还是空的</p>
            <p className="dim">EPUB / PDF / MOBI / AZW3 / DOCX / TXT / Markdown 都能直接打开。</p>
            <button className="primary-btn" onClick={onImport}>
              导入第一本书
            </button>
          </div>
        )}

        {books.length > 0 && shown.length === 0 && q.trim().length < 2 && (
          <div className="shelf-empty dim">没有符合条件的书。</div>
        )}

        {q.trim().length >= 2 && (
          <div className="shelf-hits">
            <div className="shelf-hits-head">
              全书检索
              <span className="dim">{searching ? ' 检索中…' : ` · ${hits.length} 条`}</span>
            </div>
            {!searching && hits.length === 0 && <div className="dim shelf-hits-empty">正文里没有找到这个说法。</div>}
            {hits.map((h, i) => (
              <button
                key={`${h.book_id}-${h.sec_idx}-${h.char_start}-${i}`}
                className="hit-row"
                onClick={() => onOpenHit?.(h)}
              >
                <span className="hit-book">{h.book_title}</span>
                <span className="hit-snippet">{h.snippet}</span>
              </button>
            ))}
          </div>
        )}

        <div className="shelf-grid">
          {shown.map((b) => {
            const pct = Math.min(100, Math.round(b.progress_pct ?? 0))
            return (
              <div key={b.id} className="book-card">
                <button
                  className={`cover${b.cover ? ' has-cover' : ''}`}
                  style={{ ['--h' as any]: hue(b.title) }}
                  onClick={() => onOpen(b.id)}
                  title={b.title}
                >
                  {b.cover ? (
                    <img className="cover-img" src={b.cover} alt={b.title} loading="lazy" />
                  ) : (
                    <>
                      <span className="cover-title">{b.title}</span>
                      <span className="cover-foot">
                        <span className="cover-author">{b.author || '佚名'}</span>
                        <span className="cover-fmt">{b.format.toUpperCase()}</span>
                      </span>
                    </>
                  )}
                  <span className="cover-shade" />
                </button>
                <div className="book-card-title" title={b.title}>
                  {b.title}
                </div>
                <div className="book-card-meta">
                  {b.author || '佚名'}
                  {pct > 0 && <span className="meta-sep">·</span>}
                  {pct > 0 && <span>{pct}%</span>}
                  {(b.ann_count ?? 0) > 0 && <span className="meta-sep">·</span>}
                  {(b.ann_count ?? 0) > 0 && <span>{b.ann_count} 划</span>}
                </div>
                <div className="book-card-bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <button className="card-del" title="从书架移除" onClick={() => onRemove(b)}>
                  ×
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** 用书名算一个稳定色相，让书脊有区别又不花哨 */
function hue(title: string): number {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360
  return h
}
