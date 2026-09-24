import type { Element, Point } from '../../../shared/schema'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const isLinear = (e: Element) => e.kind === 'shape' && (e.shape === 'line' || e.shape === 'arrow' || e.shape === 'pen')

export const rectOf = (e: Element): Rect => ({ x: e.x, y: e.y, w: e.w, h: e.h })

export const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y

export const unionRect = (rs: Rect[]): Rect | null => {
  if (!rs.length) return null
  const x = Math.min(...rs.map((r) => r.x))
  const y = Math.min(...rs.map((r) => r.y))
  const x2 = Math.max(...rs.map((r) => r.x + r.w))
  const y2 = Math.max(...rs.map((r) => r.y + r.h))
  return { x, y, w: x2 - x, h: y2 - y }
}

export const normRect = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
})

/** Given absolute points, return {x, y, w, h, points} with points relative to the bbox origin. */
export function fitPoints(abs: Point[]): { x: number; y: number; w: number; h: number; points: Point[] } {
  const xs = abs.map((p) => p[0])
  const ys = abs.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
    points: abs.map(([px, py]) => [px - x, py - y] as Point),
  }
}

/** Note text shrinks as it grows so it always fits the square. */
export function noteFontSize(text: string, w: number, h: number): number {
  const len = Math.max(text.length, 6)
  return Math.round(Math.max(15, Math.min(40, Math.sqrt((w * h) / len) * 0.95)))
}

export const rand = (min: number, max: number) => min + Math.random() * (max - min)
export const noteTilt = () => Math.round(rand(-3, 3) * 10) / 10
export const newSeed = () => Math.floor(Math.random() * 2 ** 31)
