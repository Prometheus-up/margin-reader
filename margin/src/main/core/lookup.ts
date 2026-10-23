/**
 * 两件都靠模型的小工具：
 *  - lookupWord：划词释义（标注为「AI 释义」，不是权威词典）
 *  - autoTag：给没标签的摘抄批量提议标签
 * 都遵守「不确定就说不确定」，不允许编造词条。
 */
import { completeJson, loadModelConfig, type ChatMsg, type ModelConfig } from './ai'

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

const DICT_CACHE = new Map<string, DictEntry>()
const DICT_MAX = 300

const DICT_SYS = `你是一部严谨的汉语/英语词典。只解释给定的词，不要扩展话题。
要求：
1. 如果这个词在给定句子里是一个固定短语或专名，按句子里的用法解释，不要罗列无关义项。
2. 不确定的读音、义项、出处一律省略，宁可少写，绝不编造。
3. 最多 3 个义项，每条不超过 40 字。
4. 只输出 JSON：{"word":"词","pinyin":"读音（没有就空字符串）","senses":[{"pos":"词性","def":"释义"}],"usage":"在这句话里怎么理解（≤50字）","caution":"如果是专名/生僻/存疑，在这里说明；否则空字符串"}`

export async function lookupWord(
  word: string,
  sentence: string,
  cfg: ModelConfig = loadModelConfig()
): Promise<DictEntry> {
  const key = `${word}\u0000${sentence.slice(0, 60)}`
  const hit = DICT_CACHE.get(key)
  if (hit) return hit

  const messages: ChatMsg[] = [
    { role: 'system', content: DICT_SYS },
    {
      role: 'user',
      content: `词：${word}\n它所在的句子：${sentence.slice(0, 240)}`
    }
  ]
  const out = await completeJson<DictEntry>(
    messages,
    cfg,
    { word, pinyin: '（本地模拟）', senses: [{ pos: '—', def: '这是本地模拟模式下的示例释义。' }], usage: '接上模型后会按句子语境给出解释。', caution: '' },
    { maxTokens: 500, temperature: 0.2, purpose: 'discuss' }
  )
  const entry: DictEntry = {
    word: out.word || word,
    pinyin: out.pinyin || undefined,
    senses: Array.isArray(out.senses) ? out.senses.filter((s) => s && s.def).slice(0, 3) : [],
    usage: out.usage || undefined,
    caution: out.caution || undefined
  }
  if (DICT_CACHE.size > DICT_MAX) DICT_CACHE.clear()
  DICT_CACHE.set(key, entry)
  return entry
}

export interface TagInput {
  id: string
  quote: string
  note?: string
}

const TAG_SYS = `你在帮读者整理读书摘抄的标签。读者要能从标签上看出「这一类想法属于什么主题」。
要求：
1. 每条给 1–2 个标签，标签 2–5 个汉字，是主题词（如「权力」「翻译」「时间观」），不要用「重要」「感想」这类空词。
2. 只根据引文与批注的字面意思，不要猜测书里没写的内容。
3. 输出 JSON：{"items":[{"n":0,"tags":["主题"]}]}，n 是题目里的编号，一条都不能漏。`

export async function autoTag(items: TagInput[], cfg: ModelConfig = loadModelConfig()): Promise<Array<{ id: string; tags: string[] }>> {
  if (!items.length) return []
  const list = items.slice(0, 40)
  const body = list
    .map((it, i) => `[${i}] 引文：${it.quote.slice(0, 120)}${it.note ? `\n     批注：${it.note.slice(0, 80)}` : ''}`)
    .join('\n')
  const messages: ChatMsg[] = [
    { role: 'system', content: TAG_SYS },
    { role: 'user', content: body }
  ]
  const out = await completeJson<{ items: Array<{ n: number; tags: string[] }> }>(
    messages,
    cfg,
    { items: list.map((_, i) => ({ n: i, tags: ['示例'] })) },
    { maxTokens: 1200, temperature: 0.3, purpose: 'discuss' }
  )
  const rows = Array.isArray(out?.items) ? out.items : []
  const result: Array<{ id: string; tags: string[] }> = []
  for (const row of rows) {
    const idx = Number(row?.n)
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) continue
    const tags = (Array.isArray(row.tags) ? row.tags : [])
      .map((t) => String(t).trim().replace(/^#/, ''))
      .filter((t) => t.length >= 1 && t.length <= 10)
      .slice(0, 3)
    if (!tags.length) continue
    result.push({ id: list[idx].id, tags })
  }
  return result
}
