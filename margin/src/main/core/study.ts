import { completeJson, type ChatMsg } from './ai'

export interface GenCard {
  front: string
  back: string
}

const CARD_SYS = `你在帮读者把「划线」变成可复习的卡片。
要求：
1. 卡片只考这条划线本身能支撑的内容，禁止引入书外知识，禁止超出给定原文。
2. front 是一个能独立回答的问题（不要写"这段话说明了什么"这种空问题，要具体到概念、因果、条件）。
3. back 控制在 60 字以内，用读者自己的话，不要抄原文整句。
4. 最多 2 张，宁可少而准。中文。`

export async function generateCards(
  input: { bookTitle: string; secTitle: string; quote: string; note: string; context: string },
  cfg: any
): Promise<GenCard[]> {
  const mock: { cards: GenCard[] } = {
    cards: [
      {
        front: `作者在「${input.quote.slice(0, 12)}…」这里想强调的是哪个判断？`,
        back: input.note || '划线只是把位置固定下来，并不解释为什么在这里停住。'
      },
      {
        front: '「划线」和「理解」的关系是什么？',
        back: '划线标记了停下来的位置，理解要靠说出为什么停。'
      }
    ]
  }

  const user = `书名：《${input.bookTitle}》
章节：${input.secTitle}
划线原文：「${input.quote}」
读者的批注：${input.note || '（无）'}
划线之前的上下文（仅供理解，不要当考点）：
${input.context.slice(0, 1200)}

请输出 JSON：{"cards":[{"front":"...","back":"..."}]}`

  const messages: ChatMsg[] = [
    { role: 'system', content: CARD_SYS },
    { role: 'user', content: user }
  ]
  const out = await completeJson<{ cards: GenCard[] }>(messages, cfg, mock, { maxTokens: 600 })
  return (out.cards ?? []).filter((c) => c?.front && c?.back).slice(0, 3)
}

const SUM_SYS = `你在帮读者做章节回顾。
要求：
1. 只根据给定的这一章正文，不要补充书外知识。
2. 输出 120–180 字，讲清这一章在推进什么论点、用了什么例子、结论是什么。
3. 不要逐段复述，要能让人读完就知道这章在干什么。
4. 中文，平实，不要"本章深入探讨了"这类套话。`

export async function summarizeSection(
  input: { bookTitle: string; secTitle: string; text: string },
  cfg: any
): Promise<{ summary: string; keywords: string[] }> {
  const body = input.text.slice(0, 7000)
  const mock = {
    summary: `这一节从「${input.secTitle}」切入，先给了一个具体场景，再抽出其中的判断，最后指出这个判断成立需要的条件。作者的落点不在结论本身，而在得出结论的过程。`,
    keywords: ['判断', '条件', '过程']
  }
  const messages: ChatMsg[] = [
    { role: 'system', content: SUM_SYS },
    {
      role: 'user',
      content: `书名：《${input.bookTitle}》\n章节：${input.secTitle}\n正文：\n${body}\n\n请输出 JSON：{"summary":"...","keywords":["...","...","..."]}`
    }
  ]
  const out = await completeJson<{ summary: string; keywords: string[] }>(messages, cfg, mock, { maxTokens: 800 })
  return { summary: out.summary ?? '', keywords: (out.keywords ?? []).slice(0, 4) }
}
