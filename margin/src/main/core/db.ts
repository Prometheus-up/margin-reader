import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Block } from './text'
import type { ParsedBook } from './epub'

export interface BookRow {
  id: string
  title: string
  author: string
  format: string
  path: string
  lang: string
  word_count: number
  sec_count: number
  added_at: number
  cover?: string
  progress_pct?: number
  progress_sec?: number
  ann_count?: number
}

export interface SectionRow {
  book_id: string
  idx: number
  title: string
  /** 目录层级：1=部/卷，2=章，3=节 */
  level: number
  href: string
  char_start: number
  char_end: number
  blocks: Block[]
  text: string
}

export interface AnnotationRow {
  id: string
  book_id: string
  sec_idx: number
  char_start: number
  char_end: number
  global_pos: number
  quote: string
  prefix: string
  suffix: string
  note: string
  color: string
  tags: string
  created_at: number
}

/** 知识库条目：划线 + 所属书 */
export interface KbItem extends AnnotationRow {
  book_title: string
  book_author: string
  sec_title: string
}

let db: DatabaseSync | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL, path TEXT NOT NULL, lang TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0, sec_count INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL, cover TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sections (
  book_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, href TEXT NOT NULL DEFAULT '',
  char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, blocks TEXT NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (book_id, idx)
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, sec_idx INTEGER NOT NULL,
  char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_book ON chunks(book_id, char_end);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, sec_idx INTEGER NOT NULL,
  char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, global_pos INTEGER NOT NULL,
  quote TEXT NOT NULL, prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'yellow', tags TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_book ON annotations(book_id, global_pos);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL, mode TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL, front TEXT NOT NULL, back TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '', due_at INTEGER NOT NULL, stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS progress (
  book_id TEXT PRIMARY KEY, sec_idx INTEGER NOT NULL, percent REAL NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, sec_idx INTEGER NOT NULL,
  global_pos INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS summaries (
  book_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, idx)
);
CREATE TABLE IF NOT EXISTS translations (
  book_id TEXT NOT NULL, sec_idx INTEGER NOT NULL, block_i INTEGER NOT NULL,
  src_hash TEXT NOT NULL, text TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0,
  stage INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, sec_idx, block_i)
);
CREATE TABLE IF NOT EXISTS glossary (
  book_id TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, PRIMARY KEY (book_id, src)
);
CREATE TABLE IF NOT EXISTS tr_jobs (
  book_id TEXT PRIMARY KEY, target_lang TEXT NOT NULL, state TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
  cursor_sec INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'thought',
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_book ON memory(book_id, created_at);

CREATE TABLE IF NOT EXISTS reading_log (
  day TEXT PRIMARY KEY,
  seconds INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0
);
`

export function initDatabase(file: string): DatabaseSync {
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** 轻量迁移：老库补列 */
function migrate(conn: DatabaseSync): void {
  const cols = conn.prepare('PRAGMA table_info(annotations)').all() as unknown as { name: string }[]
  if (!cols.some((c) => c.name === 'tags')) {
    conn.exec("ALTER TABLE annotations ADD COLUMN tags TEXT NOT NULL DEFAULT ''")
  }
  const bookCols = conn.prepare('PRAGMA table_info(books)').all() as unknown as { name: string }[]
  if (!bookCols.some((c) => c.name === 'cover')) {
    conn.exec("ALTER TABLE books ADD COLUMN cover TEXT NOT NULL DEFAULT ''")
  }
  const secCols = conn.prepare('PRAGMA table_info(sections)').all() as unknown as { name: string }[]
  if (!secCols.some((c) => c.name === 'level')) {
    conn.exec('ALTER TABLE sections ADD COLUMN level INTEGER NOT NULL DEFAULT 1')
  }
  backfillMemory(conn)
}

/**
 * 老数据回填：把已有的批注和讨论发言一次性搬进 memory 表。
 * 用 settings 里的标记避免重复执行。
 */
function backfillMemory(conn: DatabaseSync): void {
  const done = conn.prepare("SELECT value FROM settings WHERE key = 'memory.backfilled'").get() as
    | { value: string }
    | undefined
  if (done?.value === '1') return

  const now = Date.now()
  const ins = conn.prepare(
    'INSERT OR IGNORE INTO memory (id, book_id, kind, text, source, ref_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  )

  const anns = conn
    .prepare(
      `SELECT a.id, a.book_id, a.note, a.created_at,
              (SELECT title FROM sections s WHERE s.book_id = a.book_id AND s.idx = a.sec_idx) AS sec_title
       FROM annotations a WHERE TRIM(a.note) <> ''`
    )
    .all() as unknown as { id: string; book_id: string; note: string; created_at: number; sec_title: string | null }[]
  for (const a of anns) {
    ins.run(`ann:${a.id}`, a.book_id, 'note', a.note.trim(), a.sec_title ?? '', a.id, a.created_at || now, now)
  }

  const msgs = conn
    .prepare(
      `SELECT m.id, m.content, m.created_at, t.annotation_id FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.role = 'user' AND TRIM(m.content) <> ''`
    )
    .all() as unknown as { id: string; content: string; created_at: number; annotation_id: string }[]
  for (const m of msgs) {
    // 自动首轮留下的占位消息（形如「【顺着作者想】」）不是读者说的话，跳过
    const text = m.content.trim()
    if (/^【[^】]*】$/.test(text)) continue
    const bookId = resolveThreadBook(conn, m.annotation_id)
    if (!bookId) continue
    const secTitle = resolveThreadSecTitle(conn, m.annotation_id, bookId)
    ins.run(`msg:${m.id}`, bookId, 'thought', text, secTitle, m.annotation_id, m.created_at || now, now)
  }

  conn.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('memory.backfilled', '1')").run()
}

/** thread 的 annotation_id 可能是划线 id，也可能是 sec:<bookId>:<idx> */
function resolveThreadBook(conn: DatabaseSync, annotationId: string): string | null {
  if (annotationId.startsWith('sec:')) return annotationId.split(':')[1] || null
  const row = conn.prepare('SELECT book_id FROM annotations WHERE id = ?').get(annotationId) as
    | { book_id: string }
    | undefined
  return row?.book_id ?? null
}

/** 找到 thread 对应的章节标题（用于记忆条的来源标注） */
function resolveThreadSecTitle(conn: DatabaseSync, annotationId: string, bookId: string): string {
  try {
    if (annotationId.startsWith('sec:')) {
      const idx = Number(annotationId.split(':')[2])
      const row = conn.prepare('SELECT title FROM sections WHERE book_id = ? AND idx = ?').get(bookId, idx) as
        | { title: string }
        | undefined
      return row?.title ?? ''
    }
    const row = conn
      .prepare(
        'SELECT s.title AS t FROM annotations a JOIN sections s ON s.book_id = a.book_id AND s.idx = a.sec_idx WHERE a.id = ?'
      )
      .get(annotationId) as { t: string } | undefined
    return row?.t ?? ''
  } catch {
    return ''
  }
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

/** node:sqlite 没有内置事务包装，这里手动 BEGIN/COMMIT */
export function tx<T>(fn: (conn: DatabaseSync) => T): T {
  const conn = getDb()
  conn.exec('BEGIN')
  try {
    const out = fn(conn)
    conn.exec('COMMIT')
    return out
  } catch (e) {
    conn.exec('ROLLBACK')
    throw e
  }
}

export function closeDatabase(): void {
  db?.close()
  db = null
}

/* ---------------- 书籍 ---------------- */

export function insertBook(filePath: string, format: string, parsed: ParsedBook): string {
  const conn = getDb()
  const id = randomUUID()
  const wordCount = parsed.sections.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0)

  const insBook = conn.prepare(`INSERT INTO books
    (id, title, author, format, path, lang, word_count, sec_count, added_at, cover)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
  const insSec = conn.prepare(`INSERT INTO sections
    (book_id, idx, title, level, href, char_start, char_end, blocks, text) VALUES (?,?,?,?,?,?,?,?,?)`)
  const insChunk = conn.prepare(`INSERT INTO chunks
    (book_id, sec_idx, char_start, char_end, text) VALUES (?,?,?,?,?)`)

  let cursor = 0
  tx(() => {
    insBook.run(
      id,
      parsed.title,
      parsed.author,
      format,
      filePath,
      parsed.lang,
      wordCount,
      parsed.sections.length,
      Date.now(),
      parsed.cover ?? ''
    )
    for (const sec of parsed.sections) {
      const start = cursor
      const end = start + sec.text.length
      cursor = end + 1
      insSec.run(id, sec.idx, sec.title, sec.level ?? 1, sec.href, start, end, JSON.stringify(sec.blocks), sec.text)
      // 检索切块：约 600 字一块，块边界对齐段落
      let buf: string[] = []
      let bufStart = start
      let len = 0
      for (const b of sec.blocks) {
        if (len > 0 && len + b.text.length > 600) {
          insChunk.run(id, sec.idx, bufStart, bufStart + len, buf.join('\n'))
          buf = []
          len = 0
          bufStart = start + b.start
        }
        buf.push(b.text)
        len += b.text.length + 1
      }
      if (buf.length) insChunk.run(id, sec.idx, bufStart, bufStart + len, buf.join('\n'))
    }
  })
  return id
}

/**
 * 重导同一本书：保留 book id（划线、卡片、阅读进度都不丢），整体替换正文与分节。
 * 用于解析器升级之后把老书按新规则重建。
 */
export function replaceBookContent(id: string, filePath: string, format: string, parsed: ParsedBook): void {
  const conn = getDb()
  const wordCount = parsed.sections.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0)
  const delSec = conn.prepare('DELETE FROM sections WHERE book_id = ?')
  const delChunk = conn.prepare('DELETE FROM chunks WHERE book_id = ?')
  const insSec = conn.prepare(`INSERT INTO sections
    (book_id, idx, title, level, href, char_start, char_end, blocks, text) VALUES (?,?,?,?,?,?,?,?,?)`)
  const insChunk = conn.prepare(`INSERT INTO chunks
    (book_id, sec_idx, char_start, char_end, text) VALUES (?,?,?,?,?)`)
  const upd = conn.prepare(`UPDATE books SET title = ?, author = ?, format = ?, path = ?,
    lang = ?, word_count = ?, sec_count = ?, cover = ? WHERE id = ?`)

  let cursor = 0
  tx(() => {
    delSec.run(id)
    delChunk.run(id)
    upd.run(
      parsed.title,
      parsed.author,
      format,
      filePath,
      parsed.lang,
      wordCount,
      parsed.sections.length,
      parsed.cover ?? '',
      id
    )
    for (const sec of parsed.sections) {
      const start = cursor
      const end = start + sec.text.length
      cursor = end + 1
      insSec.run(id, sec.idx, sec.title, sec.level ?? 1, sec.href, start, end, JSON.stringify(sec.blocks), sec.text)
      let buf: string[] = []
      let bufStart = start
      let len = 0
      for (const b of sec.blocks) {
        if (len > 0 && len + b.text.length > 600) {
          insChunk.run(id, sec.idx, bufStart, bufStart + len, buf.join('\n'))
          buf = []
          len = 0
          bufStart = start + b.start
        }
        buf.push(b.text)
        len += b.text.length + 1
      }
      if (buf.length) insChunk.run(id, sec.idx, bufStart, bufStart + len, buf.join('\n'))
    }
  })
}

export function listBooks(): BookRow[] {
  // 带上阅读进度，书架直接显示读到哪
  return getDb()
    .prepare(`SELECT b.*, COALESCE(p.percent, 0) AS progress_pct, COALESCE(p.sec_idx, 0) AS progress_sec,
        (SELECT COUNT(*) FROM annotations a WHERE a.book_id = b.id) AS ann_count
      FROM books b LEFT JOIN progress p ON p.book_id = b.id
      ORDER BY COALESCE(p.updated_at, b.added_at) DESC`)
    .all() as unknown as BookRow[]
}

export function getBook(id: string): BookRow | undefined {
  return getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined
}

export function deleteBook(id: string): void {
  tx((conn) => {
    conn.prepare('DELETE FROM sections WHERE book_id = ?').run(id)
    conn.prepare('DELETE FROM chunks WHERE book_id = ?').run(id)
    conn.prepare('DELETE FROM annotations WHERE book_id = ?').run(id)
    conn.prepare('DELETE FROM translations WHERE book_id = ?').run(id)
    conn.prepare('DELETE FROM glossary WHERE book_id = ?').run(id)
    conn.prepare('DELETE FROM tr_jobs WHERE book_id = ?').run(id)
    conn.prepare('DELETE FROM books WHERE id = ?').run(id)
  })
}

export function getSection(bookId: string, idx: number): SectionRow | null {
  const row = getDb().prepare('SELECT * FROM sections WHERE book_id = ? AND idx = ?').get(bookId, idx) as any
  if (!row) return null
  return { ...row, blocks: JSON.parse(row.blocks) }
}

export function listSections(bookId: string): Array<Pick<SectionRow, 'idx' | 'title' | 'level' | 'char_start' | 'char_end'>> {
  return getDb()
    .prepare('SELECT idx, title, level, char_start, char_end FROM sections WHERE book_id = ? ORDER BY idx')
    .all(bookId) as any
}

/** 章节路径（EPUB 的 href），用于把「notes.xhtml#fn1」这类链接解析到具体节 */
export function listSectionPaths(bookId: string): Array<{ idx: number; title: string; href: string }> {
  return getDb().prepare('SELECT idx, title, href FROM sections WHERE book_id = ? ORDER BY idx').all(bookId) as any
}

/**
 * 按锚点 id 找块：先看指定的节，再看全书。
 * 用 JSON1 的 json_each 遍历 blocks，比在 JSON 文本里做 LIKE 更准。
 */
export function findBlockByAnchor(
  bookId: string,
  anchor: string,
  preferIdx = 0
): { idx: number; title: string; text: string; anchor: string } | null {
  const rows = getDb()
    .prepare(
      `SELECT s.idx AS idx, s.title AS title, s.blocks AS blocks
         FROM sections s, json_each(s.blocks) AS j
        WHERE s.book_id = ? AND json_extract(j.value, '$.anchor') = ?
        ORDER BY ABS(s.idx - ?), s.idx
        LIMIT 8`
    )
    .all(bookId, anchor, preferIdx) as any[]
  for (const row of rows) {
    let blocks: any[] = []
    try {
      blocks = JSON.parse(String(row.blocks ?? '[]'))
    } catch {
      continue
    }
    const hit = blocks.find((b) => b && b.anchor === anchor)
    if (hit) return { idx: Number(row.idx), title: String(row.title ?? ''), text: String(hit.text ?? ''), anchor }
  }
  return null
}

/* ---------------- 检索（只允许前文） ---------------- */

export function searchBefore(
  bookId: string,
  query: string,
  beforePos: number,
  limit = 5
): Array<{ sec_idx: number; char_start: number; char_end: number; text: string; score: number }> {
  const terms = extractTerms(query)
  if (terms.length === 0) return []
  const patterns = terms.map((t) => `%${t.replace(/[%_]/g, '')}%`)
  const where = patterns.map(() => 'text LIKE ?').join(' OR ')
  const rows = getDb()
    .prepare(`SELECT sec_idx, char_start, char_end, text FROM chunks
              WHERE book_id = ? AND char_end <= ? AND (${where}) LIMIT 400`)
    .all(bookId, beforePos, ...patterns) as any[]

  const scored = rows.map((r) => {
    let score = 0
    for (const t of terms) if (r.text.includes(t)) score += 1
    return { ...r, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** 从划线文本里抽检索词：中文取 2 字滑窗，英文取单词 */
export function extractTerms(s: string): string[] {
  const clean = s.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim()
  const out = new Set<string>()
  for (const part of clean.split(' ')) {
    if (!part) continue
    if (/^[\x00-\x7F]+$/.test(part)) {
      if (part.length >= 3) out.add(part)
      continue
    }
    for (let i = 0; i + 2 <= part.length; i++) out.add(part.slice(i, i + 2))
    if (part.length <= 6) out.add(part)
  }
  return Array.from(out).slice(0, 24)
}

/* ---------------- 划线 ---------------- */

export function createAnnotation(a: Omit<AnnotationRow, 'id' | 'created_at' | 'tags'> & { tags?: string }): AnnotationRow {
  const row: AnnotationRow = { ...a, tags: a.tags ?? '', id: randomUUID(), created_at: Date.now() }
  getDb()
    .prepare(`INSERT INTO annotations
      (id, book_id, sec_idx, char_start, char_end, global_pos, quote, prefix, suffix, note, color, tags, created_at)
      VALUES (@id, @book_id, @sec_idx, @char_start, @char_end, @global_pos, @quote, @prefix, @suffix, @note, @color, @tags, @created_at)`)
    .run(row as any)
  return row
}

export function listAnnotations(bookId: string): AnnotationRow[] {
  return getDb()
    .prepare('SELECT * FROM annotations WHERE book_id = ? ORDER BY global_pos')
    .all(bookId) as unknown as AnnotationRow[]
}

/** 知识库：跨书的所有划线，按时间倒序 */
export function listAllAnnotations(limit = 2000): KbItem[] {
  return getDb()
    .prepare(`SELECT a.*, b.title AS book_title, b.author AS book_author,
        (SELECT s.title FROM sections s WHERE s.book_id = a.book_id AND s.idx = a.sec_idx) AS sec_title
      FROM annotations a JOIN books b ON b.id = a.book_id
      ORDER BY a.created_at DESC LIMIT ?`)
    .all(limit) as unknown as KbItem[]
}

export function updateAnnotation(id: string, patch: { note?: string; color?: string; tags?: string }): void {
  const sets: string[] = []
  const vals: any[] = []
  if (patch.note !== undefined) { sets.push('note = ?'); vals.push(patch.note) }
  if (patch.color !== undefined) { sets.push('color = ?'); vals.push(patch.color) }
  if (patch.tags !== undefined) { sets.push('tags = ?'); vals.push(patch.tags) }
  if (!sets.length) return
  getDb().prepare(`UPDATE annotations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

export function deleteAnnotation(id: string): void {
  getDb().prepare('DELETE FROM cards WHERE annotation_id = ?').run(id)
  getDb().prepare('DELETE FROM annotations WHERE id = ?').run(id)
}

/** 读者在这本书上说过的话（跨划线、跨讨论），按时间正序返回最近 limit 条 */
export function listUtterances(bookId: string, limit = 20, excludeThreadId?: string): Array<{ text: string; at: number }> {
  const rows = getDb()
    .prepare(
      `SELECT m.content AS text, m.created_at AS at
         FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.role = 'user'
          AND m.content <> ''
          AND (t.annotation_id IN (SELECT id FROM annotations WHERE book_id = ?)
               OR t.annotation_id LIKE 'sec:' || ? || ':%')
          AND m.thread_id <> ?
        ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(bookId, bookId, excludeThreadId ?? '', limit) as unknown as Array<{ text: string; at: number }>
  return rows.reverse()
}

/* ---------------- 记忆库 ---------------- */

export interface MemoryRow {
  id: string
  book_id: string
  kind: 'note' | 'thought'
  text: string
  source: string
  ref_id: string
  created_at: number
  updated_at: number
}

export interface MemoryItem extends MemoryRow {
  book_title: string
}

/** 写入一条记忆；同一来源（ref_id + kind）会被覆盖，不会无限堆积 */
export function upsertMemory(m: {
  id?: string
  book_id: string
  kind: 'note' | 'thought'
  text: string
  source?: string
  ref_id?: string
}): void {
  const text = m.text.trim()
  if (!text) return
  const now = Date.now()
  const id = m.id ?? `mem_${crypto.randomUUID()}`
  const ref = m.ref_id ?? ''
  if (ref) {
    const old = getDb()
      .prepare('SELECT id, created_at FROM memory WHERE ref_id = ? AND kind = ?')
      .get(ref, m.kind) as { id: string; created_at: number } | undefined
    if (old) {
      getDb()
        .prepare('UPDATE memory SET text = ?, source = ?, updated_at = ? WHERE id = ?')
        .run(text, m.source ?? '', now, old.id)
      return
    }
  }
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO memory (id, book_id, kind, text, source, ref_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, m.book_id, m.kind, text, m.source ?? '', ref, now, now)
}

export function listMemory(bookId: string, limit = 500): MemoryRow[] {
  return getDb()
    .prepare('SELECT * FROM memory WHERE book_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(bookId, limit) as unknown as MemoryRow[]
}

export function listAllMemory(limit = 1000): MemoryItem[] {
  return getDb()
    .prepare(
      `SELECT m.*, COALESCE(b.title, '') AS book_title FROM memory m
       LEFT JOIN books b ON b.id = m.book_id
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(limit) as unknown as MemoryItem[]
}

/** 注入上下文用：时间正序，最近的在后 */
export function listMemoryForContext(bookId: string, limit = 12): Array<{ text: string; at: number }> {
  const rows = getDb()
    .prepare('SELECT text, created_at AS at FROM memory WHERE book_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(bookId, limit) as unknown as Array<{ text: string; at: number }>
  return rows.reverse()
}

export function updateMemory(id: string, text: string): void {
  const t = text.trim()
  if (!t) {
    deleteMemory(id)
    return
  }
  getDb().prepare('UPDATE memory SET text = ?, updated_at = ? WHERE id = ?').run(t, Date.now(), id)
}

export function deleteMemory(id: string): void {
  getDb().prepare('DELETE FROM memory WHERE id = ?').run(id)
}

/** 按来源删除（划线批注被清空时用） */
export function deleteMemoryByRef(refId: string, kind?: 'note' | 'thought'): void {
  if (kind) {
    getDb().prepare('DELETE FROM memory WHERE ref_id = ? AND kind = ?').run(refId, kind)
  } else {
    getDb().prepare('DELETE FROM memory WHERE ref_id = ?').run(refId)
  }
}

export function countMemory(bookId?: string): number {
  const row = bookId
    ? (getDb().prepare('SELECT COUNT(*) AS n FROM memory WHERE book_id = ?').get(bookId) as { n: number })
    : (getDb().prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number })
  return row?.n ?? 0
}

/* ---------------- 设置 / 进度 ---------------- */

export function getSetting(key: string, fallback = ''): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
  return row?.value ?? fallback
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

export function setProgress(bookId: string, secIdx: number, percent: number): void {
  getDb()
    .prepare(`INSERT INTO progress (book_id, sec_idx, percent, updated_at) VALUES (?,?,?,?)
              ON CONFLICT(book_id) DO UPDATE SET sec_idx = excluded.sec_idx,
              percent = excluded.percent, updated_at = excluded.updated_at`)
    .run(bookId, secIdx, percent, Date.now())
}

export function getProgress(bookId: string): { sec_idx: number; percent: number } | null {
  const row = getDb().prepare('SELECT sec_idx, percent FROM progress WHERE book_id = ?').get(bookId) as any
  return row ? { sec_idx: row.sec_idx, percent: row.percent } : null
}

// ---------- 书签 ----------
export interface BookmarkRow {
  id: string
  book_id: string
  sec_idx: number
  global_pos: number
  label: string
  created_at: number
}

export function createBookmark(p: Omit<BookmarkRow, 'id' | 'created_at'>): BookmarkRow {
  const row: BookmarkRow = { ...p, id: crypto.randomUUID(), created_at: Date.now() }
  getDb()
    .prepare('INSERT INTO bookmarks (id, book_id, sec_idx, global_pos, label, created_at) VALUES (?,?,?,?,?,?)')
    .run(row.id, row.book_id, row.sec_idx, row.global_pos, row.label, row.created_at)
  return row
}

export function listBookmarks(bookId: string): BookmarkRow[] {
  return getDb().prepare('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY global_pos').all(bookId) as unknown as BookmarkRow[]
}

export function deleteBookmark(id: string): void {
  getDb().prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
}

// ---------- 全书检索 ----------
export interface SearchHit {
  sec_idx: number
  char_start: number
  char_end: number
  snippet: string
}

export function searchBook(bookId: string, query: string, limit = 40): SearchHit[] {
  const terms = extractTerms(query)
  if (!terms.length) return []
  const rows = getDb()
    .prepare('SELECT sec_idx, char_start, char_end, text FROM chunks WHERE book_id = ? ORDER BY char_start')
    .all(bookId) as unknown as Array<{ sec_idx: number; char_start: number; char_end: number; text: string }>

  const hits: SearchHit[] = []
  for (const row of rows) {
    const first = terms.find((t) => row.text.includes(t))
    if (!first) continue
    let score = 0
    for (const t of terms) if (row.text.includes(t)) score++
    if (score < Math.min(2, terms.length)) continue
    const at = row.text.indexOf(first)
    const from = Math.max(0, at - 40)
    const to = Math.min(row.text.length, at + first.length + 60)
    hits.push({
      sec_idx: row.sec_idx,
      char_start: row.char_start + at,
      char_end: row.char_start + at + first.length,
      snippet: (from > 0 ? '…' : '') + row.text.slice(from, to).replace(/\s+/g, ' ') + (to < row.text.length ? '…' : '')
    })
    if (hits.length >= limit) break
  }
  return hits
}

/** 跨书全文检索 */
export interface GlobalHit extends SearchHit {
  book_id: string
  book_title: string
}

export function searchAll(query: string, limit = 50): GlobalHit[] {
  const terms = extractTerms(query)
  if (!terms.length) return []
  const rows = getDb()
    .prepare(
      `SELECT c.book_id, b.title AS book_title, c.sec_idx, c.char_start, c.char_end, c.text
       FROM chunks c JOIN books b ON b.id = c.book_id
       ORDER BY b.added_at DESC, c.char_start`
    )
    .all() as unknown as Array<{
    book_id: string
    book_title: string
    sec_idx: number
    char_start: number
    char_end: number
    text: string
  }>

  const hits: GlobalHit[] = []
  for (const row of rows) {
    const first = terms.find((t) => row.text.includes(t))
    if (!first) continue
    let score = 0
    for (const t of terms) if (row.text.includes(t)) score++
    if (score < Math.min(2, terms.length)) continue
    const at = row.text.indexOf(first)
    const from = Math.max(0, at - 40)
    const to = Math.min(row.text.length, at + first.length + 60)
    hits.push({
      book_id: row.book_id,
      book_title: row.book_title,
      sec_idx: row.sec_idx,
      char_start: row.char_start + at,
      char_end: row.char_start + at + first.length,
      snippet:
        (from > 0 ? '…' : '') +
        row.text.slice(from, to).replace(/\s+/g, ' ') +
        (to < row.text.length ? '…' : '')
    })
    if (hits.length >= limit) break
  }
  return hits
}

// ---------- 阅读统计 ----------
export function addReading(day: string, seconds: number): void {
  if (!seconds || seconds <= 0) return
  getDb()
    .prepare(
      `INSERT INTO reading_log(day, seconds) VALUES(?, ?)
       ON CONFLICT(day) DO UPDATE SET seconds = seconds + excluded.seconds`
    )
    .run(day, Math.min(3600, Math.round(seconds)))
}

export interface ReadingStats {
  today: number
  total: number
  streak: number
  days30: Array<{ day: string; seconds: number }>
}

export function getReadingStats(): ReadingStats {
  const rows = getDb()
    .prepare('SELECT day, seconds FROM reading_log ORDER BY day DESC')
    .all() as unknown as Array<{ day: string; seconds: number }>
  if (!rows.length) return { today: 0, total: 0, streak: 0, days30: [] }
  const today = dayKey(Date.now())
  let total = 0
  let streak = 0
  let expect = today
  for (const r of rows) {
    total += r.seconds
    if (r.day === expect) {
      streak++
      expect = prevDay(expect)
    } else if (streak === 0 && r.day === prevDay(today)) {
      streak++
      expect = prevDay(r.day)
    }
  }
  return {
    today: rows.find((r) => r.day === today)?.seconds ?? 0,
    total,
    streak,
    days30: rows.slice(0, 30).reverse()
  }
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function prevDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  t.setDate(t.getDate() - 1)
  return dayKey(t.getTime())
}
// ---------- 复习卡片 ----------
export interface CardRow {
  id: string
  annotation_id: string
  front: string
  back: string
  tags: string
  due_at: number
  stability: number
  difficulty: number
  reps: number
  lapses: number
  state: number
}

export interface CardWithCtx extends CardRow {
  book_id: string
  book_title: string
  sec_idx: number
  sec_title: string
  quote: string
  note: string
  color: string
}

export function createCard(p: {
  annotation_id: string
  front: string
  back: string
  tags?: string
  due_at?: number
}): CardRow {
  const row: CardRow = {
    id: crypto.randomUUID(),
    annotation_id: p.annotation_id,
    front: p.front,
    back: p.back,
    tags: p.tags ?? '',
    due_at: p.due_at ?? Date.now(),
    stability: 0,
    difficulty: 0.3,
    reps: 0,
    lapses: 0,
    state: 0
  }
  getDb()
    .prepare(
      'INSERT INTO cards (id, annotation_id, front, back, tags, due_at, stability, difficulty, reps, lapses, state) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(row.id, row.annotation_id, row.front, row.back, row.tags, row.due_at, row.stability, row.difficulty, row.reps, row.lapses, row.state)
  return row
}

const CARD_CTX_SQL = `
  SELECT c.*, a.book_id AS book_id, b.title AS book_title, a.sec_idx AS sec_idx,
         a.quote AS quote, a.note AS note, a.color AS color,
         (SELECT s.title FROM sections s WHERE s.book_id = a.book_id AND s.idx = a.sec_idx) AS sec_title
  FROM cards c
  JOIN annotations a ON a.id = c.annotation_id
  JOIN books b ON b.id = a.book_id`

export function listCards(bookId?: string): CardWithCtx[] {
  const sql = bookId ? `${CARD_CTX_SQL} WHERE a.book_id = ? ORDER BY c.due_at` : `${CARD_CTX_SQL} ORDER BY c.due_at`
  const args = bookId ? [bookId] : []
  return getDb().prepare(sql).all(...args) as unknown as CardWithCtx[]
}

export function listDueCards(limit = 30, now = Date.now()): CardWithCtx[] {
  return getDb()
    .prepare(`${CARD_CTX_SQL} WHERE c.due_at <= ? ORDER BY c.due_at LIMIT ?`)
    .all(now, limit) as unknown as CardWithCtx[]
}

export function countCards(): { total: number; due: number } {
  const now = Date.now()
  const total = (getDb().prepare('SELECT COUNT(*) AS n FROM cards').get() as any).n as number
  const due = (getDb().prepare('SELECT COUNT(*) AS n FROM cards WHERE due_at <= ?').get(now) as any).n as number
  return { total, due }
}

export function getCard(id: string): CardRow | undefined {
  return getDb().prepare('SELECT * FROM cards WHERE id = ?').get(id) as unknown as CardRow | undefined
}

export function updateCard(id: string, patch: { front?: string; back?: string; tags?: string; due_at?: number }): void {
  const sets: string[] = []
  const vals: any[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
  }
  if (!sets.length) return
  getDb().prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

export function saveCardReview(
  id: string,
  s: { stability: number; difficulty: number; reps: number; lapses: number; state: number; due_at: number }
): void {
  getDb()
    .prepare('UPDATE cards SET stability=?, difficulty=?, reps=?, lapses=?, state=?, due_at=? WHERE id=?')
    .run(s.stability, s.difficulty, s.reps, s.lapses, s.state, s.due_at, id)
}

export function deleteCard(id: string): void {
  getDb().prepare('DELETE FROM cards WHERE id = ?').run(id)
}

export function deleteCardsByAnnotation(annotationId: string): void {
  getDb().prepare('DELETE FROM cards WHERE annotation_id = ?').run(annotationId)
}

// ---------- 章节摘要缓存 ----------
export function getSectionSummary(bookId: string, idx: number): { summary: string; keywords: string[] } {
  const row = getDb().prepare('SELECT text FROM summaries WHERE book_id = ? AND idx = ?').get(bookId, idx) as any
  const raw = row?.text ? String(row.text) : ''
  if (!raw) return { summary: '', keywords: [] }
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw)
      return {
        summary: String(o.summary ?? ''),
        keywords: Array.isArray(o.keywords) ? o.keywords.map(String) : []
      }
    } catch {
      /* 落到下面按纯文本处理 */
    }
  }
  return { summary: raw, keywords: [] }
}

export function setSectionSummary(bookId: string, idx: number, summary: string, keywords: string[] = []): void {
  const text = JSON.stringify({ summary, keywords })
  getDb()
    .prepare(
      'INSERT INTO summaries (book_id, idx, text, created_at) VALUES (?,?,?,?) ON CONFLICT(book_id, idx) DO UPDATE SET text = excluded.text, created_at = excluded.created_at'
    )
    .run(bookId, idx, text, Date.now())
}

export function listSummaries(bookId: string): Array<{ idx: number; text: string }> {
  return getDb().prepare('SELECT idx, text FROM summaries WHERE book_id = ? ORDER BY idx').all(bookId) as unknown as Array<{
    idx: number
    text: string
  }>
}

// ---------- 翻译 ----------
export interface TrRow {
  book_id: string
  sec_idx: number
  block_i: number
  src_hash: string
  text: string
  score: number
  stage: number
  updated_at: number
}

export function getTranslations(bookId: string, secIdx: number): TrRow[] {
  return getDb()
    .prepare('SELECT * FROM translations WHERE book_id = ? AND sec_idx = ? ORDER BY block_i')
    .all(bookId, secIdx) as unknown as TrRow[]
}

export function upsertTranslation(r: Omit<TrRow, 'updated_at'> & { updated_at?: number }): void {
  getDb()
    .prepare(
      `INSERT INTO translations (book_id, sec_idx, block_i, src_hash, text, score, stage, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(book_id, sec_idx, block_i) DO UPDATE SET
         src_hash = excluded.src_hash, text = excluded.text, score = excluded.score,
         stage = excluded.stage, updated_at = excluded.updated_at`
    )
    .run(r.book_id, r.sec_idx, r.block_i, r.src_hash, r.text, r.score, r.stage, r.updated_at ?? Date.now())
}

export function countTranslations(bookId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM translations WHERE book_id = ?').get(bookId) as any
  return Number(row?.n ?? 0)
}

export function deleteTranslations(bookId: string): void {
  getDb().prepare('DELETE FROM translations WHERE book_id = ?').run(bookId)
}

export function listGlossary(bookId: string): Array<{ src: string; dst: string; note: string }> {
  return getDb()
    .prepare('SELECT src, dst, note FROM glossary WHERE book_id = ? ORDER BY src')
    .all(bookId) as unknown as Array<{ src: string; dst: string; note: string }>
}

export function setGlossaryItem(bookId: string, src: string, dst: string, note = ''): void {
  getDb()
    .prepare(
      `INSERT INTO glossary (book_id, src, dst, note, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(book_id, src) DO UPDATE SET dst = excluded.dst, note = excluded.note`
    )
    .run(bookId, src, dst, note, Date.now())
}

export function deleteGlossaryItem(bookId: string, src: string): void {
  getDb().prepare('DELETE FROM glossary WHERE book_id = ? AND src = ?').run(bookId, src)
}

export interface TrJob {
  book_id: string
  target_lang: string
  state: string
  total: number
  done: number
  cursor_sec: number
  error: string
  updated_at: number
}

export function getTrJob(bookId: string): TrJob | null {
  const row = getDb().prepare('SELECT * FROM tr_jobs WHERE book_id = ?').get(bookId) as any
  return (row as TrJob) ?? null
}

export function saveTrJob(j: TrJob): void {
  getDb()
    .prepare(
      `INSERT INTO tr_jobs (book_id, target_lang, state, total, done, cursor_sec, error, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(book_id) DO UPDATE SET
         target_lang = excluded.target_lang, state = excluded.state, total = excluded.total,
         done = excluded.done, cursor_sec = excluded.cursor_sec, error = excluded.error,
         updated_at = excluded.updated_at`
    )
    .run(j.book_id, j.target_lang, j.state, j.total, j.done, j.cursor_sec, j.error, j.updated_at)
}
/** Export a database copy (VACUUM INTO); target file must not exist. */
export function backupTo(file: string): void {
  const safe = file.replace(/'/g, "''")
  getDb().exec(`VACUUM INTO '${safe}'`)
}

