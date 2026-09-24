import { createClient, type Client, type InStatement, type Row } from '@libsql/client'
import type { Board, Comment, Element, Participant, Reply } from '../../shared/schema.js'

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS boards (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     version INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS elements (
     id TEXT NOT NULL,
     board_id TEXT NOT NULL,
     data TEXT NOT NULL,
     author_type TEXT NOT NULL DEFAULT 'human',
     version INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (board_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS elements_version ON elements (board_id, version)`,
  `CREATE TABLE IF NOT EXISTS comments (
     id TEXT NOT NULL,
     board_id TEXT NOT NULL,
     data TEXT NOT NULL,
     version INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (board_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS comments_version ON comments (board_id, version)`,
  `CREATE TABLE IF NOT EXISTS replies (
     id TEXT NOT NULL,
     board_id TEXT NOT NULL,
     comment_id TEXT NOT NULL,
     data TEXT NOT NULL,
     version INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (board_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS replies_version ON replies (board_id, version)`,
  `CREATE TABLE IF NOT EXISTS participants (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     last_seen_at INTEGER NOT NULL DEFAULT 0,
     last_board_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS participants_seen ON participants (last_board_id, last_seen_at)`,
  // One row per open board tab. Its heartbeat decides whether that tab's agent invites work.
  `CREATE TABLE IF NOT EXISTS host_sessions (
     id TEXT PRIMARY KEY,
     pid TEXT NOT NULL,
     board_id TEXT NOT NULL,
     last_seen_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS agent_invites (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     board_id TEXT NOT NULL,
     host_session TEXT NOT NULL,
     host_pid TEXT NOT NULL,
     agent_name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER,
     revoked_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS agent_invites_board ON agent_invites (board_id, revoked_at)`,
  // Things a human did that an agent should respond to (mentions, replies in its threads, comments on its notes).
  `CREATE TABLE IF NOT EXISTS agent_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     invite_id TEXT NOT NULL,
     board_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     comment_id TEXT NOT NULL,
     reply_id TEXT NOT NULL DEFAULT '', -- '' = the event is about the thread's first comment (NULLs would defeat UNIQUE)
     created_at INTEGER NOT NULL,
     delivered_at INTEGER,
     acked_at INTEGER,
     UNIQUE (invite_id, comment_id, reply_id)
   )`,
  `CREATE INDEX IF NOT EXISTS agent_events_inbox ON agent_events (invite_id, acked_at)`,
  `CREATE INDEX IF NOT EXISTS agent_events_board ON agent_events (board_id, created_at)`,
  // Board reports written by an agent on request (markdown).
  `CREATE TABLE IF NOT EXISTS reports (
     id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     invite_id TEXT NOT NULL,
     agent_name TEXT NOT NULL,
     requested_by TEXT NOT NULL,
     status TEXT NOT NULL,
     markdown TEXT,
     created_at INTEGER NOT NULL,
     completed_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS reports_board ON reports (board_id, created_at)`,
  // Every agent deletion, with the rows as they were, so anyone can restore them.
  `CREATE TABLE IF NOT EXISTS agent_deletions (
     id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     invite_id TEXT NOT NULL,
     agent_name TEXT NOT NULL,
     reason TEXT,
     count INTEGER NOT NULL,
     before TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     restored_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS agent_deletions_board ON agent_deletions (board_id, created_at)`,
]

let client: Client | null = null
let migrated: Promise<void> | null = null

export function getDb(): Client {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL ?? 'file:./data/local.db',
      authToken: process.env.TURSO_AUTH_TOKEN,
    })
  }
  return client
}

/** For tests: swap in a fresh in-memory database. */
export function useDb(c: Client) {
  client = c
  migrated = null
}

/** Column additions for existing databases. SQLite has no ADD COLUMN IF NOT EXISTS, so duplicates are ignored. */
const ALTERATIONS = [
  // Which page visit ("run") the last heartbeat came from, and which run said goodbye.
  `ALTER TABLE host_sessions ADD COLUMN run TEXT`,
  `ALTER TABLE host_sessions ADD COLUMN left_run TEXT`,
  // Last heartbeat while the tab was actually visible ("here" vs "away").
  `ALTER TABLE host_sessions ADD COLUMN last_visible_at INTEGER NOT NULL DEFAULT 0`,
  // Until when the agent counts as "listening" (has an inbox request open, plus a little grace between calls).
  `ALTER TABLE agent_invites ADD COLUMN listening_until INTEGER NOT NULL DEFAULT 0`,
  // Who the agent should be on this board, set when inviting.
  `ALTER TABLE agent_invites ADD COLUMN persona TEXT`,
  `ALTER TABLE agent_invites ADD COLUMN context TEXT`,
  // Paused by someone on the board: the agent can't act and gets no prompts until resumed.
  `ALTER TABLE agent_invites ADD COLUMN paused_at INTEGER`,
  `ALTER TABLE agent_invites ADD COLUMN paused_by TEXT`,
  // Until when this agent may delete: granted when a person asks it to delete / clean up.
  `ALTER TABLE agent_invites ADD COLUMN cleanup_until INTEGER NOT NULL DEFAULT 0`,
]

async function migrate() {
  const db = getDb()
  await db.batch(MIGRATIONS, 'write')
  for (const sql of ALTERATIONS) {
    await db.execute(sql).catch((err) => {
      if (!/duplicate column/i.test(String(err?.message ?? err))) throw err
    })
  }
}

export function ready(): Promise<void> {
  if (!migrated) {
    migrated = migrate()
      .then(() => undefined)
      .catch((err) => {
        migrated = null
        throw err
      })
  }
  return migrated
}

// ---------- row helpers ----------

const parse = <T,>(row: Row, extra: Partial<T> = {}): T => ({ ...JSON.parse(String(row.data)), ...extra })

export async function getBoard(id: string): Promise<Board | null> {
  const r = await getDb().execute({ sql: 'SELECT * FROM boards WHERE id = ?', args: [id] })
  const row = r.rows[0]
  if (!row) return null
  return { id: String(row.id), title: String(row.title), createdAt: Number(row.created_at), version: Number(row.version) }
}

export async function createBoard(id: string, title: string): Promise<Board | null> {
  const now = Date.now()
  const r = await getDb().execute({
    sql: 'INSERT INTO boards (id, title, created_at, version) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO NOTHING',
    args: [id, title, now],
  })
  if (r.rowsAffected === 0) return null
  return { id, title, createdAt: now, version: 0 }
}

export async function loadSince(boardId: string, since: number) {
  const db = getDb()
  const [els, cms, rps] = await db.batch(
    [
      { sql: 'SELECT data, version, deleted FROM elements WHERE board_id = ? AND version > ?', args: [boardId, since] },
      { sql: 'SELECT data, version, deleted FROM comments WHERE board_id = ? AND version > ?', args: [boardId, since] },
      { sql: 'SELECT data, version, deleted FROM replies WHERE board_id = ? AND version > ?', args: [boardId, since] },
    ],
    'read',
  )
  const map = <T,>(rows: Row[]) =>
    rows.map((row) => parse<T>(row, { version: Number(row.version), deleted: Boolean(row.deleted) } as unknown as Partial<T>))
  return {
    elements: map<Element>(els.rows),
    comments: map<Comment>(cms.rows),
    replies: map<Reply>(rps.rows),
  }
}

/**
 * Apply a set of writes atomically, bumping the board version once.
 * Each writer receives the new version number and returns the statements to run.
 */
export async function writeBoard(boardId: string, build: (version: number) => InStatement[]): Promise<number> {
  const tx = await getDb().transaction('write')
  try {
    const r = await tx.execute({
      sql: 'UPDATE boards SET version = version + 1 WHERE id = ? RETURNING version',
      args: [boardId],
    })
    const row = r.rows[0]
    if (!row) throw new NotFound('board')
    const version = Number(row.version)
    const stmts = build(version)
    if (stmts.length) await tx.batch(stmts)
    await tx.commit()
    return version
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  } finally {
    tx.close()
  }
}

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`)
  }
}

export const stmt = {
  upsertElement: (boardId: string, el: Element, version: number): InStatement => ({
    sql: `INSERT INTO elements (id, board_id, data, author_type, version, deleted) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(board_id, id) DO UPDATE SET data = excluded.data, version = excluded.version, deleted = excluded.deleted`,
    args: [el.id, boardId, JSON.stringify({ ...el, version, deleted: el.deleted }), el.authorType, version, el.deleted ? 1 : 0],
  }),
  upsertComment: (boardId: string, c: Comment, version: number): InStatement => ({
    sql: `INSERT INTO comments (id, board_id, data, version, deleted) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(board_id, id) DO UPDATE SET data = excluded.data, version = excluded.version, deleted = excluded.deleted`,
    args: [c.id, boardId, JSON.stringify({ ...c, version }), version, c.deleted ? 1 : 0],
  }),
  upsertReply: (boardId: string, r: Reply, version: number): InStatement => ({
    sql: `INSERT INTO replies (id, board_id, comment_id, data, version, deleted) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(board_id, id) DO UPDATE SET data = excluded.data, version = excluded.version, deleted = excluded.deleted`,
    args: [r.id, boardId, r.commentId, JSON.stringify({ ...r, version }), version, r.deleted ? 1 : 0],
  }),
  tombstone: (table: 'elements' | 'comments' | 'replies', boardId: string, id: string, version: number): InStatement => ({
    sql: `UPDATE ${table} SET deleted = 1, version = ?, data = json_set(data, '$.deleted', json('true'), '$.version', ?)
          WHERE board_id = ? AND id = ?`,
    args: [version, version, boardId, id],
  }),
  setTitle: (boardId: string, title: string): InStatement => ({
    sql: 'UPDATE boards SET title = ? WHERE id = ?',
    args: [title, boardId],
  }),
}

// ---------- participants ----------

export async function getParticipant(id: string): Promise<Participant | null> {
  const r = await getDb().execute({ sql: 'SELECT * FROM participants WHERE id = ?', args: [id] })
  const row = r.rows[0]
  if (!row) return null
  return parse<Participant>(row, { lastSeenAt: Number(row.last_seen_at), lastBoardId: (row.last_board_id as string) ?? null })
}

export async function putParticipant(p: Participant): Promise<void> {
  const { lastSeenAt: _s, lastBoardId: _b, ...data } = p
  await getDb().execute({
    sql: `INSERT INTO participants (id, data) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    args: [p.id, JSON.stringify(data)],
  })
}

/**
 * Presence windows. Visible tabs heartbeat every 4s, hidden ones every 10s, but
 * browsers throttle long-hidden tabs (>5 min) to ~1 timer/minute. Leave beacons
 * usually remove people instantly; these windows are the fallback when a
 * beacon is lost (crash, sleep, some embedded browsers).
 */
export const HERE_WINDOW_MS = 15_000 // visible heartbeat this recent → "here"
export const PRESENT_WINDOW_MS = 25_000 // any heartbeat this recent → still on the board
export const THROTTLED_AFTER_MS = 240_000 // hidden this long → expect throttled heartbeats…
export const THROTTLED_WINDOW_MS = 75_000 // …so allow this much slack

/**
 * Who's on this board right now, based on open tabs (host_sessions heartbeats).
 * Closing a tab sends a leave beacon that zeroes its heartbeat, so people drop
 * off immediately; if the beacon is lost they fade out within HERE_WINDOW_MS.
 */
export async function touchAndListPresence(boardId: string, pid: string | null) {
  const db = getDb()
  const now = Date.now()
  const stmts: InStatement[] = []
  if (pid) {
    stmts.push({
      sql: 'UPDATE participants SET last_seen_at = ?, last_board_id = ? WHERE id = ?',
      args: [now, boardId, pid],
    })
  }
  stmts.push({
    sql: `SELECT p.id, p.data, MAX(s.last_seen_at) AS seen, MAX(s.last_visible_at) AS visible
          FROM host_sessions s JOIN participants p ON p.id = s.pid
          WHERE s.board_id = ? AND (
            s.last_seen_at > ? OR
            (s.last_seen_at > ? AND s.last_visible_at < ?)
          )
          GROUP BY p.id ORDER BY visible DESC LIMIT 24`,
    args: [boardId, now - PRESENT_WINDOW_MS, now - THROTTLED_WINDOW_MS, now - THROTTLED_AFTER_MS],
  })
  const results = await db.batch(stmts, 'write')
  const rows = results[results.length - 1].rows
  return rows.map((row) => {
    const p = parse<Participant>(row)
    return {
      id: String(row.id),
      name: p.name,
      color: p.color,
      sketch: p.sketch,
      lastSeenAt: Number(row.seen),
      away: Number(row.visible) <= now - HERE_WINDOW_MS,
    }
  })
}
