import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import { AgentAvatar } from '../lib/Portrait'
import { useBoard } from '../store/board'
import { SEATS, seatBrief, type Seat } from '../lib/personas'

/** The command an agent runs to wait for its next prompt. It exits (printing the events) as soon as someone needs it. */
export function listenCommand(b: string, token: string) {
  return `while :; do R=$(curl -s -w '\\n%{http_code}' -H "Authorization: Bearer ${token}" "${b}/inbox?wait=25"); C=\${R##*$'\\n'}; J=\${R%$'\\n'*}; if [ "$C" = 200 ]; then case "$J" in *'"events":[{'*) echo "$J"; break;; esac; elif [ "$C" = 423 ]; then sleep 15; else echo "$J"; break; fi; done`
}

/** Tokens for invites made in this tab (tab-scoped, like the invites), so we can re-brief an agent that went quiet. */
const TOKENS_KEY = 'wall.inviteTokens'
export function rememberInviteToken(inviteId: string, token: string) {
  const all = JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? '{}')
  all[inviteId] = token
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(all))
}
export function inviteToken(inviteId: string): string | null {
  return JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? '{}')[inviteId] ?? null
}

/** A short wake-up message for an agent that stopped listening, including what's waiting for it. */
export function resumePrompt(opts: {
  origin: string
  boardId: string
  agentName: string
  hostName: string
  token: string
  waiting?: Array<{ author: string; body: string; commentId: string }>
  persona?: string | null
}) {
  const b = `${opts.origin}/api/agent/boards/${opts.boardId}`
  const role = opts.persona && opts.persona !== opts.agentName && !opts.agentName.startsWith(opts.persona + ' ') ? ` (you're here as: ${opts.persona})` : ''
  const waiting = opts.waiting ?? []
  const list = waiting.length
    ? `\n${waiting.length === 1 ? 'This is' : `These ${waiting.length} messages are`} waiting for you:\n` +
      waiting.map((w) => `- ${w.author}: "${w.body.length > 160 ? w.body.slice(0, 157) + '…' : w.body}"  (thread ${w.commentId})`).join('\n') +
      '\n'
    : ''
  return `Wake up, "${opts.agentName}"${role}: ${opts.hostName} here, people on the DESIGN 276 board need you.
${list}
Run this now (in the background if you can). It prints your waiting messages and exits, and when nothing is waiting it blocks until something arrives:
${listenCommand(b, opts.token)}

For each event it prints, reply in that thread (POST ${b}/comments/<commentId>/replies {"body": "..."}) with the header Authorization: Bearer ${opts.token}.
Then run the command again, and keep doing that until I say we're done.`
}

/** The copy-paste brief an agent needs: where, who, rules, and how. */
export function agentPrompt(opts: {
  origin: string
  boardId: string
  title: string
  agentName: string
  hostName: string
  token: string
  persona?: string
  context?: string
}) {
  const { origin, boardId, title, agentName, hostName, token } = opts
  const persona = opts.persona?.trim()
  const context = opts.context?.trim()
  const role =
    persona || context
      ? `\nYour role
${persona ? `- You are "${persona}". Stay in this role in everything you add or say on the board.\n` : ''}${
          context ? `${context.split('\n').map((l) => `  ${l}`).join('\n')}\n` : ''
        }`
      : ''
  const api = `${origin}/api`
  const b = `${api}/agent/boards/${boardId}`
  return `You're invited to collaborate on a DESIGN 276 whiteboard as "${agentName}".

Board: "${title}" (id: ${boardId}), hosted by ${hostName}.
API base: ${api}
Auth: send the header  Authorization: Bearer ${token}
${role}
Rules
- You can read the whole board; add sticky notes, text titles, topics and arrows; move things to reorganize; start comment threads, reply, and resolve threads.
- You cannot edit anyone's text or delete anything. Your name is your persona, fixed by this invite.
- Access only works while ${hostName} has the board open. HTTP 423 = host stepped away, or someone paused you (wait and retry); 401 = invite ended.
- People can pause you from the board. While paused, don't try to change anything. Keep calling /inbox?wait=25: it says "paused" until you're resumed, then delivers what queued up.

1. Get oriented
  GET  ${api}/agent/session          → confirms who/where you are
  GET  ${b}/summary                  → notes, text, shapes, topics (+ what's in each), arrows, comment threads

2. Contribute (JSON bodies)
  POST  ${b}/notes                   {"text": "...", "color": "yellow|pink|mint|lilac|sky", "nearElementId": "<id>"}
  POST  ${b}/text                    {"text": "Insights", "size": "title|heading|label", "aboveElementId": "<id>"}   (or "x"/"y")
  POST  ${b}/topics                  {"title": "Pain points", "elementIds": ["<id>", ...], "color": "gray|yellow|pink|mint|lilac|sky"}
  POST  ${b}/arrows                  {"from": {"elementId": "<id>"}, "to": {"elementId": "<id>"}, "label": "optional"}
  POST  ${b}/move                    {"moves": [{"id": "<id>", "x": 0, "y": 0}, {"id": "<id>", "dx": 40, "dy": 0}]}
  POST  ${b}/comments                {"body": "...", "anchor": {"elementId": "<id>"}}   or  {"anchor": {"x": 0, "y": 0}}
  POST  ${b}/comments/<commentId>/replies   {"body": "..."}
  PATCH ${b}/comments/<commentId>    {"resolved": true}

  How to structure a board well:
  - Sticky notes are for ideas, quotes and observations, not for labels.
  - Name things with text: a "title" for the board or a big area, a "heading" over a cluster, a "label" for small captions.
  - A topic is a titled area; everything inside it belongs to that topic. People draw them too.
  - Group related notes: first move them into a tidy cluster (~40px gaps, one /move call), then make a topic around them
    with a short title. A topic sizes itself to fit the elementIds you give it and sits behind everything.
  - Moving a topic carries everything inside it. Arrows attached to elements follow them when moved.
  - Positions are canvas pixels (x right, y down); x/y is an element's top-left.

3. Stay in the conversation (important: don't stop after your first contribution)
  People will @mention you ("@${agentName}") or reply in your threads. Wait for them with this command.
  It blocks until something arrives, then prints the events and exits. If you can run commands in the
  background, do that; you'll be woken when it finishes:

  ${listenCommand(b, token)}

  Each event has the full thread and a prompt. Reply in its thread (POST ${b}/comments/<commentId>/replies);
  that marks it answered. To skip one: POST ${b}/inbox/ack {"ids": [<eventId>]}.
  A "report_request" event means someone wants a written report of the board: follow its "instructions",
  use its "board" summary, and POST {"markdown": "..."} to its "respond.submit.path".
  Then run the command again. Keep this loop going until ${hostName} says you're done. The board shows
  people whether you're listening, and messages sent while you're not are queued for you.

Full reference: ${api}/docs
Be concise and specific; notes are sticky-note sized (a short phrase or question).`
}

/** "Skeptic" → "Skeptic 2" if a Skeptic is already on the board, so @mentions stay unambiguous. */
function uniqueName(base: string, taken: string[]) {
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base} ${n}`)) n++
  return `${base} ${n}`
}

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const board = useBoard((s) => s.board)
  const me = useBoard((s) => s.me)
  const sid = useBoard((s) => s.sid)
  // Select the stable array, then derive (a fresh array from a selector re-renders forever).
  const agents = useBoard((s) => s.agents)
  const taken = agents.map((a) => a.agentName)
  const [seat, setSeat] = useState<Seat | 'custom'>(SEATS[0])
  const [custom, setCustom] = useState('')
  const [context, setContext] = useState('')
  const personaName = seat === 'custom' ? custom.trim() : seat.name
  const name = personaName ? uniqueName(personaName, taken) : ''
  const [prompt, setPrompt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!board || !me) return null

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      // The seat's job + refusal travel with the invite, so the agent is reminded of them on every check-in.
      const roleContext = [seat === 'custom' ? '' : seatBrief(seat), context.trim() ? `Context from ${me.name}:\n${context.trim()}` : '']
        .filter(Boolean)
        .join('\n\n')
      const { token, invite } = await api.createInvite(board.id, {
        pid: me.id,
        sid,
        agentName: name,
        persona: personaName,
        context: roleContext || undefined,
      })
      rememberInviteToken(invite.id, token)
      setPrompt(
        agentPrompt({
          origin: window.location.origin,
          boardId: board.id,
          title: board.title,
          agentName: name,
          hostName: me.name,
          token,
          persona: name,
          context: roleContext,
        }),
      )
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'Hang on a second, the board is still connecting. Try again.' : "Couldn't create the invite.")
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!prompt) return
    await navigator.clipboard.writeText(prompt).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="modal-scrim" onPointerDown={onClose}>
      <div className="modal" role="dialog" aria-label="Invite an agent" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="modal-head">
          <AgentAvatar size={44} />
          <div>
            <h2>Invite an agent</h2>
            <p>
              The invite is tied to <b>this tab</b>. It works only while you have the board open, and pauses when you close it.
              Once it's in, <b>@mention</b> the agent in any comment to ask it something.
            </p>
          </div>
        </div>

        {!prompt ? (
          <form
            className="invite-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (name) create()
            }}
          >
            <div className="seat-label">Who should it be?</div>
            <div className="seats" role="radiogroup" aria-label="Persona">
              {SEATS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={seat !== 'custom' && seat.id === p.id}
                  className={`seat${seat !== 'custom' && seat.id === p.id ? ' on' : ''}`}
                  onClick={() => setSeat(p)}
                >
                  <span className="seat-head">
                    <span className="seat-emoji" aria-hidden>
                      {p.emoji}
                    </span>
                    <b>{p.name}</b>
                  </span>
                  <span className="seat-does">{p.personality}</span>
                </button>
              ))}
              <div
                role="radio"
                tabIndex={0}
                aria-checked={seat === 'custom'}
                className={`seat custom${seat === 'custom' ? ' on' : ''}`}
                onClick={() => setSeat('custom')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSeat('custom')
                }}
              >
                <span className="seat-head">
                  <span className="seat-emoji" aria-hidden>
                    ✦
                  </span>
                  <b>Custom…</b>
                </span>
                {seat === 'custom' ? (
                  <input
                    autoFocus
                    className="seat-custom-input"
                    value={custom}
                    maxLength={40}
                    placeholder="Name the persona, e.g. Facilitator"
                    onChange={(e) => setCustom(e.target.value)}
                  />
                ) : (
                  <span className="seat-does">Your own persona. Describe its personality below.</span>
                )}
              </div>
            </div>
            {name && (
              <div className="seat-name-preview">
                Joins the board as <b>@{name}</b>
              </div>
            )}
            <label>
              More context for this role <span className="optional">(optional)</span>
              <textarea
                className="invite-context"
                rows={3}
                maxLength={2000}
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={
                  seat === 'custom'
                    ? 'Describe its personality, e.g. Keeps the session moving, summarizes often, and stays neutral.'
                    : "e.g. We're redesigning how our team hands off work. Keep comments short and cite what's on the board."
                }
              />
            </label>
            {error && <div className="invite-error">{error}</div>}
            <button className="btn" type="submit" disabled={!name || busy}>
              Create invite ✦
            </button>
          </form>
        ) : (
          <div className="invite-result">
            <p className="invite-step">
              Paste this into your agent (Claude, a script, anything that can make HTTP calls). It contains a secret token, so share it only with the agent.
            </p>
            <pre className="invite-prompt">{prompt}</pre>
            <div className="invite-actions">
              <button className="btn" onClick={copy}>
                {copied ? 'Copied ✓' : 'Copy invite'}
              </button>
              <button className="btn ghost" onClick={onClose}>
                Done
              </button>
            </div>
            {window.location.hostname === 'localhost' && (
              <p className="invite-note">Heads up: this board is on localhost, so only agents running on this computer can reach it.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
