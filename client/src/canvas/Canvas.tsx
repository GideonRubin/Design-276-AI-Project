import { useEffect, useRef, useState } from 'react'
import { Style, type Element, type Point } from '../../../shared/schema'
import { uid } from '../../../shared/ids'
import { actions, nextZ, toWorld, useBoard, type Tool } from '../store/board'
import { ElementView } from '../elements/ElementView'
import { CommentLayer, anchorPoint } from '../elements/Comments'
import { fitPoints, intersects, isLinear, newSeed, normRect, noteTilt, rectOf, unionRect, type Rect } from '../elements/geometry'
import { SelectionOverlay } from './SelectionOverlay'
import { isSection, sectionContents } from '../../../shared/sections'

type Drag =
  | { mode: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { mode: 'move'; start: { x: number; y: number }; origin: Record<string, { x: number; y: number }>; moved: boolean; clickedId: string; wasSelected: boolean }
  | { mode: 'marquee'; start: { x: number; y: number }; additive: string[]; additiveComments: string[]; sectionClick: string | null }
  | { mode: 'create'; id: string; start: { x: number; y: number }; tool: Tool; startBinding: string | null }
  | { mode: 'pen'; id: string; abs: Point[] }
  | { mode: 'resize'; id: string; corner: string; orig: Element }
  | { mode: 'rotate'; id: string; orig: Element }
  | { mode: 'bubble'; id: string; start: { x: number; y: number }; orig: { dx: number; dy: number }; moved: boolean; shift: boolean }

const SHAPE_TOOLS: Tool[] = ['rect', 'ellipse', 'diamond', 'arrow', 'line', 'topic']
const DEFAULT_SIZE: Record<string, [number, number]> = { rect: [160, 100], ellipse: [140, 100], diamond: [140, 120], topic: [520, 380] }

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')

function makeElement(partial: Partial<Element> & Pick<Element, 'kind' | 'x' | 'y'>): Element {
  const me = useBoard.getState().me!
  const now = Date.now()
  return {
    id: uid('e_'),
    shape: null,
    w: 0,
    h: 0,
    rotation: 0,
    z: nextZ(),
    style: Style.parse({}),
    text: '',
    points: [],
    seed: newSeed(),
    bindings: { start: null, end: null, startAt: null, endAt: null },
    role: null,
    authorId: me.id,
    authorName: me.name,
    authorType: 'human',
    createdAt: now,
    updatedAt: now,
    version: 0,
    deleted: false,
    ...partial,
  }
}

export function Canvas() {
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [panning, setPanning] = useState(false)

  const camera = useBoard((s) => s.camera)
  const elements = useBoard((s) => s.elements)
  const tool = useBoard((s) => s.tool)
  const editingId = useBoard((s) => s.editingId)
  const freshIds = useBoard((s) => s.freshIds)
  const glideIds = useBoard((s) => s.glideIds)

  const sorted = Object.values(elements).sort((a, b) => a.z - b.z)

  const worldAt = (e: { clientX: number; clientY: number }) => {
    const r = viewport.current!.getBoundingClientRect()
    return toWorld(e.clientX - r.left, e.clientY - r.top)
  }

  // Back to select after a one-shot tool, without dropping edit mode on what we just made.
  const finishTool = () => {
    if (!useBoard.getState().toolLocked) useBoard.setState({ tool: 'select' })
  }

  // ---------- wheel: pan, pinch/ctrl to zoom ----------
  useEffect(() => {
    const node = viewport.current!
    const onWheel = (e: WheelEvent) => {
      if (isTyping(e.target) && !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const cam = useBoard.getState().camera
      if (e.ctrlKey || e.metaKey) {
        const r = node.getBoundingClientRect()
        const sx = e.clientX - r.left
        const sy = e.clientY - r.top
        const z = Math.min(4, Math.max(0.15, cam.z * Math.exp(-e.deltaY * 0.01)))
        const wx = (sx - cam.x) / cam.z
        const wy = (sy - cam.y) / cam.z
        actions.setCamera({ x: sx - wx * z, y: sy - wy * z, z })
      } else {
        actions.setCamera({ ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY })
      }
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  // ---------- keyboard ----------
  useEffect(() => {
    const TOOL_KEYS: Record<string, Tool> = {
      v: 'select', h: 'hand', b: 'topic', r: 'rect', a: 'arrow', l: 'line', t: 'text', n: 'note', c: 'comment',
    }
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const s = useBoard.getState()
      const mod = e.metaKey || e.ctrlKey
      if (e.key === ' ' && !e.repeat) {
        setSpaceDown(true)
        e.preventDefault()
        return
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) actions.redo()
        else actions.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        actions.redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        duplicateSelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        actions.select(Object.keys(s.elements))
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && (s.selection.length || s.commentSelection.length)) {
        e.preventDefault()
        deleteSelection()
        return
      }
      if (e.key === 'Escape') {
        actions.select([])
        actions.selectComments([])
        actions.openThread(null)
        actions.setTool('select')
        return
      }
      if (e.key === 'Enter' && s.selection.length === 1) {
        e.preventDefault()
        actions.edit(s.selection[0])
        return
      }
      if ((e.key === ']' || e.key === '[') && s.selection.length) {
        actions.checkpoint()
        reorder(e.key === ']' ? 'front' : 'back')
        return
      }
      if (e.key.startsWith('Arrow') && s.selection.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        actions.patchElements(s.selection, (el) => ({ x: el.x + dx, y: el.y + dy }))
        return
      }
      if (!mod && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) {
        actions.setTool(TOOL_KEYS[e.key.toLowerCase()])
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceDown(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  // ---------- pointer ----------
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return
    const target = e.target as HTMLElement
    if (target.closest('.bubble.draft, .thread')) return
    // Stop the browser's mousedown focus change, which would instantly blur any editor we open below.
    e.preventDefault()
    if (isTyping(document.activeElement)) (document.activeElement as HTMLElement).blur()
    try {
      viewport.current!.setPointerCapture(e.pointerId)
    } catch {
      /* capture can fail (e.g. a pointer that's already gone); dragging still works without it */
    }
    const s = useBoard.getState()
    const p = worldAt(e)

    // Pan: hand tool, space, or middle mouse.
    if (s.tool === 'hand' || spaceDown || e.button === 1) {
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: s.camera.x, cy: s.camera.y }
      setPanning(true)
      return
    }

    if (s.editingId) {
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
    if (s.draftComment) {
      useBoard.setState({ draftComment: null })
    }

    // Comment bubbles are always interactive.
    const bubble = target.closest<HTMLElement>('[data-comment]')
    if (bubble && s.tool !== 'comment') {
      const c = s.comments[bubble.dataset.comment!]
      if (c) {
        drag.current = { mode: 'bubble', id: c.id, start: p, orig: { dx: c.bubbleDx, dy: c.bubbleDy }, moved: false, shift: e.shiftKey }
        return
      }
    }

    const handle = target.closest<HTMLElement>('[data-handle]')
    if (handle && s.selection.length === 1) {
      const el = s.elements[s.selection[0]]
      actions.checkpoint()
      drag.current = handle.dataset.handle === 'rotate' ? { mode: 'rotate', id: el.id, orig: el } : { mode: 'resize', id: el.id, corner: handle.dataset.handle!, orig: el }
      return
    }

    const hitId = target.closest<HTMLElement>('[data-id]')?.dataset.id
    const hit = hitId ? s.elements[hitId] : undefined

    // A section's background behaves like empty canvas (drag = box-select) unless you grab its title or it's already selected.
    const sectionBody = hit && isSection(hit) && !target.closest('.section-title') && !s.selection.includes(hit.id) ? hit : null

    switch (s.tool) {
      case 'select': {
        if (hit && !sectionBody) {
          const wasSelected = s.selection.includes(hit.id)
          let sel = s.selection
          if (e.shiftKey) sel = wasSelected ? sel.filter((x) => x !== hit.id) : [...sel, hit.id]
          else if (!wasSelected) {
            sel = [hit.id]
            actions.selectComments([])
          }
          actions.select(sel)
          const origin: Record<string, { x: number; y: number }> = {}
          for (const id of sel) {
            origin[id] = { x: s.elements[id].x, y: s.elements[id].y }
            // Moving a section carries what's inside it.
            if (isSection(s.elements[id])) {
              for (const inner of sectionContents(s.elements[id], Object.values(s.elements))) origin[inner.id] ??= { x: inner.x, y: inner.y }
            }
          }
          actions.checkpoint()
          drag.current = { mode: 'move', start: p, origin, moved: false, clickedId: hit.id, wasSelected }
        } else {
          if (!e.shiftKey) {
            actions.select([])
            actions.selectComments([])
          }
          actions.openThread(null)
          drag.current = {
            mode: 'marquee',
            start: p,
            additive: e.shiftKey ? s.selection : [],
            additiveComments: e.shiftKey ? s.commentSelection : [],
            sectionClick: sectionBody?.id ?? null,
          }
        }
        return
      }
      case 'note': {
        actions.checkpoint()
        const el = makeElement({ kind: 'note', x: p.x - 90, y: p.y - 90, w: 180, h: 180, rotation: noteTilt(), style: Style.parse({ color: 'yellow' }) })
        actions.upsertElements([el])
        actions.markFresh(el.id)
        actions.select([el.id])
        actions.edit(el.id)
        finishTool()
        return
      }
      case 'text': {
        actions.checkpoint()
        const el = makeElement({ kind: 'text', x: p.x, y: p.y - 20, w: 20, h: 40 })
        actions.upsertElements([el])
        actions.select([el.id])
        actions.edit(el.id)
        finishTool()
        return
      }
      case 'comment': {
        const anchor = hit
          ? { type: 'element' as const, elementId: hit.id, dx: p.x - hit.x, dy: p.y - hit.y }
          : { type: 'point' as const, x: p.x, y: p.y }
        actions.openThread(null)
        useBoard.setState({ draftComment: { anchor } })
        return
      }
      case 'pen': {
        actions.checkpoint()
        const el = makeElement({ kind: 'shape', shape: 'pen', x: p.x, y: p.y, points: [[0, 0]] })
        actions.upsertElements([el])
        drag.current = { mode: 'pen', id: el.id, abs: [[p.x, p.y]] }
        return
      }
      default: {
        if (!SHAPE_TOOLS.includes(s.tool)) return
        actions.checkpoint()
        const linear = s.tool === 'arrow' || s.tool === 'line'
        // A topic is drawn like a rectangle, but becomes a titled area that sits beneath everything.
        const topic = s.tool === 'topic'
        const el = makeElement({
          kind: 'shape',
          shape: topic ? 'rect' : (s.tool as Element['shape']),
          x: p.x,
          y: p.y,
          points: linear ? [[0, 0], [0, 0]] : [],
          ...(topic ? { role: 'section' as const, z: Math.min(0, ...Object.values(s.elements).map((x) => x.z)) - 1, style: Style.parse({ color: 'gray' }) } : {}),
        })
        actions.upsertElements([el])
        // Arrows/lines that start on an element attach to it.
        const startBinding = linear && hit && !isLinear(hit) ? hit.id : null
        drag.current = { mode: 'create', id: el.id, start: p, tool: s.tool, startBinding }
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const s = useBoard.getState()
    if (d.mode === 'pan') {
      actions.setCamera({ ...s.camera, x: d.cx + e.clientX - d.sx, y: d.cy + e.clientY - d.sy })
      return
    }
    const p = worldAt(e)
    switch (d.mode) {
      case 'move': {
        const dx = p.x - d.start.x
        const dy = p.y - d.start.y
        if (!d.moved && Math.hypot(dx, dy) * s.camera.z < 3) return
        d.moved = true
        actions.patchElements(Object.keys(d.origin), (el) => ({ x: d.origin[el.id].x + dx, y: d.origin[el.id].y + dy }))
        return
      }
      case 'marquee': {
        const r = normRect(d.start.x, d.start.y, p.x, p.y)
        setMarquee(r)
        const hits = Object.values(s.elements)
          .filter((el) =>
            isSection(el)
              ? r.x <= el.x && r.y <= el.y && r.x + r.w >= el.x + el.w && r.y + r.h >= el.y + el.h // only when fully enclosed
              : intersects(r, rectOf(el)),
          )
          .map((el) => el.id)
        actions.select([...new Set([...d.additive, ...hits])])
        // Visible comment threads can be box-selected too.
        const commentHits = Object.values(s.comments)
          .filter((c) => {
            if (c.resolved && !s.showResolved) return false // hidden threads can't be box-selected
            const a = anchorPoint(c, s.elements)
            return a && a.x >= r.x && a.x <= r.x + r.w && a.y >= r.y && a.y <= r.y + r.h
          })
          .map((c) => c.id)
        actions.selectComments([...new Set([...d.additiveComments, ...commentHits])])
        return
      }
      case 'create': {
        const el = s.elements[d.id]
        if (!el) return
        if (d.tool === 'arrow' || d.tool === 'line') {
          let ex = p.x
          let ey = p.y
          if (e.shiftKey) {
            const ang = Math.round(Math.atan2(ey - d.start.y, ex - d.start.x) / (Math.PI / 12)) * (Math.PI / 12)
            const len = Math.hypot(ex - d.start.x, ey - d.start.y)
            ex = d.start.x + Math.cos(ang) * len
            ey = d.start.y + Math.sin(ang) * len
          }
          // Exactly where you pressed → exactly where the pointer is.
          actions.upsertElements([{ ...el, ...fitPoints([[d.start.x, d.start.y], [ex, ey]]) }])
        } else {
          let r = normRect(d.start.x, d.start.y, p.x, p.y)
          if (e.shiftKey) {
            const side = Math.max(r.w, r.h)
            r = normRect(d.start.x, d.start.y, d.start.x + Math.sign(p.x - d.start.x || 1) * side, d.start.y + Math.sign(p.y - d.start.y || 1) * side)
          }
          actions.upsertElements([{ ...el, ...r }])
        }
        return
      }
      case 'pen': {
        const el = s.elements[d.id]
        if (!el) return
        d.abs.push([p.x, p.y])
        actions.upsertElements([{ ...el, ...fitPoints(d.abs) }])
        return
      }
      case 'resize': {
        const o = d.orig
        let x1 = o.x
        let y1 = o.y
        let x2 = o.x + o.w
        let y2 = o.y + o.h
        if (d.corner.includes('w')) x1 = p.x
        if (d.corner.includes('e')) x2 = p.x
        if (d.corner.includes('n')) y1 = p.y
        if (d.corner.includes('s')) y2 = p.y
        if (e.shiftKey || o.kind === 'note') {
          // Keep proportions (notes stay square-ish).
          const ratio = o.w / Math.max(o.h, 1)
          const w = Math.abs(x2 - x1)
          const h = w / ratio
          if (d.corner.includes('n')) y1 = y2 - h
          else y2 = y1 + h
        }
        const r = normRect(x1, y1, x2, y2)
        const min = o.kind === 'note' ? 80 : 8
        r.w = Math.max(r.w, isLinear(o) ? 1 : min)
        r.h = Math.max(r.h, isLinear(o) ? 1 : min)
        const patch: Partial<Element> = { ...r }
        if (isLinear(o)) {
          const sx = o.w ? r.w / o.w : 1
          const sy = o.h ? r.h / o.h : 1
          patch.points = o.points.map(([px, py]) => [px * sx, py * sy] as Point)
        }
        if (o.kind === 'text') patch.style = { ...o.style, fontSize: Math.max(10, Math.round((o.style.fontSize ?? 30) * (r.h / Math.max(o.h, 1)))) }
        actions.upsertElements([{ ...o, ...patch }])
        return
      }
      case 'rotate': {
        const o = d.orig
        const cx = o.x + o.w / 2
        const cy = o.y + o.h / 2
        let deg = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90
        if (e.shiftKey) deg = Math.round(deg / 15) * 15
        actions.upsertElements([{ ...o, rotation: Math.round(deg * 10) / 10 }])
        return
      }
      case 'bubble': {
        const dx = p.x - d.start.x
        const dy = p.y - d.start.y
        if (!d.moved && Math.hypot(dx, dy) * s.camera.z < 3) return
        d.moved = true
        const c = s.comments[d.id]
        if (c) useBoard.setState({ comments: { ...s.comments, [c.id]: { ...c, bubbleDx: d.orig.dx + dx, bubbleDy: d.orig.dy + dy } } })
        return
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    setPanning(false)
    const hadMarquee = marquee !== null
    setMarquee(null)
    if (!d) return
    const s = useBoard.getState()
    switch (d.mode) {
      case 'marquee':
        // A plain click on a section's background selects the section.
        if (d.sectionClick && !hadMarquee) actions.select(e.shiftKey ? [...new Set([...s.selection, d.sectionClick])] : [d.sectionClick])
        return
      case 'move':
        if (!d.moved) {
          // Plain click on an already-selected item in a group narrows the selection.
          if (d.wasSelected && !e.shiftKey && s.selection.length > 1) actions.select([d.clickedId])
          useBoard.setState({ undoStack: s.undoStack.slice(0, -1) })
        }
        return
      case 'create': {
        const el = s.elements[d.id]
        if (!el) return
        if (el.w < 4 && el.h < 4) {
          // A click, not a drag: drop a default-sized shape.
          if (d.tool === 'arrow' || d.tool === 'line') {
            actions.upsertElements([{ ...el, ...fitPoints([[d.start.x, d.start.y], [d.start.x + 160, d.start.y]]) }])
          } else {
            const [w, h] = DEFAULT_SIZE[d.tool] ?? [140, 100]
            actions.upsertElements([{ ...el, x: d.start.x - w / 2, y: d.start.y - h / 2, w, h }])
          }
        }
        if ((d.tool === 'arrow' || d.tool === 'line') && !(el.w < 4 && el.h < 4)) {
          // Dropped on an element? Attach the end too, then route edge-to-edge.
          const under = document
            .elementsFromPoint(e.clientX, e.clientY)
            .map((n) => (n as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id)
            .find((id) => id && id !== el.id && s.elements[id] && !isLinear(s.elements[id]))
          const endBinding = under && under !== d.startBinding ? under : null
          if (d.startBinding || endBinding) {
            // Keep the ends exactly where they were drawn, pinned to those spots on the elements so they follow them.
            const cur = useBoard.getState().elements[d.id]
            const [p0, p1] = [cur.points[0], cur.points[cur.points.length - 1]]
            const a = { x: cur.x + p0[0], y: cur.y + p0[1] }
            const b = { x: cur.x + p1[0], y: cur.y + p1[1] }
            const pin = (id: string | null, p: { x: number; y: number }) =>
              id ? ([p.x - s.elements[id].x, p.y - s.elements[id].y] as Point) : null
            actions.upsertElements([
              { ...cur, bindings: { start: d.startBinding, end: endBinding, startAt: pin(d.startBinding, a), endAt: pin(endBinding, b) } },
            ])
          }
        }
        actions.markFresh(d.id)
        actions.select([d.id])
        if (d.tool === 'topic') actions.edit(d.id) // name it right away
        finishTool()
        return
      }
      case 'pen': {
        const el = s.elements[d.id]
        if (el && d.abs.length < 2) {
          actions.upsertElements([{ ...el, ...fitPoints([[d.abs[0][0], d.abs[0][1]], [d.abs[0][0] + 0.5, d.abs[0][1] + 0.5]]) }])
        }
        return
      }
      case 'bubble': {
        const c = s.comments[d.id]
        if (!c) return
        if (d.moved) {
          actions.upsertComment(c)
          return
        }
        // Comments select like elements (so they can be deleted), and clicking one opens its thread.
        const was = s.commentSelection.includes(c.id)
        if (d.shift) {
          actions.selectComments(was ? s.commentSelection.filter((x) => x !== c.id) : [...s.commentSelection, c.id])
          return
        }
        if (s.openThreadId === c.id) {
          actions.openThread(null)
          actions.selectComments([])
          return
        }
        actions.select([])
        actions.selectComments([c.id])
        actions.openThread(c.id)
        return
      }
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const s = useBoard.getState()
    if (s.tool !== 'select') return
    // Pointer capture retargets dblclick to the viewport, so hit-test the actual point.
    const target = (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as HTMLElement
    const hitId = target.closest<HTMLElement>('[data-id]')?.dataset.id
    let hit = hitId ? s.elements[hitId] : undefined
    // Double-clicking inside a topic (not on its title) acts like empty canvas.
    const topicBackground = hit && isSection(hit) && !target.closest('.section-title') ? hit : undefined
    if (topicBackground) hit = undefined
    if (hit && !isLinear(hit)) {
      actions.select([hit.id])
      actions.edit(hit.id)
      return
    }
    if (!hit && !target.closest('[data-comment]')) {
      // Double-click empty canvas: start a comment right there (pinned to the topic if inside one, so it moves with it).
      const p = worldAt(e)
      const anchor = topicBackground
        ? { type: 'element' as const, elementId: topicBackground.id, dx: p.x - topicBackground.x, dy: p.y - topicBackground.y }
        : { type: 'point' as const, x: p.x, y: p.y }
      actions.select([])
      actions.selectComments([])
      actions.openThread(null)
      useBoard.setState({ draftComment: { anchor } })
    }
  }

  const cursor = panning ? 'grabbing' : tool === 'hand' || spaceDown ? 'grab' : tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair'
  const gridSize = 24 * camera.z

  return (
    <div
      ref={viewport}
      className={`viewport tool-${tool}`}
      style={{
        cursor,
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})` }}>
        {sorted.map((el) => (
          <ElementView key={el.id} el={el} editing={editingId === el.id} fresh={freshIds.has(el.id)} glide={glideIds.has(el.id)} />
        ))}
        <SelectionOverlay />
        <CommentLayer />
        {marquee && <div className="marquee" style={{ transform: `translate(${marquee.x}px, ${marquee.y}px)`, width: marquee.w, height: marquee.h }} />}
      </div>
    </div>
  )
}

// ---------- selection helpers (used by keyboard + style bar) ----------

/** Delete selected elements and selected comment threads, as one undo step. */
export function deleteSelection() {
  const s = useBoard.getState()
  const threads = s.commentSelection.filter((id) => s.comments[id])
  if (!s.selection.length && !threads.length) return
  actions.checkpoint()
  if (threads.length) actions.deleteComments(threads)
  if (s.selection.length) actions.deleteElements(s.selection)
  actions.selectComments([])
}

export function duplicateSelection() {
  const s = useBoard.getState()
  if (!s.selection.length) return
  actions.checkpoint()
  let z = nextZ()
  const copies = s.selection
    .map((id) => s.elements[id])
    .filter(Boolean)
    .map((el) => ({
      ...el,
      id: uid('e_'),
      x: el.x + 24,
      y: el.y + 24,
      z: z++,
      rotation: el.kind === 'note' ? noteTilt() : el.rotation,
      seed: newSeed(),
      authorId: s.me!.id,
      authorName: s.me!.name,
      authorType: 'human' as const,
      createdAt: Date.now(),
    }))
  actions.upsertElements(copies)
  copies.forEach((c) => actions.markFresh(c.id))
  actions.select(copies.map((c) => c.id))
}

export function reorder(dir: 'front' | 'back') {
  const s = useBoard.getState()
  const all = Object.values(s.elements)
  const zs = all.map((e) => e.z)
  let z = dir === 'front' ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - s.selection.length
  actions.patchElements(
    [...s.selection].sort((a, b) => s.elements[a].z - s.elements[b].z),
    () => ({ z: z++ }),
  )
}

export function zoomTo(z: number, around?: { sx: number; sy: number }) {
  const cam = useBoard.getState().camera
  const sx = around?.sx ?? window.innerWidth / 2
  const sy = around?.sy ?? window.innerHeight / 2
  const nz = Math.min(4, Math.max(0.15, z))
  const wx = (sx - cam.x) / cam.z
  const wy = (sy - cam.y) / cam.z
  actions.setCamera({ x: sx - wx * nz, y: sy - wy * nz, z: nz })
}

export function zoomToFit() {
  const els = Object.values(useBoard.getState().elements)
  const r = unionRect(els.map(rectOf))
  if (!r) {
    actions.setCamera({ x: window.innerWidth / 2, y: window.innerHeight / 2, z: 1 })
    return
  }
  const pad = 120
  const z = Math.min(1.5, Math.max(0.15, Math.min((window.innerWidth - pad * 2) / Math.max(r.w, 1), (window.innerHeight - pad * 2) / Math.max(r.h, 1))))
  actions.setCamera({ x: window.innerWidth / 2 - (r.x + r.w / 2) * z, y: window.innerHeight / 2 - (r.y + r.h / 2) * z, z })
}
