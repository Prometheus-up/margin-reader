export interface Book {
  id: string
  title: string
  author: string
  format: string
  lang: string
  word_count: number
  sec_count: number
  added_at: number
  cover?: string
  progress_pct?: number
  progress_sec?: number
  ann_count?: number
}

export interface SectionMeta {
  idx: number
  title: string
  level: number
  char_start: number
  char_end: number
}

export interface Block {
  i: number
  tag: string
  text: string
  html: string
  start: number
  end: number
  /** 块自身的锚点 id（EPUB 的 <p id="...">） */
  anchor?: string
  /** 块内的书内链接 / 脚注引用 */
  links?: Array<{ start: number; end: number; href: string }>
}

export interface Section {
  idx: number
  title: string
  blocks: Block[]
}

export interface Annotation {
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

/** 知识库条目（跨书） */
export interface KbItem extends Annotation {
  book_title: string
  book_author: string
  sec_title: string
}

export interface Bookmark {
  id: string
  book_id: string
  sec_idx: number
  global_pos: number
  label: string
  created_at: number
}

export interface SearchHit {
  sec_idx: number
  char_start: number
  char_end: number
  snippet: string
}

export interface GlobalHit extends SearchHit {
  book_id: string
  book_title: string
}

export interface ReadingStats {
  today: number
  total: number
  streak: number
  days30: Array<{ day: string; seconds: number }>
}

/** 复习卡片 */
export interface Card {
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
  book_id: string
  book_title: string
  sec_idx: number
  sec_title: string
  quote: string
  note: string
  color: string
}

export interface SectionSummary {
  summary: string
  keywords: string[]
  cached: boolean
}

/* ---------------- 记忆库 ---------------- */

export interface MemoryItem {
  id: string
  book_id: string
  kind: 'note' | 'thought' | string
  text: string
  source: string
  ref_id: string
  created_at: number
  updated_at: number
  book_title?: string
}

/* ---------------- 书外知识 / 释义 ---------------- */

export interface ExtRef {
  source: 'openalex' | 'crossref'
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  url?: string
  abstract?: string
  cited?: number
}

export interface DictSense {
  pos?: string
  def: string
}

export interface DictEntry {
  word: string
  pinyin?: string
  senses: DictSense[]
  usage?: string
  caution?: string
}

/** 书内链接解析结果 */
export interface AnchorResult {
  kind: 'external' | 'note' | 'section' | 'none'
  url?: string
  secIdx?: number
  secTitle?: string
  text?: string
}

/* ---------------- 翻译 ---------------- */

export type TrStageId = 'draft' | 'scope' | 'polish' | 'terms' | 'final'

export interface TrStage {
  id: TrStageId
  name: string
  desc: string
}

export interface TrConfig {
  targetLang: string
  threshold: number
  maxRounds: number
  concurrency: number
  stages: Record<TrStageId, boolean>
  reviewProfile: 'main' | 'review'
}

export interface TrJob {
  book_id: string
  target_lang: string
  state: 'running' | 'paused' | 'done' | 'error'
  total: number
  done: number
  cursor_sec: number
  error: string
  updated_at: number
}

export interface TrStatus {
  job: TrJob | null
  total: number
  done: number
  running: boolean
}

export interface TrBlock {
  block_i: number
  src_hash: string
  text: string
  score: number
}

export interface TrTerm {
  src: string
  dst: string
  note: string
}

/** 阅读器的对照模式 */
export type BiMode = 'off' | 'below' | 'only' | 'side'

export interface Source {
  label: string
  secIdx: number
  start: number
  end: number
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  created_at?: number
}

export type Mode = 'socratic' | 'explain' | 'challenge' | 'external'

export const MODES: Array<{ key: Mode; label: string; hint: string }> = [
  { key: 'socratic', label: '顺着作者想', hint: '先问你，不急着给答案' },
  { key: 'explain', label: '这里没懂', hint: '解释难点，给依据' },
  { key: 'challenge', label: '我想反驳', hint: '先复述立场，再反驳' },
  { key: 'external', label: '别处怎么说', hint: '书外参照，全部标注' }
]

/** 划线颜色：先标，再决定要不要讨论 */
export const COLORS: Array<{ key: string; label: string; hex: string }> = [
  { key: 'yellow', label: '重点', hex: '#f0d78c' },
  { key: 'green', label: '认同', hex: '#b9dcae' },
  { key: 'blue', label: '疑问', hex: '#a9c8e8' },
  { key: 'pink', label: '灵感', hex: '#f0bfcd' }
]

const api = (window as any).api ?? ((window as any).__MARGIN_SERVER__ ? makeHttpApi() : makeBrowserMock())

/** 网页版：把 window.api 的每个方法转发到本地 http 服务 */
function makeHttpApi(): any {
  async function call(method: string, ...args: any[]): Promise<any> {
    const res = await fetch('/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args })
    })
    const body = await res.json()
    if (!body.ok) throw new Error(body.error || '请求失败')
    return body.data
  }

  async function pickAndUpload(): Promise<{ imported: any[]; failed: any[] }> {
    const files = await new Promise<FileList | null>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = '.epub,.pdf,.txt,.md,.markdown,.docx,.mobi,.azw3,.azw'
      input.onchange = () => resolve(input.files)
      input.oncancel = () => resolve(null)
      input.click()
    })
    const imported: any[] = []
    const failed: any[] = []
    if (!files) return { imported, failed }
    for (const file of Array.from(files)) {
      try {
        const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          body: file
        })
        const body = await res.json()
        if (body.ok) imported.push(body.data)
        else failed.push({ file: file.name, error: body.error })
      } catch (e: any) {
        failed.push({ file: file.name, error: e?.message ?? String(e) })
      }
    }
    return { imported, failed }
  }

  return {
    books: { list: () => call('books:list'), import: pickAndUpload, progress: () => call('books:progress'), remove: (id: string) => call('books:delete', id) },
    book: {
      meta: (id: string) => call('book:meta', id),
      sections: (id: string) => call('book:sections', id),
      section: (id: string, idx: number) => call('book:section', id, idx),
      search: (id: string, q: string) => call('book:search', id, q),
      searchAll: (q: string, limit?: number) => call('book:searchAll', q, limit),
      anchor: (id: string, secIdx: number, href: string) => call('book:anchor', id, secIdx, href)
    },
    stats: {
      get: () => call('stats:get'),
      add: (seconds: number) => call('stats:add', seconds)
    },
    backup: { export: () => call('backup:export') },
    annotations: {
      list: (id: string) => call('ann:list', id),
      all: () => call('ann:all'),
      create: (p: any) => call('ann:create', p),
      update: (id: string, p: any) => call('ann:update', id, p),
      remove: (id: string) => call('ann:delete', id)
    },
    bookmarks: {
      list: (id: string) => call('bm:list', id),
      create: (p: any) => call('bm:create', p),
      remove: (id: string) => call('bm:delete', id)
    },
    chat: {
      history: (id: string, m: string) => call('chat:history', id, m),
      send: (p: any) => call('chat:send', p)
    },
    settings: {
      get: (k: string, f?: string) => call('settings:get', k, f),
      set: (k: string, v: string) => call('settings:set', k, v)
    },
    progress: {
      get: (id: string) => call('progress:get', id),
      set: (id: string, idx: number, pct: number) => call('progress:set', id, idx, pct)
    },
    cards: {
      list: (bookId?: string) => call('card:list', bookId),
      due: (limit?: number) => call('card:due', limit),
      counts: () => call('card:counts'),
      generate: (annotationId: string) => call('card:generate', annotationId),
      update: (id: string, patch: any) => call('card:update', id, patch),
      remove: (id: string) => call('card:delete', id),
      review: (id: string, grade: number) => call('card:review', id, grade)
    },
    summary: {
      get: (bookId: string, secIdx: number, force = false) => call('sec:summary', bookId, secIdx, force)
    },
    memory: {
      list: (bookId: string) => call('mem:list', bookId),
      all: () => call('mem:all'),
      count: (bookId?: string) => call('mem:count', bookId),
      update: (id: string, text: string) => call('mem:update', id, text),
      remove: (id: string) => call('mem:delete', id)
    },
    ext: {
      search: (q: string, limit?: number) => call('ext:search', q, limit)
    },
    dict: {
      lookup: (word: string, sentence: string) => call('dict:lookup', word, sentence)
    },
    kb: {
      autoTag: (bookId?: string) => call('kb:autotag', bookId)
    },
    ai: {
      test: (which?: 'main' | 'review') => call('ai:test', which),
      presets: () => call('ai:presets'),
      opencode: () => call('ai:opencode'),
      cleanup: () => call('ai:cleanup')
    },
    tr: {
      config: () => call('tr:config'),
      setConfig: (p: any) => call('tr:config:set', p),
      stages: () => call('tr:stages'),
      langs: () => call('tr:langs'),
      status: (bookId: string) => call('tr:status', bookId),
      start: (bookId: string, lang?: string) => call('tr:start', bookId, lang),
      pause: (bookId: string) => call('tr:pause', bookId),
      reset: (bookId: string) => call('tr:reset', bookId),
      section: (bookId: string, secIdx: number) => call('tr:section', bookId, secIdx),
      block: (bookId: string, secIdx: number, blockI: number) => call('tr:block', bookId, secIdx, blockI),
      glossary: (bookId: string) => call('tr:glossary', bookId),
      setGlossary: (bookId: string, src: string, dst: string, note?: string) => call('tr:glossary:set', bookId, src, dst, note),
      removeGlossary: (bookId: string, src: string) => call('tr:glossary:delete', bookId, src),
      buildGlossary: (bookId: string) => call('tr:glossary:build', bookId)
    }
  }
}

export default api as {
  books: {
    list(): Promise<Book[]>
    import(): Promise<{ imported: Array<{ id: string; title: string }>; failed: Array<{ file: string; error: string }> }>
    progress(): Promise<{ name: string; done: number; total: number } | null>
    remove(id: string): Promise<boolean>
  }
  book: {
    meta(id: string): Promise<Book>
    sections(id: string): Promise<SectionMeta[]>
    section(id: string, idx: number): Promise<Section | null>
    search(bookId: string, query: string): Promise<SearchHit[]>
    searchAll(query: string, limit?: number): Promise<GlobalHit[]>
    anchor(bookId: string, secIdx: number, href: string): Promise<AnchorResult>
  }
  stats: {
    get(): Promise<ReadingStats>
    add(seconds: number): Promise<boolean>
  }
  backup: { export(): Promise<{ path: string }> }
  bookmarks: {
    list(bookId: string): Promise<Bookmark[]>
    create(payload: Omit<Bookmark, 'id' | 'created_at'>): Promise<Bookmark>
    remove(id: string): Promise<boolean>
  }
  annotations: {
    list(bookId: string): Promise<Annotation[]>
    all(): Promise<KbItem[]>
    create(payload: Partial<Annotation>): Promise<Annotation>
    update(id: string, patch: { note?: string; color?: string; tags?: string }): Promise<boolean>
    remove(id: string): Promise<boolean>
  }
  chat: {
    history(annotationId: string, mode: string): Promise<Message[]>
    send(payload: { annotationId?: string; bookId?: string; secIdx?: number; mode: string; text?: string }): Promise<{
      reply: string
      sources: Source[]
      stats: { totalChars: number; percent: number; retrieved: number; notes: number; priorSections: number; memory?: number }
      threadId: string
    }>
  }
  settings: {
    get(key: string, fallback?: string): Promise<string>
    set(key: string, value: string): Promise<boolean>
  }
  progress: {
    get(bookId: string): Promise<{ sec_idx: number; percent: number } | null>
    set(bookId: string, secIdx: number, percent: number): Promise<boolean>
  }
  cards: {
    list(bookId?: string): Promise<Card[]>
    due(limit?: number): Promise<Card[]>
    counts(): Promise<{ total: number; due: number }>
    generate(annotationId: string): Promise<Card[]>
    update(id: string, patch: { front?: string; back?: string; tags?: string; due_at?: number }): Promise<boolean>
    remove(id: string): Promise<boolean>
    review(id: string, grade: number): Promise<{ due_at: number; intervalDays: number; state: number }>
  }
  summary: {
    get(bookId: string, secIdx: number, force?: boolean): Promise<SectionSummary>
  }
  memory: {
    list(bookId: string): Promise<MemoryItem[]>
    all(): Promise<MemoryItem[]>
    count(bookId?: string): Promise<number>
    update(id: string, text: string): Promise<boolean>
    remove(id: string): Promise<boolean>
  }
  ext: {
    search(q: string, limit?: number): Promise<{ refs: ExtRef[]; errors: string[] }>
  }
  dict: {
    lookup(word: string, sentence: string): Promise<DictEntry>
  }
  kb: {
    autoTag(bookId?: string): Promise<{ updated: number; tags: string[] }>
  }
  ai: {
    test(which?: 'main' | 'review'): Promise<{ ok: boolean; ms: number; model: string; error?: string }>
    presets(): Promise<Array<{ id: string; name: string; baseUrl: string; model: string; needKey: boolean }>>
    opencode(): Promise<{ models: Array<{ id: string; name: string }>; cli: string }>
    cleanup(): Promise<{ deleted: number; kept: number }>
  }
  tr: {
    config(): Promise<TrConfig>
    setConfig(patch: Partial<TrConfig>): Promise<TrConfig>
    stages(): Promise<TrStage[]>
    langs(): Promise<Record<string, string>>
    status(bookId: string): Promise<TrStatus>
    start(bookId: string, lang?: string): Promise<any>
    pause(bookId: string): Promise<boolean>
    reset(bookId: string): Promise<boolean>
    section(bookId: string, secIdx: number): Promise<TrBlock[]>
    block(bookId: string, secIdx: number, blockI: number): Promise<{ text: string; score: number }>
    glossary(bookId: string): Promise<TrTerm[]>
    setGlossary(bookId: string, src: string, dst: string, note?: string): Promise<boolean>
    removeGlossary(bookId: string, src: string): Promise<boolean>
    buildGlossary(bookId: string): Promise<TrTerm[]>
  }
}

/** 浏览器里预览界面用（Electron 中 window.api 存在，不会走到这里） */
function makeBrowserMock(): any {
  const book = { id: 'demo', title: '页边：关于划线、边界与迁移的四章', author: '示例文本', format: 'epub', lang: 'zh-CN', word_count: 936, sec_count: 4, added_at: Date.now() }
  const texts: Record<number, string[]> = {
    0: [
      '一个人读书时停下来，往往不是因为读不懂，而是因为读懂了什么。',
      '所以有人划线。线划在纸上，其实划在理解的门槛上：这里，我曾经站住过。',
      '于是真正有价值的，不是那条线，而是停下来之后的那句话：我为什么停在这里。'
    ],
    1: [
      '有一种帮助是有害的：在你还没有形成判断之前，先把结论递到你手上。',
      '所以讨论需要边界。不是道德的边界，而是认知的边界：只使用你已经读过的部分。',
      '换句话说：可以借望远镜，但不能借别人的眼睛。'
    ]
  }
  let anns: any[] = []
  const sec = (idx: number) => {
    let cursor = 0
    const blocks = (texts[idx] || []).map((t, i) => {
      const s = cursor
      cursor = s + t.length + 1
      return { i, tag: 'p', text: t, html: t, start: s, end: s + t.length }
    })
    return { idx, title: idx === 0 ? '第一章 划线' : '第二章 边界', blocks }
  }
  return {
    books: { list: async () => [book], import: async () => ({ imported: [], failed: [] }), progress: async () => null, remove: async () => true },
    book: {
      meta: async () => book,
      sections: async () => [
        { idx: 0, title: '第一章 划线', char_start: 0, char_end: 300 },
        { idx: 1, title: '第二章 边界', char_start: 301, char_end: 600 }
      ],
      section: async (_id: string, idx: number) => sec(idx),
      search: async (_id: string, q: string) => {
        const hits: any[] = []
        for (const idx of [0, 1]) {
          const text = (texts[idx] || []).join('\n')
          const at = text.indexOf(q)
          if (at >= 0) hits.push({ sec_idx: idx, char_start: at, char_end: at + q.length, snippet: text.slice(Math.max(0, at - 20), at + 30) })
        }
        return hits
      },
      searchAll: async (_q: string) => [] as any[],
    anchor: async () => ({ kind: 'none' as const }),
    },
    stats: { get: async () => ({ today: 0, total: 0, streak: 0, days30: [] }), add: async () => true },
    backup: { export: async () => ({ path: '(预览模式不支持备份)' }) },
    bookmarks: {
      list: async () => [],
      create: async (p: any) => ({ ...p, id: String(Math.random()), created_at: Date.now() }),
      remove: async () => true
    },
    annotations: {
      list: async () => anns,
      create: async (p: any) => {
        const a = { ...p, id: String(Math.random()), created_at: Date.now() }
        anns = [...anns, a]
        return a
      },
      update: async () => true,
      remove: async () => true
    },
    chat: {
      history: async () => [],
      send: async () => ({
        reply: '（浏览器预览模式，未接模型）\n\n我先不给结论——你划线这句话里，作者为什么用"边界"而不是"限制"？这两个词在他这里能互换吗？',
        sources: [{ label: '前文·第一章', secIdx: 0, start: 0, end: 100 }],
        stats: { totalChars: 1200, percent: 41, retrieved: 2, notes: 0, priorSections: 1 },
        threadId: 't'
      })
    },
    settings: { get: async (_k: string, f?: string) => f ?? '', set: async () => true },
    progress: { get: async () => ({ sec_idx: 0, percent: 0 }), set: async () => true },
    cards: {
      list: async () => [],
      due: async () => [],
      counts: async () => ({ total: 0, due: 0 }),
      generate: async (annotationId: string) => [
        { id: String(Math.random()), annotation_id: annotationId, front: '（预览）这句话在讲什么？', back: '先标位置，再解释为什么停。', tags: '', due_at: Date.now(), stability: 0, difficulty: 0.3, reps: 0, lapses: 0, state: 0, book_id: 'demo', book_title: '示例', sec_idx: 0, sec_title: '第一章', quote: '', note: '', color: 'yellow' }
      ],
      update: async () => true,
      remove: async () => true,
      review: async () => ({ due_at: Date.now() + 86400000, intervalDays: 1, state: 2 })
    },
    summary: { get: async () => ({ summary: '（预览）这一节讲的是：划线是理解的痕迹，而不是理解本身。', keywords: ['划线', '理解'], cached: false }) },
    memory: {
      list: async () => [],
      all: async () => [],
      count: async () => 0,
      update: async () => true,
      remove: async () => true
    },
    ext: { search: async () => ({ refs: [], errors: ['预览模式不联网'] }) },
    dict: {
      lookup: async (word: string) => ({ word, pinyin: '', senses: [{ pos: '—', def: '预览模式下的示例释义。' }], usage: '', caution: '' })
    },
    kb: { autoTag: async () => ({ updated: 0, tags: [] }) },
    ai: {
      test: async () => ({ ok: true, ms: 1, model: 'mock' }),
      presets: async () => [],
      opencode: async () => ({ models: [], cli: '' }),
      cleanup: async () => ({ deleted: 0, kept: 0 })
    },
    tr: {
      config: async () => ({
        targetLang: 'zh-CN', threshold: 75, maxRounds: 3, concurrency: 3,
        stages: { draft: true, scope: true, polish: true, terms: true, final: false },
        reviewProfile: 'main'
      }),
      setConfig: async (p: any) => p,
      stages: async () => [],
      langs: async () => ({ 'zh-CN': '中文', en: '英语' }),
      status: async () => ({ job: null, total: 0, done: 0, running: false }),
      start: async () => ({}),
      pause: async () => true,
      reset: async () => true,
      section: async () => [],
      block: async () => ({ text: '（预览模式的译文）', score: 80 }),
      glossary: async () => [],
      setGlossary: async () => true,
      removeGlossary: async () => true,
      buildGlossary: async () => []
    }
  }
}
