import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { getSetting, setSetting } from './db'
import type { DiscussionMode } from './prompts'

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 调用用途：不同用途各用一条固定会话，避免互相污染，也避免列表膨胀 */
export type CallPurpose = 'discuss' | 'translate'

export interface CallOpts {
  json?: boolean
  temperature?: number
  maxTokens?: number
  purpose?: CallPurpose
}

/** 会话在 settings 里的键：{ discuss: {id, calls}, translate: {id, calls} } */
const SESSION_KEY = 'ai.oc.session'

interface SessionState {
  id?: string
  calls?: number
}

export interface ModelConfig {
  kind: 'mock' | 'openai' | 'opencode'
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  /** kind=opencode 时的 CLI 路径（留空则用默认路径） */
  cliPath?: string
}

/** OpenCode 自带 CLI 的默认位置（本机 2.x 桌面版） */
export const DEFAULT_OPENCODE_CLI = 'D:\\OpenCode\\app\\resources\\opencode-cli.exe'

/** OpenCode 免费模型（provider/model） */
export const OPENCODE_MODELS: Array<{ id: string; name: string }> = [
  { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash（快、中文稳）' },
  { id: 'opencode/glm-5.3-flash-free', name: 'GLM 5.3 Flash（较慢，长文强）' },
  { id: 'opencode/minimax-m3.1-flash-free', name: 'MiniMax M3.1 Flash' },
  { id: 'opencode/mimo-v2.6-flash-free', name: 'MiMo v2.6 Flash' },
  { id: 'opencode/longcat-2.5-preview-free', name: 'LongCat 2.5 Preview' },
  { id: 'opencode/nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning' },
  { id: 'opencode/nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super（多模态）' },
  { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra' },
  { id: 'opencode/beam-free', name: 'Beam（部分地区不可用）' }
]

/** 常见通道预设（只是填表方便，不锁定） */
export const PRESETS: Array<{ id: string; name: string; baseUrl: string; model: string; needKey: boolean }> = [
  { id: 'mock', name: '本地模拟（不联网）', baseUrl: '', model: 'mock', needKey: false },
  { id: 'opencode', name: 'OpenCode 免费模型（走本机 CLI）', baseUrl: '', model: 'opencode/deepseek-v4.1-flash-free', needKey: false },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needKey: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true },
  { id: 'moonshot', name: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', needKey: true },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', needKey: true },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needKey: true },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needKey: false }
]

export function loadModelConfig(): ModelConfig {
  return {
    kind: (getSetting('ai.kind', 'mock') as ModelConfig['kind']) || 'mock',
    baseUrl: getSetting('ai.baseUrl', 'https://api.deepseek.com/v1'),
    apiKey: getSetting('ai.apiKey', ''),
    model: getSetting('ai.model', 'deepseek-chat'),
    temperature: Number(getSetting('ai.temperature', '0.6')) || 0.6,
    cliPath: getSetting('ai.cliPath', '')
  }
}

/** 两套模型：main 干活，review 审校。review 没配就跟随 main。 */
export function loadProfile(which: 'main' | 'review'): ModelConfig {
  const base = loadModelConfig()
  if (which === 'main') return base
  const kind = getSetting('ai.review.kind', '')
  if (!kind) return base
  return {
    kind: kind as ModelConfig['kind'],
    baseUrl: getSetting('ai.review.baseUrl', base.baseUrl),
    apiKey: getSetting('ai.review.apiKey', base.apiKey),
    model: getSetting('ai.review.model', base.model),
    temperature: Number(getSetting('ai.review.temperature', '0.3')) || 0.3,
    cliPath: getSetting('ai.review.cliPath', base.cliPath ?? '')
  }
}

/**
 * 走本机 OpenCode CLI 的免费模型。
 * 免费额度只能在 OpenCode 本体里用（直连 Zen 网关会 403 FreeTierError），
 * 所以这里每次调用起一个 `opencode-cli run --format json` 子进程。
 */
function callOpenCode(
  messages: ChatMsg[],
  cfg: ModelConfig,
  opts: CallOpts = {}
): Promise<string> {
  const cli = cfg.cliPath?.trim() || DEFAULT_OPENCODE_CLI
  const prompt = flattenMessages(messages, opts.json)
  // Windows 单个参数上限约 32K 字符，超了直接给可读的错误
  if (prompt.length > 24000) throw new Error('这一次的上下文太长了（超过 2.4 万字），OpenCode CLI 传不进去')

  const purpose: CallPurpose = opts.purpose ?? 'discuss'
  const base = ['run', '--model', cfg.model, '--format', 'json', '--title', sessionTitle(purpose)]
  return runWithSession(cli, base, prompt, purpose)
}

/** 一个用途固定复用一条会话，避免每次调用都往会话列表里多塞一条 */
async function runWithSession(cli: string, base: string[], prompt: string, purpose: CallPurpose): Promise<string> {
  const state = loadSessionState()
  let cur = state[purpose] ?? {}

  const attempt = (sid?: string) =>
    runCli(cli, sid ? [...base, '--session', sid, prompt] : [...base, prompt])

  let res: { text: string; sessionID: string }
  try {
    res = await attempt(cur.id || undefined)
  } catch (e) {
    // 旧会话失效或上下文超长：删掉重来一次
    if (!cur.id) throw e
    deleteSessionQuietly(cli, cur.id)
    cur = {}
    res = await attempt(undefined)
  }

  const sid = res.sessionID
  if (sid) {
    const calls = cur.id === sid ? (cur.calls ?? 0) + 1 : 1
    state[purpose] = { id: sid, calls }
    saveSessionState(state)
  }

  const text = res.text.trim()
  if (!text) throw new Error('OpenCode 没有返回内容')
  return text
}

/** 跑一次 CLI，拿到回答和会话 ID */
function runCli(cli: string, args: string[]): Promise<{ text: string; sessionID: string }> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let done = false
    let child: any
    try {
      child = spawn(cli, args, { cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e: any) {
      reject(new Error(`启动 OpenCode CLI 失败：${e?.message ?? e}`))
      return
    }

    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error('OpenCode 响应超时（120 秒）'))
    }, 120_000)

    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8')
    })
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf8')
    })
    child.on('error', (e: any) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(e?.code === 'ENOENT' ? `找不到 OpenCode CLI：${cli}` : `OpenCode CLI 启动失败：${e?.message ?? e}`))
    })
    child.on('close', (code: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const { text, error, sessionID } = parseCliOutput(out)
      if (error) return reject(new Error(error))
      if (!text.trim()) {
        return reject(new Error(`OpenCode 没有返回内容（退出码 ${code}）${err ? '：' + err.slice(0, 200) : ''}`))
      }
      resolve({ text, sessionID })
    })
  })
}

function sessionTitle(purpose: CallPurpose): string {
  return purpose === 'translate' ? '页边 · 翻译流水线' : '页边 · 讨论与学习'
}

function loadSessionState(): Record<string, SessionState> {
  try {
    const raw = JSON.parse(getSetting(SESSION_KEY, '{}'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function saveSessionState(s: Record<string, SessionState>) {
  try {
    setSetting(SESSION_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

/** 静默删掉一条旧会话（不阻塞当前调用） */
function deleteSessionQuietly(cli: string, id: string) {
  if (!id) return
  try {
    const c = spawn(cli, ['session', 'delete', id], {
      cwd: tmpdir(),
      windowsHide: true,
      stdio: 'ignore',
      detached: true
    })
    c.on('error', () => {
      /* ignore */
    })
    c.unref()
  } catch {
    /* ignore */
  }
}

/** 列出并删除「页边」在 OpenCode 里留下的会话（标题以“页边”开头） */
export async function cleanupSessions(): Promise<{ deleted: number; kept: number }> {
  const cfg = loadModelConfig()
  const cli = cfg.cliPath?.trim() || DEFAULT_OPENCODE_CLI
  let text = ''
  try {
    text = await new Promise<string>((resolve, reject) => {
      const c = spawn(cli, ['session', 'list', '-n', '300', '--format', 'json'], {
        cwd: tmpdir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let out = ''
      c.stdout?.on('data', (d) => (out += String(d)))
      c.on('error', reject)
      c.on('close', () => resolve(out))
    })
  } catch {
    return { deleted: 0, kept: 0 }
  }
  let list: Array<{ id: string; title?: string }> = []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) list = parsed
  } catch {
    return { deleted: 0, kept: 0 }
  }
  const mine = list.filter((s) => (s.title || '').startsWith('页边'))
  for (const s of mine) {
    await new Promise<void>((resolve) => {
      try {
        const c = spawn(cli, ['session', 'delete', s.id], { cwd: tmpdir(), windowsHide: true, stdio: 'ignore' })
        c.on('close', () => resolve())
        c.on('error', () => resolve())
      } catch {
        resolve()
      }
    })
  }
  saveSessionState({})
  return { deleted: mine.length, kept: list.length - mine.length }
}

/** 把多轮消息拼成 CLI 能吃的一段话（它只有位置参数，没有 messages 接口） */
function flattenMessages(messages: ChatMsg[], json?: boolean): string {
  const parts: string[] = []
  let system = ''
  for (const m of messages) {
    if (m.role === 'system') {
      system += m.content + '\n'
      continue
    }
    if (m.role === 'assistant') parts.push(`【你刚才的回答】\n${m.content}`)
    else parts.push(m.content)
  }
  const head = [system.trim(), json ? '只输出合法 JSON，不要解释，不要代码块。' : ''].filter(Boolean).join('\n')
  const body = parts.join('\n\n')
  const all = head ? `${head}\n\n${body}` : body
  // 以 - 开头会被当成命令行参数
  return all.startsWith('-') ? ' ' + all : all
}

/** 解析 `--format json` 的 JSONL 输出 */
function parseCliOutput(stdout: string): { text: string; error?: string; sessionID: string } {
  let text = ''
  let error = ''
  let sessionID = ''
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let ev: any
    try {
      ev = JSON.parse(s)
    } catch {
      continue
    }
    if (ev?.sessionID && !sessionID) sessionID = String(ev.sessionID)
    if (ev?.type === 'text' && ev?.part?.type === 'text') text += ev.part.text
    else if (ev?.type === 'error') {
      const e = ev.error ?? {}
      const msg = e.message || e.data?.message || '未知错误'
      error = e.status ? `${msg}（${e.status}）` : msg
    }
  }
  return { text, error: error || undefined, sessionID }
}

/** 统一出口：所有 AI 调用都走这里，方便以后换协议 / 加统计 */
export async function callModel(
  messages: ChatMsg[],
  cfg: ModelConfig,
  opts: CallOpts = {}
): Promise<string> {
  if (cfg.kind === 'opencode') return callOpenCode(messages, cfg, opts)
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body: any = {
    model: cfg.model,
    temperature: opts.temperature ?? cfg.temperature,
    messages: opts.json ? [{ role: 'system', content: '只输出合法 JSON，不要解释，不要代码块。' }, ...messages] : messages,
    stream: false
  }
  if (opts.json) body.response_format = { type: 'json_object' }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 90_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`模型调用失败 (${res.status})：${text.slice(0, 300)}`)
    }
    const json: any = await res.json()
    const content = json?.choices?.[0]?.message?.content
    if (!content) throw new Error('模型返回为空')
    return String(content).trim()
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('模型响应超时（90 秒）')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 讨论用：mock 模式下按模式给示例 */
export async function complete(messages: ChatMsg[], cfg: ModelConfig, mode: DiscussionMode): Promise<string> {
  if (cfg.kind === 'mock') return mockReply(mode)
  return callModel(messages, cfg)
}

/** 结构化输出：mock 模式直接返回调用方给的示例 */
export async function completeJson<T>(messages: ChatMsg[], cfg: ModelConfig, mockValue: T, opts: { maxTokens?: number; temperature?: number; purpose?: CallPurpose } = {}): Promise<T> {
  if (cfg.kind === 'mock') return mockValue
  const raw = await callModel(messages, cfg, { json: true, temperature: opts.temperature ?? 0.3, maxTokens: opts.maxTokens, purpose: opts.purpose })
  return parseJsonLoose<T>(raw)
}

/** 模型有时会包一层 ```json``` 或者前后加话，尽量宽容地取出 JSON */
export function parseJsonLoose<T>(raw: string): T {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const balanced = extractBalanced(s)
  if (balanced) s = balanced
  return JSON.parse(s) as T
}

/** 从字符串里截出第一段结构完整的 JSON（跳过字符串内的括号，容忍模型多吐的解释文字） */
function extractBalanced(s: string): string | null {
  const start = s.search(/[[{]/)
  if (start < 0) return null
  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/** 设置页的「测试连接」 */
export async function testModel(cfg: ModelConfig): Promise<{ ok: boolean; ms: number; model: string; error?: string }> {
  const t0 = Date.now()
  if (cfg.kind === 'mock') return { ok: true, ms: 0, model: 'mock' }
  try {
    const text = await callModel([{ role: 'user', content: '只回两个字：正常' }], cfg, { temperature: 0, maxTokens: 16 })
    return { ok: true, ms: Date.now() - t0, model: cfg.model, error: text.slice(0, 40) }
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, model: cfg.model, error: e?.message ?? String(e) }
  }
}

function mockReply(mode: DiscussionMode): string {
  const map: Record<DiscussionMode, string> = {
    socratic:
      '我先不给结论——你划线这句话里，作者用的是"他"，你觉得这个"他"指的是谁？为什么这里不直接说名字？[模拟回复，未接入模型]',
    explain:
      '一句话：这句话在给前文那个判断补一个限定条件。\n\n依据：\n1. 前一段先把结论说满了；[前文 紧邻]\n2. 这里用转折把它收窄。\n\n检验一下：如果把"但是"删掉，意思会变成什么？[模拟回复，未接入模型]',
    challenge:
      '作者的立场是：这个机制普遍成立。\n\n可以反过来的两点：\n1. 它依赖一个未被证明的前提（[书外] 同类研究里这个前提常被质疑）；\n2. 前文给的例子只是一次个案，不足以支撑"普遍"。\n\n你更信哪一边？[模拟回复，未接入模型]',
    external:
      '书外的参照大致有三支：一支把这种现象看作制度产物，一支看作认知偏差，还有一支干脆否认它存在。[书外]\n\n注意：这些都不是本书后文会讲的内容，只是外部视角。[模拟回复，未接入模型]'
  }
  return map[mode]
}
