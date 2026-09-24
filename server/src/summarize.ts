import type { BoardSnapshot, Comment, Element } from '../../shared/schema.js'
import { isSection, sectionContents } from '../../shared/sections.js'
import { NOTE_COLORS } from '../../shared/schema.js'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const boxOf = (e: Element): Box => ({ x: e.x, y: e.y, w: Math.max(e.w, 1), h: Math.max(e.h, 1) })

const gap = (a: Box, b: Box) => {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w))
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h))
  return Math.hypot(dx, dy)
}

const overlaps = (a: Box, b: Box, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y

const NEARBY_PX = 120
const round = (n: number) => Math.round(n)

function noteColorName(color: string | null): string {
  if (color && color in NOTE_COLORS) return color
  return 'yellow'
}

function describeElement(e: Element) {
  const base = {
    id: e.id,
    position: { x: round(e.x), y: round(e.y), w: round(e.w), h: round(e.h) },
    author: { name: e.authorName, type: e.authorType },
  }
  if (e.kind === 'note') return { ...base, kind: 'note' as const, text: e.text, color: noteColorName(e.style.color) }
  if (e.kind === 'text') return { ...base, kind: 'text' as const, text: e.text }
  const connects =
    e.bindings?.start || e.bindings?.end ? { from: e.bindings.start ?? 'a point', to: e.bindings.end ?? 'a point' } : undefined
  return { ...base, kind: 'shape' as const, shape: e.shape, label: e.text || null, ...(connects ? { connects } : {}) }
}

export function commentAnchorPoint(c: Comment, byId: Map<string, Element>) {
  if (c.anchor.type === 'point') return { x: c.anchor.x, y: c.anchor.y }
  const el = byId.get(c.anchor.elementId)
  if (!el) return null
  return { x: el.x + c.anchor.dx, y: el.y + c.anchor.dy }
}

/** An LLM-friendly view of the board: plain text first, geometry second. */
export function summarize(snap: BoardSnapshot) {
  const elements = snap.elements.filter((e) => !e.deleted)
  const byId = new Map(elements.map((e) => [e.id, e]))
  const comments = snap.comments.filter((c) => !c.deleted)
  const replies = snap.replies.filter((r) => !r.deleted)

  const nearby = (e: Element) =>
    elements
      .filter((o) => o.id !== e.id && gap(boxOf(e), boxOf(o)) <= NEARBY_PX)
      .map((o) => o.id)

  const threads = comments
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => {
      let anchoredTo: Record<string, unknown>
      if (c.anchor.type === 'element') {
        const el = byId.get(c.anchor.elementId)
        anchoredTo = el
          ? { type: 'element', id: el.id, kind: el.kind, shape: el.shape ?? undefined, text: el.text || undefined }
          : { type: 'element', id: c.anchor.elementId, missing: true }
      } else {
        anchoredTo = { type: 'point', x: round(c.anchor.x), y: round(c.anchor.y) }
      }
      return {
        id: c.id,
        resolved: c.resolved,
        anchoredTo,
        comment: { body: c.body, author: { name: c.authorName, type: c.authorType }, createdAt: new Date(c.createdAt).toISOString() },
        replies: replies
          .filter((r) => r.commentId === c.id)
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((r) => ({
            id: r.id,
            body: r.body,
            author: { name: r.authorName, type: r.authorType },
            createdAt: new Date(r.createdAt).toISOString(),
          })),
      }
    })

  const sections = elements.filter(isSection)
  const inSection = (e: Element) => sections.filter((s) => sectionContents(s, [e]).length).map((s) => s.id)
  const described = elements
    .filter((e) => !isSection(e))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((e) => {
      const within = inSection(e)
      return { ...describeElement(e), nearby: nearby(e), ...(within.length ? { topic: within[0] } : {}) }
    })

  return {
    board: { id: snap.board.id, title: snap.board.title, version: snap.board.version },
    counts: {
      notes: elements.filter((e) => e.kind === 'note').length,
      text: elements.filter((e) => e.kind === 'text').length,
      shapes: elements.filter((e) => e.kind === 'shape').length,
      threads: threads.length,
      openThreads: threads.filter((t) => !t.resolved).length,
      topics: sections.length,
    },
    /** Topics: titled areas people (or agents) drew. Everything inside one belongs to that topic. */
    topics: sections.map((s) => ({
      id: s.id,
      title: s.text || null,
      color: s.style.color,
      position: { x: round(s.x), y: round(s.y), w: round(s.w), h: round(s.h) },
      contains: sectionContents(s, elements).map((e) => e.id),
    })),
    notes: described.filter((e) => e.kind === 'note'),
    text: described.filter((e) => e.kind === 'text'),
    shapes: described.filter((e) => e.kind === 'shape'),
    threads,
    coordinateSystem:
      'Canvas pixels; x grows right, y grows down; x/y is an element\'s top-left. Items are listed top-to-bottom, left-to-right. `topic` on an item = the topic it belongs to.',
  }
}

/** Find open space for a new note: beside a target element, or to the right of everything. */
export function placeNote(elements: Element[], size: { w: number; h: number }, nearId?: string | null): { x: number; y: number } {
  // Sections are backgrounds, not obstacles: notes can land inside them.
  const live = elements.filter((e) => !e.deleted && e.role !== 'section')
  const boxes = live.map(boxOf)
  const free = (b: Box) => !boxes.some((o) => overlaps(b, o, 16))
  const G = 32

  const near = nearId ? live.find((e) => e.id === nearId) : undefined
  if (near) {
    const b = boxOf(near)
    const candidates: Box[] = [
      { x: b.x + b.w + G, y: b.y, ...size },
      { x: b.x, y: b.y + b.h + G, ...size },
      { x: b.x - size.w - G, y: b.y, ...size },
      { x: b.x, y: b.y - size.h - G, ...size },
    ]
    for (let ring = 0; ring < 6; ring++) {
      for (const c of candidates) {
        const shifted = { ...c, x: c.x + (c.x > b.x ? ring : c.x < b.x ? -ring : 0) * (size.w + G), y: c.y + (c.y > b.y ? ring : c.y < b.y ? -ring : 0) * (size.h + G) }
        if (free(shifted)) return { x: shifted.x, y: shifted.y }
      }
    }
  }

  if (!boxes.length) return { x: 0, y: 0 }
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  for (let row = 0; row < 50; row++) {
    const c = { x: maxX + G * 2, y: minY + row * (size.h + G), ...size }
    if (free(c)) return { x: c.x, y: c.y }
  }
  return { x: maxX + G * 2, y: minY }
}
