import type { MarginApi } from './index'

declare global {
  interface Window {
    api: MarginApi
  }
}

export {}
