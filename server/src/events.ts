import type { InStatement } from '@libsql/client'
import type { BoardSnapshot, Comment, Reply } from '../../shared/schema.js'
import { getDb } from './db.js'
import { summarize } from './summarize.js'

/**
 * Agent prompting. Agents can't be pushed to, so when a human does something an
 * agent should answer, we queue an event in that agent's inbox. Agents long-poll
 * `GET /agent/boards/:id/inbox?wait=25` and reply through the normal API.
 *
 * Triggers (human-authored only, so agents never ping each other in loops):
 * - mention:  "@AgentName" (or "@agents" for everyone) in a new comment/reply
 * - reply:    a new reply in a thread the agent started or has replied in
 * - comment:  a new comment on a note/shape the agent created
 */

export type EventKind = 'mention' | 'reply' | 'comment_on_yours' | 'report_request'

interface Invite {
  id: string
  agentName: string
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function mentions(body: string, invite: Invite, others: Invite[] = []): boolean {
  // "@Claude Reporter" shouldn't also ping "Claude": blank out longer names that start with this one first.
  let text = body
  for (const o of others) {
    if (o.id !== invite.id && o.agentName.length > invite.agentName.length && o.agentName.toLowerCase().startsWith(invite.agentName.toLowerCase())) {
      text = text.replace(new RegExp(`@${escapeRe(o.agentName)}(?![\\w])`, 'gi'), ' ')
    }
  }
  const name = new RegExp(`(^|[^\\w@])@${escapeRe(invite.agentName)}(?![\\w])`, 'i')
  return name.test(text) || /(^|[^\w@])@(agents|all)\b/i.test(text)
}

async function liveInvites(boardId: string): Promise<Invite[]> {
  const r = await getDb().execute({
    sql: 'SELECT id, agent_name FROM agent_invites WHERE board_id = ? AND revoked_at IS NULL',
    args: [boardId],
  })
  return r.rows.map((row) => ({ id: String(row.id), agentName: String(row.agent_name) }))
}

/**
 * Called after human ops are written. `created` holds only comments/replies that
 * didn't exist before this write (edits and resolves don't prompt anyone).
 */
export async function queueForHumanActivity(
  boardId: string,
  created: { comments: Comment[]; replies: Reply[] },
  snap: BoardSnapshot,
): Promise<number> {
  const humanComments = created.comments.filter((c) => c.authorType === 'human' && !c.deleted)
  const humanReplies = created.replies.filter((r) => r.authorType === 'human' && !r.deleted)
  if (!humanComments.length && !humanReplies.length) return 0
  const invites = await liveInvites(boardId)
  if (!invites.length) return 0

  const comments = new Map(snap.comments.filter((c) => !c.deleted).map((c) => [c.id, c]))
  const elements = new Map(snap.elements.filter((e) => !e.deleted).map((e) => [e.id, e]))
  const repliesByThread = new Map<string, Reply[]>()
  for (const r of snap.replies) {
    if (r.deleted) continue
    repliesByThread.set(r.commentId, [...(repliesByThread.get(r.commentId) ?? []), r])
  }

  const now = Date.now()
  const events: Array<{ invite: string; kind: EventKind; commentId: string; replyId: string }> = []
  const add = (invite: string, kind: EventKind, commentId: string, replyId = '') => {
    if (!events.some((e) => e.invite === invite && e.commentId === commentId && e.replyId === replyId)) {
      events.push({ invite, kind, commentId, replyId })
    }
  }

  for (const c of humanComments) {
    for (const inv of invites) {
      if (mentions(c.body, inv, invites)) add(inv.id, 'mention', c.id)
      else if (c.anchor.type === 'element' && elements.get(c.anchor.elementId)?.authorId === inv.id) add(inv.id, 'comment_on_yours', c.id)
    }
  }
  for (const r of humanReplies) {
    const thread = comments.get(r.commentId)
    if (!thread) continue
    const participants = new Set([thread.authorId, ...(repliesByThread.get(thread.id) ?? []).map((x) => x.authorId)])
    for (const inv of invites) {
      if (mentions(r.body, inv, invites)) add(inv.id, 'mention', thread.id, r.id)
      else if (participants.has(inv.id)) add(inv.id, 'reply', thread.id, r.id)
    }
  }
  if (!events.length) return 0

  const stmts: InStatement[] = events.map((e) => ({
    sql: `INSERT INTO agent_events (invite_id, board_id, kind, comment_id, reply_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [e.invite, boardId, e.kind, e.commentId, e.replyId, now],
  }))
  await getDb().batch(stmts, 'write')
  return events.length
}

interface EventRow {
  id: number
  kind: EventKind
  commentId: string
  replyId: string
  createdAt: number
}

async function pending(inviteId: string): Promise<EventRow[]> {
  const r = await getDb().execute({
    sql: 'SELECT * FROM agent_events WHERE invite_id = ? AND acked_at IS NULL ORDER BY id LIMIT 20',
    args: [inviteId],
  })
  return r.rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind) as EventKind,
    commentId: String(row.comment_id),
    replyId: String(row.reply_id),
    createdAt: Number(row.created_at),
  }))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Grace after an inbox call returns, so the gap before the agent's next call doesn't read as "stopped listening". */
export const LISTEN_GRACE_MS = 15_000

const setListening = (inviteId: string, until: number) =>
  getDb().execute({ sql: 'UPDATE agent_invites SET listening_until = ? WHERE id = ?', args: [until, inviteId] })

/** Long-poll: return pending events now, or wait up to `waitMs` for some to arrive. */
export async function waitForEvents(inviteId: string, waitMs: number, signal?: AbortSignal): Promise<EventRow[]> {
  const deadline = Date.now() + waitMs
  await setListening(inviteId, deadline + LISTEN_GRACE_MS)
  try {
    return await waitLoop(inviteId, deadline, signal)
  } finally {
    // Got events (it's busy answering) or timed out (it should call again right away): short grace either way.
    await setListening(inviteId, Date.now() + LISTEN_GRACE_MS).catch(() => {})
  }
}

async function waitLoop(inviteId: string, deadline: number, signal?: AbortSignal): Promise<EventRow[]> {
  for (;;) {
    const rows = await pending(inviteId)
    if (rows.length || Date.now() >= deadline || signal?.aborted) {
      if (rows.length) {
        await getDb().execute({
          sql: `UPDATE agent_events SET delivered_at = COALESCE(delivered_at, ?) WHERE id IN (${rows.map(() => '?').join(',')})`,
          args: [Date.now(), ...rows.map((r) => r.id)],
        })
      }
      return rows
    }
    await sleep(1000)
  }
}

export const REPORT_INSTRUCTIONS = `Write a report of this board in Markdown, grounded only in what's on it. Structure:

# <board title>: synthesis
A 2–3 sentence overview of what the board is about and where it stands.

## <one section per topic, using the topic's title>
**Main points**: 3–6 bullets that capture the ideas (quote key notes in "…").
**Relationships**: how items connect (arrows, clusters), and links to other topics.
**Open questions & tensions**: from comment threads and unresolved items.

## Across topics
Cross-cutting themes and how the topics relate to each other.

## Not yet in a topic
Anything outside every topic (skip this section if there's nothing).

## Suggested next steps
3–5 concrete, specific actions.

Keep it concise and specific. Use the topic titles exactly. Don't invent content that isn't on the board.`

const PROMPTS: Record<EventKind, (who: string) => string> = {
  report_request: (who) => `${who} asked you to write a report of the whole board. Follow "instructions", use "board" (the full structured summary), and submit it with the "respond.submit" call.`,
  mention: (who) => `${who} mentioned you. Read the thread and reply in it.`,
  reply: (who) => `${who} replied in a thread you're part of. Reply if you have something useful to add.`,
  comment_on_yours: (who) => `${who} commented on a note you wrote. Reply in the thread.`,
}

/** Turn event rows into self-contained, LLM-friendly prompts (the full thread + how to answer). */
export function describeEvents(rows: EventRow[], snap: BoardSnapshot, requesters: Map<string, string> = new Map()) {
  const threads = new Map(summarize(snap).threads.map((t) => [t.id, t]))
  const replies = new Map(snap.replies.map((r) => [r.id, r]))
  const comments = new Map(snap.comments.map((c) => [c.id, c]))
  const summary = rows.some((r) => r.kind === 'report_request') ? summarize(snap) : null
  return rows.map((row) => {
    if (row.kind === 'report_request') {
      const reportId = row.commentId.slice('report:'.length)
      return {
        id: row.id,
        kind: row.kind,
        prompt: PROMPTS.report_request(requesters.get(reportId) ?? 'Someone'),
        instructions: REPORT_INSTRUCTIONS,
        board: summary,
        respond: {
          submit: { method: 'POST', path: `/api/agent/boards/${snap.board.id}/reports/${reportId}`, body: { markdown: '# …' } },
        },
        createdAt: new Date(row.createdAt).toISOString(),
      }
    }
    const thread = threads.get(row.commentId)
    const trigger = row.replyId ? replies.get(row.replyId) : comments.get(row.commentId)
    const who = trigger?.authorName ?? 'Someone'
    return {
      id: row.id,
      kind: row.kind,
      prompt: PROMPTS[row.kind](who),
      message: trigger ? { type: row.replyId ? 'reply' : 'comment', id: trigger.id, body: trigger.body, author: { name: trigger.authorName, type: trigger.authorType } } : null,
      thread: thread ?? null,
      respond: {
        reply: { method: 'POST', path: `/api/agent/boards/${snap.board.id}/comments/${row.commentId}/replies`, body: { body: '…' } },
        ack: { method: 'POST', path: `/api/agent/boards/${snap.board.id}/inbox/ack`, body: { ids: [row.id] } },
      },
      createdAt: new Date(row.createdAt).toISOString(),
    }
  })
}

export async function ack(inviteId: string, ids: number[]) {
  if (!ids.length) return
  await getDb().execute({
    sql: `UPDATE agent_events SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?)
          WHERE invite_id = ? AND acked_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    args: [Date.now(), Date.now(), inviteId, ...ids],
  })
}

/** Replying in a thread answers everything pending for that thread. */
export async function ackThread(inviteId: string, commentId: string) {
  await getDb().execute({
    sql: 'UPDATE agent_events SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE invite_id = ? AND comment_id = ? AND acked_at IS NULL',
    args: [Date.now(), Date.now(), inviteId, commentId],
  })
}

export interface EventStatus {
  inviteId: string
  agentName: string
  commentId: string
  replyId: string
  status: 'queued' | 'seen' | 'answered'
  at: number
}

/** Recent prompts on a board, for "sent to Claude · seen" labels and the thinking indicator. */
export async function recentEventStatus(boardId: string): Promise<EventStatus[]> {
  const r = await getDb().execute({
    sql: `SELECT e.*, i.agent_name FROM agent_events e JOIN agent_invites i ON i.id = e.invite_id
          WHERE e.board_id = ? AND e.created_at > ? ORDER BY e.id DESC LIMIT 100`,
    args: [boardId, Date.now() - 6 * 3600_000],
  })
  return r.rows.map((row) => ({
    inviteId: String(row.invite_id),
    agentName: String(row.agent_name),
    commentId: String(row.comment_id),
    replyId: String(row.reply_id),
    status: row.acked_at != null ? 'answered' : row.delivered_at != null ? 'seen' : 'queued',
    at: Number(row.acked_at ?? row.delivered_at ?? row.created_at),
  }))
}
