import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api, {
  COLORS,
  type Annotation,
  type BiMode,
  type Book,
  type Bookmark,
  type Card,
  type DictEntry,
  type GlobalHit,
  type KbItem,
  type Mode,
  type ReadingStats,
  type SearchHit,
  type Section,
  type SectionMeta,
  type TrStatus
} from './api'
import Reader from './components/Reader'
import Review from './components/Review'
import ChatPanel from './components/ChatPanel'
import SettingsPanel from './components/SettingsPanel'
import NotePanel from './components/NotePanel'
import ExcerptsPanel from './components/ExcerptsPanel'
import TranslatePanel from './components/TranslatePanel'
import MemoryPanel from './components/MemoryPanel'
import ExternalPanel from './components/ExternalPanel'
import Bookshelf from './components/Bookshelf'
import KnowledgeBase, { splitTags } from './components/KnowledgeBase'
import { downloadDataUrl, downloadText, renderShareImage, toMarkdown } from './lib/share'
import { KEYS_EVENT, loadKeys, matchCombo, type KeyAction } from './lib/keys'

type Tab = 'chat' | 'notes' | 'excerpts'
type Drawer = 'toc' | 'search' | 'marks' | null
type View = 'shelf' | 'reader' | 'review'

interface Display {
  size: number
  lh: number
  theme: 'paper' | 'sepia' | 'green' | 'night' | 'black'
  font: 'serif' | 'sans' | 'kai' | 'fang' | 'system'
  width: 'narrow' | 'normal' | 'wide' | 'full'
  gap: number
  indent: boolean
  paged: boolean
}

const DEFAULT_DISPLAY: Display = {
  size: 18,
  lh: 1.9,
  theme: 'paper',
  font: 'serif',
  width: 'wide',
  gap: 1.1,
  indent: true,
  paged: false
}

const WIDTH_PX: Record<Display['width'], number> = { narrow: 620, normal: 760, wide: 920, full: 1180 }

const FONT_STACK: Record<Display['font'], string> = {
  serif: '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", Georgia, serif',
  sans: '"Source Han Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  kai: '"KaiTi", "Kaiti SC", "STKaiti", "Noto Serif CJK SC", serif',
  fang: '"FangSong", "FangSong_GB2312", "STFangsong", serif',
  system: 'system-ui, "Microsoft YaHei", sans-serif'
}

function loadDisplay(): Display {
  try {
    const raw = localStorage.getItem('margin.display')
    if (raw) return { ...DEFAULT_DISPLAY, ...JSON.parse(raw) }
  } catch {
    /* 用默认值 */
  }
  return DEFAULT_DISPLAY
}

export default function App() {
  const [view, setView] = useState<View>('shelf')
  const [books, setBooks] = useState<Book[]>([])
  const [bookId, setBookId] = useState<string | null>(null)
  const [book, setBook] = useState<Book | null>(null)
  const [sections, setSections] = useState<SectionMeta[]>([])
  const [section, setSection] = useState<Section | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [active, setActive] = useState<Annotation | null>(null)
  const [secChat, setSecChat] = useState<{ secIdx: number; title: string } | null>(null)
  const [mode, setMode] = useState<Mode>('socratic')
  const [autoSend, setAutoSend] = useState(false)
  const [tab, setTab] = useState<Tab>('chat')
  const [panel, setPanel] = useState<Tab | 'translate' | 'memory' | 'external' | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [display, setDisplay] = useState<Display>(loadDisplay)
  const [showDisplay, setShowDisplay] = useState(false)
  const [focusRange, setFocusRange] = useState<{ start: number; end: number } | null>(null)
  const [initialScroll, setInitialScroll] = useState(0)
  const [turnCmd, setTurnCmd] = useState<{ dir: 1 | -1; nonce: number } | null>(null)
  const [pageInfo, setPageInfo] = useState({ page: 0, total: 1 })
  const turnNonce = useRef(0)
  const startLastRef = useRef(false)
  const [share, setShare] = useState<{ url: string; w: number; h: number } | null>(null)
  const [kbOpen, setKbOpen] = useState(false)
  const [kbItems, setKbItems] = useState<KbItem[]>([])
  const [kbCards, setKbCards] = useState<Card[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showMarks, setShowMarks] = useState(false)
  const [dueCount, setDueCount] = useState(0)
  const [cardCount, setCardCount] = useState(0)
  const [summary, setSummary] = useState<{ summary: string; keywords: string[] } | null>(null)
  const [sumBusy, setSumBusy] = useState(false)
  const [bi, setBi] = useState<BiMode>(() => (localStorage.getItem('margin.bi') as BiMode) || 'off')
  const [stats, setStats] = useState<ReadingStats | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const [extSeed, setExtSeed] = useState('')
  const [keys, setKeys] = useState<Record<KeyAction, string>>(loadKeys)
  const [dict, setDict] = useState<{ word: string; data: DictEntry | null; busy: boolean } | null>(null)
  const [note, setNote] = useState<{ text: string; secIdx: number; secTitle: string } | null>(null)
  const [trStatus, setTrStatus] = useState<TrStatus | null>(null)
  const [trBlocks, setTrBlocks] = useState<Record<number, string>>({})
  const searchRef = useRef<HTMLInputElement>(null)
  const ratioRef = useRef(0)
  const posRef = useRef<{ sec: number; ratio: number }>({ sec: 0, ratio: 0 })
  const saveTimer = useRef<number | null>(null)

  const sectionMeta = useMemo(
    () => sections.find((s) => s.idx === section?.idx) ?? null,
    [sections, section]
  )

  useEffect(() => {
    void refreshBooks()
    void refreshStats()
  }, [])

  async function refreshStats() {
    try {
      setStats(await api.stats.get())
    } catch {
      /* ignore */
    }
  }

  // 在阅读页里每满一分钟记一次，离开时停表（不精确到秒，够用）
  useEffect(() => {
    if (view !== 'reader') return
    const id = window.setInterval(() => {
      void api.stats.add(60).catch(() => {})
    }, 60000)
    return () => window.clearInterval(id)
  }, [view])

  // 切节 / 离开阅读页时停下朗读
  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel()
      setSpeaking(false)
    }
  }, [section?.idx, view])

  function openExt(seed: string) {
    setShowDisplay(false)
    setDrawer(null)
    setExtSeed(seed)
    setPanel('external')
  }

  async function openLink(href: string) {
    if (!bookId || !section || !href) return
    try {
      const r = await api.book.anchor(bookId, section.idx, href)
      if (r.kind === 'external' && r.url) {
        window.open(r.url, '_blank')
        return
      }
      if (r.kind === 'section' && typeof r.secIdx === 'number') {
        await openSection(bookId, r.secIdx)
        return
      }
      if (r.kind === 'note' && typeof r.secIdx === 'number') {
        setNote({ text: r.text ?? '', secIdx: r.secIdx, secTitle: r.secTitle ?? '' })
        return
      }
      setToast('这条链接指向的内容没找到')
    } catch (e: any) {
      setToast(String(e?.message ?? '链接打不开'))
    }
  }

  async function lookup(word: string, sentence: string) {    setDict({ word, data: null, busy: true })
    try {
      const data = await api.dict.lookup(word, sentence)
      setDict({ word, data, busy: false })
    } catch (e: any) {
      setDict({ word, data: null, busy: false })
      setToast(String(e?.message ?? '查词失败'))
    }
  }

  function toggleSpeak() {
    if (!section) return
    const synth = window.speechSynthesis
    if (!synth) {
      setToast('这个环境不支持朗读')
      return
    }
    if (speaking) {
      synth.cancel()
      setSpeaking(false)
      return
    }
    const text = section.blocks.map((b) => b.text).join('\n')
    if (!text.trim()) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = /[\u4e00-\u9fa5]/.test(text.slice(0, 300)) ? 'zh-CN' : 'en-US'
    u.rate = 1
    u.onend = () => setSpeaking(false)
    u.onerror = () => setSpeaking(false)
    synth.cancel()
    synth.speak(u)
    setSpeaking(true)
  }

  async function refreshCards() {
    try {
      const c = await api.cards.counts()
      setDueCount(c.due)
      setCardCount(c.total)
    } catch {
      /* 接口尚未就绪时忽略 */
    }
  }

  useEffect(() => {
    void refreshCards()
  }, [view])

  useEffect(() => {
    setSummary(null)
  }, [section?.idx, bookId])

  async function makeSummary(force = false) {
    if (!bookId || !section) return
    setSumBusy(true)
    try {
      setSummary(await api.summary.get(bookId, section.idx, force))
    } catch (e: any) {
      setToast(`概括失败：${e?.message ?? e}`)
      window.setTimeout(() => setToast(''), 2600)
    } finally {
      setSumBusy(false)
    }
  }

  async function refreshTr() {
    if (!bookId) return
    setTrStatus(await api.tr.status(bookId))
  }

  async function loadTrSection(id: string, idx: number) {
    const rows = await api.tr.section(id, idx)
    const map: Record<number, string> = {}
    for (const r of rows) map[r.block_i] = r.text
    setTrBlocks(map)
  }

  async function translateOne(blockI: number) {
    if (!bookId || !section) return
    try {
      const r = await api.tr.block(bookId, section.idx, blockI)
      setTrBlocks((m) => ({ ...m, [blockI]: r.text }))
      if (bi === 'off') setBi('below')
    } catch (e: any) {
      setToast(`这段没译成：${e?.message ?? e}`)
      window.setTimeout(() => setToast(''), 2600)
    }
  }

  useEffect(() => {
    localStorage.setItem('margin.bi', bi)
  }, [bi])

  // 打开一节时拉取已有译文
  useEffect(() => {
    if (!bookId || !section) return
    void loadTrSection(bookId, section.idx)
  }, [bookId, section?.idx])

  // 翻译任务进行中时轮询进度
  useEffect(() => {
    if (!bookId || !trStatus?.running) return
    const t = window.setInterval(() => {
      void api.tr.status(bookId).then(setTrStatus)
    }, 1500)
    return () => window.clearInterval(t)
  }, [bookId, trStatus?.running])

  useEffect(() => {
    if (bookId) void refreshTr()
  }, [bookId])

  // 任务推进或结束时，把本节新译好的段落补进对照
  useEffect(() => {
    if (!bookId || !section || !trStatus) return
    void loadTrSection(bookId, section.idx)
  }, [trStatus?.done, trStatus?.job?.state])

  useEffect(() => {
    localStorage.setItem('margin.display', JSON.stringify(display))
    const root = document.documentElement
    root.dataset.theme = display.theme
    root.style.setProperty('--reader-size', `${display.size}px`)
    root.style.setProperty('--reader-lh', String(display.lh))
    root.style.setProperty('--reader-width', `${WIDTH_PX[display.width]}px`)
    root.style.setProperty('--reader-gap', `${display.gap}em`)
    root.style.setProperty('--reader-indent', display.indent ? '2em' : '0')
    root.style.setProperty('--reader-font', FONT_STACK[display.font])
  }, [display])

  useEffect(() => {
    localStorage.setItem('margin.keys', JSON.stringify(keys))
  }, [keys])

  useEffect(() => {
    const onKeys = () => setKeys(loadKeys())
    window.addEventListener(KEYS_EVENT, onKeys)
    return () => window.removeEventListener(KEYS_EVENT, onKeys)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.key === 'Escape') {
        setDrawer(null)
        setShowDisplay(false)
        setPanel(null)
        setShowMarks(false)
        return
      }
      if (view !== 'reader' || !bookId || !section) return

      const hit = (action: KeyAction) => matchCombo(e, keys[action])

      if (hit('search')) {
        e.preventDefault()
        setDrawer('search')
        window.setTimeout(() => searchRef.current?.focus(), 30)
        return
      }
      if (hit('toc')) {
        e.preventDefault()
        setDrawer(drawer === 'toc' ? null : 'toc')
        return
      }
      if (hit('display')) {
        e.preventDefault()
        setShowDisplay((v) => !v)
        return
      }
      if (hit('marks')) {
        e.preventDefault()
        setShowMarks((v) => !v)
        return
      }
      if (hit('notes')) {
        e.preventDefault()
        setPanel((p) => (p === 'notes' ? null : 'notes'))
        setTab('notes')
        return
      }
      if (hit('speak')) {
        e.preventDefault()
        toggleSpeak()
        return
      }
      if (hit('back')) {
        e.preventDefault()
        backToShelf()
        return
      }

      if (display.paged) {
        if (hit('next') || e.key === 'PageDown' || e.key === ' ') {
          e.preventDefault()
          turnPage(1)
          return
        }
        if (hit('prev') || e.key === 'PageUp') {
          e.preventDefault()
          turnPage(-1)
          return
        }
      }
      if (hit('next') && section.idx < sections.length - 1) void openSection(bookId, section.idx + 1)
      if (hit('prev') && section.idx > 0) void openSection(bookId, section.idx - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, bookId, section, sections.length, display.paged, keys])

  async function refreshBooks() {
    setBooks(await api.books.list())
  }

  function turnPage(dir: 1 | -1) {
    turnNonce.current += 1
    setTurnCmd({ dir, nonce: turnNonce.current })
  }

  function edgeTurn(dir: 1 | -1) {
    if (!bookId || !section) return
    const next = section.idx + dir
    if (next < 0 || next >= sections.length) return
    startLastRef.current = dir < 0
    void openSection(bookId, next)
  }

  async function openBook(id: string) {
    setBusy(true)
    try {
      const [meta, secs, anns, prog, marks] = await Promise.all([
        api.book.meta(id),
        api.book.sections(id),
        api.annotations.list(id),
        api.progress.get(id),
        api.bookmarks.list(id)
      ])
      setBook(meta)
      setBookId(id)
      setSections(secs)
      setAnnotations(anns)
      setBookmarks(marks)
      setActive(null)
      setSecChat(null)
      setHits(null)
      setQuery('')
      setFocusRange(null)
      setPanel(null)
      setDrawer(null)
      setView('reader')
      const startIdx = Math.min(prog?.sec_idx ?? 0, Math.max(0, secs.length - 1))
      posRef.current = { sec: startIdx, ratio: 0 }
      await openSection(id, startIdx, true)
    } finally {
      setBusy(false)
    }
  }

  const openSection = useCallback(
    async (id: string, idx: number, keepPos = false) => {
      const sec = await api.book.section(id, idx)
      if (!sec) return
      setSection(sec)
      setFocusRange(null)
      // 只有重新打开这本书时才回到上次的位置；从目录/搜索/书签跳转一律从头开始
      const pos = keepPos ? readPos(id) : { sec: idx, ratio: 0 }
      setInitialScroll(pos.sec === idx ? pos.ratio : 0)
      posRef.current = { sec: idx, ratio: pos.sec === idx ? pos.ratio : 0 }
      void api.progress.set(id, idx, Math.round(((idx + 1) / Math.max(1, sections.length)) * 100))
    },
    [sections.length]
  )

  function readPos(id: string): { sec: number; ratio: number } {
    try {
      const raw = localStorage.getItem(`margin.pos.${id}`)
      if (raw) return JSON.parse(raw)
    } catch {
      /* ignore */
    }
    return { sec: 0, ratio: 0 }
  }

  function onScrollPos(ratio: number) {
    ratioRef.current = ratio
    if (!bookId || !section) return
    posRef.current = { sec: section.idx, ratio }
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      if (bookId) localStorage.setItem(`margin.pos.${bookId}`, JSON.stringify(posRef.current))
    }, 400)
  }

  async function importBooks() {
    setBusy(true)
    // 扫描件要逐页 OCR，可能要几分钟：边等边把识别进度显示出来，别让人以为卡死了
    const timer = window.setInterval(() => {
      void api.books
        .progress()
        .then((p: { name: string; done: number; total: number } | null) => {
          if (p) setToast(`正在识别扫描件《${p.name}》 ${p.done}/${p.total} 页，请稍候…`)
        })
        .catch(() => {})
    }, 2000)
    try {
      const res = await api.books.import()
      await refreshBooks()
      if (res.imported.length) {
        setToast(`已导入 ${res.imported.length} 本`)
        await openBook(res.imported[0].id)
      }
      if (res.failed.length) {
        setToast(`导入失败：${res.failed.map((f) => `${f.file}（${f.error}）`).join('；')}`)
      }
      window.setTimeout(() => setToast(''), res.failed.length ? 9000 : 3500)
    } finally {
      window.clearInterval(timer)
      setBusy(false)
    }
  }

  async function removeBook(b: Book) {
    if (!window.confirm(`删除《${b.title}》？划线、笔记和阅读进度会一起删掉（原文件不动）。`)) return
    await api.books.remove(b.id)
    if (bookId === b.id) backToShelf()
    await refreshBooks()
  }

  function backToShelf() {
    setView('shelf')
    setPanel(null)
    setDrawer(null)
    setBookId(null)
    setBook(null)
    setSection(null)
    setSections([])
    setActive(null)
    void refreshBooks()
    void refreshStats()
  }

  async function createAnnotation(payload: { start: number; end: number; quote: string }, color: string): Promise<Annotation | null> {
    if (!sectionMeta || !bookId) return null
    const ann = await api.annotations.create({
      book_id: bookId,
      sec_idx: sectionMeta.idx,
      char_start: payload.start,
      char_end: payload.end,
      global_pos: sectionMeta.char_start + payload.start,
      quote: payload.quote,
      prefix: '',
      suffix: '',
      note: '',
      color,
      tags: ''
    })
    setAnnotations((prev) => [...prev, ann])
    return ann
  }

  /** 只标颜色：不打开任何面板，阅读不被打断 */
  async function handleHighlight(payload: { start: number; end: number; quote: string }, color: string, withNote: boolean) {
    const ann = await createAnnotation(payload, color)
    if (!ann) return
    if (withNote) {
      setActive(ann)
      setTab('notes')
      setPanel('notes')
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.note-input')?.focus(), 80)
    } else {
      setToast(`已标为${colorLabel(color)}`)
      window.setTimeout(() => setToast(''), 1400)
    }
  }

  async function handleAnnotate(payload: { start: number; end: number; quote: string }, m: Mode) {
    const ann = await createAnnotation(payload, 'yellow')
    if (!ann) return
    setSecChat(null)
    setActive(ann)
    setMode(m)
    setAutoSend(true)
    setTab('chat')
    setPanel('chat')
  }

  function openAnnotation(a: Annotation) {
    setActive(a)
    setSecChat(null)
    setAutoSend(false)
    setTab('notes')
    setPanel('notes')
    if (section?.idx !== a.sec_idx && bookId) void openSection(bookId, a.sec_idx)
  }

  function chatAbout(a: Annotation) {
    setActive(a)
    setSecChat(null)
    setAutoSend(false)
    setTab('chat')
    setPanel('chat')
  }

  /** 整节讨论：锚点在本节末尾，AI 看到的是"读完了这一节" */
  function chatSection() {
    if (!section || !bookId || !book) return
    setActive(null)
    setSecChat({ secIdx: section.idx, title: section.title })
    setMode('socratic')
    setAutoSend(true)
    setTab('chat')
    setPanel('chat')
  }

  async function changeColor(a: Annotation, color: string) {
    await api.annotations.update(a.id, { color })
    setAnnotations((prev) => prev.map((x) => (x.id === a.id ? { ...x, color } : x)))
  }

  async function saveNote(a: Annotation, note: string) {
    await api.annotations.update(a.id, { note })
    setAnnotations((prev) => prev.map((x) => (x.id === a.id ? { ...x, note } : x)))
    setToast('批注已保存')
    window.setTimeout(() => setToast(''), 1500)
  }

  async function deleteAnnotation(a: Annotation) {
    await api.annotations.remove(a.id)
    setAnnotations((prev) => prev.filter((x) => x.id !== a.id))
    if (active?.id === a.id) setActive(null)
  }

  async function deleteMany(items: Annotation[]) {
    if (!window.confirm(`删除选中的 ${items.length} 条划线？`)) return
    for (const a of items) await api.annotations.remove(a.id)
    const ids = new Set(items.map((x) => x.id))
    setAnnotations((prev) => prev.filter((x) => !ids.has(x.id)))
    if (active && ids.has(active.id)) setActive(null)
  }

  function copyText(text: string) {
    void navigator.clipboard.writeText(text)
    setToast('已复制')
    window.setTimeout(() => setToast(''), 1500)
  }

  function shareImage(items: Annotation[]) {
    if (!book) return
    const { dataUrl, width, height } = renderShareImage({
      bookTitle: book.title,
      author: book.author,
      items: items.map((a) => ({
        quote: a.quote,
        note: a.note,
        secTitle: sections.find((s) => s.idx === a.sec_idx)?.title ?? ''
      }))
    })
    setShare({ url: dataUrl, w: width, h: height })
  }

  function markdownOf(items: Annotation[]): string {
    const groups = sections
      .map((s) => ({ secTitle: s.title, items: items.filter((a) => a.sec_idx === s.idx).sort((x, y) => x.char_start - y.char_start) }))
      .filter((g) => g.items.length)
    return toMarkdown(book?.title ?? '', book?.author ?? '', groups)
  }

  async function runSearch(q: string) {
    setQuery(q)
    if (!bookId || q.trim().length < 1) {
      setHits(null)
      return
    }
    setHits(await api.book.search(bookId, q.trim()))
  }

  async function jumpToHit(hit: SearchHit) {
    if (!bookId) return
    if (section?.idx !== hit.sec_idx) await openSection(bookId, hit.sec_idx)
    const meta = sections.find((s) => s.idx === hit.sec_idx)
    if (!meta) return
    setFocusRange({ start: hit.char_start - meta.char_start, end: hit.char_end - meta.char_start })
    setDrawer(null)
  }

  /* ---------------- 复习卡片 ---------------- */

  function openReview() {
    setView('review')
  }

  async function openCardSource(c: Card) {    const secs = await api.book.sections(c.book_id)
    await openBook(c.book_id)
    const anns = await api.annotations.list(c.book_id)
    const a = anns.find((x) => x.id === c.annotation_id)
    if (!a) return
    const meta = secs.find((s) => s.idx === a.sec_idx)
    if (!meta) return
    if (a.sec_idx !== 0) await openSection(c.book_id, a.sec_idx)
    setFocusRange({ start: a.char_start - meta.char_start, end: a.char_end - meta.char_start })
  }

  async function openGlobalHit(h: GlobalHit) {
    const secs = await api.book.sections(h.book_id)
    await openBook(h.book_id)
    const meta = secs.find((s) => s.idx === h.sec_idx)
    if (!meta) return
    await openSection(h.book_id, h.sec_idx)
    setFocusRange({ start: h.char_start - meta.char_start, end: h.char_end - meta.char_start })
    setQuery('')
  }

  async function makeCards(a: Annotation) {
    setToast('AI 正在出题…')
    try {
      const cards = await api.cards.generate(a.id)
      await refreshCards()
      setToast(cards.length ? `已生成 ${cards.length} 张卡片` : '这次没生成出合适的卡片')
    } catch (e: any) {
      setToast(`生成失败：${e?.message ?? e}`)
    }
    window.setTimeout(() => setToast(''), 2600)
  }

  async function addBookmark() {
    if (!sectionMeta || !bookId) return
    const mark = await api.bookmarks.create({
      book_id: bookId,
      sec_idx: sectionMeta.idx,
      global_pos: sectionMeta.char_start,
      label: sectionMeta.title
    })
    setBookmarks((prev) => [...prev, mark].sort((a, b) => a.global_pos - b.global_pos))
    setToast('已加书签')
    window.setTimeout(() => setToast(''), 1800)
  }

  async function removeBookmark(id: string) {
    await api.bookmarks.remove(id)
    setBookmarks((prev) => prev.filter((b) => b.id !== id))
  }

  /* ---------------- 知识库 ---------------- */

  async function openKb() {
    setKbItems(await api.annotations.all())
    setKbCards(await api.cards.list())
    setKbOpen(true)
  }

  async function kbMakeCard(item: KbItem) {
    try {
      const made = await api.cards.generate(item.id)
      setKbCards(await api.cards.list())
      setToast(made.length ? `已生成 ${made.length} 张复习卡片` : '这条还没有卡片可生成（先补一句批注试试）')
    } catch (e: any) {
      setToast(String(e?.message ?? '生成卡片失败'))
    }
  }

  async function kbTag(item: KbItem, tags: string) {
    const clean = splitTags(tags).join(',')
    await api.annotations.update(item.id, { tags: clean })
    setKbItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, tags: clean } : x)))
  }

  async function kbDelete(item: KbItem) {
    if (!window.confirm('删除这条摘抄？')) return
    await api.annotations.remove(item.id)
    setKbItems((prev) => prev.filter((x) => x.id !== item.id))
    if (bookId === item.book_id) setAnnotations((prev) => prev.filter((x) => x.id !== item.id))
  }

  async function kbOpenItem(item: KbItem) {
    setKbOpen(false)
    await openBook(item.book_id)
    const meta = await api.book.sections(item.book_id)
    const target = meta.find((s) => s.idx === item.sec_idx)
    if (target) {
      await openSection(item.book_id, item.sec_idx)
      setFocusRange({ start: item.char_start - target.char_start, end: item.char_end - target.char_start })
    }
  }

  function kbExport(items: KbItem[]) {
    const byBook = new Map<string, KbItem[]>()
    for (const it of items) byBook.set(it.book_title, [...(byBook.get(it.book_title) ?? []), it])
    let md = `# 知识库\n\n共 ${items.length} 条，来自 ${byBook.size} 本书。\n`
    for (const [title, list] of byBook) {
      md += `\n## 《${title}》\n\n`
      for (const it of list) {
        md += `> ${it.quote.replace(/\n/g, ' ')}\n\n`
        if (it.note) md += `${it.note}\n\n`
        const tags = splitTags(it.tags)
        if (tags.length) md += tags.map((t) => `\`${t}\``).join(' ') + '\n\n'
      }
    }
    downloadText(`页边-知识库-${new Date().toISOString().slice(0, 10)}.md`, md)
  }

  function kbShare(items: KbItem[]) {
    if (!items.length) return
    const { dataUrl, width, height } = renderShareImage({
      bookTitle: items[0].book_title,
      author: '',
      items: items.slice(0, 8).map((it) => ({
        quote: it.quote,
        note: it.note ? `${it.note}\n—— 《${it.book_title}》${it.sec_title ? ' · ' + it.sec_title : ''}` : `—— 《${it.book_title}》${it.sec_title ? ' · ' + it.sec_title : ''}`,
        secTitle: ''
      }))
    })
    setShare({ url: dataUrl, w: width, h: height })
  }

  const pct = sections.length && section ? Math.round(((section.idx + 1) / sections.length) * 100) : 0
  const bookPct = book && sectionMeta ? Math.min(99, Math.round((sectionMeta.char_start / Math.max(1, book.word_count)) * 100)) : 0
  const noteCount = annotations.filter((a) => a.note?.trim()).length

  const foot = (
    <div className="chapter-end">
      <span className="ce-mark">{section && section.idx + 1 < sections.length ? '本节完' : '全书完'}</span>
      <div className="ce-actions">
        <button className="ce-btn" disabled={!section || section.idx === 0} onClick={() => bookId && section && void openSection(bookId, section.idx - 1)}>
          ← 上一节
        </button>
        <button className="ce-ai" onClick={chatSection}>
          和 AI 过一遍这一节
        </button>
        <button className="ce-btn" disabled={sumBusy} onClick={() => void makeSummary()}>
          {sumBusy ? '概括中…' : summary ? '重新概括本节' : 'AI 概括本节'}
        </button>
        <button
          className="ce-btn"
          disabled={!section || section.idx >= sections.length - 1}
          onClick={() => bookId && section && void openSection(bookId, section.idx + 1)}
        >
          下一节 →
        </button>
      </div>
      {annotations.length > 0 && (
        <button className="ce-link" onClick={() => { setTab('notes'); setPanel('notes') }}>
          这一本已经划了 {annotations.length} 条，写了 {noteCount} 条批注
        </button>
      )}
      {summary && (
        <div className="ce-summary">
          {summary.summary}
          {summary.keywords?.length > 0 && (
            <div className="kw">
              {summary.keywords.map((k) => (
                <span key={k}>{k}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
      {view === 'shelf' && (
        <Bookshelf
          books={books}
          busy={busy}
          kbCount={books.reduce((n, b) => n + (b.ann_count ?? 0), 0)}
          dueCount={dueCount}
          cardCount={cardCount}
          stats={stats}
          onOpen={(id) => void openBook(id)}
          onOpenHit={(h) => void openGlobalHit(h)}
          onImport={() => void importBooks()}
          onRemove={(b) => void removeBook(b)}
          onKb={() => void openKb()}
          onReview={openReview}
          onSettings={() => setSettingsOpen(true)}
        />
      )}

      {view === 'review' && <Review onBack={backToShelf} onOpenSource={(c) => void openCardSource(c)} />}

      {view === 'reader' && book && section && (
        <div className="reader">
          <header className="reader-top">
            <button className="text-btn" onClick={backToShelf}>
              ← 书架
            </button>
            <div className="rt-mid">
              <div className="rt-title">{book.title}</div>
              <div className="rt-sub">{section.title}</div>
            </div>
            <div className="rt-right">
              {display.paged ? (
                <span className="page-no">
                  {pageInfo.page + 1} / {pageInfo.total}
                </span>
              ) : (
                <span className="page-no">{bookPct}%</span>
              )}
            </div>
          </header>
          <div className="reader-progress" title={`全书 ${bookPct}%`}>
            <i style={{ width: `${bookPct}%` }} />
          </div>

          <aside className="rail">
            <button className="rail-btn" title="返回书架" onClick={backToShelf}>
              <Icon name="back" />
            </button>
            <div className="rail-sep" />
            <button
              className={`rail-btn ${drawer === 'toc' ? 'on' : ''}`}
              title="目录"
              onClick={() => {
                setShowDisplay(false)
                setDrawer(drawer === 'toc' ? null : 'toc')
              }}
            >
              <Icon name="toc" />
            </button>
            <button
              className={`rail-btn ${drawer === 'search' ? 'on' : ''}`}
              title="搜索"
              onClick={() => {
                setShowDisplay(false)
                if (drawer === 'search') setDrawer(null)
                else {
                  setDrawer('search')
                  window.setTimeout(() => searchRef.current?.focus(), 30)
                }
              }}
            >
              <Icon name="search" />
            </button>
            <button
              className={`rail-btn ${showDisplay ? 'on' : ''}`}
              title="排版"
              onClick={() => {
                setDrawer(null)
                setShowDisplay((v) => !v)
              }}
            >
              <Icon name="type" />
            </button>
            <button
              className={`rail-btn ${drawer === 'marks' ? 'on' : ''}`}
              title="书签"
              onClick={() => {
                setShowDisplay(false)
                setDrawer(drawer === 'marks' ? null : 'marks')
              }}
            >
              <Icon name="mark" />
            </button>
            <button
              className={`rail-btn ${speaking ? 'on' : ''}`}
              title={speaking ? '停止朗读' : '朗读本节'}
              onClick={toggleSpeak}
            >
              <Icon name={speaking ? 'stop' : 'speak'} />
            </button>
            <div className="rail-sep" />
            <button
              className={`rail-btn ${panel === 'translate' ? 'on' : ''}`}
              title="翻译与对照"
              onClick={() => {
                setShowDisplay(false)
                setPanel(panel === 'translate' ? null : 'translate')
              }}
            >
              <Icon name="lang" />
            </button>
            <button
              className={`rail-btn ${panel === 'memory' ? 'on' : ''}`}
              title="记忆：AI 记得你说过的话"
              onClick={() => {
                setShowDisplay(false)
                setPanel(panel === 'memory' ? null : 'memory')
              }}
            >
              <Icon name="memory" />
            </button>
            <button
              className={`rail-btn ${panel === 'external' ? 'on' : ''}`}
              title="书外的说法：查论文与同类研究"
              onClick={() => {
                setShowDisplay(false)
                if (panel === 'external') setPanel(null)
                else openExt(active?.quote ?? '')
              }}
            >
              <Icon name="ext" />
            </button>
            <button
              className={`rail-btn ${panel === 'notes' ? 'on' : ''}`}
              title="笔记与摘抄"
              onClick={() => {
                setShowDisplay(false)
                setPanel(panel === 'notes' ? null : 'notes')
                setTab('notes')
              }}
            >
              <Icon name="note" />
              {annotations.length > 0 && <span className="rail-badge">{annotations.length}</span>}
            </button>
            <button
              className={`rail-btn ${panel === 'chat' ? 'on' : ''}`}
              title="和 AI 讨论"
              onClick={() => {
                setShowDisplay(false)
                if (panel === 'chat') setPanel(null)
                else {
                  setTab('chat')
                  setActive(null)
                  setSecChat(null)
                  setPanel('chat')
                }
              }}
            >
              <Icon name="ai" />
            </button>
          </aside>

          <Reader
            section={section}
            meta={sectionMeta!}
            annotations={annotations}
            onAnnotate={(p, m) => void handleAnnotate(p, m)}
            onHighlight={(p, c, n) => void handleHighlight(p, c, n)}
            onOpenAnnotation={openAnnotation}
            focusRange={focusRange}
            initialScroll={initialScroll}
            onScrollPos={onScrollPos}
            paged={display.paged}
            turn={turnCmd}
            startLast={startLastRef.current}
            onPageInfo={(page, total) => setPageInfo({ page, total })}
            onEdge={edgeTurn}
            layoutKey={`${display.size}-${display.lh}-${display.width}-${display.gap}-${display.font}-${display.indent}-${display.paged}`}
            translation={trBlocks}
            bi={bi}
            onTranslateBlock={(i) => void translateOne(i)}
            onLookup={(w, s) => void lookup(w, s)}
            onLink={(href) => void openLink(href)}
            footer={foot}
          />

          {drawer && (
            <aside className="drawer">
              <div className="drawer-head">
                <div className="drawer-tabs">
                  <button className={drawer === 'toc' ? 'on' : ''} onClick={() => setDrawer('toc')}>目录</button>
                  <button className={drawer === 'search' ? 'on' : ''} onClick={() => { setDrawer('search'); window.setTimeout(() => searchRef.current?.focus(), 30) }}>搜索</button>
                  <button className={drawer === 'marks' ? 'on' : ''} onClick={() => setDrawer('marks')}>书签</button>
                </div>
                <button className="icon-btn" onClick={() => setDrawer(null)}>×</button>
              </div>

              {drawer === 'toc' && (
                <div className="drawer-body">
                  {sections.map((s) => {
                    const n = annotations.filter((a) => a.sec_idx === s.idx).length
                    return (
                      <button
                        key={s.idx}
                        className={`toc-item ${s.idx === section.idx ? 'on' : ''} ${s.level > 1 ? 'sub' : ''}`}
                        style={s.level > 1 ? { paddingLeft: 10 + (s.level - 1) * 14 } : undefined}
                        onClick={() => { void openSection(book.id, s.idx); setDrawer(null) }}
                      >
                        <span className="toc-title">{s.title}</span>
                        {n > 0 && <span className="toc-dot" title={`${n} 条划线`}>{n}</span>}
                      </button>
                    )
                  })}
                </div>
              )}

              {drawer === 'search' && (
                <div className="drawer-body">
                  <input
                    ref={searchRef}
                    className="search-input"
                    placeholder="全书检索…"
                    value={query}
                    onChange={(e) => void runSearch(e.target.value)}
                  />
                  {hits === null && <div className="drawer-hint">输入至少一个字，在当前这本书里找。</div>}
                  {hits && hits.length === 0 && <div className="drawer-hint">没有找到「{query}」。</div>}
                  {hits &&
                    hits.map((h, i) => (
                      <button key={i} className="hit-item" onClick={() => void jumpToHit(h)}>
                        <div className="hit-snippet">{h.snippet}</div>
                        <div className="hit-meta">{sections.find((s) => s.idx === h.sec_idx)?.title}</div>
                      </button>
                    ))}
                </div>
              )}

              {drawer === 'marks' && (
                <div className="drawer-body">
                  <button className="import-btn" onClick={() => void addBookmark()}>
                    ＋ 给当前这一节加书签
                  </button>
                  {bookmarks.length === 0 && <div className="drawer-hint">还没有书签。</div>}
                  {bookmarks.map((m) => (
                    <div key={m.id} className="mark-item">
                      <button className="mark-open" onClick={() => { void openSection(book.id, m.sec_idx); setDrawer(null) }}>
                        <div className="toc-title">{m.label}</div>
                        <div className="hit-meta">
                          {new Date(m.created_at).toLocaleDateString('zh-CN')} · 第 {m.sec_idx + 1} 节
                        </div>
                      </button>
                      <button className="book-del" onClick={() => void removeBookmark(m.id)}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          )}

          {showDisplay && (
            <div className="display-pop">
              <div className="pop-row">
                <span>字号</span>
                <input type="range" min={14} max={30} step={0.5} value={display.size} onChange={(e) => setDisplay({ ...display, size: Number(e.target.value) })} />
                <span className="pop-val">{display.size}</span>
              </div>
              <div className="pop-row">
                <span>行距</span>
                <input type="range" min={1.4} max={2.6} step={0.05} value={display.lh} onChange={(e) => setDisplay({ ...display, lh: Number(e.target.value) })} />
                <span className="pop-val">{display.lh.toFixed(2)}</span>
              </div>
              <div className="pop-row">
                <span>段距</span>
                <input type="range" min={0.2} max={2} step={0.1} value={display.gap} onChange={(e) => setDisplay({ ...display, gap: Number(e.target.value) })} />
                <span className="pop-val">{display.gap.toFixed(1)}</span>
              </div>
              <div className="pop-row">
                <span>字体</span>
                <div className="seg">
                  {([['serif', '宋'], ['sans', '黑'], ['kai', '楷'], ['fang', '仿'], ['system', '系统']] as const).map(([k, label]) => (
                    <button key={k} className={display.font === k ? 'on' : ''} onClick={() => setDisplay({ ...display, font: k })}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="pop-row">
                <span>底色</span>
                <div className="seg">
                  {([['paper', '纸'], ['sepia', '米'], ['green', '绿'], ['night', '夜'], ['black', '黑']] as const).map(([k, label]) => (
                    <button key={k} className={display.theme === k ? 'on' : ''} onClick={() => setDisplay({ ...display, theme: k })}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="pop-row">
                <span>版心</span>
                <div className="seg">
                  {([['narrow', '窄'], ['normal', '中'], ['wide', '宽'], ['full', '满']] as const).map(([k, label]) => (
                    <button key={k} className={display.width === k ? 'on' : ''} onClick={() => setDisplay({ ...display, width: k })}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="pop-row">
                <span>阅读</span>
                <div className="seg">
                  <button className={!display.paged ? 'on' : ''} onClick={() => setDisplay({ ...display, paged: false })}>滚动</button>
                  <button className={display.paged ? 'on' : ''} onClick={() => setDisplay({ ...display, paged: true })}>翻页</button>
                </div>
                <button className={`pop-toggle ${display.indent ? 'on' : ''}`} onClick={() => setDisplay({ ...display, indent: !display.indent })}>
                  首行缩进
                </button>
              </div>
            </div>
          )}

          {panel && panel !== 'translate' && panel !== 'memory' && (
            <>
              <div className="panel-mask" onClick={() => setPanel(null)} />
              <aside className="side-panel">
                <div className="sp-head">
                  <div className="sp-tabs">
                    <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>讨论</button>
                    <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>批注 {annotations.length || ''}</button>
                    <button className={tab === 'excerpts' ? 'on' : ''} onClick={() => setTab('excerpts')}>摘抄</button>
                  </div>
                  <button className="icon-btn" onClick={() => setPanel(null)}>×</button>
                </div>

                {tab === 'chat' &&
                  (secChat ? (
                    <ChatPanel
                      key={`sec-${secChat.secIdx}`}
                      anchor={{ id: `sec:${bookId}:${secChat.secIdx}`, quote: `这一节：${secChat.title}`, bookId: bookId!, secIdx: secChat.secIdx }}
                      initialMode={mode}
                      autoSend={autoSend}
                      onModeChange={setMode}
                    />
                  ) : active ? (
                    <ChatPanel
                      key={active.id}
                      anchor={{ id: active.id, quote: active.quote }}
                      initialMode={mode}
                      autoSend={autoSend}
                      onModeChange={setMode}
                    />
                  ) : (
                    <div className="panel-empty">
                      先划一条线，或读完整节后点「和 AI 过一遍这一节」。
                      <br />
                      <span className="dim">AI 只能看到你读过的部分。</span>
                    </div>
                  ))}

                {tab === 'notes' && (
                  <div className="notes-panel">
                    {active ? (
                      <NotePanel
                        key={active.id}
                        annotation={active}
                        secTitle={sections.find((s) => s.idx === active.sec_idx)?.title ?? ''}
                        onColor={(c) => void changeColor(active, c)}
                        onNote={(n) => void saveNote(active, n)}
                        onDelete={() => void deleteAnnotation(active)}
                        onChat={() => chatAbout(active)}
                        onShare={() => shareImage([active])}
                        onCopy={() => copyText(active.quote)}
                        onMakeCards={() => void makeCards(active)}
                      />
                    ) : (
                      <div className="drawer-hint">点正文里的高亮，或下面任意一条，就能写批注。</div>
                    )}

                    <div className="notes-list-title">全部划线 · {annotations.length}</div>
                    {annotations.length === 0 && <div className="panel-empty">还没有划线。</div>}
                    {annotations.map((a) => (
                      <div key={a.id} className={`note-row ${active?.id === a.id ? 'on' : ''}`}>
                        <button className="note-item" onClick={() => openAnnotation(a)}>
                          <div className="note-quote">
                            <span className="dot tiny" style={{ background: COLORS.find((c) => c.key === a.color)?.hex ?? '#f0d78c' }} />
                            「{a.quote.slice(0, 80)}
                            {a.quote.length > 80 ? '…' : ''}」
                          </div>
                          <div className="note-meta">
                            {sections.find((s) => s.idx === a.sec_idx)?.title ?? `第 ${a.sec_idx + 1} 节`}
                            {a.note ? ' · 有批注' : ''}
                          </div>
                        </button>
                        <button className="book-del" title="删除这条划线" onClick={() => void deleteAnnotation(a)}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'excerpts' && (
                  <ExcerptsPanel
                    annotations={annotations}
                    sections={sections}
                    onJump={openAnnotation}
                    onCopyMarkdown={(items) => copyText(markdownOf(items))}
                    onExportMarkdown={(items) => downloadText(`《${book?.title ?? '书'}》摘抄.md`, markdownOf(items))}
                    onShareImage={shareImage}
                    onDelete={(items) => void deleteMany(items)}
                  />
                )}
              </aside>
            </>
          )}

          {panel === 'translate' && bookId && (
            <>
              <div className="panel-mask" onClick={() => setPanel(null)} />
              <TranslatePanel
                bookId={bookId}
                bookTitle={book?.title ?? ''}
                bi={bi}
                onBi={setBi}
                status={trStatus}
                onRefresh={() => void refreshTr()}
                onClose={() => setPanel(null)}
              />
            </>
          )}

          {panel === 'memory' && bookId && (
            <>
              <div className="panel-mask" onClick={() => setPanel(null)} />
              <MemoryPanel
                bookId={bookId}
                bookTitle={book?.title ?? ''}
                onClose={() => setPanel(null)}
              />
            </>
          )}

          {panel === 'external' && (
            <>
              <div className="panel-mask" onClick={() => setPanel(null)} />
              <ExternalPanel seed={extSeed} onClose={() => setPanel(null)} />
            </>
          )}

          {note && (
            <div className="note-pop">
              <div className="np-head">
                <span className="np-title">{note.secTitle || '注释'}</span>
                <button className="icon-btn np-close" onClick={() => setNote(null)} title="关闭">
                  ×
                </button>
              </div>
              <div className="np-body">{note.text || '这一段没有可显示的文字。'}</div>
              <div className="np-foot">
                {section && note.secIdx !== section.idx && bookId && (
                  <button
                    className="text-btn tiny"
                    onClick={() => {
                      const idx = note.secIdx
                      setNote(null)
                      if (bookId) void openSection(bookId, idx)
                    }}
                  >
                    跳到该节
                  </button>
                )}
                <span>注释来自书内原文，不是 AI 生成的</span>
              </div>
            </div>
          )}

          {dict && (
            <div className="dict-pop" style={{ right: 84, bottom: 96 }}>
              <div className="dp-head">
                <span className="dp-word">{dict.word}</span>
                {dict.data?.pinyin && <span className="dp-pinyin">{dict.data.pinyin}</span>}
                <button className="icon-btn dp-close" onClick={() => setDict(null)} title="关闭">
                  ×
                </button>
              </div>
              <div className="dp-body">
                {dict.busy && <span className="dim">正在看它在这句话里的意思…</span>}
                {dict.data?.senses?.map((s, i) => (
                  <div key={i} className="dp-sense">
                    {s.pos && <span className="dp-pos">{s.pos}</span>}
                    <span>{s.def}</span>
                  </div>
                ))}
                {dict.data?.usage && <div className="dp-use">{dict.data.usage}</div>}
                {dict.data?.caution && <div className="dp-caution">{dict.data.caution}</div>}
              </div>
              <div className="dp-foot">AI 释义 · 非权威词典，拿不准请以原文语境为准</div>
            </div>
          )}

          {showMarks && (
            <div className="modal-mask" onClick={() => setShowMarks(false)}>
              <div className="mini-modal" onClick={(e) => e.stopPropagation()}>
                <div className="share-head">
                  <span>书签</span>
                  <button className="icon-btn" onClick={() => setShowMarks(false)}>×</button>
                </div>
                <div className="mini-body">
                  <button className="import-btn" onClick={() => void addBookmark()}>＋ 给当前这一节加书签</button>
                  {bookmarks.length === 0 && <div className="drawer-hint">还没有书签。</div>}
                  {bookmarks.map((m) => (
                    <div key={m.id} className="mark-item">
                      <button className="mark-open" onClick={() => { void openSection(book.id, m.sec_idx); setShowMarks(false) }}>
                        <div className="toc-title">{m.label}</div>
                        <div className="hit-meta">{new Date(m.created_at).toLocaleDateString('zh-CN')}</div>
                      </button>
                      <button className="book-del" onClick={() => void removeBookmark(m.id)}>×</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {kbOpen && (
        <KnowledgeBase
          items={kbItems}
          onBack={() => setKbOpen(false)}
          onOpen={(it) => void kbOpenItem(it)}
          onDelete={(it) => void kbDelete(it)}
          onTag={(it, tags) => void kbTag(it, tags)}
          onExport={kbExport}
          onShare={kbShare}
          onTagged={() => void api.annotations.all().then(setKbItems)}
          cards={kbCards}
          onMakeCard={(it) => void kbMakeCard(it)}
        />
      )}

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="mini-modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="share-head">
              <span>设置</span>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)}>×</button>
            </div>
            <div className="mini-body">
              <SettingsPanel onSaved={() => {}} />
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {share && (
        <div className="modal-mask" onClick={() => setShare(null)}>
          <div className="share-modal" onClick={(e) => e.stopPropagation()}>
            <div className="share-head">
              <span>分享图</span>
              <button className="icon-btn" onClick={() => setShare(null)}>×</button>
            </div>
            <div className="share-preview">
              <img src={share.url} alt="分享图" />
            </div>
            <div className="share-actions">
              <button
                className="primary-btn slim"
                onClick={() => downloadDataUrl(`页边-${(book?.title ?? '摘抄').slice(0, 12)}-${Date.now()}.png`, share.url)}
              >
                保存图片（{share.w}×{share.h}）
              </button>
              <button className="ghost-btn" onClick={() => setShare(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function colorLabel(key: string): string {
  return COLORS.find((c) => c.key === key)?.label ?? '重点'
}

function Icon({ name }: { name: 'back' | 'toc' | 'search' | 'type' | 'mark' | 'note' | 'ai' | 'lang' | 'memory' | 'speak' | 'stop' | 'ext' }) {
  const common = {
    width: 19,
    height: 19,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  if (name === 'back') return <svg {...common}><path d="M15 5 8 12l7 7" /></svg>
  if (name === 'toc') return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
  if (name === 'type') return <svg {...common}><path d="M5 6V4h14v2M12 4v16M9 20h6" /></svg>
  if (name === 'mark') return <svg {...common}><path d="M7 4h10v16l-5-4-5 4z" /></svg>
  if (name === 'note') return <svg {...common}><path d="M5 6h14M5 11h14M5 16h9" /></svg>
  if (name === 'lang') return <svg {...common}><path d="M4 6h9M8.5 6v1.5c0 3.5-2 6.5-4.5 8M6 10c.8 2.4 2.6 4.2 5 5" /><path d="m12.5 20 4-10 4 10M14 17h5" /></svg>
  if (name === 'memory') return <svg {...common}><path d="M12 4a4 4 0 0 1 4 4v1a3.5 3.5 0 0 1 0 7 4 4 0 0 1-8 0 3.5 3.5 0 0 1 0-7V8a4 4 0 0 1 4-4z" /><path d="M12 4v16" /><path d="M9.2 8.4h.01M14.8 8.4h.01M9.6 14.6h.01M14.4 14.6h.01" /></svg>
  if (name === 'speak') return <svg {...common}><path d="M4 10v4h3l5 4V6L7 10H4z" /><path d="M16 8.5c1.6 1.6 1.6 5.4 0 7M18.8 6c2.8 2.8 2.8 9.2 0 12" /></svg>
  if (name === 'stop') return <svg {...common}><rect x="6.5" y="6.5" width="11" height="11" rx="2" /></svg>
  if (name === 'ext') return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M4.5 9.5h15M4.5 14.5h15M12 4c-2.2 2.2-3.2 5-3.2 8s1 5.8 3.2 8c2.2-2.2 3.2-5 3.2-8s-1-5.8-3.2-8z" /></svg>
  return (
    <svg {...common}>
      <path d="M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9z" />
      <path d="M18.5 16.5v4M16.5 18.5h4" />
    </svg>
  )
}