import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ppOcrAvailable, ppOcrPng } from './ppocr'

/**
 * 扫描版 PDF 的 OCR。
 *
 * 两段式：
 * 1. scripts/render.ps1 用 Windows 自带的 Windows.Data.Pdf 把页面渲染成 PNG（每页 ~0.2 秒，不用装 poppler）；
 * 2. 识别走 PP-OCRv4（PaddleOCR 的模型，见 ppocr.ts），质量比 Windows 自带的 OCR 高一大截。
 *
 * 结果带着行框像素坐标，交给 pdf.ts 复用「行 → 段 → 节」那套逻辑。
 * 每页识别完立刻单独落盘缓存（%APPDATA%\页边\ocr-cache），中途失败或重导都不用从头再来。
 */

export interface OcrWord {
  t: string
  x: number
  y: number
  w: number
  h: number
}

export interface OcrLine {
  t: string
  x: number
  y: number
  words: OcrWord[]
}

export interface OcrPage {
  page: number
  w: number
  h: number
  lines: OcrLine[]
}

function findScript(name: string): string {
  let here = process.cwd()
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    /* 打包成 CJS 后没有 import.meta */
  }
  const cands = [
    process.env.MARGIN_OCR_SCRIPT ? join(process.env.MARGIN_OCR_SCRIPT, name) : '',
    join((process as any).resourcesPath ?? '', 'app', 'scripts', name),
    join(process.cwd(), 'scripts', name),
    join(here, '..', '..', 'scripts', name),
    join(here, '..', '..', '..', 'scripts', name)
  ]
  return cands.find((p) => p && existsSync(p)) ?? ''
}

/** 本机能不能 OCR（非 Windows、缺渲染脚本或缺模型就返回 false，导入时报可读的错误） */
export function ocrSupported(): boolean {
  return process.platform === 'win32' && !!findScript('render.ps1') && ppOcrAvailable()
}

export interface OcrOptions {
  /** 渲染宽度上限：2500 对 32 开扫描件足够，再大只是变慢 */
  maxWidth?: number
  onProgress?: (done: number, total: number) => void
  /** 每识别完一页回调，便于流式落盘 */
  onPage?: (page: OcrPage) => void
}

/** 跑一次 PowerShell 脚本，边跑边解析进度行 */
function runPs(
  script: string,
  args: string[],
  onLine?: (line: string) => void
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true }
    )
    let stderr = ''
    let settled = false
    const finish = (err: Error | null, code = 0) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve({ code, stderr })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('PDF 渲染超时（超过 1 小时）'))
    }, 60 * 60 * 1000)
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      stderr = (stderr + s).slice(-4000)
      for (const line of s.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim())
    })
    child.on('error', (e) => finish(new Error(`渲染进程启动失败：${e.message}`)))
    child.on('close', (code) => {
      // PowerShell 收尾时偶发访问违例（0xC0000005），页面已经写出来了就照常返回
      const avCrash = code === 3221225477 || code === -1073741819
      finish(null, avCrash ? 0 : (code ?? 0))
    })
  })
}

/** 页缓存目录：同一份文件（内容哈希）只识别一次 */
function cacheDirFor(pdfPath: string): string {
  const root = process.env.APPDATA ? join(process.env.APPDATA, '页边') : tmpdir()
  const base = process.env.MARGIN_OCR_CACHE ?? join(root, 'ocr-cache')
  let hash = 'nohash'
  try {
    hash = createHash('sha1').update(readFileSync(pdfPath)).digest('hex')
  } catch {
    /* 读不到内容就不缓存 */
  }
  const dir = join(base, hash)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return ''
  }
  return dir
}

function readCached(dir: string, page: number): OcrPage | null {
  if (!dir) return null
  const f = join(dir, `p${String(page).padStart(4, '0')}.json`)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as OcrPage
  } catch {
    return null
  }
}

function writeCached(dir: string, page: OcrPage): void {
  if (!dir) return
  try {
    writeFileSync(join(dir, `p${String(page.page).padStart(4, '0')}.json`), JSON.stringify(page), 'utf8')
  } catch {
    /* 缓存写不进去不影响这一次导入 */
  }
}

/** PP-OCR 的一行结果转成 OCR 页结构（每行一个「词」，保留行框用于判字号/脚注） */
function toOcrPage(page: number, w: number, h: number, lines: { t: string; x: number; y: number; w: number; h: number }[]): OcrPage {
  return {
    page,
    w,
    h,
    lines: lines.map((l) => {
      // 圈号脚注标记（①-⑳）就地转成私有标记，后面会变成可点击的角标；
      // 行首的圈号通常是脚注正文自己的编号，不动
      const t = l.t.replace(/[\u2460-\u2473]/g, (m, off: number) => (off > 2 ? `\u0001${m}\u0001` : m))
      return { t, x: l.x, y: l.y, words: [{ t, x: l.x, y: l.y, w: l.w, h: l.h }] }
    })
  }
}

const CHUNK = 24

/** 对一个已落盘的 PDF 做逐页 OCR（调用方负责清理临时文件） */
export async function ocrPdfFile(pdfPath: string, opts: OcrOptions = {}): Promise<OcrPage[]> {
  const script = findScript('render.ps1')
  if (process.platform !== 'win32' || !script) {
    throw new Error('这台机器不支持离线 OCR（需要 Windows）')
  }
  if (!ppOcrAvailable()) {
    throw new Error('OCR 模型文件缺失（models/），请重新安装或把 models 目录放到应用目录下')
  }
  const dir = cacheDirFor(pdfPath)
  const maxWidth = String(opts.maxWidth ?? 2500)
  const pages: OcrPage[] = []
  let total = 0

  for (let from = 1; ; from += CHUNK) {
    const to = total ? Math.min(total, from + CHUNK - 1) : from + CHUNK - 1
    if (total && from > total) break
    // 这一块全都识别过了就不用再渲染
    const need: number[] = []
    for (let i = from; i <= to && (!total || i <= total); i++) if (!readCached(dir, i)) need.push(i)
    if (total && !need.length) {
      for (let i = from; i <= to && i <= total; i++) {
        const c = readCached(dir, i)
        if (c) pages.push(c)
      }
      opts.onProgress?.(Math.min(to, total), total)
      continue
    }

    const tmp = mkdtempSync(join(tmpdir(), 'margin-pages-'))
    try {
      const { stderr } = await runPs(script, ['-Pdf', pdfPath, '-OutDir', tmp, '-From', String(from), '-To', String(to), '-MaxWidth', maxWidth], (line) => {
        if (line.startsWith('T ')) total = Number(line.slice(2)) || total
      })
      if (!total) {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
        throw new Error(`PDF 渲染失败：${tail || '没有读出页数'}`)
      }
      for (let i = from; i <= Math.min(to, total); i++) {
        const cached = readCached(dir, i)
        if (cached) {
          pages.push(cached)
          opts.onProgress?.(i, total)
          continue
        }
        const png = join(tmp, `p${String(i).padStart(4, '0')}.png`)
        if (!existsSync(png)) continue // 个别页渲染不出来就跳过，不至于整本失败
        const res = await ppOcrPng(png)
        const page = toOcrPage(i, res.w, res.h, res.lines)
        pages.push(page)
        writeCached(dir, page)
        opts.onProgress?.(i, total)
      }
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* 临时目录删不掉不影响结果 */
      }
    }
  }

  pages.sort((a, b) => a.page - b.page)
  if (!pages.length) throw new Error('OCR 没有识别出任何内容')
  return pages
}
