import type { InStatement } from '@libsql/client'
import { uid } from '../../shared/ids.js'
import type { AgentDeletion, BoardSnapshot, Comment, Element, Reply } from '../../shared/schema.js'
import { getDb, stmt, writeBoard } from './db.js'

/**
 * Agent deletions. Every deletion stores the rows as they were, so anyone on the
 * board can restore them in one click.
 *
 * Who may delete: Orchestrators always (it's part of reorganizing); other agents only
 * while a person has asked them to delete / clean up (a grant set in events.ts).
 */
export async function canDelete(inviteId: string): Promise<boolean> {
  const r = await getDb().execute({ sql: 'SELECT cleanup_until, persona, agent_name FROM agent_invites WHERE id = ?', args: [inviteId] })
  const row = r.rows[0]
  if (!row) return false
  const name = String(row.agent_name ?? '')
  const orchestrator = row.persona === 'Orchestrator' || name === 'Orchestrator' || name.startsWith('Orchestrator ')
  return orchestrator || Number(row.cleanup_until ?? 0) > Date.now()
}

interface Before {
  elements: Element[]
  comments: Comment[]
  replies: Reply[]
}

export async function agentDelete(
  boardId: string,
  snap: BoardSnapshot,
  agent: { inviteId: string; agentName: string },
  ids: string[],
  reason: string | null,
): Promise<{ deleted: string[]; unknown: string[]; deletionId: string | null }> {
  const els = new Map(snap.elements.filter((e) => !e.deleted).map((e) => [e.id, e]))
  const cms = new Map(snap.comments.filter((c) => !c.deleted && !c.dmInviteId).map((c) => [c.id, c]))
  const elementIds = ids.filter((id) => els.has(id))
  const commentIds = ids.filter((id) => cms.has(id))
  const unknown = ids.filter((id) => !els.has(id) && !cms.has(id))
  if (!elementIds.length && !commentIds.length) return { deleted: [], unknown, deletionId: null }

  const gone = new Set(elementIds)
  const goneThreads = new Set(commentIds)
  const before: Before = { elements: [], comments: [], replies: [] }
  const now = Date.now()

  const deletionId = uid('del_')
  await writeBoard(boardId, (v) => {
    const out: InStatement[] = []
    for (const id of elementIds) {
      before.elements.push(els.get(id)!)
      out.push(stmt.tombstone('elements', boardId, id, v))
    }
    // Arrows attached to deleted elements stay, just detached at that end (like a person deleting).
    for (const e of els.values()) {
      if (gone.has(e.id) || !(e.bindings?.start && gone.has(e.bindings.start)) && !(e.bindings?.end && gone.has(e.bindings.end))) continue
      before.elements.push(e)
      const b = e.bindings
      out.push(
        stmt.upsertElement(
          boardId,
          {
            ...e,
            bindings: {
              start: b.start && gone.has(b.start) ? null : b.start,
              end: b.end && gone.has(b.end) ? null : b.end,
              startAt: b.start && gone.has(b.start) ? null : b.startAt,
              endAt: b.end && gone.has(b.end) ? null : b.endAt,
            },
            updatedAt: now,
          },
          v,
        ),
      )
    }
    // Comments pinned to deleted elements stay where they were, as point comments.
    for (const c of snap.comments) {
      if (c.deleted || goneThreads.has(c.id) || c.anchor.type !== 'element' || !gone.has(c.anchor.elementId)) continue
      const el = els.get(c.anchor.elementId)!
      before.comments.push(c)
      out.push(stmt.upsertComment(boardId, { ...c, anchor: { type: 'point', x: el.x + c.anchor.dx, y: el.y + c.anchor.dy }, updatedAt: now }, v))
    }
    for (const id of commentIds) {
      before.comments.push(cms.get(id)!)
      out.push(stmt.tombstone('comments', boardId, id, v))
      for (const r of snap.replies) {
        if (r.commentId !== id || r.deleted) continue
        before.replies.push(r)
        out.push(stmt.tombstone('replies', boardId, r.id, v))
      }
    }
    out.push({
      sql: `INSERT INTO agent_deletions (id, board_id, invite_id, agent_name, reason, count, before, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [deletionId, boardId, agent.inviteId, agent.agentName, reason, elementIds.length + commentIds.length, JSON.stringify(before), now],
    })
    return out
  })
  return { deleted: [...elementIds, ...commentIds], unknown, deletionId }
}

/** Put a deletion back exactly as it was. */
export async function restoreDeletion(boardId: string, deletionId: string): Promise<boolean> {
  const r = await getDb().execute({
    sql: 'SELECT before FROM agent_deletions WHERE id = ? AND board_id = ? AND restored_at IS NULL',
    args: [deletionId, boardId],
  })
  const row = r.rows[0]
  if (!row) return false
  const before = JSON.parse(String(row.before)) as Before
  const now = Date.now()
  await writeBoard(boardId, (v) => [
    ...before.elements.map((e) => stmt.upsertElement(boardId, { ...e, deleted: false, updatedAt: now }, v)),
    ...before.comments.map((c) => stmt.upsertComment(boardId, { ...c, deleted: false, updatedAt: now }, v)),
    ...before.replies.map((x) => stmt.upsertReply(boardId, { ...x, deleted: false }, v)),
    { sql: 'UPDATE agent_deletions SET restored_at = ? WHERE id = ?', args: [now, deletionId] },
  ])
  return true
}

export async function recentDeletions(boardId: string): Promise<AgentDeletion[]> {
  const r = await getDb().execute({
    sql: `SELECT id, invite_id, agent_name, count, reason, created_at, restored_at FROM agent_deletions
          WHERE board_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 10`,
    args: [boardId, Date.now() - 60 * 60_000],
  })
  return r.rows.map((row) => ({
    id: String(row.id),
    inviteId: String(row.invite_id),
    agentName: String(row.agent_name),
    count: Number(row.count),
    reason: row.reason == null ? null : String(row.reason),
    at: Number(row.created_at),
    restoredAt: row.restored_at == null ? null : Number(row.restored_at),
  }))
}
