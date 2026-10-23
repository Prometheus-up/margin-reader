import { describe, it, expect, beforeAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseEpub } from './epub'
import { initDatabase, insertBook, listBooks, listSections, getSection, createAnnotation, searchBefore } from './db'
import { buildContext } from './context'

function fixture(): Uint8Array {
  return zipSync({
    'META-INF/container.xml': strToU8(
      `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`
    ),
    'OEBPS/content.opf': strToU8(`<package><metadata>
      <dc:title xmlns:dc="x">整链测试</dc:title></metadata>
      <manifest>
        <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    'OEBPS/c1.xhtml': strToU8(`<html><body>
      <h1>第一章</h1>
      <p>城市在雨里显得很安静。</p>
      <p>他想起十年前的那个夏天，也是这样的雨。</p>
      </body></html>`),
    'OEBPS/c2.xhtml': strToU8(`<html><body>
      <h1>第二章</h1>
      <p>第二天清晨，雨停了。</p>
      <p>他决定不再等那封信。</p>
      <p>结局：他离开了这座城市，再也没有回来。</p>
      </body></html>`)
  })
}

describe('整链：EPUB → SQLite → 上下文', () => {
  let bookId = ''

  beforeAll(() => {
    initDatabase(':memory:')
    const parsed = parseEpub(fixture())
    bookId = insertBook('test://demo.epub', 'epub', parsed)
  })

  it('书籍与章节落库', () => {
    const books = listBooks()
    expect(books.length).toBe(1)
    expect(books[0].title).toBe('整链测试')
    const secs = listSections(bookId)
    expect(secs.length).toBe(2)
    expect(secs[0].char_start).toBe(0)
    expect(secs[1].char_start).toBeGreaterThan(secs[0].char_end)
  })

  it('章节块与文本可从库里取回', () => {
    const s = getSection(bookId, 1)!
    expect(s.text).toContain('第二天清晨')
    expect(s.blocks.length).toBeGreaterThanOrEqual(3)
    expect(s.text.slice(s.blocks[1].start, s.blocks[1].end)).toBe(s.blocks[1].text)
  })

  it('划线 + 前文检索 + 上下文装配，全程不泄漏后文', () => {
    const s2 = getSection(bookId, 1)!
    const target = s2.blocks[1] // 他决定不再等那封信。
    const globalPos = s2.char_start + target.start + 3
    const quote = target.text.slice(3, 9)

    const ann = createAnnotation({
      book_id: bookId,
      sec_idx: 1,
      char_start: target.start + 3,
      char_end: target.start + 9,
      global_pos: globalPos,
      quote,
      prefix: '',
      suffix: '',
      note: '',
      color: 'yellow'
    })
    expect(ann.id).toBeTruthy()

    const hits = searchBefore(bookId, quote, globalPos, 5)
    for (const h of hits) expect(h.char_end).toBeLessThanOrEqual(globalPos)

    const sections = listSections(bookId).map((m) => {
      const full = getSection(bookId, m.idx)!
      return { idx: m.idx, title: m.title, charStart: m.char_start, charEnd: m.char_end, blocks: full.blocks, text: full.text }
    })

    const ctx = buildContext({
      sections,
      globalPos,
      quote,
      retrieved: hits.map((h) => ({ secIdx: h.sec_idx, start: h.char_start, end: h.char_end, text: h.text }))
    })

    expect(ctx.contextText).not.toContain('结局')
    expect(ctx.contextText).not.toContain('再也没有回来')
    expect(ctx.contextText).toContain('城市在雨里')
    expect(ctx.contextText).toContain('本章已读部分')
    expect(ctx.contextText).toContain('第二天')
    expect(ctx.stats.percent).toBeGreaterThan(0)
  })
})
