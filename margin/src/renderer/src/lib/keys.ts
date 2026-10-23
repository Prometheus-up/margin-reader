export type KeyAction = 'next' | 'prev' | 'search' | 'toc' | 'display' | 'marks' | 'notes' | 'speak' | 'back'

export type KeyMap = Record<KeyAction, string>

export const KEY_ACTIONS: Array<{ id: KeyAction; label: string }> = [
  { id: 'next', label: '下一节 / 下一页' },
  { id: 'prev', label: '上一节 / 上一页' },
  { id: 'search', label: '搜索本书' },
  { id: 'toc', label: '目录' },
  { id: 'display', label: '排版' },
  { id: 'marks', label: '书签' },
  { id: 'notes', label: '批注与摘抄' },
  { id: 'speak', label: '朗读' },
  { id: 'back', label: '回到书架' }
]

export const DEFAULT_KEYS: KeyMap = {
  next: 'ArrowRight',
  prev: 'ArrowLeft',
  search: 'Ctrl+f',
  toc: 't',
  display: 'a',
  marks: 'b',
  notes: 'n',
  speak: 's',
  back: 'Escape'
}

export const KEYS_EVENT = 'margin:keys'

export function loadKeys(): KeyMap {
  try {
    const raw = localStorage.getItem('margin.keys')
    if (raw) return { ...DEFAULT_KEYS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_KEYS }
}

export function saveKeys(map: KeyMap) {
  localStorage.setItem('margin.keys', JSON.stringify(map))
  window.dispatchEvent(new Event(KEYS_EVENT))
}

export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key)
  return parts.join('+')
}

export function matchCombo(e: KeyboardEvent, combo?: string): boolean {
  if (!combo) return false
  return comboOf(e) === combo
}

/** 界面上显示得更像键帽：Ctrl+F、→、Esc */
export function prettyKey(combo: string): string {
  const arrow: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Escape: 'Esc',
    ' ': 'Space',
    PageUp: 'PgUp',
    PageDown: 'PgDn'
  }
  return combo
    .split('+')
    .map((p) => arrow[p] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join('+')
}
