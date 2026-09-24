import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AgentPresence } from '../../../shared/schema'
import { inviteToken, resumePrompt } from './InviteDialog'
import { seatByName } from '../lib/personas'
import { agentActivity } from '../lib/agentState'
import { AgentChat } from './AgentChat'
import { InviteDialog } from './InviteDialog'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import { AgentAvatar, Portrait } from '../lib/Portrait'
import { useBoard } from '../store/board'

/** Messages that prompted this agent and haven't been answered yet, oldest first. */
function useWaitingFor(inviteId: string) {
  const prompts = useBoard((s) => s.prompts)
  const comments = useBoard((s) => s.comments)
  const replies = useBoard((s) => s.replies)
  const reports = useBoard((s) => s.reports)
  return prompts
    .filter((p) => p.inviteId === inviteId && p.status !== 'answered')
    .map((p) => {
      if (p.commentId.startsWith('report:')) {
        const r = reports.find((x) => x.id === p.commentId.slice('report:'.length))
        return { author: r?.requestedBy ?? 'Someone', body: 'Please write a report of the whole board.', commentId: p.commentId, at: p.at }
      }
      const m = p.replyId ? replies[p.replyId] : comments[p.commentId]
      return m ? { author: m.authorName, body: m.body, commentId: p.commentId, at: p.at } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.at - b.at)
}

/**
 * An invited agent. Listening → awake card. Not listening → it dozes (closed eyes, drifting Zzz),
 * and hovering shows a wake-up message the host can copy and paste back into the agent.
 */
function AgentCard({
  agent: a,
  index,
  hostName,
  onRevoke,
  chatOpen,
  onToggleChat,
}: {
  agent: AgentPresence
  index: number
  hostName: string
  onRevoke: () => void
  chatOpen: boolean
  onToggleChat: () => void
}) {
  const me = useBoard((s) => s.me)!
  const boardId = useBoard((s) => s.board!.id)
  const sid = useBoard((s) => s.sid)
  const waiting = useWaitingFor(a.id)
  const [copied, setCopied] = useState(false)
  const mine = a.hostPid === me.id
  const token = mine ? inviteToken(a.id) : null
  const prompts = useBoard((s) => s.prompts)
  const activity = agentActivity(a, prompts)
  const paused = activity === 'paused'
  const asleep = activity === 'asleep'
  const working = activity === 'working'

  const togglePause = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const next = !paused
    // Optimistic: flip the card now; the next poll confirms.
    useBoard.setState({
      agents: useBoard.getState().agents.map((x) => (x.id === a.id ? { ...x, paused: next, pausedBy: next ? me.name : null } : x)),
    })
    await api.pauseAgent(boardId, a.id, sid, next).catch(() => {})
  }
  const message = token
    ? resumePrompt({ origin: window.location.origin, boardId, agentName: a.agentName, hostName: me.name, token, waiting, persona: a.persona })
    : null

  const copy = async () => {
    if (!message) return
    await navigator.clipboard.writeText(message).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  return (
    <div
      className={`person agent${asleep ? ' asleep' : ''}${paused ? ' paused' : ''}${working ? ' working' : ''}${chatOpen ? ' chatting' : ''}`}
      onClick={onToggleChat}
      style={{ ['--i' as string]: index }}
      title={
        paused
          ? `${a.agentName} is paused by ${a.pausedBy ?? 'someone'}. Messages wait until it's resumed.`
          : asleep
            ? undefined
            : working
              ? `${a.agentName} is working. It'll pick up new @mentions when it checks in next.`
              : `${a.agentName}${a.persona ? ` · ${a.persona}` : ''} is listening. Click to message it, or @mention it in a comment`
      }
      tabIndex={0}
      aria-label={asleep ? `${a.agentName} is asleep. Click to message it` : `Message ${a.agentName}`}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onToggleChat()
        }
      }}
      // Leaving with the mouse closes the popover even if Copy still has focus.
      onPointerLeave={(e) => {
        const el = e.currentTarget
        if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      }}
    >
      <span className={`live-dot${activity === 'listening' || working ? ' on' : ''}${working ? ' busy' : ''}`} />
      <span className="agent-avatar-wrap">
        <AgentAvatar size={44} sleeping={asleep || paused} />
        {paused && <span className="paused-badge" aria-hidden>❚❚</span>}
        {seatByName(a.agentName) && !paused && (
          <span className="seat-badge" aria-hidden>
            {seatByName(a.agentName)!.emoji}
          </span>
        )}
        {asleep && (
          <span className="zzz" aria-hidden>
            <i>z</i>
            <i>z</i>
            <i>Z</i>
          </span>
        )}
      </span>
      <span className="person-name">{a.agentName}</span>
      {a.persona && a.persona !== a.agentName && !a.agentName.startsWith(a.persona + ' ') && <span className="agent-persona">{a.persona}</span>}
      <span className="agent-state">
        {paused
          ? `paused${waiting.length ? ` · ${waiting.length} waiting` : ''}`
          : asleep
            ? waiting.length
              ? `asleep · ${waiting.length} waiting`
              : 'asleep'
            : working
              ? 'working…'
              : 'listening'}
      </span>
      {waiting.length > 0 && (asleep || paused) && <span className="waiting-badge">{waiting.length}</span>}
      <button
        className={`agent-play${paused ? ' on' : ''}`}
        onClick={togglePause}
        aria-label={paused ? `Resume ${a.agentName}` : `Pause ${a.agentName}`}
        title={paused ? `Resume ${a.agentName}` : `Pause ${a.agentName}: it stops acting and waits`}
      >
        {paused ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 1l7 4-7 4z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="1.5" y="1" width="2.5" height="8" rx="0.8" fill="currentColor" />
            <rect x="6" y="1" width="2.5" height="8" rx="0.8" fill="currentColor" />
          </svg>
        )}
      </button>

      {(
        <button
          className="revoke"
          onClick={(e) => {
            e.stopPropagation()
            onRevoke()
          }}
          aria-label={`Remove ${a.agentName}`}
          title={`Remove ${a.agentName} from this board`}
        >
          ×
        </button>
      )}

      {chatOpen && (
        <AgentChat agent={a} wakeMessage={message} onCopyWake={copy} wakeCopied={copied} onClose={onToggleChat} />
      )}

      {asleep && !chatOpen && (
        <div className="wake-pop" role="dialog" aria-label={`Wake ${a.agentName}`}>
          <div className="wake-head">
            <span className="wake-title">💤 {a.agentName} is asleep</span>
            {a.persona && a.persona !== a.agentName && !a.agentName.startsWith(a.persona + ' ') && <span className="wake-sub">Persona: {a.persona}</span>}
            <span className="wake-sub">
              {waiting.length
                ? `${waiting.length} ${waiting.length === 1 ? 'message is' : 'messages are'} waiting for it.`
                : "It's not listening for @mentions right now."}
            </span>
          </div>
          {waiting.length > 0 && (
            <ul className="wake-list">
              {waiting.slice(-3).map((w, j) => (
                <li key={j}>
                  <b>{w.author}:</b> {w.body.length > 90 ? w.body.slice(0, 87) + '…' : w.body}
                </li>
              ))}
            </ul>
          )}
          {message ? (
            <>
              <div className="wake-label">Send this to {a.agentName} to wake it up:</div>
              <pre className="wake-message">{message}</pre>
              <button className="btn small wake-copy" onClick={copy}>
                {copied ? 'Copied ✓ Now paste it to the agent' : 'Copy wake-up message'}
              </button>
            </>
          ) : (
            <div className="wake-note">
              {mine
                ? 'This invite was made before wake-up messages existed. Invite it again to get one.'
                : `Only ${hostName} can wake it; it's their invite. Messages will wait in its inbox.`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}


/** Bottom-right: everyone on this wall right now (people with the board open, and their invited agents), you last. */
export function PresenceCorner() {
  const me = useBoard((s) => s.me)
  const boardId = useBoard((s) => s.board?.id)
  const sid = useBoard((s) => s.sid)
  const presence = useBoard((s) => s.presence)
  const agents = useBoard((s) => s.agents)
  const navigate = useNavigate()
  const [chatFor, setChatFor] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  if (!me || !boardId) return null
  const others = presence.filter((p) => p.id !== me.id)
  const hostName = (pid: string) => (pid === me.id ? 'you' : (presence.find((p) => p.id === pid)?.name ?? 'someone'))

  const revoke = async (inviteId: string) => {
    useBoard.setState({ agents: useBoard.getState().agents.filter((a) => a.id !== inviteId) })
    await api.revokeInvite(boardId, inviteId, sid).catch(() => {})
  }

  return (
    <div className="presence" onPointerDown={(e) => e.stopPropagation()}>
      <button className="person invite-card" onClick={() => setInviting(true)} title="Invite an AI agent to this board">
        <span className="invite-plus" aria-hidden>
          +
        </span>
        <span className="person-name">Invite agent</span>
      </button>
      {inviting && createPortal(<InviteDialog onClose={() => setInviting(false)} />, document.body)}
      {agents.map((a, i) => (
        <AgentCard
          key={a.id}
          agent={a}
          index={i}
          hostName={hostName(a.hostPid)}
          onRevoke={() => revoke(a.id)}
          chatOpen={chatFor === a.id}
          onToggleChat={() => setChatFor((c) => (c === a.id ? null : a.id))}
        />
      ))}
      {others.map((p, i) => (
        <div
          key={p.id}
          className={`person other${p.away ? ' away' : ''}`}
          style={{ ['--i' as string]: i }}
          title={p.away ? `${p.name} has the board open in the background` : `${p.name} is here`}
        >
          <Portrait sketch={p.sketch} color={p.color} size={52} />
          <span className="person-name">{p.name}</span>
          {p.away && <span className="away-tag">away</span>}
        </div>
      ))}
      <button className="person me" onClick={() => navigate(`/?edit=1&next=${boardId}`)} title="Edit your name & portrait">
        <Portrait sketch={me.sketch} color={me.color} size={64} />
        <span className="person-name">
          {me.name} <em>(you)</em>
        </span>
      </button>
    </div>
  )
}
