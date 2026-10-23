import { useEffect, useState } from 'react'
import api, { type BiMode, type TrConfig, type TrStage, type TrStatus, type TrTerm } from '../api'

interface Props {
  bookId: string
  bookTitle: string
  bi: BiMode
  onBi: (m: BiMode) => void
  status: TrStatus | null
  onRefresh: () => void
  onClose: () => void
}

const BI_LABEL: Array<{ id: BiMode; label: string }> = [
  { id: 'off', label: '原文' },
  { id: 'below', label: '对照' },
  { id: 'only', label: '译文' },
  { id: 'side', label: '左右' }
]

export default function TranslatePanel({ bookId, bookTitle, bi, onBi, status, onRefresh, onClose }: Props) {
  const [stages, setStages] = useState<TrStage[]>([])
  const [langs, setLangs] = useState<Record<string, string>>({})
  const [cfg, setCfg] = useState<TrConfig | null>(null)
  const [terms, setTerms] = useState<TrTerm[]>([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [newSrc, setNewSrc] = useState('')
  const [newDst, setNewDst] = useState('')

  useEffect(() => {
    void (async () => {
      setStages(await api.tr.stages())
      setLangs(await api.tr.langs())
      setCfg(await api.tr.config())
      setTerms(await api.tr.glossary(bookId))
    })()
  }, [bookId])

  async function patch(p: Partial<TrConfig>) {
    const next = await api.tr.setConfig(p)
    setCfg(next)
  }

  async function start() {
    setBusy('start')
    setMsg('')
    try {
      await api.tr.start(bookId)
      onRefresh()
    } catch (e: any) {
      setMsg(String(e?.message ?? e))
    } finally {
      setBusy('')
    }
  }

  async function pause() {
    await api.tr.pause(bookId)
    onRefresh()
  }

  async function reset() {
    setBusy('reset')
    try {
      await api.tr.reset(bookId)
      onRefresh()
      setMsg('已清空本书译文')
    } finally {
      setBusy('')
    }
  }

  async function buildTerms() {
    setBusy('terms')
    setMsg('正在从全书抽样抽取术语…')
    try {
      const list = await api.tr.buildGlossary(bookId)
      setTerms(await api.tr.glossary(bookId))
      setMsg(`抽取到 ${list.length} 条术语`)
    } catch (e: any) {
      setMsg(String(e?.message ?? e))
    } finally {
      setBusy('')
    }
  }

  async function addTerm() {
    const s = newSrc.trim()
    const d = newDst.trim()
    if (!s || !d) return
    await api.tr.setGlossary(bookId, s, d)
    setNewSrc('')
    setNewDst('')
    setTerms(await api.tr.glossary(bookId))
  }

  const total = status?.total ?? 0
  const done = status?.done ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const running = status?.running ?? false
  const state = status?.job?.state

  return (
    <aside className="side-panel tr-panel">
      <header className="sp-head">
        <div className="sp-title">翻译</div>
        <button className="sp-close" onClick={onClose} title="关闭">
          ×
        </button>
      </header>

      <div className="sp-body">
        <div className="tr-book">《{bookTitle}》</div>

        <div className="tr-seg">
          {BI_LABEL.map((m) => (
            <button key={m.id} className={bi === m.id ? 'on' : ''} onClick={() => onBi(m.id)}>
              {m.label}
            </button>
          ))}
        </div>

        <div className="tr-block">
          <label className="tr-label">目标语言</label>
          <select
            value={cfg?.targetLang ?? 'zh-CN'}
            onChange={(e) => void patch({ targetLang: e.target.value })}
          >
            {Object.entries(langs).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="tr-progress">
          <div className="tr-bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="tr-meta">
            <span>
              {done} / {total} 段
            </span>
            <span className="dim">
              {running ? '翻译中…' : state === 'paused' ? '已暂停' : state === 'done' ? '已完成' : state === 'error' ? '出错' : '未开始'}
            </span>
          </div>
          {state === 'error' && status?.job?.error && <div className="tr-err">{status.job.error}</div>}
        </div>

        <div className="tr-actions">
          {running ? (
            <button className="primary-btn slim" onClick={() => void pause()}>
              暂停
            </button>
          ) : total > 0 && done >= total ? (
            <button className="primary-btn slim" disabled>
              已全部译完
            </button>
          ) : (
            <button className="primary-btn slim" disabled={busy === 'start'} onClick={() => void start()}>
              {done > 0 && done < total ? '继续翻译' : '开始翻译'}
            </button>
          )}
          <button className="text-btn" disabled={busy === 'reset'} onClick={() => void reset()}>
            清空译文
          </button>
        </div>

        <div className="tr-sec-title">流水线</div>
        <div className="tr-stages">
          {stages.map((s) => (
            <label key={s.id} className={`tr-stage ${cfg?.stages?.[s.id] ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={Boolean(cfg?.stages?.[s.id])}
                onChange={(e) => void patch({ stages: { ...(cfg!.stages as any), [s.id]: e.target.checked } })}
              />
              <span className="tr-stage-name">{s.name}</span>
              <span className="tr-stage-desc">{s.desc}</span>
            </label>
          ))}
        </div>

        <div className="tr-grid">
          <label className="tr-label">及格线</label>
          <input
            type="range"
            min={40}
            max={98}
            value={cfg?.threshold ?? 75}
            onChange={(e) => void patch({ threshold: Number(e.target.value) })}
          />
          <span className="tr-val">{cfg?.threshold ?? 75}</span>

          <label className="tr-label">最多重跑</label>
          <input
            type="range"
            min={1}
            max={5}
            value={cfg?.maxRounds ?? 3}
            onChange={(e) => void patch({ maxRounds: Number(e.target.value) })}
          />
          <span className="tr-val">{cfg?.maxRounds ?? 3} 轮</span>

          <label className="tr-label">并发段数</label>
          <input
            type="range"
            min={1}
            max={6}
            value={cfg?.concurrency ?? 3}
            onChange={(e) => void patch({ concurrency: Number(e.target.value) })}
          />
          <span className="tr-val">{cfg?.concurrency ?? 3}</span>
        </div>

        <div className="tr-sec-title">
          术语表 <span className="dim">{terms.length}</span>
          <button className="text-btn tr-mini" disabled={busy === 'terms'} onClick={() => void buildTerms()}>
            从全书抽取
          </button>
        </div>

        <div className="tr-terms">
          {terms.length === 0 && <div className="dim tr-empty">还没有术语。抽取一份，翻译时就会保持一致。</div>}
          {terms.map((t) => (
            <div key={t.src} className="tr-term">
              <span className="tr-term-src">{t.src}</span>
              <span className="tr-term-arrow">→</span>
              <span className="tr-term-dst">{t.dst}</span>
              <button
                className="tr-term-del"
                title="删除"
                onClick={() => void api.tr.removeGlossary(bookId, t.src).then(() => api.tr.glossary(bookId)).then(setTerms)}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="tr-term-add">
          <input placeholder="原文词" value={newSrc} onChange={(e) => setNewSrc(e.target.value)} />
          <input placeholder="译名" value={newDst} onChange={(e) => setNewDst(e.target.value)} />
          <button className="text-btn" onClick={() => void addTerm()}>
            添加
          </button>
        </div>

        {msg && <div className="tr-msg">{msg}</div>}

        <div className="tr-hint">
          翻译是逐段进行的，每段单独走完流水线。随时可以暂停，进度会记在书里；重新导入同一本书，原文变了的段落会自动重译。
        </div>
      </div>
    </aside>
  )
}
