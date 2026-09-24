import { create } from 'zustand'
import type { AgentDeletion, AgentPresence, Board, BoardSnapshot, Comment, Element, PresenceEntry, PromptStatus, Reply, ReportInfo } from '../../../shared/schema'
import { reflowArrows } from '../../../shared/connectors'
import type { Profile } from '../lib/profile'

export type Tool =
  | 'select'
  | 'hand'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'line'
  | 'pen'
  | 'text'
  | 'note'
  | 'comment'
  | 'topic'

export type Entity = 'element' | 'comment' | 'reply'
export type SaveState = 'saved' | 'saving' | 'offline'

export interface Camera {
  x: number
  y: number
  z: number
}

interface HistoryEntry {
  elements: Record<string, Element>
  comments: Record<string, Comment>
  replies: Record<string, Reply>
}

/** Changes that arrived from someone else; `null` = deleted. */
export interface RemotePatch {
  elements: Record<string, Element | null>
  comments: Record<string, Comment | null>
  replies: Record<string, Reply | null>
}

interface State {
  me: Profile | null
  board: Board | null
  elements: Record<string, Element>
  comments: Record<string, Comment>
  replies: Record<string, Reply>
  presence: PresenceEntry[]
  agents: AgentPresence[]
  /** Which human messages prompted which agents, and whether they've answered. */
  prompts: PromptStatus[]
  reports: ReportInfo[]
  /** True once the first update check has come back (lists like reports are only complete from then on). */
  synced: boolean
  /** Recent deletions agents made (on request), so people can restore them. */
  agentDeletions: AgentDeletion[]
  /** Elements that just moved because of someone else (animate them into place). */
  glideIds: Set<string>
  /** This tab's session id (agent invites are bound to it). */
  sid: string

  camera: Camera
  tool: Tool
  toolLocked: boolean
  selection: string[]
  /** Selected (resolved) comment threads, highlighted like elements so they can be deleted. */
  commentSelection: string[]
  editingId: string | null
  openThreadId: string | null
  draftComment: { anchor: Comment['anchor'] } | null
  showResolved: boolean
  freshIds: Set<string>

  saveState: SaveState
  /** `${entity}:${id}` keys with local changes not yet sent. */
  dirty: Set<string>
  titleDirty: boolean
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
}

const initial = (): State => ({
  me: null,
  board: null,
  elements: {},
  comments: {},
  replies: {},
  presence: [],
  agents: [],
  prompts: [],
  reports: [],
  synced: false,
  agentDeletions: [],
  glideIds: new Set(),
  sid: '',
  camera: { x: 0, y: 0, z: 1 },
  tool: 'select',
  toolLocked: false,
  selection: [],
  commentSelection: [],
  editingId: null,
  openThreadId: null,
  draftComment: null,
  showResolved: false,
  freshIds: new Set(),
  saveState: 'saved',
  dirty: new Set(),
  titleDirty: false,
  undoStack: [],
  redoStack: [],
})

export const useBoard = create<State>(() => initial())

const set = useBoard.setState
const get = useBoard.getState

const byId = <T extends { id: string; deleted?: boolean }>(xs: T[]) => {
  const out: Record<string, T> = {}
  for (const x of xs) if (!x.deleted) out[x.id] = x
  return out
}

let listeners: Array<() => void> = []
/** Called whenever something is marked dirty (the sync loop schedules a flush). */
export const onDirty = (fn: () => void) => {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}
const markDirty = (keys: string[]) => {
  if (!keys.length) return
  const dirty = new Set(get().dirty)
  keys.forEach((k) => dirty.add(k))
  set({ dirty, saveState: 'saving' })
  listeners.forEach((l) => l())
}

export const actions = {
  reset() {
    set(initial())
  },

  load(snap: BoardSnapshot, me: Profile, sid: string) {
    set({
      ...initial(),
      me,
      sid,
      board: snap.board,
      elements: byId(snap.elements),
      comments: byId(snap.comments),
      replies: byId(snap.replies),
    })
  },

  // ---------- history ----------

  checkpoint() {
    const { elements, comments, replies, undoStack } = get()
    set({ undoStack: [...undoStack.slice(-99), { elements, comments, replies }], redoStack: [] })
  },

  undo() {
    const { undoStack, redoStack, elements, comments, replies } = get()
    const prev = undoStack[undoStack.length - 1]
    if (!prev) return
    set({ undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, { elements, comments, replies }] })
    restore(prev)
  },

  redo() {
    const { undoStack, redoStack, elements, comments, replies } = get()
    const next = redoStack[redoStack.length - 1]
    if (!next) return
    set({ redoStack: redoStack.slice(0, -1), undoStack: [...undoStack, { elements, comments, replies }] })
    restore(next)
  },

  /**
   * Fold someone else's changes into every history entry, so undo/redo only
   * ever revert *my* actions and never delete an agent's new note (etc.).
   */
  rebaseHistory(patch: RemotePatch) {
    const apply = <T,>(map: Record<string, T>, changes: Record<string, T | null>) => {
      const ids = Object.keys(changes)
      if (!ids.length) return map
      const next = { ...map }
      for (const id of ids) {
        const v = changes[id]
        if (v === null) delete next[id]
        else next[id] = v
      }
      return next
    }
    const fix = (e: HistoryEntry): HistoryEntry => ({
      elements: apply(e.elements, patch.elements),
      comments: apply(e.comments, patch.comments),
      replies: apply(e.replies, patch.replies),
    })
    const { undoStack, redoStack } = get()
    if (!undoStack.length && !redoStack.length) return
    set({ undoStack: undoStack.map(fix), redoStack: redoStack.map(fix) })
  },

  // ---------- elements ----------

  upsertElements(els: Element[]) {
    if (!els.length) return
    const now = Date.now()
    const elements = { ...get().elements }
    for (const e of els) elements[e.id] = { ...e, updatedAt: now }
    // Arrows attached to anything that changed follow along.
    const rerouted = reflowArrows(elements, els.map((e) => e.id))
    for (const a of rerouted) elements[a.id] = { ...a, updatedAt: now }
    set({ elements })
    markDirty([...els, ...rerouted].map((e) => `element:${e.id}`))
  },

  patchElements(ids: string[], patch: (e: Element) => Partial<Element>) {
    const els = get().elements
    actions.upsertElements(ids.filter((id) => els[id]).map((id) => ({ ...els[id], ...patch(els[id]) })))
  },

  deleteElements(ids: string[]) {
    if (!ids.length) return
    const { elements, comments } = get()
    const nextEls = { ...elements }
    const nextComments = { ...comments }
    const keys: string[] = []
    for (const id of ids) {
      const el = elements[id]
      if (!el) continue
      delete nextEls[id]
      keys.push(`element:${id}`)
      // Arrows attached to it stay put, just detached at that end.
      for (const a of Object.values(nextEls)) {
        if (a.bindings?.start === id || a.bindings?.end === id) {
          const b = a.bindings
          nextEls[a.id] = {
            ...a,
            bindings: {
              start: b.start === id ? null : b.start,
              end: b.end === id ? null : b.end,
              startAt: b.start === id ? null : (b.startAt ?? null),
              endAt: b.end === id ? null : (b.endAt ?? null),
            },
          }
          keys.push(`element:${a.id}`)
        }
      }
      // Comments pinned to a deleted element stay where they were, as point comments.
      for (const c of Object.values(comments)) {
        if (c.anchor.type === 'element' && c.anchor.elementId === id) {
          nextComments[c.id] = { ...c, anchor: { type: 'point', x: el.x + c.anchor.dx, y: el.y + c.anchor.dy } }
          keys.push(`comment:${c.id}`)
        }
      }
    }
    set({ elements: nextEls, comments: nextComments, selection: get().selection.filter((s) => !ids.includes(s)) })
    markDirty(keys)
  },

  // ---------- comments ----------

  upsertComment(c: Comment) {
    set({ comments: { ...get().comments, [c.id]: { ...c, updatedAt: Date.now() } } })
    markDirty([`comment:${c.id}`])
  },

  deleteComment(id: string) {
    const comments = { ...get().comments }
    delete comments[id]
    const replies = { ...get().replies }
    const keys = [`comment:${id}`]
    for (const r of Object.values(replies)) {
      if (r.commentId === id) {
        delete replies[r.id]
        keys.push(`reply:${r.id}`)
      }
    }
    set({
      comments,
      replies,
      openThreadId: get().openThreadId === id ? null : get().openThreadId,
      commentSelection: get().commentSelection.filter((c) => c !== id),
    })
    markDirty(keys)
  },

  deleteComments(ids: string[]) {
    for (const id of ids) actions.deleteComment(id)
  },

  addReply(r: Reply) {
    set({ replies: { ...get().replies, [r.id]: r } })
    markDirty([`reply:${r.id}`])
  },

  deleteReply(id: string) {
    const replies = { ...get().replies }
    delete replies[id]
    set({ replies })
    markDirty([`reply:${id}`])
  },

  setTitle(title: string) {
    const board = get().board
    if (!board) return
    set({ board: { ...board, title }, titleDirty: true })
    listeners.forEach((l) => l())
  },

  // ---------- ui ----------

  setTool(tool: Tool, locked = false) {
    set({ tool, toolLocked: locked, editingId: null, draftComment: null })
  },
  select(ids: string[]) {
    set({ selection: ids })
  },
  selectComments(ids: string[]) {
    set({ commentSelection: ids })
  },
  setCamera(camera: Camera) {
    set({ camera })
  },
  edit(id: string | null) {
    set({ editingId: id })
  },
  openThread(id: string | null) {
    set({ openThreadId: id, draftComment: null })
  },
  markFresh(id: string) {
    const freshIds = new Set(get().freshIds)
    freshIds.add(id)
    set({ freshIds })
    setTimeout(() => {
      const f = new Set(get().freshIds)
      f.delete(id)
      set({ freshIds: f })
    }, 900)
  },
}

/** Replace elements/comments with a history entry and mark whatever changed as dirty. */
function restore(entry: HistoryEntry) {
  const { elements, comments, replies } = get()
  const keys: string[] = []
  for (const id of new Set([...Object.keys(replies), ...Object.keys(entry.replies)])) {
    if (replies[id] !== entry.replies[id]) keys.push(`reply:${id}`)
  }
  for (const id of new Set([...Object.keys(elements), ...Object.keys(entry.elements)])) {
    if (elements[id] !== entry.elements[id]) keys.push(`element:${id}`)
  }
  for (const id of new Set([...Object.keys(comments), ...Object.keys(entry.comments)])) {
    if (comments[id] !== entry.comments[id]) keys.push(`comment:${id}`)
  }
  const selection = get().selection.filter((id) => entry.elements[id])
  const commentSelection = get().commentSelection.filter((id) => entry.comments[id])
  set({ elements: entry.elements, comments: entry.comments, replies: entry.replies, selection, commentSelection, editingId: null })
  markDirty(keys)
}

export const nextZ = () => Math.max(0, ...Object.values(get().elements).map((e) => e.z)) + 1

/** Screen (client) → world coordinates. */
export const toWorld = (sx: number, sy: number, cam = get().camera) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z })
