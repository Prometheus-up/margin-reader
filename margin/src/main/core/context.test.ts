import { describe, it, expect } from 'vitest'
import { buildContext, ContextLeakError, type SectionLite } from './context'

function makeSection(idx: number, title: string, paras: string[], charStart: number): SectionLite {
  let cursor = 0
  const blocks = paras.map((text, i) => {
    const start = cursor
    cursor = start + text.length + 1
    return { i, tag: 'p', text, html: text, start, end: start + text.length }
  })
  const text = paras.join('\n')
  return { idx, title, charStart, charEnd: charStart + text.length, blocks, text }
}

const s1 = makeSection(0, '第一章', ['甲段落在前面。', '乙段落也在前面。'], 0)
const s2 = makeSection(1, '第二章', ['丙段落是第二章开头。', '丁段落是划线所在段。', '戊段落是后文秘密A。', '己段落是后文秘密B。'], s1.charEnd + 1)

describe('buildContext — 后文隔离', () => {
  const secondBlock = s2.blocks[1]
  const globalPos = s2.charStart + secondBlock.start + 8 // 划到"丁段落是划线所在"之后

  it('上下文里不出现划线之后的正文', () => {
    const r = buildContext({ sections: [s1, s2], globalPos, quote: '划线所在段' })
    expect(r.contextText).not.toContain('秘密A')
    expect(r.contextText).not.toContain('秘密B')
    expect(r.contextText).toContain('丙段落是第二章开头')
    expect(r.contextText).toContain('甲段落在前面')
  })

  it('划线所在段落被截断在划线位置', () => {
    const r = buildContext({ sections: [s1, s2], globalPos, quote: '划线所在段' })
    expect(r.contextText).toContain('丁段落是划线')
    expect(r.contextText).not.toContain('所在段。') // 截断点在"划线"之后
  })

  it('所有来源区间都结束于划线位置之前（或划线本身）', () => {
    const r = buildContext({ sections: [s1, s2], globalPos, quote: '划线所在段' })
    for (const s of r.sources) {
      expect(s.end).toBeLessThanOrEqual(globalPos + '划线所在段'.length)
    }
  })

  it('后文检索结果会被丢弃', () => {
    const r = buildContext({
      sections: [s1, s2],
      globalPos,
      quote: '划线所在段',
      retrieved: [{ secIdx: 1, start: globalPos + 10, end: globalPos + 40, text: '这是后文' }]
    })
    expect(r.contextText).not.toContain('这是后文')
    expect(r.stats.retrieved).toBe(0)
  })

  it('前文检索结果保留', () => {
    const r = buildContext({
      sections: [s1, s2],
      globalPos,
      quote: '划线所在段',
      retrieved: [{ secIdx: 0, start: 0, end: 5, text: '甲段落在前面。' }]
    })
    expect(r.stats.retrieved).toBe(1)
    expect(r.contextText).toContain('【前文中与此相关的段落】')
  })

  it('读者以前的思考会被注入上下文（长期记忆）', () => {
    const r = buildContext({
      sections: [s1, s2],
      globalPos,
      quote: '划线所在段',
      utterances: [
        { text: '我第一次读到这儿，觉得停下来是因为意外。', at: 1 },
        { text: '后来我又想，也许是因为不同意。', at: 2 }
      ]
    })
    expect(r.stats.memory).toBe(2)
    expect(r.contextText).toContain('此前的思考')
    expect(r.contextText).toContain('停下来是因为意外')
  })
})

describe('buildContext — 长书摘要路径', () => {
  it('超出预算时改用逐章概要，且仍不泄漏后文', () => {
    const long = makeSection(0, '长章', Array.from({ length: 40 }, (_, i) => '内容'.repeat(100) + i), 0)
    const s2b = makeSection(1, '第二章', ['起点段。', '划线段。', '后文绝密内容。'], long.charEnd + 1)
    const pos = s2b.charStart + s2b.blocks[1].start
    const r = buildContext({ sections: [long, s2b], globalPos: pos, quote: '划线段', budgetChars: 2000 })
    expect(r.contextText).not.toContain('后文绝密内容')
    expect(r.contextText).toContain('前文脉络')
  })
})
