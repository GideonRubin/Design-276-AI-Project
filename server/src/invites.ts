import type { MiddlewareHandler } from 'hono'
import { uid } from '../../shared/ids.js'
import type { AgentPresence } from '../../shared/schema.js'
import { getDb } from './db.js'

/**
 * Agent invites are bound to one host *tab session* (a random id kept in the
 * tab's sessionStorage). A token only works while that tab keeps sending
 * heartbeats (the board's change polling).
 */

/** How long after the last heartbeat a host still counts as present. Background tabs can be throttled to ~1 call/min. */
export const HOST_ACTIVE_MS = 90_000
/** After this long without a heartbeat, the invite is dead for good. */
export const HOST_EXPIRE_MS = 30 * 60_000

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return 'wb_' + Buffer.from(bytes).toString('base64url')
}

/**
 * Record that a tab is open on a board. `run` identifies one visit (one sync loop);
 * once a run has left, late requests from it (e.g. a poll still in flight while the
 * page closed) are ignored so they can't resurrect the session.
 */
export async function heartbeat(sid: string, pid: string, boardId: string, run: string, visible: boolean) {
  const now = Date.now()
  await getDb().execute({
    sql: `INSERT INTO host_sessions (id, pid, board_id, last_seen_at, last_visible_at, run) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            pid = excluded.pid, board_id = excluded.board_id, last_seen_at = excluded.last_seen_at, run = excluded.run,
            last_visible_at = CASE WHEN ? THEN excluded.last_seen_at ELSE host_sessions.last_visible_at END
          WHERE host_sessions.left_run IS NULL OR host_sessions.left_run != excluded.run`,
    // A brand-new session starts its "hidden since" clock now, even if it opened in the background.
    args: [sid, pid, boardId, now, now, run, visible ? 1 : 0],
  })
}

/** Tab closed / navigated away: mark this run gone right now. A reload starts a new run, which revives the session. */
export async function leaveSession(sid: string, run: string | null) {
  await getDb().execute({
    sql: 'UPDATE host_sessions SET last_seen_at = 0, last_visible_at = 0, left_run = COALESCE(?, run) WHERE id = ?',
    args: [run, sid],
  })
}

export async function createInvite(
  boardId: string,
  sid: string,
  pid: string,
  agentName: string,
  role: { persona?: string | null; context?: string | null } = {},
) {
  const s = await getDb().execute({ sql: 'SELECT * FROM host_sessions WHERE id = ?', args: [sid] })
  const row = s.rows[0]
  if (!row || row.pid !== pid || row.board_id !== boardId || Number(row.last_seen_at) < Date.now() - HOST_ACTIVE_MS) {
    return null
  }
  const token = newToken()
  const persona = role.persona?.trim() || null
  const context = role.context?.trim() || null
  const invite = { id: uid('ai_'), agentName, persona, context, createdAt: Date.now() }
  await getDb().execute({
    sql: `INSERT INTO agent_invites (id, token_hash, board_id, host_session, host_pid, agent_name, created_at, persona, context)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [invite.id, await sha256(token), boardId, sid, pid, agentName, invite.createdAt, persona, context],
  })
  return { invite, token }
}

/** The person behind a tab that's live on this board, or null if it isn't connected. */
async function liveTabPerson(boardId: string, sid: string): Promise<{ name: string } | null> {
  const s = await getDb().execute({
    sql: `SELECT p.data FROM host_sessions s LEFT JOIN participants p ON p.id = s.pid
          WHERE s.id = ? AND s.board_id = ? AND s.last_seen_at > ?`,
    args: [sid, boardId, Date.now() - HOST_ACTIVE_MS],
  })
  if (!s.rows.length) return null
  return { name: s.rows[0].data ? String(JSON.parse(String(s.rows[0].data)).name) : 'Someone' }
}

/** Anyone with the board open can pause or resume any agent on it. */
export async function setPaused(boardId: string, inviteId: string, sid: string, paused: boolean): Promise<boolean> {
  const who = await liveTabPerson(boardId, sid)
  if (!who) return false
  const r = await getDb().execute({
    sql: `UPDATE agent_invites SET paused_at = ?, paused_by = ? WHERE id = ? AND board_id = ? AND revoked_at IS NULL`,
    args: [paused ? Date.now() : null, paused ? who.name : null, inviteId, boardId],
  })
  return r.rowsAffected > 0
}

/** Is this invite paused right now? (Used while an inbox long-poll waits.) */
export async function isPaused(inviteId: string): Promise<boolean> {
  const r = await getDb().execute({ sql: 'SELECT paused_at FROM agent_invites WHERE id = ?', args: [inviteId] })
  return r.rows[0]?.paused_at != null
}

/** Anyone with the board open (a live tab session on this board) can remove any agent from it. */
export async function revokeInvite(boardId: string, inviteId: string, sid: string): Promise<boolean> {
  if (!(await liveTabPerson(boardId, sid))) return false
  const r = await getDb().execute({
    sql: 'UPDATE agent_invites SET revoked_at = ? WHERE id = ? AND board_id = ? AND revoked_at IS NULL',
    args: [Date.now(), inviteId, boardId],
  })
  return r.rowsAffected > 0
}

/** Live invites on a board whose host tab is currently present. */
export async function listAgents(boardId: string): Promise<AgentPresence[]> {
  const r = await getDb().execute({
    sql: `SELECT i.id, i.agent_name, i.host_pid, i.created_at, i.last_used_at, i.listening_until, i.persona, i.paused_at, i.paused_by
          FROM agent_invites i JOIN host_sessions s ON s.id = i.host_session
          WHERE i.board_id = ? AND s.board_id = i.board_id AND i.revoked_at IS NULL AND s.last_seen_at > ?
          ORDER BY i.created_at`,
    args: [boardId, Date.now() - HOST_ACTIVE_MS],
  })
  return r.rows.map((row) => ({
    id: String(row.id),
    agentName: String(row.agent_name),
    hostPid: String(row.host_pid),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    listening: Number(row.listening_until ?? 0) > Date.now(),
    persona: row.persona == null ? null : String(row.persona),
    paused: row.paused_at != null,
    pausedBy: row.paused_by == null ? null : String(row.paused_by),
  }))
}

export interface AgentAuth {
  inviteId: string
  agentName: string
  persona: string | null
  context: string | null
  paused: boolean
  pausedBy: string | null
  boardId: string
  hostPid: string
  hostActive: boolean
}

export type AgentEnv = { Variables: { agent: AgentAuth } }

class AuthError extends Error {
  constructor(
    public status: 401 | 403 | 423,
    message: string,
    public hint?: string,
  ) {
    super(message)
  }
}

async function authenticate(header: string | undefined, boardParam: string | undefined): Promise<AgentAuth> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) throw new AuthError(401, 'Missing invite token.', 'Send "Authorization: Bearer <token>" from your invite.')
  const r = await getDb().execute({
    sql: `SELECT i.*, s.last_seen_at AS host_seen, s.board_id AS host_board FROM agent_invites i
          LEFT JOIN host_sessions s ON s.id = i.host_session
          WHERE i.token_hash = ?`,
    args: [await sha256(token)],
  })
  const row = r.rows[0]
  if (!row || row.revoked_at != null) throw new AuthError(401, 'This invite is not valid (revoked or unknown).', 'Ask the host for a new invite.')
  const seen = Number(row.host_seen ?? 0)
  const now = Date.now()
  if (seen && seen < now - HOST_EXPIRE_MS) {
    await getDb().execute({ sql: 'UPDATE agent_invites SET revoked_at = ? WHERE id = ?', args: [now, row.id] })
    throw new AuthError(401, 'This invite expired because the host session ended.', 'Ask the host for a new invite.')
  }
  const auth: AgentAuth = {
    inviteId: String(row.id),
    agentName: String(row.agent_name),
    persona: row.persona == null ? null : String(row.persona),
    context: row.context == null ? null : String(row.context),
    paused: row.paused_at != null,
    pausedBy: row.paused_by == null ? null : String(row.paused_by),
    boardId: String(row.board_id),
    hostPid: String(row.host_pid),
    // Present = the inviting tab is open *and still on this board*.
    hostActive: seen > now - HOST_ACTIVE_MS && row.host_board === row.board_id,
  }
  if (boardParam && boardParam !== auth.boardId) throw new AuthError(403, `This invite is for board "${auth.boardId}", not "${boardParam}".`)
  return auth
}

/** Guards /api/agent/*: valid token, right board, and the host's tab must be open. */
export const requireAgent =
  (opts: { allowAway?: boolean; allowPaused?: boolean } = {}): MiddlewareHandler<AgentEnv> =>
  async (c, next) => {
    try {
      const auth = await authenticate(c.req.header('authorization'), c.req.param('id'))
      if (!auth.hostActive && !opts.allowAway) {
        throw new AuthError(423, 'The host has stepped away from the board, so this session is paused.', 'Retry in a minute; access resumes when their tab is open again.')
      }
      if (auth.paused && !opts.allowPaused) {
        throw new AuthError(
          423,
          `You've been paused by ${auth.pausedBy ?? 'someone on the board'}. Don't change the board until you're resumed.`,
          'Keep calling /inbox?wait=25: it tells you when you are resumed and delivers anything that queued up meanwhile.',
        )
      }
      c.set('agent', auth)
      await getDb().execute({ sql: 'UPDATE agent_invites SET last_used_at = ? WHERE id = ?', args: [Date.now(), auth.inviteId] })
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message, hint: err.hint }, err.status)
      throw err
    }
    await next()
  }
