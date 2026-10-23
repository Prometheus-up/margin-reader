import { useMemo, useState } from 'react'
import api, { COLORS, type Card, type KbItem } from '../api'

interface Props {
  items: KbItem[]
  onBack: () => void
  onOpen: (item: KbItem) => void
  onDelete: (item: KbItem) => void
  onTag: (item: KbItem, tags: string) => void
  onExport: (items: KbItem[]) => void
  onShare: (items: KbItem[]) => void
  /** 自动打标后刷新列表 */
  onTagged?: () => void
  /** 全库卡片，用来在条目上显示「已出 N 张」 */
  cards?: Card[]
  /** 从这条划线生成复习卡片 */
  onMakeCard?: (item: KbItem) => void
}

/** 摘抄 → 知识库：跨书聚合，按标签与书重新组织 */
export default function KnowledgeBase({ items, onBack, onOpen, onDelete, onTag, onExport, onShare, onTagged, cards, onMakeCard }: Props) {
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [color, setColor] = useState('')
  const [group, setGroup] = useState<'tag' | 'book' | 'time'>('tag')
  const [tagBusy, setTagBusy] = useState(false)
  const [tagMsg, setTagMsg] = useState('')

  async function autoTag() {
    setTagBusy(true)
    setTagMsg('')
    try {
      const r = await api.kb.autoTag()
      setTagMsg(r.updated > 0 ? `已给 ${r.updated} 条打上标签` : '没有需要打标签的条目')
      if (r.updated > 0) {
        onTagged?.()
        window.setTimeout(() => setTagMsg(''), 3200)
      }
    } catch (e: any) {
      setTagMsg(String(e?.message ?? '提取失败'))
    } finally {
      setTagBusy(false)
    }
  }

  const tags = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      for (const t of splitTags(it.tags)) m.set(t, (m.get(t) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const shown = useMemo(() => {
    const key = q.trim().toLowerCase()
    return items.filter((it) => {
      if (color && it.color !== color) return false
      if (tag === '__none' && splitTags(it.tags).length) return false
      if (tag && tag !== '__none' && !splitTags(it.tags).includes(tag)) return false
      if (key && !`${it.quote} ${it.note} ${it.book_title} ${it.tags}`.toLowerCase().includes(key)) return false
      return true
    })
  }, [items, q, tag, color])

  const groups = useMemo(() => {
    if (group === 'book') {
      const m = new Map<string, KbItem[]>()
      for (const it of shown) m.set(it.book_title, [...(m.get(it.book_title) ?? []), it])
      return [...m.entries()].map(([k, v]) => ({ key: k, items: v }))
    }
    if (group === 'time') {
      const m = new Map<string, KbItem[]>()
      for (const it of shown) {
        const k = new Date(it.created_at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })
        m.set(k, [...(m.get(k) ?? []), it])
      }
      return [...m.entries()].map(([k, v]) => ({ key: k, items: v }))
    }
    // 按标签分组：无标签归到「未归类」
    const m = new Map<string, KbItem[]>()
    for (const it of shown) {
      const list = splitTags(it.tags)
      const keys = list.length ? list : ['未归类']
      for (const k of keys) m.set(k, [...(m.get(k) ?? []), it])
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => ({ key: k, items: v }))
  }, [shown, group])

  return (
    <div className="kb">
      <header className="kb-top">
        <button className="text-btn" onClick={onBack}>
          ← 书架
        </button>
        <h1 className="kb-title">知识库</h1>
        <span className="kb-count">{items.length} 条摘抄</span>
        <div className="kb-actions">
          <button className="text-btn" onClick={() => void autoTag()} disabled={tagBusy || !items.length}>
            {tagBusy ? '提取中…' : 'AI 提标签'}
          </button>
          <button className="text-btn" onClick={() => onExport(shown)} disabled={!shown.length}>
            导出
          </button>
          <button className="text-btn" onClick={() => onShare(shown)} disabled={!shown.length}>
            分享图
          </button>
        </div>
        {tagMsg && <span className="kb-tagmsg">{tagMsg}</span>}
      </header>

      <div className="kb-toolbar">
        <input className="kb-search" placeholder="搜原文、批注、书名、标签" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="kb-group">
          {([['tag', '按主题'], ['book', '按书'], ['time', '按时间']] as const).map(([k, label]) => (
            <button key={k} className={group === k ? 'on' : ''} onClick={() => setGroup(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="kb-chips">
        <button className={!tag ? 'on' : ''} onClick={() => setTag('')}>
          全部
        </button>
        {tags.map(([t, n]) => (
          <button key={t} className={tag === t ? 'on' : ''} onClick={() => setTag(tag === t ? '' : t)}>
            {t} <span className="chip-n">{n}</span>
          </button>
        ))}
        <button className={tag === '__none' ? 'on' : ''} onClick={() => setTag(tag === '__none' ? '' : '__none')}>
          未归类
        </button>
        <span className="kb-chip-sep" />
        {COLORS.map((c) => (
          <button
            key={c.key}
            className={`color-chip ${color === c.key ? 'on' : ''}`}
            onClick={() => setColor(color === c.key ? '' : c.key)}
            title={c.label}
          >
            <i style={{ background: c.hex }} />
            {c.label}
          </button>
        ))}
      </div>

      {items.length === 0 && (
        <div className="kb-empty">
          <p>这里会慢慢长出你自己的东西。</p>
          <p className="dim">读书时划一条线、写一句批注，它们都会汇到这里，跨书可见。</p>
        </div>
      )}

      <div className="kb-list">
        {groups.map((g) => (
          <section key={g.key} className="kb-group-block">
            <h2 className="kb-group-title">
              {g.key} <span>{g.items.length}</span>
            </h2>
            {g.items.map((it) => (
              <article key={it.id} className="kb-item">
                <i className="kb-color" style={{ background: colorHex(it.color) }} />
                <div className="kb-item-main">
                  <button className="kb-quote" onClick={() => onOpen(it)}>
                    {it.quote}
                  </button>
                  {it.note && <p className="kb-note">{it.note}</p>}
                  <div className="kb-meta">
                    <button className="kb-src" onClick={() => onOpen(it)}>
                      《{it.book_title}》{it.sec_title ? ` · ${it.sec_title}` : ''}
                    </button>
                    <TagEditor item={it} onTag={onTag} />
                    {(() => {
                      const n = (cards ?? []).filter((c) => c.annotation_id === it.id).length
                      if (n > 0) return <span className="kb-cardbadge" title={`已为这条划线做了 ${n} 张复习卡`}>◎ {n} 张卡</span>
                      if (!onMakeCard) return null
                      return (
                        <button className="kb-cardbtn" title="为这条划线生成复习卡片" onClick={() => onMakeCard(it)}>
                          出卡片
                        </button>
                      )
                    })()}
                  </div>
                </div>
                <button className="kb-del" title="删除" onClick={() => onDelete(it)}>
                  ×
                </button>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

function TagEditor({ item, onTag }: { item: KbItem; onTag: (item: KbItem, tags: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(item.tags)
  const list = splitTags(item.tags)

  if (!editing) {
    return (
      <span className="kb-tags">
        {list.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
        <button className="tag-add" onClick={() => setEditing(true)}>
          {list.length ? '改标签' : '+ 标签'}
        </button>
      </span>
    )
  }

  return (
    <span className="tag-edit">
      <input
        autoFocus
        value={value}
        placeholder="用逗号分开，如：认知科学, 阅读"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onTag(item, value)
            setEditing(false)
          }
          if (e.key === 'Escape') setEditing(false)
        }}
        onBlur={() => {
          onTag(item, value)
          setEditing(false)
        }}
      />
    </span>
  )
}

export function splitTags(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
}

function colorHex(key: string): string {
  return COLORS.find((c) => c.key === key)?.hex ?? '#f0d78c'
}
