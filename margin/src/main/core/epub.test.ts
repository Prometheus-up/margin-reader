import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseEpub } from './epub'

function makeEpub(): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title><dc:creator>某作者</dc:creator><dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`),
    'OEBPS/nav.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
      <ol><li><a href="text/ch1.xhtml">第一章 起点</a></li><li><a href="text/ch2.xhtml">第二章 转折</a></li></ol>
    </nav></body></html>`),
    'OEBPS/text/ch1.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch1</title>
      <style>p{color:red}</style><script>alert(1)</script></head>
      <body><h1>第一章 起点</h1>
      <p>第一段：他走进屋子，发现桌上有一封信。</p>
      <p>第二段：信上没有署名，只有<em>一个日期</em>。</p>
      <blockquote>引文一段。</blockquote>
      </body></html>`),
    'OEBPS/text/ch2.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <h1>第二章 转折</h1><div><p>第三段：他决定把信烧掉。</p></div>
      </body></html>`)
  }
  return zipSync(files)
}

describe('parseEpub', () => {
  const book = parseEpub(makeEpub())

  it('读取元数据', () => {
    expect(book.title).toBe('测试之书')
    expect(book.author).toBe('某作者')
    expect(book.lang).toBe('zh-CN')
  })

  it('按 spine 顺序取章节，并用目录标题命名', () => {
    expect(book.sections.length).toBe(2)
    expect(book.sections[0].title).toBe('第一章 起点')
    expect(book.sections[1].title).toBe('第二章 转折')
  })

  it('切分出正文块，且剥离 script/style', () => {
    const s1 = book.sections[0]
    expect(s1.blocks.length).toBeGreaterThanOrEqual(3)
    expect(s1.text).toContain('他走进屋子')
    expect(s1.text).not.toContain('alert')
    expect(s1.text).not.toContain('color:red')
    // 行内标签只保留文字
    expect(s1.text).toContain('一个日期')
  })

  it('块偏移连续可定位', () => {
    const s1 = book.sections[0]
    for (const b of s1.blocks) {
      expect(s1.text.slice(b.start, b.start + b.text.length)).toBe(b.text)
    }
  })
})
