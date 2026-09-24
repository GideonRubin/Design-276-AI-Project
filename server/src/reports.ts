import { uid } from '../../shared/ids.js'
import type { ReportInfo } from '../../shared/schema.js'
import { getDb } from './db.js'
import { HOST_ACTIVE_MS } from './invites.js'

/**
 * Reports: a person asks a connected agent to write a synthesis of the board.
 * The request lands in the agent's inbox as a `report_request` event (comment_id
 * = "report:<id>"); the agent answers with POST /agent/boards/:id/reports/:rid.
 */

export const REPORT_PREFIX = 'report:'

export async function requestReport(boardId: string, sid: string, inviteId: string): Promise<{ id: string } | { error: string; status: 404 | 409 }> {
  const db = getDb()
  const s = await db.execute({
    sql: `SELECT p.data FROM host_sessions s LEFT JOIN participants p ON p.id = s.pid
          WHERE s.id = ? AND s.board_id = ? AND s.last_seen_at > ?`,
    args: [sid, boardId, Date.now() - HOST_ACTIVE_MS],
  })
  if (!s.rows.length) return { error: 'Your board tab is not connected.', status: 409 }
  const requester = s.rows[0].data ? JSON.parse(String(s.rows[0].data)).name : 'Someone'
  const inv = await db.execute({
    sql: 'SELECT agent_name FROM agent_invites WHERE id = ? AND board_id = ? AND revoked_at IS NULL',
    args: [inviteId, boardId],
  })
  if (!inv.rows.length) return { error: 'That agent is no longer on this board.', status: 404 }
  const id = uid('rep_')
  const now = Date.now()
  await db.batch(
    [
      {
        sql: `INSERT INTO reports (id, board_id, invite_id, agent_name, requested_by, status, created_at)
              VALUES (?, ?, ?, ?, ?, 'requested', ?)`,
        args: [id, boardId, inviteId, String(inv.rows[0].agent_name), requester, now],
      },
      {
        sql: `INSERT INTO agent_events (invite_id, board_id, kind, comment_id, reply_id, created_at)
              VALUES (?, ?, 'report_request', ?, '', ?)`,
        args: [inviteId, boardId, REPORT_PREFIX + id, now],
      },
    ],
    'write',
  )
  return { id }
}

const toInfo = (row: Record<string, unknown>, delivered: boolean): ReportInfo => ({
  id: String(row.id),
  agentName: String(row.agent_name),
  inviteId: String(row.invite_id),
  requestedBy: String(row.requested_by),
  status: row.status === 'ready' ? 'ready' : delivered ? 'writing' : 'requested',
  createdAt: Number(row.created_at),
  completedAt: row.completed_at == null ? null : Number(row.completed_at),
})

export async function listReports(boardId: string): Promise<ReportInfo[]> {
  const r = await getDb().execute({
    sql: `SELECT r.*, e.delivered_at FROM reports r
          LEFT JOIN agent_events e ON e.comment_id = 'report:' || r.id
          WHERE r.board_id = ? ORDER BY r.created_at DESC LIMIT 10`,
    args: [boardId],
  })
  return r.rows.map((row) => toInfo(row as Record<string, unknown>, row.delivered_at != null))
}

export async function getReport(boardId: string, id: string) {
  const r = await getDb().execute({ sql: 'SELECT * FROM reports WHERE id = ? AND board_id = ?', args: [id, boardId] })
  const row = r.rows[0]
  if (!row) return null
  return { ...toInfo(row as Record<string, unknown>, true), markdown: row.markdown == null ? null : String(row.markdown) }
}

/** The agent hands in its report. Only the agent that was asked can submit it. */
export async function submitReport(boardId: string, id: string, inviteId: string, markdown: string): Promise<boolean> {
  const db = getDb()
  const r = await db.execute({
    sql: `UPDATE reports SET status = 'ready', markdown = ?, completed_at = ? WHERE id = ? AND board_id = ? AND invite_id = ?`,
    args: [markdown, Date.now(), id, boardId, inviteId],
  })
  if (!r.rowsAffected) return false
  await db.execute({
    sql: 'UPDATE agent_events SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE invite_id = ? AND comment_id = ? AND acked_at IS NULL',
    args: [Date.now(), Date.now(), inviteId, REPORT_PREFIX + id],
  })
  return true
}
