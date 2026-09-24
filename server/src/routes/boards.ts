import { Hono } from 'hono'
import { z } from 'zod'
import { Comment, Element, OpsBody, Reply, type BoardSnapshot, type ChangesResponse } from '../../../shared/schema.js'
import { parseDatafile, toDatafile } from '../../../shared/datafile.js'
import { BOARD_ID_RE, friendlyBoardId, normalizeBoardId } from '../../../shared/ids.js'
import { createBoard, getBoard, loadSince, NotFound, stmt, touchAndListPresence, writeBoard } from '../db.js'
import type { InStatement } from '@libsql/client'
import { createInvite, heartbeat, leaveSession, listAgents, revokeInvite, setPaused } from '../invites.js'
import { queueForHumanActivity, recentEventStatus } from '../events.js'
import { getReport, listReports, requestReport } from '../reports.js'
import { getDb } from '../db.js'

export const boards = new Hono()

export async function snapshot(id: string, since = 0): Promise<BoardSnapshot> {
  const board = await getBoard(id)
  if (!board) throw new NotFound('board')
  const rows = await loadSince(id, since)
  return { board, ...rows }
}

const CreateBody = z.object({ id: z.string().optional(), title: z.string().max(120).optional() })

boards.post('/', async (c) => {
  const body = CreateBody.parse(await c.req.json().catch(() => ({})))
  const id = body.id ? normalizeBoardId(body.id) : friendlyBoardId()
  if (!BOARD_ID_RE.test(id)) return c.json({ error: 'Board IDs use 2–48 lowercase letters, numbers and dashes.' }, 400)
  const board = await createBoard(id, body.title?.trim() || 'Untitled wall')
  if (!board) return c.json({ error: `A board called "${id}" already exists.` }, 409)
  return c.json(board, 201)
})

boards.get('/:id', async (c) => {
  const snap = await snapshot(c.req.param('id'))
  return c.json({
    ...snap,
    elements: snap.elements.filter((e) => !e.deleted),
    comments: snap.comments.filter((x) => !x.deleted),
    replies: snap.replies.filter((x) => !x.deleted),
  })
})

boards.get('/:id/changes', async (c) => {
  const id = c.req.param('id')
  const since = Number(c.req.query('since') ?? 0) || 0
  const pid = c.req.query('pid') ?? null
  const sid = c.req.query('sid') ?? null
  const run = c.req.query('run') ?? sid ?? ''
  const visible = c.req.query('vis') !== '0'
  if (sid && pid) await heartbeat(sid, pid, id, run, visible)
  const [snap, presence, agents, prompts, reports] = await Promise.all([
    snapshot(id, since),
    touchAndListPresence(id, pid),
    listAgents(id),
    recentEventStatus(id),
    listReports(id),
  ])
  const res: ChangesResponse = { ...snap, presence, agents, prompts, reports }
  return c.json(res)
})

// ---------- agent invites (created from a live board tab) ----------

const InviteBody = z.object({
  pid: z.string().min(1),
  sid: z.string().min(8),
  agentName: z.string().trim().min(1).max(40),
  persona: z.string().trim().max(80).optional(),
  context: z.string().trim().max(2000).optional(),
})

boards.post('/:id/invites', async (c) => {
  const id = c.req.param('id')
  await snapshot(id) // 404 if the board doesn't exist
  const body = InviteBody.parse(await c.req.json())
  const created = await createInvite(id, body.sid, body.pid, body.agentName, { persona: body.persona, context: body.context })
  if (!created) return c.json({ error: 'Invites can only be created from an open board tab.' }, 409)
  return c.json(created, 201)
})

// ---------- reports (written by a connected agent) ----------

boards.post('/:id/reports', async (c) => {
  const id = c.req.param('id')
  await snapshot(id)
  const body = z.object({ sid: z.string().min(8), inviteId: z.string().min(1) }).parse(await c.req.json())
  const res = await requestReport(id, body.sid, body.inviteId)
  if ('error' in res) return c.json({ error: res.error }, res.status)
  return c.json(res, 201)
})

boards.get('/:id/reports', async (c) => c.json({ reports: await listReports(c.req.param('id')) }))

boards.get('/:id/reports/:rid', async (c) => {
  const r = await getReport(c.req.param('id'), c.req.param('rid'))
  if (!r) return c.json({ error: 'report not found' }, 404)
  return c.json(r)
})

boards.post('/:id/invites/:inviteId/pause', async (c) => {
  const body = z.object({ sid: z.string().min(8), paused: z.boolean() }).parse(await c.req.json())
  const ok = await setPaused(c.req.param('id'), c.req.param('inviteId'), body.sid, body.paused)
  if (!ok) return c.json({ error: 'No such active agent, or your board tab is not connected.' }, 404)
  return c.json({ ok: true, paused: body.paused })
})

boards.delete('/:id/invites/:inviteId', async (c) => {
  const ok = await revokeInvite(c.req.param('id'), c.req.param('inviteId'), c.req.query('sid') ?? '')
  if (!ok) return c.json({ error: 'No such active agent, or your board tab is not connected.' }, 404)
  return c.json({ ok: true })
})

async function applyOps(c: any) {
  const id = c.req.param('id')
  // sendBeacon posts text/plain, so parse the raw body ourselves.
  const raw = await c.req.text()
  const { ops } = OpsBody.parse(JSON.parse(raw || '{"ops":[]}'))
  if (!ops.length) {
    const board = await getBoard(id)
    if (!board) throw new NotFound('board')
    return c.json({ version: board.version })
  }
  const now = Date.now()

  // Which comments/replies are brand new? Only those can prompt agents (edits/resolves don't).
  const existing = async (table: 'comments' | 'replies', ids: string[]) => {
    if (!ids.length) return new Set<string>()
    const r = await getDb().execute({
      sql: `SELECT id FROM ${table} WHERE board_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      args: [id, ...ids],
    })
    return new Set(r.rows.map((row) => String(row.id)))
  }
  const upsertedComments = ops.flatMap((o) => (o.op === 'upsert' && o.entity === 'comment' ? [o.data] : []))
  const upsertedReplies = ops.flatMap((o) => (o.op === 'upsert' && o.entity === 'reply' ? [o.data] : []))
  const [oldComments, oldReplies] = await Promise.all([
    existing('comments', upsertedComments.map((c) => c.id)),
    existing('replies', upsertedReplies.map((r) => r.id)),
  ])

  const version = await writeBoard(id, (v) =>
    ops.map((op): InStatement => {
      if (op.op === 'delete') {
        const table = op.entity === 'element' ? 'elements' : op.entity === 'comment' ? 'comments' : 'replies'
        return stmt.tombstone(table, id, op.id, v)
      }
      switch (op.entity) {
        case 'element':
          return stmt.upsertElement(id, { ...op.data, updatedAt: now }, v)
        case 'comment':
          return stmt.upsertComment(id, { ...op.data, updatedAt: now }, v)
        case 'reply':
          return stmt.upsertReply(id, op.data, v)
        case 'board':
          return stmt.setTitle(id, op.data.title.slice(0, 120) || 'Untitled wall')
      }
    }),
  )

  const created = {
    comments: upsertedComments.filter((c) => !oldComments.has(c.id)),
    replies: upsertedReplies.filter((r) => !oldReplies.has(r.id)),
  }
  if (created.comments.length || created.replies.length) {
    await queueForHumanActivity(id, created, await snapshot(id))
  }
  return c.json({ version })
}
boards.patch('/:id/ops', applyOps)
boards.post('/:id/ops', applyOps)

boards.get('/:id/export', async (c) => {
  const snap = await snapshot(c.req.param('id'))
  const file = toDatafile(snap)
  c.header('Content-Disposition', `attachment; filename="${snap.board.id}.board.json"`)
  return c.json(file)
})

boards.post('/:id/import', async (c) => {
  const id = normalizeBoardId(c.req.param('id'))
  if (!BOARD_ID_RE.test(id)) return c.json({ error: 'Invalid board ID.' }, 400)
  const parsed = parseDatafile(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: 'That file does not look like a whiteboard file.', details: parsed.error }, 400)
  const { file } = parsed
  await createBoard(id, file.board.title) // no-op if it already exists

  const version = await writeBoard(id, (v) => {
    const out: InStatement[] = [
      // Tombstone everything first so clients drop it, then write the file's contents.
      { sql: 'UPDATE elements SET deleted = 1, version = ?, data = json_set(data, \'$.deleted\', json(\'true\')) WHERE board_id = ?', args: [v, id] },
      { sql: 'UPDATE comments SET deleted = 1, version = ?, data = json_set(data, \'$.deleted\', json(\'true\')) WHERE board_id = ?', args: [v, id] },
      { sql: 'UPDATE replies SET deleted = 1, version = ?, data = json_set(data, \'$.deleted\', json(\'true\')) WHERE board_id = ?', args: [v, id] },
      stmt.setTitle(id, file.board.title),
    ]
    for (const e of file.elements) out.push(stmt.upsertElement(id, Element.parse({ ...e, deleted: false }), v))
    for (const { replies, ...cm } of file.comments) {
      out.push(stmt.upsertComment(id, Comment.parse({ ...cm, deleted: false }), v))
      for (const r of replies) out.push(stmt.upsertReply(id, Reply.parse({ ...r, commentId: cm.id, deleted: false }), v))
    }
    return out
  })
  return c.json({ ok: true, version, elements: file.elements.length, comments: file.comments.length })
})
