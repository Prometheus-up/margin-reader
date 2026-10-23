import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { initDatabase } from '../main/core/db'
import { handlers, importOne } from '../main/api'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// 静态文件目录：优先 web/（打包后的位置），退回 out/renderer（开发时）
const webDir = [join(root, 'web'), join(root, 'out', 'renderer')].find((p) => existsSync(join(p, 'index.html')))
if (!webDir) {
  console.error('找不到前端文件（web/index.html 或 out/renderer/index.html）')
  process.exit(1)
}

const dataDir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'margin')
mkdirSync(dataDir, { recursive: true })
initDatabase(join(dataDir, 'margin.db'))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(data)
}

async function readBody(req: IncomingMessage, limit = 600 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('文件太大')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  try {
    // ---- API ----
    if (url.pathname === '/api/call' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'))
      const fn = handlers[body.method]
      if (!fn) return sendJson(res, 404, { ok: false, error: `未知接口 ${body.method}` })
      try {
        const data = await fn(...(body.args ?? []))
        return sendJson(res, 200, { ok: true, data })
      } catch (e: any) {
        console.error(`[api] ${body.method} 失败：`, e?.message ?? e)
        return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) })
      }
    }

    // ---- 上传导入 ----
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const name = url.searchParams.get('name') || 'book.epub'
      const reuseId = url.searchParams.get('id') || undefined
      const buf = await readBody(req)
      try {
        const item = await importOne(name, `upload://${name}`, new Uint8Array(buf), reuseId)
        console.log(`[import] ${name} → ${item.title}`)
        return sendJson(res, 200, { ok: true, data: item })
      } catch (e: any) {
        console.error(`[import] ${name} 失败：`, e?.message ?? e)
        return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) })
      }
    }

    if (url.pathname === '/api/ping') return sendJson(res, 200, { ok: true, data: 'margin' })

    // ---- 静态文件 ----
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const filePath = normalize(join(webDir, rel))
    if (!filePath.startsWith(normalize(webDir))) {
      res.writeHead(403).end('forbidden')
      return
    }
    const info = await stat(filePath).catch(() => null)
    if (!info || !info.isFile()) {
      res.writeHead(404).end('not found')
      return
    }
    let content = await readFile(filePath)
    if (rel === '/index.html') {
      // 告诉前端：这是网页版，走 HTTP 接口而不是 Electron IPC
      const html = content.toString('utf8').replace('<head>', '<head>\n    <script>window.__MARGIN_SERVER__=1</script>')
      content = Buffer.from(html, 'utf8')
    }
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    })
    res.end(content)
  } catch (e: any) {
    console.error('[http] 处理失败：', e?.message ?? e)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
    else res.end()
  }
})

function listen(port: number, attempt = 0): void {
  server.once('error', (err: any) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      listen(port + 1, attempt + 1)
    } else {
      console.error('启动失败：', err.message)
      process.exit(1)
    }
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    console.log('')
    console.log('  页边 已启动（网页版）')
    console.log('  ' + url)
    console.log('  数据保存在：' + join(dataDir, 'margin.db'))
    console.log('  关闭这个窗口即退出。')
    console.log('')
    if (process.env.MARGIN_NO_OPEN !== '1') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    }
  })
}

listen(5178)
