import { PORTRAIT_COLORS, type Stroke } from '../../../shared/schema'
import { uid } from '../../../shared/ids'

export interface Profile {
  id: string
  name: string
  color: string
  sketch: Stroke[]
}

const PROFILE_KEY = 'wall.profile'
const RECENT_KEY = 'wall.recentBoards'

export function loadProfile(): Profile | null {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null')
    if (p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.sketch)) return p
  } catch {}
  return null
}

export function saveProfile(p: Profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p))
}

export const newProfileId = () => uid('p_')

export function randomColor(except?: string): string {
  const pool = PORTRAIT_COLORS.filter((c) => c !== except)
  return pool[Math.floor(Math.random() * pool.length)]
}

export function recentBoards(): string[] {
  try {
    const xs = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(xs) ? xs.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function rememberBoard(id: string) {
  const next = [id, ...recentBoards().filter((x) => x !== id)].slice(0, 6)
  localStorage.setItem(RECENT_KEY, JSON.stringify(next))
}

/** One id per browser tab (survives reloads, not closing). Agent invites are bound to it. */
export function tabSessionId(): string {
  const KEY = 'wall.sid'
  let sid = sessionStorage.getItem(KEY)
  if (!sid) {
    sid = uid('s_')
    sessionStorage.setItem(KEY, sid)
  }
  return sid
}
