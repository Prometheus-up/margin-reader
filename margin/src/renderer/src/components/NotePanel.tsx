import { useEffect, useState } from 'react'
import type { Annotation } from '../api'
import { COLORS } from '../api'

interface Props {
  annotation: Annotation
  secTitle: string
  onColor: (color: string) => void
  onNote: (note: string) => void
  onDelete: () => void
  onChat: () => void
  onShare: () => void
  onCopy: () => void
  onMakeCards?: () => void
}

export default function NotePanel({ annotation, secTitle, onColor, onNote, onDelete, onChat, onShare, onCopy, onMakeCards }: Props) {
  const [note, setNote] = useState(annotation.note ?? '')

  useEffect(() => {
    setNote(annotation.note ?? '')
  }, [annotation.id, annotation.note])

  function commit(v: string) {
    if (v !== (annotation.note ?? '')) onNote(v)
  }

  return (
    <div className="note-editor">
      <div className="note-editor-head">
        <span className="note-sec">{secTitle}</span>
        <div className="note-colors">
          {COLORS.map((c) => (
            <button
              key={c.key}
              className={`dot ${annotation.color === c.key ? 'on' : ''}`}
              style={{ background: c.hex }}
              title={c.label}
              onClick={() => onColor(c.key)}
            />
          ))}
        </div>
      </div>

      <blockquote className="note-quote-full">{annotation.quote}</blockquote>

      <textarea
        className="note-input"
        placeholder="写点什么。这一句为什么让你停下来？（Ctrl+Enter 保存）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => commit(note)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            commit(note)
            ;(e.target as HTMLTextAreaElement).blur()
          }
        }}
      />

      <div className="note-actions">
        <button className="ghost-btn" onClick={() => commit(note)}>保存批注</button>
        <button className="ghost-btn" onClick={onCopy}>复制原文</button>
        <button className="ghost-btn" onClick={onShare}>生成分享图</button>
      </div>

      <div className="note-actions">
        <button className="primary-btn slim" onClick={onChat}>和 AI 聊聊这段</button>
        {onMakeCards && <button className="ghost-btn" onClick={onMakeCards}>做成卡片</button>}
        <button className="ghost-btn danger" onClick={onDelete}>删除</button>
      </div>

      <div className="note-hint">
        讨论时 AI 只能看到这条线之前的内容。你的批注也算「之前」——写在这里，后面的讨论会带着它。
      </div>
    </div>
  )
}
