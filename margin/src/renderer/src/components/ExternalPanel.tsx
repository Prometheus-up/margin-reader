import { useEffect, useState } from 'react'
import api, { type ExtRef } from '../api'

interface Props {
  seed?: string
  onClose: () => void
  onCite?: (text: string) => void
}

function formatAuthors(r: ExtRef): string {
  if (!r.authors.length) return '作者不详'
  if (r.authors.length <= 2) return r.authors.join('、')
  return `${r.authors.slice(0, 2).join('、')} 等`
}

function citeOf(r: ExtRef): string {
  const parts = [`${formatAuthors(r)}${r.year ? `（${r.year}）` : ''}. ${r.title}.`]
  if (r.venue) parts.push(`《${r.venue}》`)
  if (r.doi) parts.push(`DOI: ${r.doi}`)
  parts.push(`（来源：${r.source === 'openalex' ? 'OpenAlex' : 'Crossref'}）`)
  return parts.join(' ')
}

export default function ExternalPanel({ seed, onClose, onCite }: Props) {
  const [q, setQ] = useState(seed ?? '')
  const [busy, setBusy] = useState(false)
  const [refs, setRefs] = useState<ExtRef[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    if (seed) setQ(seed)
  }, [seed])

  useEffect(() => {
    if (!msg) return
    const t = window.setTimeout(() => setMsg(''), 2200)
    return () => window.clearTimeout(t)
  }, [msg])

  async function run() {
    const key = q.trim()
    if (!key) return
    setBusy(true)
    setMsg('')
    try {
      const res = await api.ext.search(key, 8)
      setRefs(res.refs)
      setErrors(res.errors)
      setSearched(true)
    } catch (e: any) {
      setRefs([])
      setErrors([String(e?.message ?? e)])
      setSearched(true)
    } finally {
      setBusy(false)
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setMsg('已复制')
    } catch {
      setMsg('复制失败')
    }
  }

  return (
    <aside className="side-panel ext-panel">
      <div className="sp-head">
        <div className="sp-title">书外的说法</div>
        <button className="icon-btn" onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      <div className="sp-body">
        <div className="ext-note">只查 OpenAlex 与 Crossref 的真实文献，查不到就显示为空——这里不会凭空生成观点。</div>

        <div className="ext-search">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run()
            }}
            placeholder="关键词、理论名、作者…"
          />
          <button className="primary-btn slim" disabled={busy || !q.trim()} onClick={() => void run()}>
            {busy ? '检索中…' : '检索'}
          </button>
        </div>

        {errors.length > 0 && <div className="ext-err">{errors.join('；')}</div>}

        {searched && !busy && refs.length === 0 && <div className="ext-empty">没有查到结果。换个更学术的说法试试，比如用英文关键词。</div>}

        <div className="ext-list">
          {refs.map((r, i) => (
            <div key={`${r.doi ?? r.title}-${i}`} className="ext-card">
              <div className="ext-title" title={r.title}>
                {r.title}
              </div>
              <div className="ext-meta">
                {formatAuthors(r)}
                {r.year ? ` · ${r.year}` : ''}
                {r.venue ? ` · ${r.venue}` : ''}
                {typeof r.cited === 'number' ? ` · 被引 ${r.cited}` : ''}
              </div>
              {r.abstract && <div className="ext-abs">{r.abstract}</div>}
              <div className="ext-actions">
                <button
                  className="text-btn tiny"
                  onClick={() => {
                    const text = citeOf(r)
                    if (onCite) onCite(text)
                    else void copy(text)
                  }}
                >
                  {onCite ? '引用到讨论' : '复制引用'}
                </button>
                {r.url && (
                  <button className="text-btn tiny" onClick={() => window.open(r.url!, '_blank')}>
                    打开原文
                  </button>
                )}
                <span className="ext-src">{r.source === 'openalex' ? 'OpenAlex' : 'Crossref'}</span>
              </div>
            </div>
          ))}
        </div>

        {msg && <div className="ext-msg">{msg}</div>}
      </div>
    </aside>
  )
}
