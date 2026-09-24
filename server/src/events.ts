import type { InStatement } from '@libsql/client'
import type { BoardSnapshot, Comment, Reply } from '../../shared/schema.js'
import { getDb } from './db.js'
import { summarize } from './summarize.js'

/**
 * Agent prompting. Agents can't be pushed to, so when a human does something an
 * agent should answer, we queue an event in that agent's inbox. Agents long-poll
 * `GET /agent/boards/:id/inbox?wait=25` and reply through the normal API.
 *
 * Triggers, from people *and* other agents (an agent never prompts itself):
 * - mention:  "@AgentName" (or "@agents" for everyone) in a new comment/reply
 * - reply:    a new reply in a thread the agent started or has replied in
 * - comment:  a new comment on a note/shape the agent created
 *
 * Loop guard: agent-written messages stop prompting other agents in a thread once
 * it has MAX_AGENT_STREAK agent messages in a row with no person in between.
 */

/** Consecutive agent messages allowed in a thread before agents stop pinging each other there. */
export const MAX_AGENT_STREAK = 6

export type EventKind = 'mention' | 'reply' | 'comment_on_yours' | 'report_request' | 'direct' | 'board_activity'

/** Words that mean "you may delete things" when a person says them to an agent. */
export const CLEANUP_RE = /\b(delete|deleting|remove|removing|clean\s*up|cleanup|clear\s+out|clear\s+up|declutter|get\s+rid\s+of|prune|trash|erase|wipe)\b/i
/** How long a person's "clean this up" lets that agent delete. */
export const CLEANUP_GRANT_MS = 30 * 60_000

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
export async function queueForActivity(
  boardId: string,
  created: { comments: Comment[]; replies: Reply[] },
  snap: BoardSnapshot,
): Promise<number> {
  const newComments = created.comments.filter((c) => !c.deleted)
  const newReplies = created.replies.filter((r) => !r.deleted)
  if (!newComments.length && !newReplies.length) return 0
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

  // Agent-written messages carry authorId = the writing agent's invite id.
  const fromAgent = (m: { authorType: string }) => m.authorType === 'agent'
  const recipients = (author: { authorType: string; authorId: string | null }) =>
    invites.filter((inv) => !(fromAgent(author) && author.authorId === inv.id)) // never prompt yourself

  /** Agent messages at the end of the thread with no person in between. */
  const agentStreak = (threadId: string) => {
    const root = comments.get(threadId)
    const msgs = [...(root ? [root] : []), ...(repliesByThread.get(threadId) ?? [])].sort((a, b) => a.createdAt - b.createdAt)
    let n = 0
    for (let i = msgs.length - 1; i >= 0 && fromAgent(msgs[i]); i--) n++
    return n
  }

  // Direct conversations (from an agent's card): only that agent hears them, and agents' answers ping no one.
  const dmOf = (threadId: string) => comments.get(threadId)?.dmInviteId ?? null
  // A person asking an agent to delete / clean up grants it delete rights for a while.
  const grants = new Set<string>()
  const maybeGrant = (inviteId: string, author: { authorType: string }, body: string) => {
    if (!fromAgent(author) && CLEANUP_RE.test(body)) grants.add(inviteId)
  }

  for (const c of newComments) {
    if (c.dmInviteId) {
      if (!fromAgent(c) && invites.some((i) => i.id === c.dmInviteId)) {
        add(c.dmInviteId, 'direct', c.id)
        maybeGrant(c.dmInviteId, c, c.body)
      }
      continue
    }
    if (fromAgent(c) && agentStreak(c.id) > MAX_AGENT_STREAK) continue
    for (const inv of recipients(c)) {
      if (mentions(c.body, inv, invites)) {
        add(inv.id, 'mention', c.id)
        maybeGrant(inv.id, c, c.body)
      } else if (c.anchor.type === 'element' && elements.get(c.anchor.elementId)?.authorId === inv.id) add(inv.id, 'comment_on_yours', c.id)
    }
  }
  for (const r of newReplies) {
    const thread = comments.get(r.commentId)
    if (!thread) continue
    const dm = dmOf(thread.id)
    if (dm) {
      if (!fromAgent(r) && invites.some((i) => i.id === dm)) {
        add(dm, 'direct', thread.id, r.id)
        maybeGrant(dm, r, r.body)
      }
      continue
    }
    if (fromAgent(r) && agentStreak(thread.id) > MAX_AGENT_STREAK) continue
    const participants = new Set([thread.authorId, ...(repliesByThread.get(thread.id) ?? []).map((x) => x.authorId)])
    for (const inv of recipients(r)) {
      if (mentions(r.body, inv, invites)) {
        add(inv.id, 'mention', thread.id, r.id)
        maybeGrant(inv.id, r, r.body)
      } else if (participants.has(inv.id)) {
        add(inv.id, 'reply', thread.id, r.id)
        maybeGrant(inv.id, r, r.body)
      }
    }
  }
  if (grants.size) {
    await getDb().batch(
      [...grants].map((id) => ({ sql: 'UPDATE agent_invites SET cleanup_until = ? WHERE id = ?', args: [now + CLEANUP_GRANT_MS, id] })),
      'write',
    )
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
  inviteId: string
  kind: EventKind
  commentId: string
  replyId: string
  createdAt: number
}

async function pending(inviteId: string): Promise<EventRow[]> {
  const r = await getDb().execute({
    // Orchestrator nudges wait until the other agents have been quiet for a moment.
    sql: `SELECT * FROM agent_events WHERE invite_id = ? AND acked_at IS NULL
          AND NOT (kind = 'board_activity' AND created_at > ?)
          ORDER BY id LIMIT 20`,
    args: [inviteId, Date.now() - SETTLE_MS],
  })
  return r.rows.map((row) => ({
    id: Number(row.id),
    inviteId: String(row.invite_id),
    kind: String(row.kind) as EventKind,
    commentId: String(row.comment_id),
    replyId: String(row.reply_id),
    createdAt: Number(row.created_at),
  }))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- the Orchestrator ----------

/** How long other agents must be quiet before the Orchestrator is nudged to reorganize. */
export const SETTLE_MS = 30_000

const ORCHESTRATOR_SQL = `(persona = 'Orchestrator' OR agent_name = 'Orchestrator' OR agent_name LIKE 'Orchestrator %')`

export const ORCHESTRATE = `Reorganize the board around these ideas:
0. First read "board.structure" and each item's "where": respect what people drew. If there's a question with a line splitting
   it into sides (e.g. "yes" / "no"), keep that frame: sort ideas onto the side they support, and don't regroup across it.
1. Group related notes into topics by theme (POST /topics with elementIds), even across agents. Give each topic a short, clear title.
2. Add a heading (POST /text, size "heading", topicId or nearElementId) where a cluster needs a name.
3. Connect ideas that cause, support, contradict or build on each other with labeled arrows (POST /arrows), especially across different agents' work.
4. Tidy the layout: POST /arrange {"topicId"} for each topic you touched, then POST /arrange {} so topics don't overlap.
   Check "board.problems": it should list no overlaps when you're done.
5. Where agents disagree or something is missing, start a comment thread and @mention the agent best placed to answer.
6. Reply to the person who asked (or leave one short comment on the board) summarizing what you changed and why.
You may delete (POST /delete {"ids": [...], "reason": "..."}) without asking: remove exact duplicates, empty or stray items,
and clutter that no longer fits. Merge ideas by keeping the clearest note. Don't delete anyone's distinct idea just to tidy.
Always give a short reason; people see it and can restore anything.`

/** Something another agent did: queue (or refresh) a single "reorganize" nudge for each Orchestrator on the board. */
export async function nudgeOrchestrators(boardId: string, fromInviteId: string) {
  const db = getDb()
  const r = await db.execute({
    sql: `SELECT id, created_at FROM agent_invites WHERE board_id = ? AND revoked_at IS NULL AND id != ? AND ${ORCHESTRATOR_SQL}`,
    args: [boardId, fromInviteId],
  })
  const now = Date.now()
  for (const row of r.rows) {
    const orch = String(row.id)
    const open = await db.execute({
      sql: `SELECT id FROM agent_events WHERE invite_id = ? AND kind = 'board_activity' AND delivered_at IS NULL LIMIT 1`,
      args: [orch],
    })
    if (open.rows.length) {
      // Still waiting to be delivered: restart the quiet-period clock.
      await db.execute({ sql: 'UPDATE agent_events SET created_at = ? WHERE id = ?', args: [now, open.rows[0].id] })
      continue
    }
    // Contributions "since" the last nudge it got (or since it joined).
    const last = await db.execute({
      sql: `SELECT MAX(delivered_at) AS t FROM agent_events WHERE invite_id = ? AND kind = 'board_activity'`,
      args: [orch],
    })
    const since = Number(last.rows[0]?.t ?? 0) || Number(row.created_at)
    await db.execute({
      sql: `INSERT INTO agent_events (invite_id, board_id, kind, comment_id, reply_id, created_at)
            VALUES (?, ?, 'board_activity', 'activity', ?, ?) ON CONFLICT DO NOTHING`,
      args: [orch, boardId, String(since), now],
    })
  }
}

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
        // Nudges are informational: delivering one is enough (no thread to answer in).
        const nudges = rows.filter((r) => r.kind === 'board_activity')
        if (nudges.length) {
          await getDb().execute({
            sql: `UPDATE agent_events SET acked_at = ? WHERE id IN (${nudges.map(() => '?').join(',')})`,
            args: [Date.now(), ...nudges.map((r) => r.id)],
          })
        }
      }
      return rows
    }
    await sleep(1000)
  }
}

export const REPORT_INSTRUCTIONS = `Write a short, readable summary of this board in plain, natural language, as if you were
explaining it to a teammate who missed the session. Use Markdown headings, but write normal sentences, not labeled fields.

# <a short heading for what the board is about>
Two or three sentences on what the board is about and where the thinking has landed.

## <one short section per topic, using the topic's title>
A few sentences on what the team came up with in this topic and why it matters. Mention any open question or
disagreement naturally, in passing.

## What's next
Three to five concrete next steps, as a short bulleted list.

Keep it brief and friendly. Don't use labels like "Main points", "Relationships" or "Tensions", don't describe the board's
layout (arrows, positions, colors), and don't say who suggested what (no agent or person names): write about the ideas as the team's. Quote a note only when its exact words really matter. Don't add anything that isn't on the board.`

/** Appended to every prompt: finish the job, and use the board's structure to do it. */
export const WORK_UNTIL_DONE =
  'Work on this until it is fully done, across as many calls as it takes: reply in the thread, and where it helps, add notes, headings, topics and arrows on the board. ' +
  "Only stop early if you're paused, the invite ends, or someone asks you to stop. When you're finished, go back to listening."

const PROMPTS: Record<EventKind, (who: string) => string> = {
  report_request: (who) => `${who} asked you to write a report of the whole board. Follow "instructions", use "board" (the full structured summary), and submit it with the "respond.submit" call.`,
  mention: (who) => `${who} mentioned you. Read the thread and do what it asks.`,
  reply: (who) => `${who} replied in a thread you're part of. Respond if you can add something: build on it, question it, or connect it to other ideas.`,
  comment_on_yours: (who) => `${who} commented on something you made. Reply in the thread and follow through.`,
  board_activity: () => 'Other agents have added to the board since you last organized it.',
  direct: (who) => `${who} messaged you directly from your card. Do what they ask on the board, then reply in this conversation (it's private to you two).`,
}

/** Deep-copy a summary with every `author` field removed. */
function withoutAuthors<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === 'author' ? undefined : v)))
}

/** Turn event rows into self-contained, LLM-friendly prompts (the full thread + how to answer). */
export function describeEvents(rows: EventRow[], snap: BoardSnapshot, requesters: Map<string, string> = new Map()) {
  const threads = new Map(summarize(snap, { directFor: '*' }).threads.map((t) => [t.id, t]))
  const replies = new Map(snap.replies.map((r) => [r.id, r]))
  const comments = new Map(snap.comments.map((c) => [c.id, c]))
  // Reports are about the ideas, not who had them: strip every author from the data the writer sees.
  const summary = rows.some((r) => r.kind === 'report_request') ? withoutAuthors(summarize(snap)) : null
  return rows.map((row) => {
    if (row.kind === 'board_activity') {
      const since = Number(row.replyId) || 0
      const self = row.inviteId
      const byOthers = (x: { authorType: string; authorId: string | null }) => x.authorType === 'agent' && x.authorId !== self
      const contributions = [
        ...snap.elements
          .filter((e) => !e.deleted && byOthers(e) && Math.max(e.createdAt, e.updatedAt) > since)
          .map((e) => ({
            id: e.id,
            type: e.role === 'section' ? 'topic' : e.kind === 'shape' ? (e.shape ?? 'shape') : e.kind,
            author: e.authorName,
            text: e.text || null,
            isNew: e.createdAt > since,
          })),
        ...snap.comments
          .filter((c) => !c.deleted && !c.dmInviteId && byOthers(c) && c.createdAt > since)
          .map((c) => ({ id: c.id, type: 'comment', author: c.authorName, text: c.body, isNew: true })),
        ...snap.replies
          .filter((x) => !x.deleted && byOthers(x) && x.createdAt > since)
          .map((x) => ({ id: x.id, type: 'reply', author: x.authorName, text: x.body, threadId: x.commentId, isNew: true })),
      ].slice(0, 80)
      const authors = [...new Set(contributions.map((c) => c.author))]
      return {
        id: row.id,
        kind: row.kind,
        prompt: `${authors.length ? `${authors.join(', ')} added to the board since you last organized it.` : PROMPTS.board_activity('')} ${ORCHESTRATE}`,
        contributions,
        board: summarize(snap, { directFor: self }),
        respond: {
          topics: { method: 'POST', path: `/api/agent/boards/${snap.board.id}/topics` },
          arrows: { method: 'POST', path: `/api/agent/boards/${snap.board.id}/arrows` },
          move: { method: 'POST', path: `/api/agent/boards/${snap.board.id}/move` },
          text: { method: 'POST', path: `/api/agent/boards/${snap.board.id}/text` },
          delete: { method: 'POST', path: `/api/agent/boards/${snap.board.id}/delete`, body: { ids: ['…'], reason: '…' } },
        },
        createdAt: new Date(row.createdAt).toISOString(),
      }
    }
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
    const who = trigger ? (trigger.authorType === 'agent' ? `${trigger.authorName} (another agent)` : trigger.authorName) : 'Someone'
    return {
      id: row.id,
      kind: row.kind,
      prompt: `${PROMPTS[row.kind](who)} ${WORK_UNTIL_DONE}`,
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
