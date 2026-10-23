import { contextBridge, ipcRenderer } from 'electron'

const api = {
  books: {
    list: () => ipcRenderer.invoke('books:list'),
    import: () => ipcRenderer.invoke('books:import'),
    progress: () => ipcRenderer.invoke('books:progress'),
    remove: (id: string) => ipcRenderer.invoke('books:delete', id)
  },
  book: {
    meta: (id: string) => ipcRenderer.invoke('book:meta', id),
    sections: (id: string) => ipcRenderer.invoke('book:sections', id),
    section: (id: string, idx: number) => ipcRenderer.invoke('book:section', id, idx),
    search: (id: string, q: string) => ipcRenderer.invoke('book:search', id, q)
  },
  bookmarks: {
    list: (bookId: string) => ipcRenderer.invoke('bm:list', bookId),
    create: (payload: any) => ipcRenderer.invoke('bm:create', payload),
    remove: (id: string) => ipcRenderer.invoke('bm:delete', id)
  },
  annotations: {
    list: (bookId: string) => ipcRenderer.invoke('ann:list', bookId),
    create: (payload: any) => ipcRenderer.invoke('ann:create', payload),
    update: (id: string, patch: any) => ipcRenderer.invoke('ann:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('ann:delete', id)
  },
  chat: {
    history: (annotationId: string, mode: string) => ipcRenderer.invoke('chat:history', annotationId, mode),
    send: (payload: { annotationId: string; mode: string; text?: string }) => ipcRenderer.invoke('chat:send', payload)
  },
  settings: {
    get: (key: string, fallback?: string) => ipcRenderer.invoke('settings:get', key, fallback),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value)
  },
  progress: {
    get: (bookId: string) => ipcRenderer.invoke('progress:get', bookId),
    set: (bookId: string, secIdx: number, percent: number) => ipcRenderer.invoke('progress:set', bookId, secIdx, percent)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type MarginApi = typeof api
