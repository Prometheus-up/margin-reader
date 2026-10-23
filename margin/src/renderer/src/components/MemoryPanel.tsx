import { useEffect, useMemo, useState } from 'react'
import type { MemoryItem } from '../api'
import api from '../api'

interface Props {
  bookId: string
  bookTitle: string
  onClose: () => void
  /** 记忆数量变化（让上层刷新徽标） */
  onCount?: (n: number) => void
}

const KIND_LABEL: Record<string, string> = {
  note: '批注',
  thought: '你想过的'
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function MemoryPanel({ bookId, bookTitle, onClose, onCount }: Props) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState('')

  async function load() {
    setLoading(true)
    try {
      const list = await api.memory.list(bookId)
      setItems(list)
      onCount?.(list.length)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  const groups = useMemo(() => {
    const note = items.filter((m) => m.kind === 'note')
    const thought = items.filter((m) => m.kind !== 'note')
    return [
      { key: 'note', title: '批注', desc: '你在划线上写下的想法', items: note },
      { key: 'thought', title: '你说的', desc: '讨论里你自己讲过的判断', items: thought }
    ].filter((g) => g.items.length > 0)
  }, [items])

  async function save(id: string) {
    const text = draft.trim()
    if (!text) {
      await remove(id)
      return
    }
    await api.memory.update(id, text)
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, text, updated_at: Date.now() } : m)))
    setEditing(null)
    setMsg('已记住')
    window.setTimeout(() => setMsg(''), 1500)
  }

  async function remove(id: string) {
    await api.memory.remove(id)
    const next = items.filter((m) => m.id !== id)
    setItems(next)
    onCount?.(next.length)
    setEditing(null)
    setMsg('已忘掉这条')
    window.setTimeout(() => setMsg(''), 1500)
  }

  return (
    <div className="side-panel mem-panel">
      <div className="sp-head">
        <div>
          <div className="sp-title">记忆</div>
          <div className="sp-sub">{bookTitle}</div>
        </div>
        <button className="icon-btn" onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      <div className="sp-body">
        <p className="mem-hint">
          这些是你自己说过的话，AI 每次讨论都会带上最近 12 条——所以它会记得你前面怎么想过的。
          它们不来自书里的正文，只来自你。
        </p>

        {loading && <div className="mem-empty">读取中……</div>}
        {!loading && items.length === 0 && (
          <div className="mem-empty">
            还没有。写一条批注，或者在讨论里说说你的看法，就会被记在这里。
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} className="mem-group">
            <div className="mem-group-head">
              <span>{g.title}</span>
              <span className="mem-group-n">{g.items.length}</span>
            </div>
            <div className="mem-group-desc">{g.desc}</div>
            {g.items.map((m) => (
              <div key={m.id} className={`mem-item ${editing === m.id ? 'on' : ''}`}>
                {editing === m.id ? (
                  <>
                    <textarea
                      className="mem-input"
                      value={draft}
                      autoFocus
                      rows={3}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save(m.id)
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                    <div className="mem-actions">
                      <button className="text-btn" onClick={() => void save(m.id)}>
                        保存
                      </button>
                      <button className="text-btn" onClick={() => void remove(m.id)}>
                        删掉
                      </button>
                      <button className="text-btn dim" onClick={() => setEditing(null)}>
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className="mem-text"
                      onClick={() => {
                        setEditing(m.id)
                        setDraft(m.text)
                      }}
                    >
                      {m.text}
                    </div>
                    <div className="mem-meta">
                      {m.source && <span className="mem-src">{m.source}</span>}
                      <span className="mem-time">{fmtTime(m.created_at)}</span>
                      <button
                        className="mem-del"
                        title="从记忆里删掉"
                        onClick={() => void remove(m.id)}
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}

        {msg && <div className="mem-msg">{msg}</div>}
      </div>
    </div>
  )
}
