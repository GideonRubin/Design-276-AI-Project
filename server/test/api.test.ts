import { beforeEach, describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'
import { app } from '../src/app.js'
import { getDb, useDb } from '../src/db.js'

let token: string | null = null

const req = async (method: string, path: string, body?: unknown, auth: string | null = token) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const note = (id: string, x = 0, y = 0, text = 'hello') => ({
  id,
  kind: 'note',
  x,
  y,
  w: 180,
  h: 180,
  text,
  style: { color: 'yellow' },
  authorName: 'Gidi',
})

/** Host tab opens the board (heartbeat) and invites an agent. */
async function invite(board: string, agentName = 'Bot', sid = 'sid_host_tab_1') {
  await req('PUT', '/participants/host', { name: 'Gidi', color: '#FF5A47', sketch: [] }, null)
  await req('GET', `/boards/${board}/changes?since=0&pid=host&sid=${sid}`, undefined, null)
  const res = await req('POST', `/boards/${board}/invites`, { pid: 'host', sid, agentName }, null)
  expect(res.status).toBe(201)
  return res.body as { token: string; invite: { id: string } }
}

beforeEach(() => {
  useDb(createClient({ url: ':memory:' }))
  token = null
})

describe('boards', () => {
  it('creates a board, rejects duplicates, 404s unknown ids', async () => {
    expect((await req('POST', '/boards', { id: 'Demo Board' })).body.id).toBe('demo-board')
    expect((await req('POST', '/boards', { id: 'demo-board' })).status).toBe(409)
    expect((await req('GET', '/boards/nope')).status).toBe(404)
    const generated = await req('POST', '/boards', {})
    expect(generated.body.id).toMatch(/^[a-z]+-[a-z]+-\d\d$/)
  })

  it('applies ops and reports only changes since a version (including deletes)', async () => {
    await req('POST', '/boards', { id: 'demo' })
    const v1 = (await req('PATCH', '/boards/demo/ops', {
      ops: [
        { entity: 'element', op: 'upsert', data: note('a') },
        { entity: 'element', op: 'upsert', data: note('b', 300) },
      ],
    })).body.version
    expect(v1).toBe(1)

    const v2 = (await req('PATCH', '/boards/demo/ops', { ops: [{ entity: 'element', op: 'delete', id: 'a' }] })).body.version
    const changes = (await req('GET', `/boards/demo/changes?since=${v1}`)).body
    expect(changes.board.version).toBe(v2)
    expect(changes.elements).toHaveLength(1)
    expect(changes.elements[0]).toMatchObject({ id: 'a', deleted: true })

    const full = (await req('GET', '/boards/demo')).body
    expect(full.elements.map((e: any) => e.id)).toEqual(['b'])
  })

  it('round-trips export → import', async () => {
    await req('POST', '/boards', { id: 'src', title: 'Kickoff' })
    await req('PATCH', '/boards/src/ops', { ops: [{ entity: 'element', op: 'upsert', data: note('a', 10, 20, 'idea') }] })
    token = (await invite('src')).token
    await req('POST', '/agent/boards/src/comments', { author: 'Bot', body: 'nice', anchor: { elementId: 'a' } })
    const threads = (await req('GET', '/agent/boards/src/comments')).body.comments
    await req('POST', `/agent/boards/src/comments/${threads[0].id}/replies`, { author: 'Bot', body: 'agreed' })

    const file = (await req('GET', '/boards/src/export')).body
    expect(file.format).toBe('dschool-whiteboard')
    expect(file.comments[0].replies).toHaveLength(1)

    expect((await req('POST', '/boards/copy/import', file)).status).toBe(200)
    const again = (await req('GET', '/boards/copy/export')).body
    const strip = (f: any) => JSON.parse(JSON.stringify({ ...f, exportedAt: 0, board: { title: f.board.title } }, (k, v) => (k === 'version' || k === 'updatedAt' ? undefined : v)))
    expect(strip(again)).toEqual(strip(file))
  })

  it('rejects garbage datafiles', async () => {
    const res = await req('POST', '/boards/x1/import', { hello: 'world' })
    expect(res.status).toBe(400)
  })
})

describe('agent API', () => {
  beforeEach(async () => {
    await req('POST', '/boards', { id: 'demo' })
    await req('PATCH', '/boards/demo/ops', {
      ops: [
        { entity: 'element', op: 'upsert', data: note('a', 0, 0, 'Users hate waiting') },
        { entity: 'element', op: 'upsert', data: { id: 's', kind: 'shape', shape: 'rect', x: 1000, y: 0, w: 100, h: 60, text: 'Journey map' } },
      ],
    })
    token = (await invite('demo', 'Bot')).token
  })

  it('adds notes, auto-placing them without overlap', async () => {
    const res = await req('POST', '/agent/boards/demo/notes', { author: 'Bot', text: 'What if no queue?', nearElementId: 'a' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ kind: 'note', authorType: 'agent', authorName: 'Bot' })
    expect(res.body.x).toBeGreaterThanOrEqual(180)
    expect(Math.abs(res.body.rotation)).toBeLessThanOrEqual(3)
  })

  it('comments on an element and the summary resolves the anchor', async () => {
    const c = await req('POST', '/agent/boards/demo/comments', { author: 'Bot', body: 'Evidence?', anchor: { elementId: 'a' } })
    expect(c.status).toBe(201)
    await req('POST', `/agent/boards/demo/comments/${c.body.id}/replies`, { author: 'Bot', body: 'From interviews' })
    await req('PATCH', `/agent/boards/demo/comments/${c.body.id}`, { resolved: true })

    const s = (await req('GET', '/agent/boards/demo/summary')).body
    expect(s.counts).toMatchObject({ notes: 1, shapes: 1, threads: 1, openThreads: 0 })
    expect(s.threads[0].anchoredTo).toMatchObject({ type: 'element', id: 'a', kind: 'note', text: 'Users hate waiting' })
    expect(s.threads[0].replies[0].body).toBe('From interviews')
    expect(s.shapes[0].label).toBe('Journey map')
  })

  it('404s on unknown anchors, and has no delete/move endpoints', async () => {
    expect((await req('POST', '/agent/boards/demo/comments', { body: 'x', anchor: { elementId: 'zzz' } })).status).toBe(404)
    expect((await req('DELETE', '/agent/boards/demo/elements/a')).status).toBe(404)
    expect((await req('PATCH', '/agent/boards/demo/elements/a', { x: 5 })).status).toBe(404)
  })
})

describe('agent invites', () => {
  beforeEach(async () => {
    await req('POST', '/boards', { id: 'demo' }, null)
    await req('POST', '/boards', { id: 'other' }, null)
  })

  it('rejects missing or bogus tokens', async () => {
    expect((await req('GET', '/agent/boards/demo/summary', undefined, null)).status).toBe(401)
    expect((await req('GET', '/agent/boards/demo/summary', undefined, 'wb_nope')).status).toBe(401)
  })

  it('only creates invites from a live tab of the same person and board', async () => {
    expect((await req('POST', '/boards/demo/invites', { pid: 'host', sid: 'sid_never_seen', agentName: 'Bot' }, null)).status).toBe(409)
  })

  it('stores the persona + role context and reminds the agent of them', async () => {
    await req('PUT', '/participants/host', { name: 'Gidi', color: '#FF5A47', sketch: [] }, null)
    await req('GET', '/boards/demo/changes?since=0&pid=host&sid=sid_host_tab_1', undefined, null)
    const res = await req('POST', '/boards/demo/invites', {
      pid: 'host', sid: 'sid_host_tab_1', agentName: 'Critic', persona: "Devil's advocate", context: 'Push back on assumptions; cite evidence.',
    }, null)
    const you = { name: 'Critic', persona: "Devil's advocate", context: 'Push back on assumptions; cite evidence.' }
    expect((await req('GET', '/agent/session', undefined, res.body.token)).body.you).toEqual(you)
    expect((await req('GET', '/agent/boards/demo/inbox', undefined, res.body.token)).body.you).toEqual(you)
    const agents = (await req('GET', '/boards/demo/changes?since=0&pid=host&sid=sid_host_tab_1', undefined, null)).body.agents
    expect(agents[0].persona).toBe("Devil's advocate")
  })

  it('binds a token to one board and fixes the agent name', async () => {
    const { token: t } = await invite('demo', 'Critic')
    expect((await req('GET', '/agent/boards/other/summary', undefined, t)).status).toBe(403)
    const note = await req('POST', '/agent/boards/demo/notes', { author: 'Someone Else', text: 'hi' }, t)
    expect(note.body).toMatchObject({ authorName: 'Critic', authorType: 'agent' })
    const who = await req('GET', '/agent/session', undefined, t)
    expect(who.body).toMatchObject({ agentName: 'Critic', board: { id: 'demo' }, host: { active: true } })
  })

  it('pauses when the host tab leaves or goes quiet, and resumes on heartbeat', async () => {
    const { token: t } = await invite('demo')
    await req('POST', '/sessions/sid_host_tab_1/leave', undefined, null)
    expect((await req('GET', '/agent/boards/demo/summary', undefined, t)).status).toBe(423)
    expect((await req('GET', '/agent/session', undefined, t)).body.host.active).toBe(false)

    // Host comes back (reload = a new run).
    await req('GET', '/boards/demo/changes?since=0&pid=host&sid=sid_host_tab_1&run=run_2', undefined, null)
    expect((await req('GET', '/agent/boards/demo/summary', undefined, t)).status).toBe(200)

    await getDb().execute({ sql: 'UPDATE host_sessions SET last_seen_at = ?', args: [Date.now() - 120_000] })
    expect((await req('GET', '/agent/boards/demo/summary', undefined, t)).status).toBe(423)

    await getDb().execute({ sql: 'UPDATE host_sessions SET last_seen_at = ?', args: [Date.now() - 31 * 60_000] })
    expect((await req('GET', '/agent/boards/demo/summary', undefined, t)).status).toBe(401)
  })

  it('pauses and resumes an agent: paused = no changes, no prompts, but it keeps listening', async () => {
    const claude = await invite('demo', 'Claude')
    await req('PUT', '/participants/guest', { name: 'Maya', color: '#1FA59A', sketch: [] }, null)
    await req('GET', '/boards/demo/changes?since=0&pid=guest&sid=sid_guest_tab', undefined, null)

    // Anyone on the board can pause (not someone who isn't connected).
    expect((await req('POST', `/boards/demo/invites/${claude.invite.id}/pause`, { sid: 'not_connected', paused: true }, null)).status).toBe(404)
    expect((await req('POST', `/boards/demo/invites/${claude.invite.id}/pause`, { sid: 'sid_guest_tab', paused: true }, null)).status).toBe(200)
    const agents = (await req('GET', '/boards/demo/changes?since=0&pid=guest&sid=sid_guest_tab', undefined, null)).body.agents
    expect(agents[0]).toMatchObject({ paused: true, pausedBy: 'Maya' })

    // Can't act…
    const blocked = await req('POST', '/agent/boards/demo/notes', { text: 'hi' }, claude.token)
    expect(blocked.status).toBe(423)
    expect(blocked.body.error).toContain('paused by Maya')
    // …mentions queue but aren't delivered; the inbox says it's paused.
    await req('PATCH', '/boards/demo/ops', {
      ops: [{ entity: 'comment', op: 'upsert', data: { id: 'cp', anchor: { type: 'point', x: 0, y: 0 }, body: '@Claude you there?', authorId: 'guest', authorName: 'Maya', authorType: 'human' } }],
    }, null)
    const held = (await req('GET', '/agent/boards/demo/inbox?wait=0', undefined, claude.token)).body
    expect(held).toMatchObject({ paused: { by: 'Maya' }, events: [] })
    expect((await req('GET', '/agent/session', undefined, claude.token)).body.paused).toEqual({ by: 'Maya' })

    // Resume while a long-poll is waiting → it returns the queued mention.
    const waiting = req('GET', '/agent/boards/demo/inbox?wait=5', undefined, claude.token)
    await new Promise((r) => setTimeout(r, 300))
    await req('POST', `/boards/demo/invites/${claude.invite.id}/pause`, { sid: 'sid_guest_tab', paused: false }, null)
    const got = (await waiting).body
    expect(got.events.map((e: any) => e.thread.id)).toEqual(['cp'])
    expect((await req('POST', '/agent/boards/demo/notes', { text: 'back!' }, claude.token)).status).toBe(201)
  })

  it('lists live agents in changes and lets anyone on the board remove them', async () => {
    const a = await invite('demo', 'Synth')
    const b = await invite('demo', 'Critic')
    const changes = (await req('GET', '/boards/demo/changes?since=0&pid=host&sid=sid_host_tab_1', undefined, null)).body
    expect(changes.agents.map((x: any) => x.agentName)).toEqual(['Synth', 'Critic'])

    // Someone without a live tab on this board can't; anyone who has the board open can.
    expect((await req('DELETE', `/boards/demo/invites/${a.invite.id}?sid=not_connected`, undefined, null)).status).toBe(404)
    await req('PUT', '/participants/guest', { name: 'Maya', color: '#1FA59A', sketch: [] }, null)
    await req('GET', '/boards/demo/changes?since=0&pid=guest&sid=sid_guest_tab', undefined, null)
    expect((await req('DELETE', `/boards/demo/invites/${b.invite.id}?sid=sid_guest_tab`, undefined, null)).status).toBe(200)
    expect((await req('GET', '/agent/boards/demo/summary', undefined, b.token)).status).toBe(401)
    b.token = (await invite('demo', 'Critic2')).token
    expect((await req('DELETE', `/boards/demo/invites/${a.invite.id}?sid=sid_host_tab_1`, undefined, null)).status).toBe(200)
    expect((await req('GET', '/agent/boards/demo/summary', undefined, a.token)).status).toBe(401)
    expect((await req('GET', '/agent/boards/demo/summary', undefined, b.token)).status).toBe(200)
  })
})

describe('prompting agents', () => {
  const humanComment = (id: string, body: string, anchor: any = { type: 'point', x: 0, y: 0 }) => ({
    entity: 'comment', op: 'upsert', data: { id, anchor, body, authorId: 'host', authorName: 'Gidi', authorType: 'human' },
  })
  const humanReply = (id: string, commentId: string, body: string) => ({
    entity: 'reply', op: 'upsert', data: { id, commentId, body, authorId: 'host', authorName: 'Gidi', authorType: 'human' },
  })
  const inbox = async (t: string, wait = 0) => (await req('GET', `/agent/boards/demo/inbox?wait=${wait}`, undefined, t)).body

  beforeEach(async () => {
    await req('POST', '/boards', { id: 'demo' }, null)
  })

  it('queues @mentions, replies in agent threads, and comments on agent notes (only for the right agent)', async () => {
    const claude = await invite('demo', 'Claude')
    const critic = await invite('demo', 'Critic Bot')

    await req('PATCH', '/boards/demo/ops', { ops: [humanComment('c1', 'hey @claude what do you think?')] }, null)
    let events = (await inbox(claude.token)).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'mention', message: { body: 'hey @claude what do you think?' } })
    expect(events[0].thread.id).toBe('c1')
    expect((await inbox(critic.token)).events).toHaveLength(0)

    // "@Claude Reporter" only pings Claude Reporter, not Claude
    const reporter = await invite('demo', 'Claude Reporter')
    await req('PATCH', '/boards/demo/ops', { ops: [humanComment('c0', '@Claude Reporter please summarize')] }, null)
    expect((await inbox(reporter.token)).events.map((e: any) => e.thread.id)).toEqual(['c0'])
    expect((await inbox(claude.token)).events.map((e: any) => e.thread.id)).toEqual(['c1'])

    // Multi-word names and @agents
    await req('PATCH', '/boards/demo/ops', { ops: [humanComment('c2', '@Critic Bot and @agents, thoughts?')] }, null)
    expect((await inbox(critic.token)).events.map((e: any) => e.thread.id)).toEqual(['c2'])

    // Claude replies in c1 → its prompts for c1 are answered; a human follow-up prompts again.
    await req('POST', '/agent/boards/demo/comments/c1/replies', { body: 'Looks promising' }, claude.token)
    expect((await inbox(claude.token)).events.map((e: any) => e.thread.id)).toEqual(['c2'])
    await req('POST', '/agent/boards/demo/inbox/ack', { ids: (await inbox(claude.token)).events.map((e: any) => e.id) }, claude.token)
    await req('PATCH', '/boards/demo/ops', { ops: [humanReply('r1', 'c1', 'why?')] }, null)
    events = (await inbox(claude.token)).events
    expect(events).toMatchObject([{ kind: 'reply', message: { body: 'why?' } }])

    // Comment on the agent's note
    const note = (await req('POST', '/agent/boards/demo/notes', { text: 'idea' }, claude.token)).body
    await req('PATCH', '/boards/demo/ops', { ops: [humanComment('c3', 'nice', { type: 'element', elementId: note.id, dx: 0, dy: 0 })] }, null)
    expect((await inbox(claude.token)).events.map((e: any) => e.kind)).toContain('comment_on_yours')

    // The board sees prompt status for its UI
    const prompts = (await req('GET', '/boards/demo/changes?since=0', undefined, null)).body.prompts
    expect(prompts.find((p: any) => p.commentId === 'c1' && p.replyId === '')).toMatchObject({ agentName: 'Claude', status: 'answered' })
  })

  it('reports whether each agent is listening (inbox open or just polled)', async () => {
    const claude = await invite('demo', 'Claude')
    const agents = async () => (await req('GET', '/boards/demo/changes?since=0&pid=host&sid=sid_host_tab_1', undefined, null)).body.agents
    expect((await agents())[0]).toMatchObject({ agentName: 'Claude', listening: false })

    const waiting = inbox(claude.token, 3) // long-poll in flight
    await new Promise((r) => setTimeout(r, 200))
    expect((await agents())[0].listening).toBe(true)
    await waiting
    expect((await agents())[0].listening).toBe(true) // short grace between calls

    // Agent went away: the grace lapses and it shows as not listening; messages still queue.
    await getDb().execute({ sql: 'UPDATE agent_invites SET listening_until = ?', args: [Date.now() - 1] })
    expect((await agents())[0].listening).toBe(false)
    await req('PATCH', '/boards/demo/ops', { ops: [humanComment('c9', '@Claude still there?')] }, null)
    expect((await inbox(claude.token)).events.map((e: any) => e.thread.id)).toEqual(['c9'])
  })

  it('does not re-prompt on edits, and long-poll returns as soon as something arrives', async () => {
    const claude = await invite('demo', 'Claude')
    await req('PATCH', '/boards/demo/ops', { ops: [humanComment('c1', 'no mention')] }, null)
    await req('PATCH', '/boards/demo/ops', { ops: [humanComment('c1', 'edited to @Claude')] }, null)
    expect((await inbox(claude.token)).events).toHaveLength(0)

    const started = Date.now()
    const waiting = inbox(claude.token, 5)
    setTimeout(() => req('PATCH', '/boards/demo/ops', { ops: [humanComment('c2', '@Claude ping')] }, null), 300)
    const got = await waiting
    expect(got.events).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(4000)
  })
})

describe('agents reorganizing', () => {
  let t: string
  beforeEach(async () => {
    await req('POST', '/boards', { id: 'demo' }, null)
    await req('PATCH', '/boards/demo/ops', {
      ops: [
        { entity: 'element', op: 'upsert', data: note('a', 0, 0, 'A') },
        { entity: 'element', op: 'upsert', data: note('b', 400, 0, 'B') },
      ],
    }, null)
    t = (await invite('demo', 'Claude')).token
  })

  it('draws an attached arrow edge-to-edge', async () => {
    const res = await req('POST', '/agent/boards/demo/arrows', { from: { elementId: 'a' }, to: { elementId: 'b' }, label: 'leads to' }, t)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ shape: 'arrow', bindings: { start: 'a', end: 'b' }, authorType: 'agent', text: 'leads to' })
    // From A's right edge (180 + gap) to B's left edge (400 - gap), at mid-height.
    expect(res.body.x).toBeGreaterThan(180)
    expect(res.body.x + res.body.w).toBeLessThan(400)
    expect(res.body.y).toBeCloseTo(90)
    const s = (await req('GET', '/agent/boards/demo/summary', undefined, t)).body
    expect(s.shapes[0].connects).toEqual({ from: 'a', to: 'b' })
  })

  it('moves elements in a batch and re-routes attached arrows', async () => {
    const arrow = (await req('POST', '/agent/boards/demo/arrows', { from: { elementId: 'a' }, to: { elementId: 'b' } }, t)).body
    const res = await req('POST', '/agent/boards/demo/move', { moves: [{ id: 'b', x: 0, y: 400 }, { id: 'a', dx: 10, dy: 0 }] }, t)
    expect(res.status).toBe(200)
    expect(res.body.reroutedArrows).toEqual([arrow.id])
    const els = (await req('GET', '/boards/demo', undefined, null)).body.elements
    const b = els.find((e: any) => e.id === 'b')
    const moved = els.find((e: any) => e.id === arrow.id)
    expect([b.x, b.y]).toEqual([0, 400])
    expect(moved.y + moved.h).toBeLessThan(400) // now points down to B
    expect(moved.h).toBeGreaterThan(150)
  })

  it('keeps hand-drawn (pinned) arrow ends at the exact spot on the element when it moves', async () => {
    // A person drew from (100, 50) inside A to a free point (700, 300); the start is pinned 100,50 into A.
    const arrow = {
      id: 'hand', kind: 'shape', shape: 'arrow', x: 100, y: 50, w: 600, h: 250, points: [[0, 0], [600, 250]],
      bindings: { start: 'a', end: null, startAt: [100, 50], endAt: null },
    }
    await req('PATCH', '/boards/demo/ops', { ops: [{ entity: 'element', op: 'upsert', data: arrow }] }, null)
    await req('POST', '/agent/boards/demo/move', { moves: [{ id: 'a', dx: 0, dy: 400 }] }, t)
    const moved = (await req('GET', '/boards/demo', undefined, null)).body.elements.find((e: any) => e.id === 'hand')
    const start = [moved.x + moved.points[0][0], moved.y + moved.points[0][1]]
    const end = [moved.x + moved.points[1][0], moved.y + moved.points[1][1]]
    expect(start).toEqual([100, 450]) // same spot on A, not snapped to A's edge
    expect(end).toEqual([700, 300]) // free end stays put
  })

  it('rejects unknown ids and moving attached arrows directly; still cannot delete', async () => {
    expect((await req('POST', '/agent/boards/demo/move', { moves: [{ id: 'zzz', x: 0, y: 0 }] }, t)).status).toBe(404)
    const arrow = (await req('POST', '/agent/boards/demo/arrows', { from: { elementId: 'a' }, to: { x: 900, y: 900 } }, t)).body
    expect((await req('POST', '/agent/boards/demo/move', { moves: [{ id: arrow.id, dx: 5, dy: 5 }] }, t)).status).toBe(400)
    expect((await req('DELETE', '/agent/boards/demo/elements/a', undefined, t)).status).toBe(404)
  })
})

describe('agents structuring the board', () => {
  let t: string
  beforeEach(async () => {
    await req('POST', '/boards', { id: 'demo' }, null)
    await req('PATCH', '/boards/demo/ops', {
      ops: [
        { entity: 'element', op: 'upsert', data: note('a', 0, 0, 'A') },
        { entity: 'element', op: 'upsert', data: note('b', 220, 0, 'B') },
        { entity: 'element', op: 'upsert', data: note('far', 2000, 0, 'far away') },
      ],
    }, null)
    t = (await invite('demo', 'Claude')).token
  })

  it('frames elements in a titled section that sits beneath them', async () => {
    const res = await req('POST', '/agent/boards/demo/sections', { title: 'Pain points', elementIds: ['a', 'b'], color: 'pink' }, t)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ role: 'section', shape: 'rect', text: 'Pain points', authorType: 'agent' })
    expect(res.body.contains.sort()).toEqual(['a', 'b'])
    expect(res.body.x).toBeLessThan(0)
    expect(res.body.y).toBeLessThan(-60) // room for the title
    expect(res.body.x + res.body.w).toBeGreaterThan(400)
    expect(res.body.z).toBeLessThan(0)

    const s = (await req('GET', '/agent/boards/demo/summary', undefined, t)).body
    expect(s.topics).toMatchObject([{ title: 'Pain points', color: 'pink' }])
    expect(s.topics[0].contains.sort()).toEqual(['a', 'b'])
    expect(s.notes.find((n: any) => n.id === 'a').topic).toBe(res.body.id)
    expect(s.counts.topics).toBe(1)

    // /topics is the primary name for the same thing
    const t2 = await req('POST', '/agent/boards/demo/topics', { title: 'Far', elementIds: ['far'] }, t)
    expect(t2.body).toMatchObject({ role: 'section', text: 'Far', contains: ['far'] })
    expect(s.shapes).toHaveLength(0) // sections aren't listed as plain shapes
  })

  it('moving a section carries its contents (and nothing else)', async () => {
    const sec = (await req('POST', '/agent/boards/demo/sections', { title: 'Group', elementIds: ['a', 'b'] }, t)).body
    await req('POST', '/agent/boards/demo/move', { moves: [{ id: sec.id, dx: 0, dy: 500 }] }, t)
    const els = (await req('GET', '/boards/demo', undefined, null)).body.elements
    const y = (id: string) => els.find((e: any) => e.id === id).y
    expect([y('a'), y('b'), y('far')]).toEqual([500, 500, 0])
  })

  it('adds text headings, including above a given element', async () => {
    const res = await req('POST', '/agent/boards/demo/text', { text: 'Insights', size: 'title', aboveElementId: 'a' }, t)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ kind: 'text', text: 'Insights', style: { fontSize: 48 }, authorType: 'agent' })
    expect(res.body.y + res.body.h).toBeLessThanOrEqual(0)
    const s = (await req('GET', '/agent/boards/demo/summary', undefined, t)).body
    expect(s.text.map((x: any) => x.text)).toEqual(['Insights'])
  })

  it('validates sections', async () => {
    expect((await req('POST', '/agent/boards/demo/sections', { title: 'x' }, t)).status).toBe(400)
    expect((await req('POST', '/agent/boards/demo/sections', { elementIds: ['nope'] }, t)).status).toBe(404)
  })
})

describe('reports', () => {
  it('asks a connected agent for a report, delivers topics + instructions, and stores the result', async () => {
    await req('POST', '/boards', { id: 'demo' }, null)
    await req('PATCH', '/boards/demo/ops', { ops: [{ entity: 'element', op: 'upsert', data: note('a', 0, 0, 'Queues are stressful') }] }, null)
    const claude = await invite('demo', 'Claude')
    await req('POST', '/agent/boards/demo/topics', { title: 'Pain points', elementIds: ['a'] }, claude.token)

    // Not connected → refused; connected host tab → queued for that agent.
    expect((await req('POST', '/boards/demo/reports', { sid: 'nobody_here', inviteId: claude.invite.id }, null)).status).toBe(409)
    const r = await req('POST', '/boards/demo/reports', { sid: 'sid_host_tab_1', inviteId: claude.invite.id }, null)
    expect(r.status).toBe(201)
    let list = (await req('GET', '/boards/demo/changes?since=0', undefined, null)).body.reports
    expect(list[0]).toMatchObject({ id: r.body.id, agentName: 'Claude', status: 'requested', requestedBy: 'Gidi' })

    const ev = (await req('GET', '/agent/boards/demo/inbox', undefined, claude.token)).body.events
    expect(ev).toHaveLength(1)
    expect(ev[0].kind).toBe('report_request')
    expect(ev[0].instructions).toContain('## <one section per topic')
    expect(ev[0].board.topics[0].title).toBe('Pain points')
    expect(ev[0].respond.submit.path).toBe(`/api/agent/boards/demo/reports/${r.body.id}`)
    expect((await req('GET', `/boards/demo/reports`, undefined, null)).body.reports[0].status).toBe('writing')

    // Someone else's token can't submit it; the asked agent can.
    const other = await invite('demo', 'Other')
    expect((await req('POST', `/agent/boards/demo/reports/${r.body.id}`, { markdown: '# nope nope nope nope nope' }, other.token)).status).toBe(404)
    const md = '# Board: synthesis\n\n## Pain points\n- "Queues are stressful"'
    expect((await req('POST', `/agent/boards/demo/reports/${r.body.id}`, { markdown: md }, claude.token)).status).toBe(200)
    const full = (await req('GET', `/boards/demo/reports/${r.body.id}`, undefined, null)).body
    expect(full).toMatchObject({ status: 'ready', markdown: md })
    expect((await req('GET', '/agent/boards/demo/inbox', undefined, claude.token)).body.events).toHaveLength(0)
  })
})

describe('participants + presence', () => {
  it('saves a profile and reports presence on the board', async () => {
    await req('POST', '/boards', { id: 'demo' })
    const p = { name: 'Gidi', color: '#FF5A47', sketch: [[[0.1, 0.1, 0.5], [0.5, 0.5, 0.5]]] }
    expect((await req('PUT', '/participants/p1', p)).status).toBe(200)
    expect((await req('GET', '/participants/p1')).body.name).toBe('Gidi')

    const changes = (await req('GET', '/boards/demo/changes?since=0&pid=p1&sid=sid_tab_p1')).body
    expect(changes.presence).toHaveLength(1)
    expect(changes.presence[0]).toMatchObject({ id: 'p1', name: 'Gidi', color: '#FF5A47' })

    expect(changes.presence[0].away).toBe(false)

    // Closing the tab drops them from the corner right away…
    await req('POST', '/sessions/sid_tab_p1/leave?run=run_a')
    expect((await req('GET', '/boards/demo/changes?since=0')).body.presence).toHaveLength(0)
  })

  it('ignores a late heartbeat from a run that already left, but a new visit revives', async () => {
    await req('POST', '/boards', { id: 'demo' })
    await req('PUT', '/participants/p1', { name: 'Gidi', color: '#FF5A47', sketch: [] })
    const beat = (run: string, vis = 1) => req('GET', `/boards/demo/changes?since=0&pid=p1&sid=sid_tab&run=${run}&vis=${vis}`)
    await beat('run_a')
    await req('POST', '/sessions/sid_tab/leave?run=run_a')
    // A poll that was still in flight when the page closed:
    await beat('run_a')
    expect((await req('GET', '/boards/demo/changes?since=0')).body.presence).toHaveLength(0)
    // Reload = new run:
    await beat('run_b')
    expect((await req('GET', '/boards/demo/changes?since=0')).body.presence).toHaveLength(1)
  })

  it('shows backgrounded tabs as away, and drops silent tabs', async () => {
    await req('POST', '/boards', { id: 'demo' })
    await req('PUT', '/participants/p1', { name: 'Gidi', color: '#FF5A47', sketch: [] })
    await req('GET', '/boards/demo/changes?since=0&pid=p1&sid=sid_tab&run=r1&vis=1')
    await getDb().execute({ sql: 'UPDATE host_sessions SET last_visible_at = ?', args: [Date.now() - 30_000] })
    await req('GET', '/boards/demo/changes?since=0&pid=p1&sid=sid_tab&run=r1&vis=0')
    let presence = (await req('GET', '/boards/demo/changes?since=0')).body.presence
    expect(presence[0]).toMatchObject({ id: 'p1', away: true })

    // Tab closed without a goodbye (crash, lost beacon): gone ~25s after heartbeats stop…
    await getDb().execute({ sql: 'UPDATE host_sessions SET last_seen_at = ?, last_visible_at = ?', args: [Date.now() - 30_000, Date.now() - 30_000] })
    expect((await req('GET', '/boards/demo/changes?since=0')).body.presence).toHaveLength(0)

    // …but a tab hidden for many minutes (throttled to ~1 beat/min) isn't dropped between beats.
    await getDb().execute({ sql: 'UPDATE host_sessions SET last_seen_at = ?, last_visible_at = ?', args: [Date.now() - 50_000, Date.now() - 600_000] })
    presence = (await req('GET', '/boards/demo/changes?since=0')).body.presence
    expect(presence[0]).toMatchObject({ id: 'p1', away: true })
  })
})
