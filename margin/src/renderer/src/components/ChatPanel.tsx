import { useEffect, useRef, useState } from 'react'
import api, { MODES, type Message, type Mode } from '../api'

/** 讨论锚点：一条划线，或一整节（锚在该节末尾） */
export interface Anchor {
  id: string
  quote: string
  bookId?: string
  secIdx?: number
}

interface Props {
  anchor: Anchor
  initialMode: Mode
  autoSend: boolean
  onModeChange: (m: Mode) => void
}

export default function ChatPanel({ anchor, initialMode, autoSend, onModeChange }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [stats, setStats] = useState<string>('')
  const sentRef = useRef<string>('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => setMode(initialMode), [initialMode])

  useEffect(() => {
    let cancelled = false
    setMessages([])
    setError('')
    setStats('')
    api.chat
      .history(anchor.id, mode)
      .then((h) => {
        // 首轮自动提问时，历史回填可能晚于回复落地，不能把刚生成的消息冲掉
        if (!cancelled && sentRef.current !== `${anchor.id}:${mode}`) setMessages(h as Message[])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [anchor.id, mode])

  useEffect(() => {
    const key = `${anchor.id}:${mode}`
    if (!autoSend || sentRef.current === key) return
    if (messages.length > 0) return
    sentRef.current = key
    void send('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.id, mode, autoSend, messages.length])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, loading])

  async function send(text: string) {
    setLoading(true)
    setError('')
    if (text.trim()) {
      setMessages((prev) => [...prev, { role: 'user', content: text }])
    }
    setInput('')
    try {
      const res = await api.chat.send({
        annotationId: anchor.bookId ? undefined : anchor.id,
        bookId: anchor.bookId,
        secIdx: anchor.secIdx,
        mode,
        text: text || undefined
      })
      setMessages((prev) => [...prev, { role: 'assistant', content: res.reply, sources: res.sources }])
      setStats(
        `上下文 ${res.stats.totalChars} 字 · 位置 ${res.stats.percent}% · 前文检索 ${res.stats.retrieved} 段 · 历史笔记 ${res.stats.notes} 条` +
          ((res.stats.memory ?? 0) > 0 ? ` · 记得你说过 ${res.stats.memory} 句` : '')
      )
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <div className="quote-box">「{anchor.quote.length > 120 ? anchor.quote.slice(0, 120) + '…' : anchor.quote}」</div>
        <div className="mode-tabs">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={`mode-tab ${mode === m.key ? 'on' : ''}`}
              title={m.hint}
              onClick={() => {
                setMode(m.key)
                onModeChange(m.key)
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chat-body">
        {messages.length === 0 && !loading && (
          <div className="chat-empty">
            <p>这条线之后的讨论，AI 只能看到你读过的部分。</p>
            <p className="dim">它不会替你翻到后面去。</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-body">
              {m.content}
              {m.sources && m.sources.length > 0 && (
                <div className="msg-sources">
                  {m.sources.map((s, j) => (
                    <span key={j} className="chip">
                      {s.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && <div className="msg msg-assistant"><div className="msg-body dim">思考中…</div></div>}
        {error && <div className="chat-error">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="chat-foot">
        {stats && <div className="chat-stats">{stats}</div>}
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            placeholder="用自己的话说说你的理解（这条回复会带着你读过的前文一起发给 AI）"
            value={input}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (!loading && input.trim()) void send(input)
              }
            }}
          />
          <button className="send-btn" disabled={loading || !input.trim()} onClick={() => void send(input)}>
            发送
          </button>
        </div>
        <div className="chat-hint">Ctrl / ⌘ + Enter 发送</div>
      </div>
    </div>
  )
}
