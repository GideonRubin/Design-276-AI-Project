import type { Element, Point } from './schema.js'

/**
 * Bound arrows: an arrow can be attached at either end to another element.
 * Whenever an attached element moves (human drag, agent move), the arrow is
 * re-routed edge-to-edge. Used by both the client and the server.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

const GAP = 10

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/** Where the line from the box's center toward `toward` leaves the (padded) box. */
export function edgePoint(b: Box, toward: { x: number; y: number }, gap = GAP): { x: number; y: number } {
  const c = center(b)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (!dx && !dy) return c
  const hw = b.w / 2 + gap
  const hh = b.h / 2 + gap
  const t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9))
  return { x: c.x + dx * Math.min(t, 1), y: c.y + dy * Math.min(t, 1) }
}

export type End = Box | { x: number; y: number }
const isBox = (e: End): e is Box => 'w' in e

/** Geometry for an arrow element from one end to the other (boxes are clipped at their edges). */
export function route(from: End, to: End): { x: number; y: number; w: number; h: number; points: Point[] } {
  const fromC = isBox(from) ? center(from) : from
  const toC = isBox(to) ? center(to) : to
  const a = isBox(from) ? edgePoint(from, toC) : from
  const b = isBox(to) ? edgePoint(to, fromC) : to
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
    points: [
      [a.x - x, a.y - y],
      [b.x - x, b.y - y],
    ],
  }
}

const boxOf = (e: Element): Box => ({ x: e.x, y: e.y, w: e.w, h: e.h })

/** Current absolute endpoints of a linear element. */
function endpoints(e: Element): [{ x: number; y: number }, { x: number; y: number }] {
  const p0 = e.points[0] ?? [0, 0]
  const p1 = e.points[e.points.length - 1] ?? [e.w, e.h]
  return [
    { x: e.x + p0[0], y: e.y + p0[1] },
    { x: e.x + p1[0], y: e.y + p1[1] },
  ]
}

export const isConnector = (e: Element) => (e.shape === 'arrow' || e.shape === 'line') && Boolean(e.bindings?.start || e.bindings?.end)

/** Re-route one bound arrow against the current elements. */
export function reroute(arrow: Element, all: Record<string, Element>): Element {
  const [a, b] = endpoints(arrow)
  const bind = arrow.bindings
  const s = bind?.start ? all[bind.start] : undefined
  const t = bind?.end ? all[bind.end] : undefined
  const sLive = s && !s.deleted ? s : undefined
  const tLive = t && !t.deleted ? t : undefined
  // Pinned ends (drawn by hand) keep their exact spot on the element; unpinned ends clip to its edge.
  const pinned = (el: Element, at: Point) => ({ x: el.x + at[0], y: el.y + at[1] })
  const from: End = sLive ? (bind.startAt ? pinned(sLive, bind.startAt) : boxOf(sLive)) : a
  const to: End = tLive ? (bind.endAt ? pinned(tLive, bind.endAt) : boxOf(tLive)) : b
  return { ...arrow, ...route(from, to) }
}

/** Arrows attached to any of `movedIds`, re-routed. Returns only the arrows that changed. */
export function reflowArrows(all: Record<string, Element>, movedIds: Iterable<string>): Element[] {
  const moved = new Set(movedIds)
  const out: Element[] = []
  for (const e of Object.values(all)) {
    if (e.deleted || moved.has(e.id) || !isConnector(e)) continue
    if ((e.bindings.start && moved.has(e.bindings.start)) || (e.bindings.end && moved.has(e.bindings.end))) {
      out.push(reroute(e, all))
    }
  }
  return out
}
