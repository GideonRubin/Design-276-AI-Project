import type { Element } from '../../shared/schema.js'
import { isSection, sectionContents, SECTION_PAD, SECTION_TITLE_BAND } from '../../shared/sections.js'

/**
 * Layout helpers so agents don't have to do pixel math:
 * - structure: read what people drew (lines dividing a topic into labeled sides)
 * - problems: overlapping items / topics
 * - placement: find free space inside a topic, on the right side of a divider
 * - arrange: pack a topic's contents into a tidy grid (per side), or space topics apart
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

const box = (e: Element): Box => ({ x: e.x, y: e.y, w: Math.max(e.w, 1), h: Math.max(e.h, 1) })
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const isLine = (e: Element) => e.kind === 'shape' && (e.shape === 'line' || e.shape === 'arrow' || e.shape === 'pen')
const isContent = (e: Element) => !e.deleted && !isSection(e) && !isLine(e)
const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
const inside = (p: { x: number; y: number }, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
const intersects = (a: Box, b: Box, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y

const ends = (e: Element) => {
  const p0 = e.points[0] ?? [0, 0]
  const p1 = e.points[e.points.length - 1] ?? [e.w, e.h]
  return [
    { x: e.x + p0[0], y: e.y + p0[1] },
    { x: e.x + p1[0], y: e.y + p1[1] },
  ] as const
}

// ---------- structure: dividers ----------

export interface Divider {
  line: Element
  topic: Element | null
  orientation: 'vertical' | 'horizontal'
  /** Which side a point is on: 'left' | 'right' (vertical line) or 'above' | 'below' (horizontal). */
  sideOf: (p: { x: number; y: number }) => string
  sides: [string, string]
}

/** A long plain line (not an arrow: arrows are relationships) counts as a divider; people use these to split an area into sides. */
export function dividers(elements: Element[]): Divider[] {
  const live = elements.filter((e) => !e.deleted)
  const topics = live.filter(isSection)
  const out: Divider[] = []
  for (const e of live) {
    if (!(e.kind === 'shape' && (e.shape === 'line' || e.shape === 'pen'))) continue
    const [a, b] = ends(e)
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 140) continue
    // Its topic: the smallest one containing both ends (a topic someone later dropped on top of the line doesn't count),
    // else the one containing its top/left end.
    const first = a.y + a.x / 10 <= b.y + b.x / 10 ? a : b
    const bySize = (p: Element, q: Element) => p.w * p.h - q.w * q.h
    // Prefer topics that existed before the line was drawn: that's the one it was drawn for.
    const older = (t: Element) => t.createdAt <= e.createdAt
    const holding = topics.filter((t) => inside(a, box(t)) && inside(b, box(t)))
    const topic =
      holding.filter(older).sort(bySize)[0] ??
      holding.sort(bySize)[0] ??
      topics.filter((t) => inside(first, box(t))).sort(bySize)[0] ??
      null
    const vertical = Math.abs(b.x - a.x) < Math.abs(b.y - a.y)
    const sideOf = vertical
      ? (p: { x: number; y: number }) => {
          const t = (p.y - a.y) / ((b.y - a.y) || 1)
          const lx = a.x + (b.x - a.x) * Math.min(1, Math.max(0, t))
          return p.x < lx ? 'left' : 'right'
        }
      : (p: { x: number; y: number }) => {
          const t = (p.x - a.x) / ((b.x - a.x) || 1)
          const ly = a.y + (b.y - a.y) * Math.min(1, Math.max(0, t))
          return p.y < ly ? 'above' : 'below'
        }
    out.push({ line: e, topic, orientation: vertical ? 'vertical' : 'horizontal', sideOf, sides: vertical ? ['left', 'right'] : ['above', 'below'] })
  }
  return out
}

/** The area a divider splits: its topic, or the neighborhood of the line if it's not in one. */
function dividerArea(d: Divider): Box {
  if (d.topic) return box(d.topic)
  const b = box(d.line)
  return { x: b.x - 500, y: b.y - 300, w: b.w + 1000, h: b.h + 600 }
}

/** Human-readable structure for the summary: sides of each divider, with their labels and items. */
export function describeStructure(elements: Element[]) {
  const live = elements.filter(isContent)
  return dividers(elements).map((d) => {
    const area = dividerArea(d)
    const [la, lb] = ends(d.line)
    const top = Math.min(la.y, lb.y)
    const left = Math.min(la.x, lb.x)
    // A side's label is short text near the start of the line ("yes" / "no" at the top of each column).
    const nearStart = (e: Element) =>
      d.orientation === 'vertical' ? e.y + e.h >= top - 120 && e.y <= top + 100 : e.x + e.w >= left - 160 && e.x <= left + 120
    const bySide = new Map<string, { labels: string[]; items: Array<{ id: string; kind: string; text: string }> }>()
    for (const s of d.sides) bySide.set(s, { labels: [], items: [] })
    for (const e of live) {
      const c = center(box(e))
      if (!inside(c, area)) continue
      if (d.topic && !sectionContents(d.topic, [e]).length) continue
      const side = bySide.get(d.sideOf(c))!
      // Short text on a side reads as that side's label ("yes", "no", "pros"…).
      if (e.kind === 'text' && e.text.trim().length <= 40 && nearStart(e)) side.labels.push(e.text.trim())
      else side.items.push({ id: e.id, kind: e.kind, text: e.text })
    }
    // The question the split answers: text just above a vertical line (or left of a horizontal one), else the topic's title.
    const [a, b] = ends(d.line)
    const lineTop = Math.min(a.y, b.y)
    const lineLeft = Math.min(a.x, b.x)
    const lineMidX = (a.x + b.x) / 2
    const lineMidY = (a.y + b.y) / 2
    const questionEl = live
      .filter((e) => e.kind === 'text' && (!d.topic || sectionContents(d.topic, [e]).length > 0))
      .filter((e) => {
        const c = center(box(e))
        return d.orientation === 'vertical'
          ? e.y + e.h <= lineTop + 30 && Math.abs(c.x - lineMidX) < 500 && lineTop - (e.y + e.h) < 400
          : e.x + e.w <= lineLeft + 30 && Math.abs(c.y - lineMidY) < 400 && lineLeft - (e.x + e.w) < 500
      })
      .sort((p, q) => {
        const dist = (e: Element) => Math.hypot(center(box(e)).x - lineMidX, center(box(e)).y - (d.orientation === 'vertical' ? lineTop : lineMidY))
        return dist(p) - dist(q)
      })[0]
    const question = questionEl?.text || d.topic?.text || null
    // The question isn't one of the side's items/labels.
    if (questionEl) for (const side of bySide.values()) {
      side.labels = side.labels.filter((l) => l !== questionEl.text.trim())
      side.items = side.items.filter((i) => i.id !== questionEl.id)
    }
    return {
      type: 'divider',
      lineId: d.line.id,
      topic: d.topic ? { id: d.topic.id, title: d.topic.text || null } : null,
      question,
      questionId: questionEl?.id ?? null,
      orientation: d.orientation,
      sides: d.sides.map((s) => ({ side: s, ...bySide.get(s)! })),
      meaning: describeSides(d, bySide, question),
    }
  })
}

function describeSides(d: Divider, bySide: Map<string, { labels: string[]; items: unknown[] }>, question: string | null) {
  const where = d.topic ? `the topic "${d.topic.text || 'untitled'}"` : 'this area'
  const parts = d.sides.map((s) => {
    const x = bySide.get(s)!
    return `the ${s} side${x.labels.length ? ` ("${x.labels.join('", "')}")` : ''} with ${x.items.length} item${x.items.length === 1 ? '' : 's'}`
  })
  const q = question ? `This is a two-sided answer to "${question}". ` : ''
  return `${q}A line splits ${where}: ${parts.join(' vs. ')}. Treat each side as its own column: add each argument or idea on the side it supports (use nearElementId = that side's label), and don't mix them.`
}

/**
 * Where each item sits, in words: its topic, its side of any divider, and the label or heading it falls under.
 * This is what lets an agent read "text at top, a line down the middle, yes/no on each side" the way a person does.
 */
export function describePlacement(elements: Element[]) {
  const live = elements.filter(isContent)
  const divs = dividers(elements)
  const structure = describeStructure(elements)
  const questionIds = new Set(structure.map((x) => x.questionId).filter(Boolean) as string[])
  const questionOf = new Map(structure.map((x) => [x.lineId, x.question]))
  const labels = live.filter((e) => e.kind === 'text' && !questionIds.has(e.id))
  const out = new Map<string, { topic?: string; side?: string; sideLabel?: string; answers?: string; under?: string }>()
  for (const e of live) {
    const c = center(box(e))
    const info: { topic?: string; side?: string; sideLabel?: string; answers?: string; under?: string } = {}
    const topic = topicOf(e, elements)
    if (topic) info.topic = topic.text || topic.id
    for (const d of divs) {
      if (!inside(c, dividerArea(d))) continue
      if (d.topic && topic?.id !== d.topic.id) continue
      if (questionIds.has(e.id)) break // the question itself spans both sides
      const side = d.sideOf(c)
      info.side = side
      const q = questionOf.get(d.line.id)
      if (q) info.answers = q
      const sideLabel = labels.find((l) => l.id !== e.id && l.text.trim().length <= 40 && d.sideOf(center(box(l))) === side && inside(center(box(l)), dividerArea(d)) && l.y < e.y)
      if (sideLabel) info.sideLabel = sideLabel.text.trim()
      break
    }
    // The nearest text above it that horizontally overlaps: the heading it's "under".
    const heading = labels
      .filter((l) => l.id !== e.id && l.y + l.h <= e.y + 10 && l.x < e.x + e.w && l.x + l.w > e.x && e.y - (l.y + l.h) < 500)
      .sort((p, q) => q.y + q.h - (p.y + p.h))[0]
    if (heading && heading.text.trim() !== info.sideLabel) info.under = heading.text.trim()
    if (Object.keys(info).length) out.set(e.id, info)
  }
  return out
}

// ---------- problems ----------

export function layoutProblems(elements: Element[]) {
  const items = elements.filter(isContent)
  const topics = elements.filter((e) => !e.deleted && isSection(e))
  const overlappingItems: Array<[string, string]> = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = box(items[i])
      const b = box(items[j])
      if (overlapArea(a, b) > 0.15 * Math.min(a.w * a.h, b.w * b.h)) overlappingItems.push([items[i].id, items[j].id])
    }
  }
  const overlappingTopics: Array<[string, string]> = []
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const a = box(topics[i])
      const b = box(topics[j])
      const contained = inside({ x: a.x, y: a.y }, b) && inside({ x: a.x + a.w, y: a.y + a.h }, b)
      const containedRev = inside({ x: b.x, y: b.y }, a) && inside({ x: b.x + b.w, y: b.y + b.h }, a)
      if (!contained && !containedRev && overlapArea(a, b) > 0) overlappingTopics.push([topics[i].id, topics[j].id])
    }
  }
  // A topic spanning both sides of a dividing line mixes the two sides: it should sit on one side.
  const straddlingDivider: Array<{ topicId: string; lineId: string }> = []
  for (const d of dividers(elements)) {
    for (const t of topics) {
      if (t.id === d.topic?.id) continue
      if (d.topic && !(inside(center(box(t)), box(d.topic)))) continue
      const b = box(t)
      const corners = [
        { x: b.x + 10, y: b.y + b.h / 2 },
        { x: b.x + b.w - 10, y: b.y + b.h / 2 },
        { x: b.x + b.w / 2, y: b.y + 10 },
        { x: b.x + b.w / 2, y: b.y + b.h - 10 },
      ]
      if (new Set(corners.map((p) => d.sideOf(p))).size > 1) straddlingDivider.push({ topicId: t.id, lineId: d.line.id })
    }
  }
  const hint =
    overlappingItems.length || overlappingTopics.length || straddlingDivider.length
      ? 'Fix overlaps with POST /arrange (a topicId to tidy one topic, or no body to space topics apart). ' +
        'A topic in straddlingDivider spans both sides of a dividing line: split its notes onto the side each belongs to (or move it to one side).'
      : null
  return { overlappingItems, overlappingTopics, straddlingDivider, hint }
}

// ---------- placement ----------

const GAP = 24

/** Rectangles that a new item must not overlap: content, plus thin boxes around lines. */
function obstacles(elements: Element[], ignore: Set<string> = new Set()): Box[] {
  const out: Box[] = []
  for (const e of elements) {
    if (e.deleted || isSection(e) || ignore.has(e.id)) continue
    if (isLine(e)) {
      // Sample the line into small boxes so notes don't land on top of it.
      const [a, b] = ends(e)
      const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 40))
      for (let i = 0; i <= n; i++) out.push({ x: a.x + ((b.x - a.x) * i) / n - 6, y: a.y + ((b.y - a.y) * i) / n - 6, w: 12, h: 12 })
    } else out.push(box(e))
  }
  return out
}

/** The innermost topic an element sits in. */
export function topicOf(e: Element, elements: Element[]): Element | null {
  const c = center(box(e))
  return elements.filter((t) => !t.deleted && isSection(t) && t.id !== e.id && inside(c, box(t))).sort((p, q) => p.w * p.h - q.w * q.h)[0] ?? null
}

/**
 * Free spot for a new item of `size` near `near` (e.g. a "yes" label or a related note):
 * same topic, same side of any divider, not overlapping anything.
 */
export function placeNear(elements: Element[], size: { w: number; h: number }, near: Element): { x: number; y: number } | null {
  const obs = obstacles(elements)
  const topic = isSection(near) ? near : topicOf(near, elements)
  const nb = box(near)
  const nearC = center(nb)
  const divs = dividers(elements).filter((d) => d.topic?.id === topic?.id)
  const bounds = topic ? { x: topic.x + SECTION_PAD / 2, y: topic.y + SECTION_TITLE_BAND, w: topic.w - SECTION_PAD, h: topic.h - SECTION_TITLE_BAND - SECTION_PAD / 2 } : null
  const ok = (c: Box) =>
    !obs.some((o) => intersects(c, o, 12)) &&
    (!bounds || (c.x >= bounds.x && c.y >= bounds.y && c.x + c.w <= bounds.x + bounds.w && c.y + c.h <= bounds.y + bounds.h)) &&
    divs.every((d) => d.sideOf(center(c)) === d.sideOf(nearC))
  // Spiral outward: below and right first (reading order), then left/up.
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [1, -1],
    [-1, -1],
  ]
  for (let ring = 1; ring <= 10; ring++) {
    for (const [dx, dy] of dirs) {
      const c = {
        x: (dx > 0 ? nb.x + nb.w + GAP : dx < 0 ? nb.x - size.w - GAP : nb.x) + (dx * (ring - 1) * (size.w + GAP)),
        y: (dy > 0 ? nb.y + nb.h + GAP : dy < 0 ? nb.y - size.h - GAP : nb.y) + (dy * (ring - 1) * (size.h + GAP)),
        ...size,
      }
      if (ok(c)) return { x: c.x, y: c.y }
    }
  }
  return null
}

/** First free grid slot inside a topic (reading order). Null if it's full. */
export function placeInTopic(elements: Element[], size: { w: number; h: number }, topic: Element): { x: number; y: number } | null {
  const obs = obstacles(elements)
  const x0 = topic.x + SECTION_PAD
  const y0 = topic.y + SECTION_TITLE_BAND
  for (let y = y0; y + size.h <= topic.y + topic.h - SECTION_PAD / 2; y += 20) {
    for (let x = x0; x + size.w <= topic.x + topic.w - SECTION_PAD / 2; x += 20) {
      const c = { x, y, ...size }
      if (!obs.some((o) => intersects(c, o, 12))) return { x, y }
    }
  }
  return null
}

// ---------- arrange ----------

export interface Arrangement {
  /** New geometry for every element that moved or resized (topic included). */
  changes: Map<string, Partial<Element>>
}

/**
 * Tidy one topic: labels on top, notes/shapes/text in a neat grid, nothing overlapping,
 * and the topic resized to fit. If a line splits the topic, each side is packed on its own side.
 */
export function arrangeTopic(topic: Element, elements: Element[], order?: string[]): Arrangement {
  const changes = new Map<string, Partial<Element>>()
  const contents = sectionContents(topic, elements).filter(isContent)
  const rank = (e: Element) => {
    const i = order?.indexOf(e.id) ?? -1
    return i >= 0 ? i : 1e6 + e.y * 10 + e.x / 100
  }
  const divider = dividers(elements).find((d) => d.topic?.id === topic.id) ?? null
  // Anything sitting above a vertical divider (the question it splits) stays on top, across both sides.
  const lineTop = divider ? Math.min(...ends(divider.line).map((p) => p.y)) : Infinity
  const header = divider?.orientation === 'vertical' ? contents.filter((e) => e.y + e.h <= lineTop + 30) : []
  const body = contents.filter((e) => !header.includes(e))
  const groups: Array<{ side: string | null; items: Element[] }> = divider
    ? divider.sides.map((s) => ({ side: s, items: body.filter((e) => divider.sideOf(center(box(e))) === s) }))
    : [{ side: null, items: body }]

  const cellW = Math.max(180, ...contents.filter((e) => e.kind !== 'text').map((e) => e.w))
  const cellH = Math.max(180, ...contents.filter((e) => e.kind !== 'text').map((e) => e.h))
  const vertical = divider?.orientation !== 'horizontal'

  // Width per group: enough for up to 3 columns, at least what the topic has now.
  const colsFor = (n: number) => Math.max(1, Math.min(3, Math.ceil(Math.sqrt(n))))
  const groupW = groups.map((g) => {
    const notes = g.items.filter((e) => !(e.kind === 'text' && e.text.trim().length <= 40))
    return Math.max(cellW, colsFor(notes.length) * (cellW + GAP) - GAP)
  })

  let cursorX = topic.x + SECTION_PAD
  let cursorY = topic.y + SECTION_TITLE_BAND
  // Header row (the question) first.
  let hx = cursorX
  let headerH = 0
  for (const e of header.sort((a, b) => a.x - b.x)) {
    changes.set(e.id, { x: hx, y: cursorY })
    hx += e.w + GAP
    headerH = Math.max(headerH, e.h)
  }
  const bodyTop = cursorY + (header.length ? headerH + GAP * 1.5 : 0)
  cursorY = bodyTop
  let maxBottom = cursorY
  let maxRight = Math.max(cursorX, hx - GAP)
  const dividerGap = 80

  groups.forEach((g, gi) => {
    const labels = g.items.filter((e) => e.kind === 'text' && e.text.trim().length <= 40).sort((a, b) => rank(a) - rank(b))
    const items = g.items.filter((e) => !labels.includes(e)).sort((a, b) => rank(a) - rank(b))
    const originX = vertical ? cursorX : topic.x + SECTION_PAD
    let y = vertical ? bodyTop : cursorY
    // Labels in a row at the top of the group.
    let lx = originX
    let labelH = 0
    for (const l of labels) {
      changes.set(l.id, { x: lx, y })
      lx += l.w + GAP
      labelH = Math.max(labelH, l.h)
    }
    if (labels.length) y += labelH + GAP
    const cols = colsFor(items.length)
    items.forEach((e, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = originX + col * (cellW + GAP) + (cellW - e.w) / 2
      const ey = y + row * (cellH + GAP) + (cellH - e.h) / 2
      changes.set(e.id, { x, y: ey })
    })
    const rows = Math.ceil(items.length / cols)
    const bottom = y + Math.max(0, rows * (cellH + GAP) - GAP)
    maxBottom = Math.max(maxBottom, bottom, y)
    maxRight = Math.max(maxRight, originX + groupW[gi], lx - GAP)
    if (vertical) cursorX = originX + groupW[gi] + dividerGap
    else cursorY = bottom + dividerGap
  })

  const newW = Math.max(topic.w, maxRight - topic.x + SECTION_PAD)
  const newH = Math.max(SECTION_TITLE_BAND + 120, maxBottom - topic.y + SECTION_PAD)
  changes.set(topic.id, { w: newW, h: newH })

  // Put the divider back between the sides, spanning the topic.
  if (divider && groups.length === 2) {
    if (vertical) {
      const x = topic.x + SECTION_PAD + groupW[0] + dividerGap / 2
      const top = bodyTop - 10
      const len = topic.y + newH - SECTION_PAD / 2 - top
      changes.set(divider.line.id, { x, y: top, w: 0, h: len, points: [[0, 0], [0, len]] })
    } else {
      const y = (changes.get(groups[1].items[0]?.id ?? '')?.y as number | undefined) ?? topic.y + newH / 2
      const len = newW - SECTION_PAD * 2
      changes.set(divider.line.id, { x: topic.x + SECTION_PAD, y: y - dividerGap / 2, w: len, h: 0, points: [[0, 0], [len, 0]] })
    }
  }
  return { changes }
}

/** Space topics apart so none overlap (row by row, in reading order). Their contents move with them. */
export function arrangeTopics(elements: Element[]): Arrangement {
  const changes = new Map<string, Partial<Element>>()
  const topics = elements.filter((e) => !e.deleted && isSection(e))
  // Only top-level topics (not ones nested inside another).
  const top = topics.filter((t) => !topics.some((o) => o.id !== t.id && inside({ x: t.x, y: t.y }, box(o)) && inside({ x: t.x + t.w, y: t.y + t.h }, box(o))))
  if (!top.length) return { changes }
  top.sort((a, b) => a.y - b.y || a.x - b.x)
  const GAP_T = 80
  const totalW = top.reduce((s, t) => s + t.w + GAP_T, 0)
  const maxRow = Math.max(Math.max(...top.map((t) => t.w)), Math.sqrt(totalW * Math.max(...top.map((t) => t.h))) * 1.6)
  let x = Math.min(...top.map((t) => t.x))
  const x0 = x
  let y = Math.min(...top.map((t) => t.y))
  let rowH = 0
  for (const t of top) {
    if (x > x0 && x + t.w > x0 + maxRow) {
      x = x0
      y += rowH + GAP_T
      rowH = 0
    }
    const dx = x - t.x
    const dy = y - t.y
    if (dx || dy) {
      changes.set(t.id, { x: t.x + dx, y: t.y + dy })
      for (const e of elements) {
        if (e.deleted || e.id === t.id) continue
        if (!sectionContents(t, [e]).length && !(isSection(e) && inside(center(box(e)), box(t)))) continue
        if (e.bindings?.start || e.bindings?.end) continue // attached arrows re-route themselves
        changes.set(e.id, { x: e.x + dx, y: e.y + dy })
      }
    }
    x += t.w + GAP_T
    rowH = Math.max(rowH, t.h)
  }
  return { changes }
}
