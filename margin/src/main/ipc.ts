import { BrowserWindow, dialog, ipcMain } from 'electron'
import { importPaths, handlers } from './api'

export function registerIpc(): void {
  // 其余接口全部来自共享 handler 表（网页版用的是同一份）
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, ...args: any[]) => fn(...args))
  }

  // 只有这个需要弹系统文件对话框
  ipcMain.handle('books:import', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win!, {
      title: '导入书籍',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '电子书', extensions: ['epub', 'pdf', 'txt', 'md', 'markdown', 'docx', 'mobi', 'azw3', 'azw'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return { imported: [], failed: [] }
    return importPaths(result.filePaths)
  })
}
