import { useMemo, useState } from 'react'
import type { Annotation, SectionMeta } from '../api'
import { COLORS } from '../api'

interface Props {
  annotations: Annotation[]
  sections: SectionMeta[]
  onJump: (a: Annotation) => void
  onCopyMarkdown: (items: Annotation[]) => void
  onExportMarkdown: (items: Annotation[]) => void
  onShareImage: (items: Annotation[]) => void
  onDelete: (items: Annotation[]) => void
}

export default function ExcerptsPanel({ annotations, sections, onJump, onCopyMarkdown, onExportMarkdown, onShareImage, onDelete }: Props) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<string>('all')

  const shown = useMemo(
    () => annotations.filter((a) => filter === 'all' || a.color === filter),
    [annotations, filter]
  )

  const groups = useMemo(() => {
    const map = new Map<number, Annotation[]>()
    for (const a of shown) {
      const arr = map.get(a.sec_idx) ?? []
      arr.push(a)
      map.set(a.sec_idx, arr)
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([idx, items]) => ({
        idx,
        title: sections.find((s) => s.idx === idx)?.title ?? `第 ${idx + 1} 节`,
        items: items.sort((a, b) => a.char_start - b.char_start)
      }))
  }, [shown, sections])

  const selected = annotations.filter((a) => picked.has(a.id))
  const target = selected.length ? selected : shown

  function toggle(id: string) {
    const next = new Set(picked)
    next.has(id) ? next.delete(id) : next.add(id)
    setPicked(next)
  }

  const counts = COLORS.map((c) => ({ ...c, n: annotations.filter((a) => a.color === c.key).length }))

  return (
    <div className="excerpts">
      <div className="excerpts-toolbar">
        <div className="chips">
          <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
            全部 {annotations.length}
          </button>
          {counts.map((c) => (
            <button
              key={c.key}
              className={`chip ${filter === c.key ? 'on' : ''}`}
              onClick={() => setFilter(filter === c.key ? 'all' : c.key)}
              title={c.label}
            >
              <span className="dot tiny" style={{ background: c.hex }} />
              {c.n}
            </button>
          ))}
        </div>
        <div className="excerpts-actions">
          <button className="ghost-btn" disabled={!target.length} onClick={() => onCopyMarkdown(target)}>
            复制
          </button>
          <button className="ghost-btn" disabled={!target.length} onClick={() => onExportMarkdown(target)}>
            导出
          </button>
          <button className="ghost-btn" disabled={!target.length} onClick={() => onShareImage(target)}>
            分享图
          </button>
          <button
            className="ghost-btn danger"
            disabled={!selected.length}
            onClick={() => {
              onDelete(selected)
              setPicked(new Set())
            }}
          >
            删除
          </button>
        </div>
      </div>

      {annotations.length === 0 && (
        <div className="panel-empty">
          还没有划线。
          <br />
          在正文里选中一段，先标个颜色；想深聊了，再点「和 AI 聊聊」。
        </div>
      )}

      <div className="excerpts-body">
        {groups.map((g) => (
          <div key={g.idx} className="excerpt-group">
            <div className="excerpt-sec">{g.title}</div>
            {g.items.map((a) => (
              <div key={a.id} className={`excerpt ${picked.has(a.id) ? 'on' : ''}`}>
                <button className="excerpt-check" onClick={() => toggle(a.id)} title="选中">
                  {picked.has(a.id) ? '✓' : ''}
                </button>
                <button className="excerpt-main" onClick={() => onJump(a)}>
                  <div className="excerpt-quote" style={{ borderLeftColor: COLORS.find((c) => c.key === a.color)?.hex ?? '#f0d78c' }}>
                    {a.quote}
                  </div>
                  {a.note && <div className="excerpt-note">{a.note}</div>}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
