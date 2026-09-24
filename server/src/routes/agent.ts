import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { Comment, Element, NOTE_COLORS, Reply, SECTION_COLORS, Style, type NoteColor, type SectionColor } from '../../../shared/schema.js'
import { frameAround, isSection, sectionContents } from '../../../shared/sections.js'
import { uid } from '../../../shared/ids.js'
import { reflowArrows, route, type End } from '../../../shared/connectors.js'
import { NotFound, stmt, writeBoard } from '../db.js'
import { placeNote, summarize } from '../summarize.js'
import { snapshot } from './boards.js'
import { isPaused, requireAgent, type AgentEnv } from '../invites.js'
import { ack, ackThread, describeEvents, waitForEvents } from '../events.js'
import { listReports, submitReport } from '../reports.js'

/**
 * Agent API. Agents can read everything; add notes, text titles, sections, arrows,
 * comments and replies; resolve threads; and move elements to reorganize.
 * They cannot edit text or delete.
 * Every route needs an invite token, and only works while the inviting tab is open.
 */
export const agent = new Hono<AgentEnv>()

// The inbox stays reachable while paused (so agents keep listening and learn when they're resumed).
agent.use('/boards/:id/*', async (c, next) => {
  const inbox = /\/inbox$/.test(c.req.path)
  return requireAgent({ allowPaused: inbox })(c, next)
})

/** Whoami: works even while the host is away, so agents can tell "paused" from "invalid". */
agent.get('/session', requireAgent({ allowAway: true, allowPaused: true }), async (c) => {
  const a = c.get('agent')
  const snap = await snapshot(a.boardId)
  return c.json({
    agentName: a.agentName,
    you: { name: a.agentName, persona: a.persona, context: a.context },
    board: { id: snap.board.id, title: snap.board.title },
    host: { active: a.hostActive },
    paused: a.paused ? { by: a.pausedBy } : false,
    endpoints: {
      summary: `/api/agent/boards/${a.boardId}/summary`,
      notes: `/api/agent/boards/${a.boardId}/notes`,
      comments: `/api/agent/boards/${a.boardId}/comments`,
      text: `/api/agent/boards/${a.boardId}/text`,
      topics: `/api/agent/boards/${a.boardId}/topics`,
      arrows: `/api/agent/boards/${a.boardId}/arrows`,
      move: `/api/agent/boards/${a.boardId}/move`,
      inbox: `/api/agent/boards/${a.boardId}/inbox?wait=25`,
      docs: '/api/docs',
    },
  })
})

/** The invite fixes the agent's name; any "author" in the body is ignored. */
const agentAuthor = (c: { get: (k: 'agent') => { agentName: string; inviteId: string } }) => ({
  authorId: c.get('agent').inviteId,
  authorName: c.get('agent').agentName,
  authorType: 'agent' as const,
})
const AuthorName = z.string().optional()

const live = async (id: string) => {
  const snap = await snapshot(id)
  return {
    ...snap,
    elements: snap.elements.filter((e) => !e.deleted),
    comments: snap.comments.filter((c) => !c.deleted),
    replies: snap.replies.filter((r) => !r.deleted),
  }
}

agent.get('/boards/:id/summary', async (c) => c.json(summarize(await live(c.req.param('id')))))

agent.get('/boards/:id/elements', async (c) => {
  const kind = c.req.query('kind')
  const { elements } = await live(c.req.param('id'))
  return c.json({ elements: kind ? elements.filter((e) => e.kind === kind) : elements })
})

agent.get('/boards/:id/comments', async (c) => {
  const resolved = c.req.query('resolved')
  const { comments, replies } = await live(c.req.param('id'))
  const filtered = resolved === undefined ? comments : comments.filter((x) => String(x.resolved) === resolved)
  return c.json({ comments: filtered.map((x) => ({ ...x, replies: replies.filter((r) => r.commentId === x.id) })) })
})

const NOTE_W = 180
const NOTE_H = 180

const NoteBody = z.object({
  author: AuthorName,
  text: z.string().trim().min(1).max(2000),
  color: z.enum(Object.keys(NOTE_COLORS) as [NoteColor, ...NoteColor[]]).default('yellow'),
  x: z.number().optional(),
  y: z.number().optional(),
  nearElementId: z.string().optional(),
})

agent.post('/boards/:id/notes', async (c) => {
  const id = c.req.param('id')
  const body = NoteBody.parse(await c.req.json())
  const snap = await live(id)
  if (body.nearElementId && !snap.elements.some((e) => e.id === body.nearElementId)) {
    return c.json({ error: `No element with id "${body.nearElementId}".` }, 404)
  }
  const pos =
    body.x !== undefined && body.y !== undefined
      ? { x: body.x, y: body.y }
      : placeNote(snap.elements, { w: NOTE_W, h: NOTE_H }, body.nearElementId)
  const maxZ = Math.max(0, ...snap.elements.map((e) => e.z))
  const note = Element.parse({
    id: uid('n_'),
    kind: 'note',
    ...pos,
    w: NOTE_W,
    h: NOTE_H,
    rotation: Math.round((Math.random() * 6 - 3) * 10) / 10,
    z: maxZ + 1,
    style: Style.parse({ color: body.color }),
    text: body.text,
    seed: Math.floor(Math.random() * 1e6),
    ...agentAuthor(c),
  })
  const version = await writeBoard(id, (v) => [stmt.upsertElement(id, note, v)])
  return c.json({ ...note, version }, 201)
})

const CommentBody = z.object({
  author: AuthorName,
  body: z.string().trim().min(1).max(4000),
  anchor: z.union([
    z.object({ elementId: z.string(), dx: z.number().optional(), dy: z.number().optional() }),
    z.object({ x: z.number(), y: z.number() }),
  ]),
})

agent.post('/boards/:id/comments', async (c) => {
  const id = c.req.param('id')
  const body = CommentBody.parse(await c.req.json())
  let anchor: Comment['anchor']
  if ('elementId' in body.anchor) {
    const snap = await live(id)
    const el = snap.elements.find((e) => e.id === (body.anchor as { elementId: string }).elementId)
    if (!el) return c.json({ error: `No element with id "${body.anchor.elementId}".` }, 404)
    // Default: pin to the element's top-right corner.
    anchor = { type: 'element', elementId: el.id, dx: body.anchor.dx ?? Math.max(el.w - 12, 0), dy: body.anchor.dy ?? 12 }
  } else {
    anchor = { type: 'point', x: body.anchor.x, y: body.anchor.y }
  }
  const comment = Comment.parse({ id: uid('c_'), anchor, body: body.body, ...agentAuthor(c) })
  const version = await writeBoard(id, (v) => [stmt.upsertComment(id, comment, v)])
  return c.json({ ...comment, version }, 201)
})

const ReplyBody = z.object({ author: AuthorName, body: z.string().trim().min(1).max(4000) })

agent.post('/boards/:id/comments/:cid/replies', async (c) => {
  const id = c.req.param('id')
  const cid = c.req.param('cid')
  const body = ReplyBody.parse(await c.req.json())
  const snap = await live(id)
  if (!snap.comments.some((x) => x.id === cid)) throw new NotFound('comment')
  const reply = Reply.parse({ id: uid('r_'), commentId: cid, body: body.body, ...agentAuthor(c) })
  const version = await writeBoard(id, (v) => [stmt.upsertReply(id, reply, v)])
  await ackThread(c.get('agent').inviteId, cid) // answering a thread clears its pending prompts
  return c.json({ ...reply, version }, 201)
})

agent.patch('/boards/:id/comments/:cid', async (c) => {
  const id = c.req.param('id')
  const cid = c.req.param('cid')
  const { resolved } = z.object({ resolved: z.boolean() }).parse(await c.req.json())
  const snap = await live(id)
  const existing = snap.comments.find((x) => x.id === cid)
  if (!existing) throw new NotFound('comment')
  const updated = { ...existing, resolved, updatedAt: Date.now() }
  const version = await writeBoard(id, (v) => [stmt.upsertComment(id, updated, v)])
  return c.json({ ...updated, version })
})

// ---------- inbox: how humans prompt agents ----------

const MAX_WAIT_S = 25

/**
 * Pending prompts for this agent (mentions, replies in its threads, comments on its notes).
 * `?wait=25` long-polls: the request stays open until something arrives or time runs out.
 */
agent.get('/boards/:id/inbox', async (c) => {
  const wait = Math.max(0, Math.min(MAX_WAIT_S, Number(c.req.query('wait') ?? 0) || 0))
  const deadline = Date.now() + wait * 1000
  // Paused: hold the request (like a quiet inbox) until resumed or time runs out. Prompts keep queuing.
  if (c.get('agent').paused) {
    while (Date.now() < deadline && !c.req.raw.signal.aborted && (await isPaused(c.get('agent').inviteId))) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (await isPaused(c.get('agent').inviteId)) {
      const a = c.get('agent')
      return c.json({
        you: { name: a.agentName, persona: a.persona, context: a.context },
        paused: { by: a.pausedBy },
        events: [],
        next: `You're paused by ${a.pausedBy ?? 'someone on the board'}. Don't change the board. Call /inbox?wait=25 again to keep waiting; you'll get your queued messages once you're resumed.`,
      })
    }
  }
  const rows = await waitForEvents(c.get('agent').inviteId, Math.max(0, deadline - Date.now()), c.req.raw.signal)
  let events: ReturnType<typeof describeEvents> = []
  if (rows.length) {
    const requesters = new Map((await listReports(c.req.param('id'))).map((r) => [r.id, r.requestedBy]))
    events = describeEvents(rows, await live(c.req.param('id')), requesters)
  }
  const a = c.get('agent')
  return c.json({
    // A reminder of who you are here, in case you've lost the original brief.
    you: { name: a.agentName, persona: a.persona, context: a.context },
    events,
    next: events.length
      ? 'Answer each event by replying in its thread (that marks it done), or POST its id to /inbox/ack to skip it. Then call /inbox?wait=25 again.'
      : 'Nothing new. Call /inbox?wait=25 again to keep listening.',
  })
})

agent.post('/boards/:id/inbox/ack', async (c) => {
  const { ids } = z.object({ ids: z.array(z.number().int()).max(100) }).parse(await c.req.json())
  await ack(c.get('agent').inviteId, ids)
  return c.json({ ok: true })
})

// ---------- arrows + moving: reorganizing the board ----------

const EndSpec = z.union([z.object({ elementId: z.string() }), z.object({ x: z.number(), y: z.number() })])

const ArrowBody = z.object({
  author: AuthorName,
  from: EndSpec,
  to: EndSpec,
  label: z.string().trim().max(80).optional(),
  kind: z.enum(['arrow', 'line']).default('arrow'),
})

/** Draw an arrow between two elements (or points). Attached ends follow those elements when they move. */
agent.post('/boards/:id/arrows', async (c) => {
  const id = c.req.param('id')
  const body = ArrowBody.parse(await c.req.json())
  const snap = await live(id)
  const byId = new Map(snap.elements.map((e) => [e.id, e]))
  const resolve = (spec: z.infer<typeof EndSpec>, which: string): { end: End; binding: string | null } | Response => {
    if ('elementId' in spec) {
      const el = byId.get(spec.elementId)
      if (!el) return c.json({ error: `No element with id "${spec.elementId}" (${which}).` }, 404)
      return { end: { x: el.x, y: el.y, w: el.w, h: el.h }, binding: el.id }
    }
    return { end: { x: spec.x, y: spec.y }, binding: null }
  }
  const from = resolve(body.from, 'from')
  if (from instanceof Response) return from
  const to = resolve(body.to, 'to')
  if (to instanceof Response) return to
  if (from.binding && from.binding === to.binding) return c.json({ error: 'An arrow needs two different ends.' }, 400)

  const maxZ = Math.max(0, ...snap.elements.map((e) => e.z))
  const arrow = Element.parse({
    id: uid('e_'),
    kind: 'shape',
    shape: body.kind,
    ...route(from.end, to.end),
    z: maxZ + 1,
    text: body.label ?? '',
    seed: Math.floor(Math.random() * 1e6),
    bindings: { start: from.binding, end: to.binding },
    ...agentAuthor(c),
  })
  const version = await writeBoard(id, (v) => [stmt.upsertElement(id, arrow, v)])
  return c.json({ ...arrow, version }, 201)
})

const MoveBody = z.object({
  moves: z
    .array(
      z.union([
        z.object({ id: z.string(), x: z.number(), y: z.number() }),
        z.object({ id: z.string(), dx: z.number(), dy: z.number() }),
      ]),
    )
    .min(1)
    .max(200),
})

/**
 * Reposition elements (absolute x/y = new top-left, or relative dx/dy). Batch it:
 * one call can regroup a whole cluster. Attached arrows re-route, comments follow.
 */
agent.post('/boards/:id/move', async (c) => {
  const id = c.req.param('id')
  const { moves } = MoveBody.parse(await c.req.json())
  const snap = await live(id)
  const all: Record<string, (typeof snap.elements)[number]> = Object.fromEntries(snap.elements.map((e) => [e.id, e]))
  const missing = moves.filter((m) => !all[m.id]).map((m) => m.id)
  if (missing.length) return c.json({ error: `Unknown element id(s): ${missing.join(', ')}` }, 404)
  const bound = moves.filter((m) => all[m.id].bindings?.start || all[m.id].bindings?.end).map((m) => m.id)
  if (bound.length) return c.json({ error: `Attached arrows move with their elements; move those instead: ${bound.join(', ')}` }, 400)

  const now = Date.now()
  const explicit = new Set(moves.map((m) => m.id))
  const movedIds = new Set<string>()
  const original = { ...all }
  const shift = (id: string, dx: number, dy: number) => {
    const el = all[id]
    all[id] = { ...el, x: el.x + dx, y: el.y + dy, updatedAt: now }
    movedIds.add(id)
  }
  for (const m of moves) {
    const el = original[m.id]
    const dx = 'x' in m ? m.x - el.x : m.dx
    const dy = 'x' in m ? m.y - el.y : m.dy
    shift(m.id, dx, dy)
    // A section carries what's inside it (unless those items were given their own moves).
    if (isSection(el)) {
      for (const inner of sectionContents(el, Object.values(original))) {
        if (!explicit.has(inner.id) && !movedIds.has(inner.id)) shift(inner.id, dx, dy)
      }
    }
  }
  const rerouted = reflowArrows(all, movedIds)
  const changed = [...[...movedIds].map((id) => all[id]), ...rerouted]
  const version = await writeBoard(id, (v) => changed.map((e) => stmt.upsertElement(id, e, v)))
  return c.json({
    version,
    moved: [...movedIds].map((id) => ({ id, x: Math.round(all[id].x), y: Math.round(all[id].y) })),
    reroutedArrows: rerouted.map((a) => a.id),
  })
})

// ---------- structure: text titles + sections ----------

const TextBody = z.object({
  author: AuthorName,
  text: z.string().trim().min(1).max(200),
  x: z.number().optional(),
  y: z.number().optional(),
  /** Place it just above this element (e.g. a heading over a cluster). */
  aboveElementId: z.string().optional(),
  size: z.enum(['title', 'heading', 'label']).default('heading'),
})

const TEXT_SIZES = { title: 48, heading: 34, label: 24 } as const
/** Rough size of handwritten text until the browser measures it. */
const estimateText = (text: string, fontSize: number) => {
  const lines = text.split('\n')
  return { w: Math.max(...lines.map((l) => l.length)) * fontSize * 0.48 + 8, h: lines.length * fontSize * 1.15 + 4 }
}

/** Standalone text: titles for the board, headings over clusters, labels. Prefer this to a sticky note for anything that names a group. */
agent.post('/boards/:id/text', async (c) => {
  const id = c.req.param('id')
  const body = TextBody.parse(await c.req.json())
  const snap = await live(id)
  const fontSize = TEXT_SIZES[body.size]
  const size = estimateText(body.text, fontSize)
  let pos: { x: number; y: number }
  if (body.aboveElementId) {
    const el = snap.elements.find((e) => e.id === body.aboveElementId)
    if (!el) return c.json({ error: `No element with id "${body.aboveElementId}".` }, 404)
    pos = { x: el.x, y: el.y - size.h - 16 }
  } else if (body.x !== undefined && body.y !== undefined) {
    pos = { x: body.x, y: body.y }
  } else {
    pos = placeNote(snap.elements.filter((e) => !isSection(e)), size)
  }
  const el = Element.parse({
    id: uid('e_'),
    kind: 'text',
    ...pos,
    ...size,
    z: Math.max(0, ...snap.elements.map((e) => e.z)) + 1,
    style: Style.parse({ fontSize }),
    text: body.text,
    ...agentAuthor(c),
  })
  const version = await writeBoard(id, (v) => [stmt.upsertElement(id, el, v)])
  return c.json({ ...el, version }, 201)
})

const SectionBody = z
  .object({
    author: AuthorName,
    title: z.string().trim().max(80).default(''),
    /** Frame these elements (sized to fit, with room for the title). */
    elementIds: z.array(z.string()).min(1).max(200).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    color: z.enum(Object.keys(SECTION_COLORS) as [SectionColor, ...SectionColor[]]).default('gray'),
  })
  .refine((b) => b.elementIds || (b.x !== undefined && b.y !== undefined && b.w && b.h), {
    message: 'Give elementIds to frame, or x, y, w and h.',
  })

/**
 * A section: a titled rectangle around a group. It renders beneath everything,
 * and moving it (via /move) carries the elements inside it.
 */
const createTopic = async (c: Context<AgentEnv>) => {
  const id = c.req.param('id')!
  const body = SectionBody.parse(await c.req.json())
  const snap = await live(id)
  let frame: { x: number; y: number; w: number; h: number }
  if (body.elementIds) {
    const byId = new Map(snap.elements.map((e) => [e.id, e]))
    const missing = body.elementIds.filter((x) => !byId.has(x))
    if (missing.length) return c.json({ error: `Unknown element id(s): ${missing.join(', ')}` }, 404)
    frame = frameAround(body.elementIds.map((x) => byId.get(x)!))
  } else {
    frame = { x: body.x!, y: body.y!, w: body.w!, h: body.h! }
  }
  const section = Element.parse({
    id: uid('e_'),
    kind: 'shape',
    shape: 'rect',
    role: 'section',
    ...frame,
    z: Math.min(0, ...snap.elements.map((e) => e.z)) - 1,
    style: Style.parse({ color: body.color, strokeWidth: 2 }),
    text: body.title,
    ...agentAuthor(c),
  })
  const version = await writeBoard(id, (v) => [stmt.upsertElement(id, section, v)])
  return c.json({ ...section, contains: sectionContents(section, snap.elements).map((e) => e.id), version }, 201)
}
/** Topics (a.k.a. sections): titled areas; everything inside belongs to the topic. */
agent.post('/boards/:id/topics', createTopic)
agent.post('/boards/:id/sections', createTopic)

// ---------- reports ----------

/** Hand in a report you were asked to write (see report_request events in your inbox). */
agent.post('/boards/:id/reports/:rid', async (c) => {
  const { markdown } = z.object({ markdown: z.string().trim().min(20).max(60_000) }).parse(await c.req.json())
  const ok = await submitReport(c.req.param('id'), c.req.param('rid'), c.get('agent').inviteId, markdown)
  if (!ok) return c.json({ error: 'No report request for you with that id.' }, 404)
  return c.json({ ok: true })
})
