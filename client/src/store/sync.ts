import type { Op } from '../../../shared/schema'
import { uid } from '../../../shared/ids'
import { api } from '../lib/api'
import { actions, onDirty, useBoard, type RemotePatch } from './board'

/** Stable content fingerprint, ignoring server bookkeeping, to tell echoes of my own saves from real remote edits. */
function fingerprint(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(x).sort()) {
        if (k === 'version' || k === 'updatedAt') continue
        out[k] = norm((x as Record<string, unknown>)[k])
      }
      return out
    }
    return x
  }
  return JSON.stringify(norm(v))
}

/** Does an incoming row differ from what I already have locally? */
const isRemoteChange = (incoming: { deleted?: boolean }, local: unknown) =>
  incoming.deleted ? local !== undefined : local === undefined || fingerprint(incoming) !== fingerprint(local)

const FLUSH_IDLE_MS = 400
const POLL_MS = 4000
/** Hidden tabs still heartbeat (slower) so agent invites stay alive while the tab is open. */
const HIDDEN_POLL_MS = 10000

/**
 * Autosave + polling for one board.
 * - Local edits mark entities dirty; after a short idle we send just those as ops.
 * - Every few seconds we fetch rows changed since our version and merge them in,
 *   skipping anything with unsent local edits (local wins).
 */
export function startSync(boardId: string): () => void {
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let flushing = false
  let flushSeq = 0
  let stopped = false
  /** One id per visit. Once this run says goodbye, the server ignores any of its late requests. */
  let run = uid('run_')
  let polling = false
  let pollAgain = false

  const buildOps = (keys: string[], titleDirty: boolean): Op[] => {
    const { elements, comments, replies, board } = useBoard.getState()
    const ops: Op[] = []
    for (const key of keys) {
      const [entity, id] = key.split(/:(.*)/s) as ['element' | 'comment' | 'reply', string]
      const value = entity === 'element' ? elements[id] : entity === 'comment' ? comments[id] : replies[id]
      if (value) ops.push({ entity, op: 'upsert', data: value } as Op)
      else ops.push({ entity, op: 'delete', id })
    }
    if (titleDirty && board) ops.push({ entity: 'board', op: 'upsert', data: { title: board.title } })
    return ops
  }

  const takeDirty = () => {
    const { dirty, titleDirty } = useBoard.getState()
    const keys = [...dirty]
    useBoard.setState({ dirty: new Set(), titleDirty: false })
    return { keys, titleDirty }
  }

  const flush = async () => {
    flushTimer = null
    if (flushing) {
      schedule()
      return
    }
    const { keys, titleDirty } = takeDirty()
    if (!keys.length && !titleDirty) return
    flushing = true
    flushSeq++
    try {
      await api.ops(boardId, buildOps(keys, titleDirty))
      const s = useBoard.getState()
      useBoard.setState({ saveState: s.dirty.size || s.titleDirty ? 'saving' : 'saved' })
    } catch {
      // Put the keys back and try again later.
      const s = useBoard.getState()
      const dirty = new Set(s.dirty)
      keys.forEach((k) => dirty.add(k))
      useBoard.setState({ dirty, titleDirty: s.titleDirty || titleDirty, saveState: 'offline' })
      flushTimer = setTimeout(flush, 3000)
    } finally {
      flushing = false
    }
  }

  const schedule = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, FLUSH_IDLE_MS)
  }

  const poll = async () => {
    pollTimer = null
    if (stopped) return
    const s0 = useBoard.getState()
    if (!s0.board || !s0.me) return
    polling = true
    const seqAtStart = flushSeq
    try {
      const res = await api.changes(boardId, s0.board.version, {
        pid: s0.me.id,
        sid: s0.sid,
        run,
        visible: document.visibilityState === 'visible',
      })
      if (stopped) return
      const s = useBoard.getState()
      // A save happened mid-request: this response may predate it, so drop it and ask again.
      if (flushSeq !== seqAtStart || flushing) {
        useBoard.setState({ presence: res.presence, agents: res.agents, prompts: res.prompts, reports: res.reports })
        return
      }
      const elements = { ...s.elements }
      const comments = { ...s.comments }
      const replies = { ...s.replies }
      let changed = false
      const glide: string[] = []
      const patch: RemotePatch = { elements: {}, comments: {}, replies: {} }
      for (const e of res.elements) {
        if (s.dirty.has(`element:${e.id}`)) continue
        changed = true
        if (isRemoteChange(e, s.elements[e.id])) patch.elements[e.id] = e.deleted ? null : e
        const prev = elements[e.id]
        if (prev && !e.deleted && (prev.x !== e.x || prev.y !== e.y)) glide.push(e.id)
        if (e.deleted) delete elements[e.id]
        else elements[e.id] = e
      }
      for (const c of res.comments) {
        if (s.dirty.has(`comment:${c.id}`)) continue
        changed = true
        if (isRemoteChange(c, s.comments[c.id])) patch.comments[c.id] = c.deleted ? null : c
        if (c.deleted) delete comments[c.id]
        else comments[c.id] = c
      }
      for (const r of res.replies) {
        if (s.dirty.has(`reply:${r.id}`)) continue
        changed = true
        if (isRemoteChange(r, s.replies[r.id])) patch.replies[r.id] = r.deleted ? null : r
        if (r.deleted) delete replies[r.id]
        else replies[r.id] = r
      }
      const board = s.titleDirty ? { ...res.board, title: s.board!.title } : res.board
      useBoard.setState({
        board,
        presence: res.presence,
        agents: res.agents,
        prompts: res.prompts,
        reports: res.reports,
        ...(glide.length ? { glideIds: new Set([...s.glideIds, ...glide]) } : {}),
        ...(changed
          ? {
              elements,
              comments,
              replies,
              selection: s.selection.filter((id) => elements[id]),
              commentSelection: s.commentSelection.filter((id) => comments[id]),
            }
          : {}),
        ...(s.saveState === 'offline' && !s.dirty.size ? { saveState: 'saved' as const } : {}),
      })
      if (changed) actions.rebaseHistory(patch)
      if (glide.length) {
        setTimeout(() => {
          const g = new Set(useBoard.getState().glideIds)
          glide.forEach((id) => g.delete(id))
          useBoard.setState({ glideIds: g })
        }, 900)
      }
    } catch {
      if (!useBoard.getState().dirty.size) useBoard.setState({ saveState: 'offline' })
    } finally {
      polling = false
      if (!stopped) {
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = setTimeout(poll, pollAgain ? 0 : document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : POLL_MS)
        pollAgain = false
      }
    }
  }

  const pollNow = () => {
    if (stopped) return
    if (polling) {
      pollAgain = true // run right after the current request, never two loops at once
      return
    }
    if (pollTimer) clearTimeout(pollTimer)
    poll()
  }

  const flushBeacon = () => {
    const { keys, titleDirty } = takeDirty()
    if (keys.length || titleDirty) {
      flushSeq++
      if (!api.beaconOps(boardId, buildOps(keys, titleDirty))) {
        const dirty = new Set(useBoard.getState().dirty)
        keys.forEach((k) => dirty.add(k))
        useBoard.setState({ dirty })
      }
    }
  }

  // Visible again → catch up; hidden → save now and tell others we're away.
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flushBeacon()
    pollNow()
  }

  // Closing (or reloading) the tab pauses its agent invites right away; a reload's next poll revives them.
  // No polling here: a request fired while the page closes could land after the goodbye.
  const onPageHide = () => {
    stopped = true
    if (pollTimer) clearTimeout(pollTimer)
    flushBeacon()
    const { sid } = useBoard.getState()
    if (sid) api.leaveBeacon(sid, run)
  }

  // Restored from the back/forward cache after we said goodbye: start a fresh run.
  const onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted || !stopped) return
    run = uid('run_')
    stopped = false
    pollNow()
  }

  const unsub = onDirty(schedule)
  window.addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  pollTimer = setTimeout(pollNow, 300)

  return () => {
    stopped = true
    // Leaving the board (in-app navigation): drop out of presence and pause this tab's agents.
    const { sid } = useBoard.getState()
    if (sid) api.leaveBeacon(sid, run)
    unsub()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    if (pollTimer) clearTimeout(pollTimer)
    if (flushTimer) {
      clearTimeout(flushTimer)
      flush()
    }
  }
}
