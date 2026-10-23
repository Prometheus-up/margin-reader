/**
 * 书外知识检索：只查真实存在、可回溯的来源。
 * 现接两个免费、免密钥的元数据源：
 *  - OpenAlex（论文/图书，含被引次数）
 *  - Crossref（DOI 注册库，作为兜底）
 * 查不到就返回空数组，绝不编造。
 */

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

const UA = 'Margin-Reader/1.0 (local desktop app; mailto:none@example.com)'

async function fetchJson(url: string, ms = 12000): Promise<any> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

/** OpenAlex 把摘要存成倒排索引，还原成可读文本 */
function rebuildAbstract(inv: Record<string, number[]> | null | undefined, max = 420): string | undefined {
  if (!inv) return undefined
  const slots: string[] = []
  for (const [word, poses] of Object.entries(inv)) for (const p of poses) slots[p] = word
  const text = slots.filter(Boolean).join(' ')
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function shortDoi(doi?: string | null): string | undefined {
  if (!doi) return undefined
  return doi.replace(/^https?:\/\/doi\.org\//i, '')
}

async function searchOpenAlex(query: string, limit: number): Promise<ExtRef[]> {
  const url =
    'https://api.openalex.org/works?search=' +
    encodeURIComponent(query) +
    `&per-page=${Math.min(25, Math.max(1, limit))}&sort=relevance_score:desc`
  const data = await fetchJson(url)
  const list = Array.isArray(data?.results) ? data.results : []
  return list.map((w: any): ExtRef => {
    const authors: string[] = (w.authorships ?? [])
      .map((a: any) => a?.author?.display_name)
      .filter((s: any) => typeof s === 'string' && s.trim())
      .slice(0, 4)
    return {
      source: 'openalex',
      title: String(w.display_name ?? w.title ?? '').trim(),
      authors,
      year: w.publication_year ?? undefined,
      venue: w.primary_location?.source?.display_name ?? undefined,
      doi: shortDoi(w.doi),
      url: w.doi ? `https://doi.org/${shortDoi(w.doi)}` : w.id,
      abstract: rebuildAbstract(w.abstract_inverted_index),
      cited: typeof w.cited_by_count === 'number' ? w.cited_by_count : undefined
    }
  }).filter((r: ExtRef) => r.title)
}

async function searchCrossref(query: string, limit: number): Promise<ExtRef[]> {
  const url =
    'https://api.crossref.org/works?query=' +
    encodeURIComponent(query) +
    `&rows=${Math.min(25, Math.max(1, limit))}&select=title,author,issued,container-title,DOI,URL,abstract`
  const data = await fetchJson(url)
  const list = data?.message?.items
  if (!Array.isArray(list)) return []
  return list.map((w: any): ExtRef => {
    const authors: string[] = (w.author ?? [])
      .map((a: any) => [a?.given, a?.family].filter(Boolean).join(' '))
      .filter((s: string) => s.trim())
      .slice(0, 4)
    const year = w.issued?.['date-parts']?.[0]?.[0]
    const abs = typeof w.abstract === 'string' ? w.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
    return {
      source: 'crossref' as const,
      title: Array.isArray(w.title) ? String(w.title[0] ?? '').trim() : String(w.title ?? '').trim(),
      authors,
      year: typeof year === 'number' ? year : undefined,
      venue: Array.isArray(w['container-title']) ? w['container-title'][0] : undefined,
      doi: shortDoi(w.DOI),
      url: w.URL,
      abstract: abs ? (abs.length > 420 ? `${abs.slice(0, 420)}…` : abs) : undefined
    }
  }).filter((r: ExtRef) => r.title)
}

/** 去重（同 DOI / 同标题）后合并 */
function merge(a: ExtRef[], b: ExtRef[], limit: number): ExtRef[] {
  const out: ExtRef[] = []
  const seen = new Set<string>()
  for (const r of [...a, ...b]) {
    const key = (r.doi || r.title).toLowerCase().replace(/\s+/g, ' ').slice(0, 120)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}

export async function searchExternal(query: string, limit = 8): Promise<{ refs: ExtRef[]; errors: string[] }> {
  const q = query.trim()
  if (q.length < 2) return { refs: [], errors: ['检索词太短'] }
  const errors: string[] = []
  let oa: ExtRef[] = []
  let cr: ExtRef[] = []
  const [oaRes, crRes] = await Promise.allSettled([searchOpenAlex(q, limit), searchCrossref(q, limit)])
  if (oaRes.status === 'fulfilled') oa = oaRes.value
  else errors.push(`OpenAlex：${oaRes.reason?.message ?? oaRes.reason}`)
  if (crRes.status === 'fulfilled') cr = crRes.value
  else errors.push(`Crossref：${crRes.reason?.message ?? crRes.reason}`)
  return { refs: merge(oa, cr, limit), errors }
}

/** 把一条外部来源排成一句话，便于塞进讨论或复制 */
export function formatRef(r: ExtRef): string {
  const who = r.authors.length ? `${r.authors.join('、')}${r.authors.length >= 4 ? ' 等' : ''}` : '佚名'
  const year = r.year ? `（${r.year}）` : ''
  const venue = r.venue ? `《${r.venue}》` : ''
  const doi = r.doi ? ` DOI: ${r.doi}` : ''
  return `${who}${year}. ${r.title}. ${venue}${doi}`.replace(/\s+/g, ' ').trim()
}
