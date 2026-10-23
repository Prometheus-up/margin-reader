import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseDocx } from './docx'
import { parseMobi } from './mobi'
import { parsePdf } from './pdf'

function makeDocx(): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 开场</w:t></w:r></w:p>
<w:p><w:r><w:t>这是第一段正文，用来验证 docx 解析。</w:t></w:r></w:p>
<w:p><w:r><w:t>第二段里有一个</w:t></w:r><w:r><w:t>被拆成两段 run 的句子</w:t></w:r><w:r><w:t>。</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第二章 边界</w:t></w:r></w:p>
<w:p><w:r><w:t>第二章正文，讨论只使用已读部分。</w:t></w:r></w:p>
<w:p><w:r><w:t>然后这里还有一个 &amp; 转义符。</w:t></w:r></w:p>
</w:body></w:document>`
  const core = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试文档</dc:title><dc:creator>某人</dc:creator></cp:coreProperties>`
  return zipSync({
    'word/document.xml': strToU8(document),
    'docProps/core.xml': strToU8(core)
  })
}

function makeMobi(opts: { html: string; encryption?: number }): Uint8Array {
  const html = new TextEncoder().encode(opts.html)
  const rec0 = new Uint8Array(16)
  const dv = new DataView(rec0.buffer)
  dv.setUint16(0, 1) // 不压缩
  dv.setUint32(4, html.length)
  dv.setUint16(8, 1)
  dv.setUint16(10, 4096)
  dv.setUint16(12, opts.encryption ?? 0)

  const numRecords = 2
  const headerSize = 78 + numRecords * 8
  const buf = new Uint8Array(headerSize + rec0.length + html.length)
  const out = new DataView(buf.buffer)
  const name = new TextEncoder().encode('test.mobi')
  buf.set(name, 0)
  out.setUint16(76, numRecords)
  out.setUint32(78, headerSize)
  out.setUint32(86, headerSize + rec0.length)
  buf.set(rec0, headerSize)
  buf.set(html, headerSize + rec0.length)
  return buf
}

/** 一个最小可用的单页 PDF（Helvetica，两种字号模拟段落） */
function makePdf(): Uint8Array {
  const content = [
    'BT /F1 18 Tf 72 760 Td (Margin PDF Sample) Tj ET',
    'BT /F1 12 Tf 72 720 Td (This is the first paragraph of the test document.) Tj ET',
    'BT /F1 12 Tf 72 700 Td (It should be grouped into sentences.) Tj ET',
    'BT /F1 12 Tf 72 660 Td (Second paragraph starts here.) Tj ET'
  ].join('\n')

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

describe('docx', () => {
  const book = parseDocx(makeDocx())

  it('读出元数据并按一级标题切章', () => {
    expect(book.title).toBe('测试文档')
    expect(book.author).toBe('某人')
    expect(book.sections.length).toBe(2)
    expect(book.sections[0].title).toBe('第一章 开场')
  })

  it('合并被拆散的 run，保留转义符', () => {
    expect(book.sections[0].text).toContain('被拆成两段 run 的句子。')
    expect(book.sections[1].text).toContain('& 转义符')
  })

  it('块偏移与正文对得上', () => {
    for (const s of book.sections) {
      for (const b of s.blocks) {
        expect(s.text.slice(b.start, b.end)).toBe(b.text)
      }
    }
  })
})

describe('mobi', () => {
  it('解析未压缩的 MOBI 正文', () => {
    const book = parseMobi(makeMobi({ html: '<html><body><p>你好，页边。</p><p>第二段。</p></body></html>' }))
    expect(book.sections[0].text).toContain('你好，页边')
    expect(book.sections[0].text).toContain('第二段')
  })

  it('DRM 加密的书直接拒绝', () => {
    expect(() => parseMobi(makeMobi({ html: '<p>x</p>', encryption: 2 }))).toThrow(/DRM/)
  })
})

describe('pdf', () => {
  it('抽取文字层并按行聚合', async () => {
    const book = await parsePdf(makePdf())
    expect(book.sections.length).toBe(1)
    expect(book.sections[0].text).toContain('Margin PDF Sample')
    expect(book.sections[0].text).toContain('first paragraph')
    for (const b of book.sections[0].blocks) {
      expect(book.sections[0].text.slice(b.start, b.end)).toBe(b.text)
    }
  })
})
