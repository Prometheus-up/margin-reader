import { parseHTML } from 'linkedom'
import { buildSectionText, chapterLevel, snippetTitle, type Block } from './text'
import type { ParsedBook, ParsedSection } from './epub'

/**
 * MOBI / AZW3（KF7 + KF8）最小解析：
 * PDB 容器 → PalmDOC 头 → MOBI 头（取编码、EXTH 元数据）→ 文本记录
 * 只做「把正文取出来读」，不还原排版；DRM 加密的会直接报错。
 */

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

/** PalmDOC 的 LZ77 解压 */
function decompressRecord(src: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === 0) {
      out.push(0)
    } else if (c <= 8) {
      for (let j = 0; j < c; j++) out.push(src[++i] ?? 0)
    } else if (c < 0x80) {
      out.push(c)
    } else if (c >= 0xc0) {
      // 0xC0–0xFF：空格 + 一个字节（c ^ 0x80），这是规范里容易被漏掉的一支
      out.push(0x20)
      out.push(c ^ 0x80)
    } else {
      const c2 = src[++i] ?? 0
      const dist = ((c & 0x3f) << 5) | (c2 >> 3)
      const len = (c2 & 0x07) + 3
      const start = out.length - dist
      for (let j = 0; j < len; j++) {
        out.push(start + j >= 0 ? (out[start + j] ?? 0x20) : 0x20)
      }
    }
  }
  return Uint8Array.from(out)
}

/** MOBI 文本记录尾部的「trailing entries」：不剔掉就会在正文里冒出乱码 */
function trimTrailingEntries(rec: Uint8Array, extraFlags: number): Uint8Array {
  if (!extraFlags || !rec.length) return rec
  let end = rec.length
  // 规范（KindleUnpack）：bit 1…15 每个置位对应一条尾部记录，从末尾往前读变长整数；
  // 变长整数的最高位为 1 表示这是最后一个字节。最后 bit 0 再按 (末字节 & 0x3) + 1 去掉。
  let test = extraFlags >> 1
  while (test) {
    if (test & 1) {
      let size = 0
      let shift = 0
      for (let k = 0; k < 4; k++) {
        const v = rec[end - 1 - k]
        if (v === undefined) {
          size = 0
          break
        }
        size |= (v & 0x7f) << shift
        shift += 7
        if (v & 0x80) break
      }
      if (size <= 0 || size >= end) break
      end -= size
    }
    test >>= 1
  }
  if (extraFlags & 1) {
    const last = rec[end - 1]
    if (last !== undefined) {
      const n = (last & 0x3) + 1
      if (n <= end) end -= n
    }
  }
  return end > 0 ? rec.subarray(0, end) : rec
}

function decodeWith(bytes: Uint8Array, enc: string): { text: string; bad: number } {
  try {
    const text = new TextDecoder(enc).decode(bytes)
    let bad = 0
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++
    return { text, bad }
  } catch {
    return { text: '', bad: Number.POSITIVE_INFINITY }
  }
}

function decodeText(bytes: Uint8Array, codepage: number): string {
  const first =
    codepage === 1252
      ? 'windows-1252'
      : codepage === 936
        ? 'gbk'
        : codepage === 932
          ? 'shift_jis'
          : 'utf-8'
  const a = decodeWith(bytes, first)
  // utf-8 声明但实际是 GBK 的书很常见：按替换符比例判断，改判一次
  if (a.bad > 0 && a.bad / Math.max(1, a.text.length) > 0.002) {
    const b = decodeWith(bytes, 'gbk')
    const c = decodeWith(bytes, 'gb18030')
    const best = [a, b, c].sort((x, y) => x.bad - y.bad)[0]
    if (best.text) return best.text
  }
  return a.text || new TextDecoder('utf-8').decode(bytes)
}

function readExth(rec0: Uint8Array, mobiStart: number): Record<number, string> {
  const flags = u32(rec0, mobiStart + 0x80)
  if ((flags & 0x40) === 0) return {}
  const len = u32(rec0, mobiStart + 0x14)
  const start = mobiStart + 0x10 + len
  if (rec0[start] !== 0x45 || rec0[start + 1] !== 0x58) return {}
  const count = u32(rec0, start + 8)
  const meta: Record<number, string> = {}
  let p = start + 12
  for (let i = 0; i < count && p + 8 <= rec0.length; i++) {
    const type = u32(rec0, p)
    const size = u32(rec0, p + 4)
    if (size < 8) break
    const data = rec0.subarray(p + 8, p + size)
    meta[type] = decodeText(data, 65001).replace(/\0/g, '')
    p += size
  }
  return meta
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ')
}

export function parseMobi(buf: Uint8Array): ParsedBook {
  const numRecords = u16(buf, 76)
  if (numRecords < 2) throw new Error('不是有效的 MOBI/AZW3 文件')
  const offsets: number[] = []
  for (let i = 0; i < numRecords; i++) offsets.push(u32(buf, 78 + i * 8))

  const rec0 = buf.subarray(offsets[0], offsets[1] ?? buf.length)
  const compression = u16(rec0, 0)
  const textLength = u32(rec0, 4)
  const textRecordCount = u16(rec0, 8)
  const encryption = u16(rec0, 12)

  if (encryption !== 0) throw new Error('这本书有 DRM 加密，页边只支持无 DRM 的书')
  if (compression === 17480) throw new Error('这本书是 HUFF/CDIC 压缩（老 Kindle 格式），暂不支持')
  if (compression !== 1 && compression !== 2) throw new Error(`未知的 MOBI 压缩方式：${compression}`)

  const mobiStart = 16
  const isMobi = String.fromCharCode(rec0[16], rec0[17], rec0[18], rec0[19]) === 'MOBI'
  const codepage = isMobi ? u32(rec0, mobiStart + 12) : 65001
  const headerLen = isMobi ? u32(rec0, mobiStart + 0x04) : 0
  // extra data flags 在 MOBI 头 0xE2 处（绝对偏移 0xF2）；头长 ≥0xE4 才有这一项
  const extraFlags = isMobi && headerLen >= 0xe4 ? u16(rec0, mobiStart + 0xe2) : 0
  const meta = isMobi ? readExth(rec0, mobiStart) : {}

  const parts: Uint8Array[] = []
  for (let i = 0; i < textRecordCount; i++) {
    const from = offsets[1 + i]
    const to = offsets[2 + i] ?? buf.length
    if (from === undefined) break
    const rec = buf.subarray(from, to)
    // 尾部附加数据是压在「压缩后」的记录末尾的：先剔掉再解压，否则会把它们当 LZ77 指令解出乱码
    const plain = compression === 2 ? decompressRecord(trimTrailingEntries(rec, extraFlags)) : trimTrailingEntries(rec, extraFlags)
    parts.push(plain)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const merged = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    merged.set(p, off)
    off += p.length
  }
  const html = decodeText(merged.subarray(0, Math.min(textLength || total, total)), codepage)
  if (!stripTags(html).trim()) throw new Error('这本书没有可提取的正文（可能是纯图片电子书）')

  // KF8 会把正文拆成多个 <html> 片段；段内再用 <mbp:pagebreak> 切成「页」
  const chunks = html.split(/<html[^>]*>/i).slice(1)
  const raw = chunks.length ? chunks : [html]
  const pages: Block[][] = []
  for (const chunk of raw) {
    const body = chunk.split(/<\/html>/i)[0]
    if (!body || !stripTags(body).trim()) continue
    for (const seg of body.split(/<mbp:pagebreak[^>]*>/i)) {
      if (!stripTags(seg).trim()) continue
      const { document } = parseHTML(`<html><body>${seg}</body></html>`)
      const built = buildSectionText(document.body as any)
      const kept = built.blocks.filter((b) => b.text.trim())
      if (kept.length) pages.push(kept)
    }
  }
  const allBlocks: Block[] = pages.flat()

  const sections: ParsedSection[] = []
  const pushBlocks = (blocks: Block[], title: string) => {
    const kept = blocks.filter((b) => b.text.trim())
    if (!kept.length) return
    let cursor = 0
    const re: Block[] = kept.map((b, i) => {
      const start = cursor
      cursor += b.text.length + 1
      return { ...b, i, start, end: start + b.text.length }
    })
    sections.push({
      idx: sections.length,
      title,
      level: chapterLevel(title),
      href: `#mobi-${sections.length}`,
      blocks: re,
      text: re.map((b) => b.text).join('\n')
    })
  }

  // 章节标题：书里原本的「第一章 / 序 / 前言 …」，不是自己编的第一节
  const CHAPTER_RE =
    /^(序|序言|序章|前言|引言|楔子|后记|尾声|结语|附录|致谢|目录|第\s*[一二三四五六七八九十百千零〇0-9]+\s*[章节卷篇回部集]|Chapter\s+\d+|Part\s+[IVX\d]+)/i
  const titleOf = (blocks: Block[]): string | null => {
    const first = blocks[0]
    if (!first) return null
    const t = first.text.replace(/\s+/g, ' ').trim()
    if (!t || t.length > 60) return null
    if (/^h[1-3]$/.test(first.tag)) return t
    if (CHAPTER_RE.test(t) && !/[。！？；]$/.test(t)) return t
    return null
  }

  // 书里的目录页：连续出现多个章节标题的行，收进词表用于校正标题
  const tocTitles = new Set<string>()
  for (const pg of pages) {
    const hits = pg.map((b) => b.text.trim()).filter((t) => CHAPTER_RE.test(t) && t.length <= 60)
    if (hits.length >= 5) hits.forEach((t) => tocTitles.add(t))
  }

  if (pages.length > 1) {
    let cur: Block[] = []
    let curTitle = ''
    const flush = () => {
      if (cur.length) {
        const joined = cur.map((b) => b.text).join(' ')
        pushBlocks(cur, curTitle || snippetTitle(joined) || `正文 ${sections.length + 1}`)
      }
      cur = []
    }
    for (const pg of pages) {
      const t = titleOf(pg)
      const isToC = pg.some((b) => /^目\s*录$/.test(b.text.trim()))
      if (isToC && !cur.length) {
        pushBlocks(pg, '目录')
        continue
      }
      const startsChapter =
        !!t &&
        (tocTitles.has(t) || CHAPTER_RE.test(t) || /^h[1-3]$/.test(pg[0]?.tag ?? '')) &&
        cur.length > 0
      if (startsChapter) {
        flush()
        curTitle = t!
      }
      if (!cur.length && !curTitle && t) curTitle = t
      cur.push(...pg)
      // 单节过长时按 20000 字再切，避免一个 section 塞满整本
      const size = cur.reduce((n, b) => n + b.text.length, 0)
      if (size > 20000) {
        flush()
        curTitle = ''
      }
    }
    flush()
  } else {
    const CHUNK = 12000
    let i = 0
    let n = 0
    while (i < allBlocks.length) {
      let size = 0
      let j = i
      while (j < allBlocks.length && size < CHUNK) {
        size += allBlocks[j].text.length
        j++
      }
      const part = allBlocks.slice(i, j)
      pushBlocks(part, snippetTitle(part.map((b) => b.text).join(' ')) || `正文 ${++n}`)
      i = j
    }
  }

  if (!sections.length) throw new Error('这本书没有可读的正文')

  const title = (meta[503] || '').trim() || '未命名电子书'
  const author = (meta[100] || '').trim()
  const lang = (meta[524] || '').trim()

  // 封面：正文记录之后的图片记录里找第一张 JPEG/PNG
  let cover: string | undefined
  for (let i = textRecordCount + 1; i < numRecords; i++) {
    const s = offsets[i]
    const e = offsets[i + 1] ?? buf.length
    if (s === undefined || e - s < 5000) continue
    const b = buf.subarray(s, e)
    const isJpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    if (!isJpg && !isPng) continue
    const mime = isJpg ? 'image/jpeg' : 'image/png'
    cover = `data:${mime};base64,${Buffer.from(b).toString('base64')}`
    break
  }

  return { title, author, lang, sections, cover }
}
