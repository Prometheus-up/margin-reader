import { readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import * as db from './core/db'
import { parseEpub } from './core/epub'
import { parsePlainText, splitNameAuthor } from './core/txt'
import { parseDocx } from './core/docx'
import { parseMobi } from './core/mobi'
import { parsePdf } from './core/pdf'
import { buildContext, type SectionLite } from './core/context'
import { buildSystemPrompt, buildFirstUserMessage, MODE_LABEL, type DiscussionMode } from './core/prompts'
import { complete, loadModelConfig, loadProfile, testModel, cleanupSessions, PRESETS, OPENCODE_MODELS, DEFAULT_OPENCODE_CLI, type ChatMsg } from './core/ai'
import * as tr from './core/translate'
import { schedule, type Grade } from './core/srs'
import { generateCards, summarizeSection } from './core/study'
import { searchExternal } from './core/external'
import { lookupWord, autoTag } from './core/lookup'
import { resolveAnchor } from './core/anchors'

export type Handler = (...args: any[]) => any

function loadSections(bookId: string): SectionLite[] {
  return db.listSections(bookId).map((s) => {
    const full = db.getSection(bookId, s.idx)!
    return { idx: s.idx, title: s.title, charStart: s.char_start, charEnd: s.char_end, blocks: full.blocks, text: full.text }
  })
}

/** 中文 txt 常常是 GBK，先按 UTF-8 严格解，失败再退 GBK */
export function decodeTextFile(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return new TextDecoder('utf-8').decode(buf)
    }
  }
}

export interface ImportResult {
  imported: Array<{ id: string; title: string }>
  failed: Array<{ file: string; error: string }>
}

/** 当前正在做的 OCR（扫描件导入可能要好几分钟，界面据此显示进度） */
let ocrLive: { name: string; done: number; total: number; at: number } | null = null

/** 返回 OCR 进度；超过 15 秒没有新进展就当结束了 */
export function ocrProgress(): { name: string; done: number; total: number } | null {
  if (!ocrLive || Date.now() - ocrLive.at > 15000) return null
  return { name: ocrLive.name, done: ocrLive.done, total: ocrLive.total }
}

/** 解析并入库；filePath 只作记录（网页版传的是上传文件名） */
export async function importOne(
  fileName: string,
  filePath: string,
  data: Uint8Array,
  reuseId?: string
): Promise<{ id: string; title: string }> {
  const ext = extname(fileName).toLowerCase().replace('.', '')
  let parsed
  if (ext === 'epub') parsed = parseEpub(data)
  else if (ext === 'docx') parsed = parseDocx(data)
  else if (ext === 'mobi' || ext === 'azw3' || ext === 'azw') parsed = parseMobi(data)
  else if (ext === 'pdf') {
    // 扫描件要逐页 OCR，耗时可能几分钟；按页打进度，便于在日志里看到卡在哪
    let lastLog = 0
    const short = basename(fileName)
    parsed = await parsePdf(data, {
      onProgress: (done, tot) => {
        const now = Date.now()
        ocrLive = { name: short, done, total: tot, at: now }
        if (done === 1 || done === tot || now - lastLog > 20000) {
          lastLog = now
          console.log(`[ocr] ${short} ${done}/${tot}`)
        }
      }
    })
    ocrLive = null
  }
  else if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    parsed = parsePlainText(decodeTextFile(data), fileName, ext === 'md' ? 'md' : 'txt')
  } else {
    throw new Error(`暂不支持 .${ext}`)
  }

  // 元数据兜底：书名/作者常写在文件名里（「绝世唐门 作者：唐家三少.txt」）
  const fromName = splitNameAuthor(basename(fileName))
  if (!parsed.author && fromName.author) parsed.author = fromName.author
  if ((!parsed.title || /^未命名/.test(parsed.title) || parsed.title === basename(fileName)) && fromName.title) parsed.title = fromName.title
  // reuseId：解析器升级后重建老书，保留 id，划线与卡片不丢
  const id = reuseId ? (db.replaceBookContent(reuseId, filePath, ext, parsed), reuseId) : db.insertBook(filePath, ext, parsed)
  return { id, title: parsed.title }
}

export async function importPaths(paths: string[]): Promise<ImportResult> {
  const imported: Array<{ id: string; title: string }> = []
  const failed: Array<{ file: string; error: string }> = []
  for (const file of paths) {
    try {
      const buf = readFileSync(file)
      imported.push(await importOne(basename(file), file, new Uint8Array(buf)))
    } catch (e: any) {
      failed.push({ file: basename(file), error: e?.message ?? String(e) })
    }
  }
  return { imported, failed }
}

export const handlers: Record<string, Handler> = {
  'books:list': () => db.listBooks(),
  'books:progress': () => ocrProgress(),
  'books:delete': (id: string) => {
    db.deleteBook(id)
    return true
  },

  'book:sections': (bookId: string) => db.listSections(bookId),
  'book:section': (bookId: string, idx: number) => {
    const row = db.getSection(bookId, idx)
    if (!row) return null
    return { idx: row.idx, title: row.title, blocks: row.blocks }
  },
  'book:meta': (bookId: string) => db.getBook(bookId),
  'book:search': (bookId: string, query: string) => db.searchBook(bookId, query),
  'book:outline': (bookId: string) =>
    db.listSections(bookId).map((s) => ({ idx: s.idx, title: s.title, char_start: s.char_start })),

  'ann:list': (bookId: string) => db.listAnnotations(bookId),
  'ann:all': () => db.listAllAnnotations(),
  'ann:create': (payload: any) => db.createAnnotation(payload),
  'ann:update': (id: string, patch: any) => {
    db.updateAnnotation(id, patch)
    if (patch?.note !== undefined) {
      const ann = db.listAllAnnotations(5000).find((a) => a.id === id)
      if (ann) {
        if (String(patch.note).trim()) {
          db.upsertMemory({
            book_id: ann.book_id,
            kind: 'note',
            text: String(patch.note),
            source: ann.sec_title ?? '',
            ref_id: id
          })
        } else {
          db.deleteMemoryByRef(id, 'note')
        }
      }
    }
    return true
  },
  'ann:delete': (id: string) => {
    db.deleteAnnotation(id)
    return true
  },

  'bm:list': (bookId: string) => db.listBookmarks(bookId),
  'bm:create': (payload: any) => db.createBookmark(payload),
  'bm:delete': (id: string) => {
    db.deleteBookmark(id)
    return true
  },

  'progress:get': (bookId: string) => db.getProgress(bookId),
  'progress:set': (bookId: string, secIdx: number, percent: number) => {
    db.setProgress(bookId, secIdx, percent)
    return true
  },

  'settings:get': (key: string, fallback?: string) => db.getSetting(key, fallback ?? ''),
  'settings:set': (key: string, value: string) => {
    db.setSetting(key, value)
    return true
  },

  'chat:history': (annotationId: string, mode: DiscussionMode) => {
    const thread = db
      .getDb()
      .prepare('SELECT id FROM threads WHERE annotation_id = ? AND mode = ? ORDER BY created_at DESC LIMIT 1')
      .get(annotationId, mode) as any
    if (!thread) return []
    return db
      .getDb()
      .prepare('SELECT role, content, sources, created_at FROM messages WHERE thread_id = ? ORDER BY created_at')
      .all(thread.id)
      .map((m: any) => ({ ...m, sources: JSON.parse(m.sources || '[]') }))
  },

  'chat:send': async (payload: {
    annotationId?: string
    bookId?: string
    secIdx?: number
    mode: DiscussionMode
    text?: string
  }) => {
    const conn = db.getDb()
    let ann: any = null
    if (payload.annotationId) {
      ann = conn.prepare('SELECT * FROM annotations WHERE id = ?').get(payload.annotationId)
      if (!ann) throw new Error('划线记录不存在')
    } else if (payload.bookId !== undefined && payload.secIdx !== undefined) {
      // 章节级讨论：锚点在本节末尾，等于“你已读完这一节”
      const secs = loadSections(payload.bookId)
      const sec = secs.find((s) => s.idx === payload.secIdx)
      if (!sec) throw new Error('章节不存在')
      ann = {
        id: `sec:${payload.bookId}:${payload.secIdx}`,
        book_id: payload.bookId,
        sec_idx: payload.secIdx,
        global_pos: sec.charEnd,
        quote: ''
      }
    } else {
      throw new Error('缺少讨论锚点')
    }
    const book = db.getBook(ann.book_id)
    if (!book) throw new Error('书籍不存在')

    const sections = loadSections(ann.book_id)
    const retrieved = db.searchBefore(ann.book_id, ann.quote, ann.global_pos, 5)
    const notes = db
      .listAnnotations(ann.book_id)
      .filter((a) => a.global_pos < ann.global_pos && a.note)
      .map((a) => ({ pos: a.global_pos, quote: a.quote, note: a.note }))

    let thread = conn
      .prepare('SELECT id FROM threads WHERE annotation_id = ? AND mode = ? ORDER BY created_at DESC LIMIT 1')
      .get(ann.id, payload.mode) as any
    if (!thread) {
      const id = crypto.randomUUID()
      conn
        .prepare('INSERT INTO threads (id, annotation_id, mode, model, created_at) VALUES (?,?,?,?,?)')
        .run(id, ann.id, payload.mode, loadModelConfig().model, Date.now())
      thread = { id }
    }

    // 长期记忆：读者在这本书上说过的其他话（不含当前这条讨论本身）
    const memories = db.listMemoryForContext(ann.book_id, 12)

    const ctx = buildContext({
      sections,
      globalPos: ann.global_pos,
      quote: ann.quote,
      retrieved: retrieved.map((r) => ({ secIdx: r.sec_idx, start: r.char_start, end: r.char_end, text: r.text })),
      notes,
      utterances: memories
    })

    const history: ChatMsg[] = (
      conn.prepare('SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at').all(thread.id) as any[]
    ).map((m) => ({ role: m.role, content: m.content }))

    const firstTurn = history.length === 0
    const userContent = firstTurn ? buildFirstUserMessage(ctx.contextText, payload.text) : (payload.text ?? '')

    const messages: ChatMsg[] = [
      { role: 'system', content: buildSystemPrompt(payload.mode, book.title) },
      ...history,
      { role: 'user', content: userContent }
    ]

    conn
      .prepare('INSERT INTO messages (id, thread_id, role, content, sources, created_at) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), thread.id, 'user', payload.text ?? `【${MODE_LABEL[payload.mode]}】`, '[]', Date.now())

    // 顺手沉淀成记忆：读者自己说过的话，跨划线、跨会话都能被再次想起
    if ((payload.text ?? '').trim()) {
      const secTitle = sections.find((s) => s.idx === ann.sec_idx)?.title ?? ''
      db.upsertMemory({
        book_id: ann.book_id,
        kind: 'thought',
        text: payload.text!,
        source: secTitle,
        ref_id: thread.id
      })
    }

    const reply = await complete(messages, loadModelConfig(), payload.mode)

    const sources = firstTurn ? ctx.sources : []
    conn
      .prepare('INSERT INTO messages (id, thread_id, role, content, sources, created_at) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), thread.id, 'assistant', reply, JSON.stringify(sources), Date.now())

    return { reply, sources, stats: ctx.stats, threadId: thread.id }
  },

  'mem:list': (bookId: string) => db.listMemory(bookId),
  'mem:all': () => db.listAllMemory(),
  'mem:count': (bookId?: string) => db.countMemory(bookId),
  'mem:update': (id: string, text: string) => {
    db.updateMemory(id, text)
    return true
  },
  'mem:delete': (id: string) => {
    db.deleteMemory(id)
    return true
  },

  /* ---------------- 全库检索与阅读统计 ---------------- */
  'book:searchAll': (q: string, limit?: number) => db.searchAll(q, limit ?? 50),
  'backup:export': () => {
    const dir = join(homedir(), 'Desktop')
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const file = join(dir, `页边备份-${stamp}.db`)
    db.backupTo(file)
    return { path: file }
  },
  'stats:get': () => db.getReadingStats(),
  'stats:add': (seconds: number) => {
    const d = new Date()
    const key = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
    db.addReading(key, seconds)
    return true
  },

  /* ---------------- 复习卡片 ---------------- */
  'card:list': (bookId?: string) => db.listCards(bookId),
  'card:due': (limit?: number) => db.listDueCards(limit ?? 40),
  'card:counts': () => db.countCards(),
  'card:update': (id: string, patch: any) => {
    db.updateCard(id, patch)
    return true
  },
  'card:delete': (id: string) => {
    db.deleteCard(id)
    return true
  },

  /** 让 AI 从一条划线生成卡片；返回新建的卡片 */
  'card:generate': async (annotationId: string) => {
    const conn = db.getDb()
    const ann = conn.prepare('SELECT * FROM annotations WHERE id = ?').get(annotationId) as any
    if (!ann) throw new Error('划线不存在')
    const book = db.getBook(ann.book_id)
    const sec = db.getSection(ann.book_id, ann.sec_idx)
    if (!book || !sec) throw new Error('书籍或章节不存在')

    // 只给划线之前的正文——和讨论一样，不让 AI 拿到后文
    const localOffset = Math.max(0, ann.global_pos - sec.char_start)
    const context = sec.text.slice(0, localOffset).slice(-1200)
    const secTitle = sec.title

    const cards = await generateCards(
      { bookTitle: book.title, secTitle, quote: ann.quote, note: ann.note, context },
      loadModelConfig()
    )
    return cards.map((c) => db.createCard({ annotation_id: annotationId, front: c.front, back: c.back, tags: ann.tags }))
  },

  /** 复习评分：0 忘了 / 1 有点印象 / 2 记得 / 3 很熟 */
  'card:review': (id: string, grade: Grade) => {
    const card = db.getCard(id)
    if (!card) throw new Error('卡片不存在')
    const now = Date.now()
    const next = schedule(
      { stability: card.stability, difficulty: card.difficulty, reps: card.reps, lapses: card.lapses, state: card.state },
      grade,
      now
    )
    db.saveCardReview(id, next)
    return { due_at: next.due_at, intervalDays: next.intervalDays, state: next.state }
  },

  /* ---------------- 章节摘要 ---------------- */
  'sec:summary': async (bookId: string, secIdx: number, force = false) => {
    if (!force) {
      const cached = db.getSectionSummary(bookId, secIdx)
      if (cached.summary) return { summary: cached.summary, keywords: cached.keywords, cached: true }
    }
    const book = db.getBook(bookId)
    const sec = db.getSection(bookId, secIdx)
    if (!book || !sec) throw new Error('章节不存在')
    const out = await summarizeSection({ bookTitle: book.title, secTitle: sec.title, text: sec.text }, loadModelConfig())
    db.setSectionSummary(bookId, secIdx, out.summary, out.keywords)
    return { ...out, cached: false }
  },

  /* ---------------- AI 通道 ---------------- */
  'ai:test': (which?: 'main' | 'review') => testModel(loadProfile(which ?? 'main')),
  'ai:presets': () => PRESETS,
  'ai:opencode': () => ({ models: OPENCODE_MODELS, cli: DEFAULT_OPENCODE_CLI }),

  /** 书内链接 / 脚注：把 href 解析成可展示的结果 */
  'book:anchor': (bookId: string, secIdx: number, href: string) => resolveAnchor(bookId, secIdx, href),

  /* ---------------- 书外知识 / 释义 / 标签 ---------------- */
  'ext:search': (q: string, limit?: number) => searchExternal(q, limit ?? 8),
  'dict:lookup': (word: string, sentence: string) => lookupWord(word, sentence),
  'kb:autotag': async (bookId?: string) => {
    const all = db.listAllAnnotations(2000).filter((a) => (!bookId || a.book_id === bookId) && !String(a.tags ?? '').trim())
    const picked = all.slice(0, 24)
    if (!picked.length) return { updated: 0, tags: [] as string[] }
    const rows = await autoTag(picked.map((a) => ({ id: a.id, quote: a.quote, note: a.note })))
    let updated = 0
    for (const r of rows) {
      if (!r.tags.length) continue
      db.updateAnnotation(r.id, { tags: r.tags.join(',') })
      updated += 1
    }
    return { updated, tags: db.listAllAnnotations(2000).filter((a) => !bookId || a.book_id === bookId).flatMap((a) => String(a.tags ?? '').split(/[,，、\s]+/).filter(Boolean)) }
  },
  'ai:cleanup': () => cleanupSessions(),

  /* ---------------- 翻译流水线 ---------------- */
  'tr:config': () => tr.loadConfig(),
  'tr:config:set': (patch: any) => tr.saveConfig(patch),
  'tr:stages': () => tr.STAGES,
  'tr:langs': () => tr.LANGS,
  'tr:status': (bookId: string) => tr.status(bookId),
  'tr:start': async (bookId: string, targetLang?: string) => {
    const job = await tr.startJob(bookId, targetLang)
    return job
  },
  'tr:pause': (bookId: string) => {
    tr.pauseJob(bookId)
    return true
  },
  'tr:reset': (bookId: string) => {
    tr.pauseJob(bookId)
    db.deleteTranslations(bookId)
    return true
  },
  'tr:section': (bookId: string, secIdx: number) => tr.getSectionTranslations(bookId, secIdx),
  'tr:block': (bookId: string, secIdx: number, blockI: number) => tr.translateBlock(bookId, secIdx, blockI),
  'tr:glossary': (bookId: string) => db.listGlossary(bookId),
  'tr:glossary:set': (bookId: string, src: string, dst: string, note?: string) => {
    db.setGlossaryItem(bookId, src, dst, note ?? '')
    return true
  },
  'tr:glossary:delete': (bookId: string, src: string) => {
    db.deleteGlossaryItem(bookId, src)
    return true
  },
  'tr:glossary:build': async (bookId: string) => {
    const items = await tr.buildGlossary(bookId)
    for (const it of items) db.setGlossaryItem(bookId, it.src, it.dst)
    return db.listGlossary(bookId)
  }
}
