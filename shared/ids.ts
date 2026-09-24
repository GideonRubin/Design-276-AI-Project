const ADJ = ['sunny', 'brave', 'curious', 'wobbly', 'bright', 'quiet', 'bold', 'fuzzy', 'lucky', 'mellow', 'nimble', 'zesty', 'cosmic', 'gentle', 'plucky', 'breezy']
const NOUN = ['otter', 'mango', 'comet', 'fern', 'pebble', 'heron', 'kite', 'maple', 'walrus', 'noodle', 'lantern', 'cactus', 'marble', 'puffin', 'tulip', 'yeti']

const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]

export function friendlyBoardId(): string {
  return `${pick(ADJ)}-${pick(NOUN)}-${10 + Math.floor(Math.random() * 90)}`
}

export function uid(prefix = ''): string {
  const r = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix + r.replace(/-/g, '').slice(0, 16)
}

/** Board IDs: lowercase letters, digits, dashes. */
export const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/

export function normalizeBoardId(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}
