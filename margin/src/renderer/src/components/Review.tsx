import { useEffect, useMemo, useState } from 'react'
import api, { type Card } from '../api'

interface Props {
  onBack: () => void
  onOpenSource: (c: Card) => void
}

const GRADES = [
  { g: 0, label: '忘了', hint: '10 分钟后', cls: 'again' },
  { g: 1, label: '有点印象', hint: '明天', cls: 'hard' },
  { g: 2, label: '记得', hint: '几天后', cls: 'good' },
  { g: 3, label: '很熟', hint: '更久', cls: 'easy' }
] as const

export default function Review({ onBack, onOpenSource }: Props) {
  const [queue, setQueue] = useState<Card[]>([])
  const [idx, setIdx] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tally, setTally] = useState({ again: 0, done: 0 })
  const [total, setTotal] = useState(0)

  useEffect(() => {
    void (async () => {
      const [due, counts] = await Promise.all([api.cards.due(40), api.cards.counts()])
      setQueue(due)
      setTotal(counts.total)
      setLoading(false)
    })()
  }, [])

  const card = queue[idx]

  async function grade(g: number) {
    if (!card) return
    await api.cards.review(card.id, g)
    setTally((t) => ({ again: t.again + (g === 0 ? 1 : 0), done: t.done + 1 }))
    setFlipped(false)
    setIdx((i) => i + 1)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onBack()
      if (!card) return
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        setFlipped((v) => !v)
      }
      if (flipped && ['1', '2', '3', '4'].includes(e.key)) void grade(Number(e.key) - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, flipped])

  const progress = useMemo(() => {
    if (!queue.length) return 0
    return Math.round((Math.min(idx, queue.length) / queue.length) * 100)
  }, [idx, queue.length])

  return (
    <div className="review">
      <header className="review-top">
        <button className="text-btn" onClick={onBack}>
          ← 书架
        </button>
        <div className="rv-title">复习</div>
        <div className="rv-count">
          {queue.length ? `${Math.min(idx + 1, queue.length)} / ${queue.length}` : ''}
        </div>
      </header>
      <div className="rv-progress">
        <i style={{ width: `${progress}%` }} />
      </div>

      {loading && <div className="rv-empty dim">正在取卡片…</div>}

      {!loading && !card && (
        <div className="rv-empty">
          {total === 0 ? (
            <>
              <div className="rv-empty-title">还没有卡片</div>
              <p className="dim">
                在书里划一条线，打开「笔记」，点「做成卡片」——AI 会把这条划线变成一张能复习的问答卡。
              </p>
            </>
          ) : (
            <>
              <div className="rv-empty-title">今天的复习完成了</div>
              <p className="dim">
                这一轮复习了 {tally.done} 张{tally.again ? `，其中 ${tally.again} 张没记住，会很快再出现` : ''}。
              </p>
              <button className="primary-btn" onClick={onBack}>
                回到书架
              </button>
            </>
          )}
        </div>
      )}

      {card && (
        <div className="rv-stage">
          <div className={`rv-card ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped((v) => !v)}>
            <div className="rv-face rv-front">
              <div className="rv-book">
                《{card.book_title}》· {card.sec_title}
              </div>
              <div className="rv-question">{card.front}</div>
              <div className="rv-hint dim">{flipped ? '' : '想一想，再点一次翻面（空格）'}</div>
            </div>
            <div className="rv-face rv-back">
              <div className="rv-answer">{card.back}</div>
              {card.quote && <div className="rv-quote">「{card.quote}」</div>}
              {card.note && <div className="rv-note">你的批注：{card.note}</div>}
            </div>
          </div>

          {flipped ? (
            <div className="rv-grades">
              {GRADES.map((x) => (
                <button key={x.g} className={`rv-grade ${x.cls}`} onClick={() => void grade(x.g)}>
                  <span>{x.label}</span>
                  <em>{x.hint}</em>
                </button>
              ))}
            </div>
          ) : (
            <div className="rv-actions">
              <button className="ce-btn" onClick={() => onOpenSource(card)}>
                回到原文
              </button>
              <button className="primary-btn" onClick={() => setFlipped(true)}>
                翻面
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
