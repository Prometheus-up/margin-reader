import { app, BrowserWindow, shell, dialog } from 'electron'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { initDatabase, closeDatabase } from './core/db'
import { registerIpc } from './ipc'

// electron-vite 已注入 __dirname（import.meta.dirname），这里不要再声明一次

let logFile = ''
function log(msg: string): void {
  try {
    if (!logFile) {
      const dir = join(app.getPath('userData'))
      mkdirSync(dir, { recursive: true })
      logFile = join(dir, 'boot.log')
    }
    appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不影响启动 */
  }
}

process.on('uncaughtException', (err) => {
  log('uncaughtException: ' + (err?.stack ?? String(err)))
  try {
    dialog.showErrorBox('页边启动出错', String(err?.stack ?? err))
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (err: any) => {
  log('unhandledRejection: ' + (err?.stack ?? String(err)))
})

function createWindow(): void {
  log('createWindow')
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: true,
    backgroundColor: '#f7f6f3',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`did-fail-load ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone ' + JSON.stringify(details))
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log(`renderer console(${level}): ${message}`)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    log('loadURL ' + process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const index = join(__dirname, '../renderer/index.html')
    log('loadFile ' + index)
    void win.loadFile(index)
  }
}

log('boot start')

app.whenReady().then(() => {
  try {
    const dbPath = join(app.getPath('userData'), 'margin.db')
    log('init db ' + dbPath)
    initDatabase(dbPath)
    registerIpc()
    createWindow()
    log('ready')
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  } catch (err: any) {
    log('fatal: ' + (err?.stack ?? String(err)))
    dialog.showErrorBox('页边启动出错', String(err?.stack ?? err))
    app.quit()
  }
})

app.on('window-all-closed', () => {
  log('window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  log('before-quit')
  closeDatabase()
})
