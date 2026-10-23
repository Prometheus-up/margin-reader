import { unzipSync, strFromU8 } from 'fflate'
import { parseHTML } from 'linkedom'
import { buildSectionText, chapterLevel, snippetTitle, type Block } from './text'

export interface ParsedSection {
  idx: number
  title: string
  /** 目录层级：1=部/卷，2=章，3=节（没有层级信息时为 1） */
  level?: number
  href: string
  blocks: Block[]
  text: string
}

export interface ParsedBook {
  title: string
  author: string
  lang: string
  sections: ParsedSection[]
  /** 封面：data URL（image/jpeg 等）；没有就是 undefined */
  cover?: string
}

function resolvePath(base: string, rel: string): string {
  const parts = (base ? base.split('/') : []).slice(0, -1)
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

function mimeOf(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'svg') return 'image/svg+xml'
  return 'image/jpeg'
}

export function parseEpub(buf: Uint8Array): ParsedBook {
  const files = unzipSync(buf)
  const readText = (path: string): string | null => {
    const f = files[path]
    if (!f) return null
    return strFromU8(f)
  }

  // 1. container.xml → opf 路径
  const container = readText('META-INF/container.xml')
  if (!container) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml')
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1]
  if (!opfPath) throw new Error('不是有效的 EPUB：container.xml 中找不到 rootfile')
  const opf = readText(opfPath)
  if (!opf) throw new Error(`EPUB 损坏：找不到 ${opfPath}`)

  const { document: opfDoc } = parseHTML(opf)
  const textOf = (el: Element | null) => (el?.textContent ?? '').trim()

  const metaTitle = textOf(opfDoc.querySelector('metadata > dc\\:title, title') as any)
  const metaAuthor = textOf(opfDoc.querySelector('metadata > dc\\:creator, creator') as any)
  const metaLang = textOf(opfDoc.querySelector('metadata > dc\\:language, language') as any)

  const manifest = new Map<string, { href: string; type: string; props: string }>()
  for (const item of Array.from(opfDoc.querySelectorAll('manifest item')) as Element[]) {
    manifest.set(item.getAttribute('id') ?? '', {
      href: item.getAttribute('href') ?? '',
      type: item.getAttribute('media-type') ?? '',
      props: item.getAttribute('properties') ?? ''
    })
  }

  // 2. spine 顺序
  const spineIds = (Array.from(opfDoc.querySelectorAll('spine itemref')) as Element[])
    .map((el) => el.getAttribute('idref') ?? '')
    .filter(Boolean)

  // 3. 目录：epub3 nav（properties 含 nav）+ epub2 ncx（spine 的 toc 属性）
  const toc = new Map<string, { title: string; hash: string; level: number }[]>()
  const addToc = (path: string, title: string, hash: string, level = 1) => {
    const list = toc.get(path) ?? []
    list.push({ title, hash, level })
    toc.set(path, list)
  }

  const readNav = (navPath: string) => {
    const navText = readText(navPath)
    if (!navText) return
    const { document: navDoc } = parseHTML(navText)
    // EPUB3 的 nav 是嵌套 <ol><li><a>…<ol>…，层级就是目录层级；
    // 用 querySelectorAll('a') 会把它拍平，这里按 li 递归。
    const nav = navDoc.querySelector('nav') ?? navDoc
    const walkList = (list: Element | null, level: number) => {
      if (!list) return
      for (const li of Array.from(list.children ?? []) as Element[]) {
        if (String(li.tagName).toLowerCase() !== 'li') continue
        const kids = Array.from(li.children ?? []) as Element[]
        const a = kids.find((c) => String(c.tagName).toLowerCase() === 'a')
        if (a) {
          const raw = a.getAttribute('href') ?? ''
          const label = (a.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (raw && label) {
            const [file, hash = ''] = raw.split('#')
            addToc(file ? resolvePath(navPath, file) : navPath, label, hash, level)
          }
        }
        const sub = kids.find((c) => String(c.tagName).toLowerCase() === 'ol')
        if (sub) walkList(sub, level + 1)
      }
    }
    walkList(nav.querySelector('ol') as Element | null, 1)
  }

  const readNcx = (ncxPath: string) => {
    const ncxText = readText(ncxPath)
    if (!ncxText) return
    const { document: ncxDoc } = parseHTML(ncxText)
    // navPoint 同样可嵌套，按递归深度给 level
    const walk = (np: Element, level: number) => {
      const label = (np.querySelector('navLabel text, navLabel > text')?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const src = np.querySelector('content')?.getAttribute('src') ?? ''
      if (label && src) {
        const [file, hash = ''] = src.split('#')
        addToc(resolvePath(ncxPath, file), label, hash, level)
      }
      for (const child of Array.from(np.children ?? []) as Element[]) {
        if (String(child.tagName).toLowerCase() === 'navpoint') walk(child, level + 1)
      }
    }
    for (const np of Array.from(ncxDoc.querySelectorAll('navMap navPoint, navpoint')) as Element[]) {
      const parent = np.parentElement
      if (parent && String(parent.tagName).toLowerCase() === 'navpoint') continue
      walk(np, 1)
    }
  }

  try {
    const navItem = [...manifest.values()].find((v) => /(^|\s)nav(\s|$)/.test(v.props) || v.type === 'application/xhtml+xml' && /nav/i.test(v.href))
    if (navItem) readNav(resolvePath(opfPath, navItem.href))
  } catch {
    /* EPUB3 目录解析失败不影响正文 */
  }
  try {
    const ncxId = opfDoc.querySelector('spine')?.getAttribute('toc') ?? ''
    const ncxHref = ncxId ? manifest.get(ncxId)?.href : undefined
    if (ncxHref) readNcx(resolvePath(opfPath, ncxHref))
    else {
      const anyNcx = [...manifest.values()].find((v) => /\.ncx$/i.test(v.href))
      if (anyNcx) readNcx(resolvePath(opfPath, anyNcx.href))
    }
  } catch {
    /* EPUB2 目录解析失败不影响正文 */
  }

  // 4. 封面
  let cover: string | undefined
  try {
    const coverId =
      opfDoc.querySelector('metadata > meta[name="cover"]')?.getAttribute('content') ??
      [...manifest.entries()].find(([, v]) => /cover-image/.test(v.props))?.[0] ??
      ''
    const href = coverId ? manifest.get(coverId)?.href : undefined
    if (href) {
      const path = resolvePath(opfPath, href)
      const bytes = files[path]
      if (bytes) cover = `data:${mimeOf(path)};base64,${Buffer.from(bytes).toString('base64')}`
    }
  } catch {
    /* 没封面也能读 */
  }

  const sections: ParsedSection[] = []
  for (const id of spineIds) {
    const item = manifest.get(id)
    if (!item) continue
    const path = resolvePath(opfPath, item.href)
    const raw = readText(path)
    if (!raw) continue
    if (!/xhtml|html|xml/i.test(item.type) && !/\.x?html?$/i.test(path)) continue

    const { document } = parseHTML(raw)
    const body = document.body ?? document.documentElement
    if (!body) continue
    const built = buildSectionText(body as any)
    if (!built.text.trim()) continue

    const heading = (document.querySelector('h1,h2,h3')?.textContent ?? '').trim()
    const entries = toc.get(path) ?? []
    const baseLevel = entries[0]?.level ?? 1
    const baseTitle =
      entries[0]?.title || normalizeHeading(heading) || snippetTitle(built.text) || `正文 ${sections.length + 1}`

    // 目录里有同一文件的多个锚点 → 按标题块再切一次（层级按该条目的深度）
    const wanted = new Map(entries.filter((e) => e.hash).map((e) => [normalizeHeading(e.title), e.level]))
    if (wanted.size >= 2) {
      const chunks: { title: string; blocks: Block[]; level: number }[] = []
      for (const b of built.blocks) {
        const isHeading = /^h[1-6]$/.test(b.tag) && wanted.has(normalizeHeading(b.text))
        if (isHeading || !chunks.length)
          chunks.push({
            title: isHeading ? normalizeHeading(b.text) : chunks.length ? chunks[0].title : baseTitle,
            level: isHeading ? (wanted.get(normalizeHeading(b.text)) ?? baseLevel) : baseLevel,
            blocks: []
          })
        chunks[chunks.length - 1].blocks.push(b)
      }
      for (const c of chunks) {
        const text = c.blocks.map((b) => b.text).join('\n')
        if (!text.trim()) continue
        sections.push({
          idx: sections.length,
          title: c.title || baseTitle,
          level: Math.max(c.level, chapterLevel(c.title)),
          href: `${path}`,
          blocks: c.blocks,
          text
        })
      }
      continue
    }

    // 目录只指到文件、而文件本身很长（整卷合一）时，按文件内标题再切
    if (!wanted.size && built.text.length > 8000) {
      const isHead = (b: Block) => /^h[1-3]$/.test(b.tag) && b.text.trim().length > 0 && b.text.trim().length <= 40
      if (built.blocks.filter(isHead).length >= 2) {
        let cur: Block[] = []
        let curTitle = ''
        const flush = () => {
          const text = cur.map((b) => b.text).join('\n')
          if (!text.trim()) return
          sections.push({
            idx: sections.length,
            title: curTitle || snippetTitle(text) || baseTitle,
            level: 2,
            href: path,
            blocks: cur,
            text
          })
        }
        for (const b of built.blocks) {
          if (isHead(b) && cur.length) {
            flush()
            cur = []
            curTitle = normalizeHeading(b.text)
          } else if (!cur.length && !curTitle && isHead(b)) {
            curTitle = normalizeHeading(b.text)
          }
          cur.push(b)
        }
        flush()
        continue
      }
    }

    sections.push({
      idx: sections.length,
      title: baseTitle,
      level: Math.max(baseLevel, chapterLevel(baseTitle)),
      href: path,
      blocks: built.blocks,
      text: built.text
    })
  }

  if (sections.length === 0) throw new Error('EPUB 中没有解析到任何正文')

  // 目录里指向空锚点的条目会产出「只有标题、没有内容」的节，直接丢掉
  const cleaned = sections.filter((s) => s.text.replace(/\s/g, '').length >= 10)
  cleaned.forEach((s, i) => (s.idx = i))
  if (!cleaned.length) throw new Error('EPUB 中没有解析到任何正文')

  return {
    title: metaTitle || '未命名书籍',
    author: metaAuthor || '',
    lang: metaLang || '',
    sections: cleaned,
    cover
  }
}

function normalizeHeading(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 80)
}
