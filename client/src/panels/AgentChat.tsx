import { useEffect, useRef, useState } from 'react'
import type { AgentPresence, Comment, Reply } from '../../../shared/schema'
import { uid } from '../../../shared/ids'
import { actions, useBoard } from '../store/board'
import { agentActivity } from '../lib/agentState'
import { AgentAvatar } from '../lib/Portrait'
import { Avatar } from '../elements/Avatar'

const STATUS: Record<string, string> = { queued: 'sent', seen: 'reading…', answered: 'replied' }

/**
 * A direct conversation with one agent, opened by clicking its card. It's a comment
 * thread with `dmInviteId` set: it never shows on the canvas and only that agent hears it.
 */
export function AgentChat({
  agent: a,
  wakeMessage,
  onCopyWake,
  wakeCopied,
  onClose,
}: {
  agent: AgentPresence
  wakeMessage: string | null
  onCopyWake: () => void
  wakeCopied: boolean
  onClose: () => void
}) {
  const me = useBoard((s) => s.me)!
  const comments = useBoard((s) => s.comments)
  const replies = useBoard((s) => s.replies)
  const prompts = useBoard((s) => s.prompts)
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const activity = agentActivity(a, prompts)

  // My conversation with this agent (one per person per agent).
  const thread: Comment | undefined = Object.values(comments)
    .filter((c) => c.dmInviteId === a.id && c.authorId === me.id)
    .sort((x, y) => y.createdAt - x.createdAt)[0]
  const messages: Array<Comment | Reply> = thread
    ? [thread, ...Object.values(replies).filter((r) => r.commentId === thread.id).sort((x, y) => x.createdAt - y.createdAt)]
    : []
  const statusFor = (m: Comment | Reply) =>
    thread && prompts.find((p) => p.inviteId === a.id && p.commentId === thread.id && p.replyId === ('commentId' in m ? m.id : ''))?.status

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length])

  const send = () => {
    const body = text.trim()
    if (!body) return
    const now = Date.now()
    if (!thread) {
      actions.upsertComment({
        id: uid('c_'),
        anchor: { type: 'point', x: 0, y: 0 },
        bubbleDx: 0,
        bubbleDy: 0,
        body,
        resolved: false,
        dmInviteId: a.id,
        authorId: me.id,
        authorName: me.name,
        authorType: 'human',
        createdAt: now,
        updatedAt: now,
        version: 0,
        deleted: false,
      })
    } else {
      actions.addReply({
        id: uid('r_'),
        commentId: thread.id,
        body,
        authorId: me.id,
        authorName: me.name,
        authorType: 'human',
        createdAt: now,
        version: 0,
        deleted: false,
      })
    }
    setText('')
  }

  const pending = messages.length > 0 && messages[messages.length - 1].authorType === 'human'
  const thinking =
    pending &&
    (activity === 'paused'
      ? `${a.agentName} is paused. It'll answer when resumed.`
      : activity === 'asleep'
        ? `${a.agentName} is asleep. Wake it below and it'll answer.`
        : statusFor(messages[messages.length - 1]) === 'seen'
          ? `${a.agentName} is working on it…`
          : `${a.agentName} will pick this up in a moment…`)

  return (
    <div className="agent-chat" role="dialog" aria-label={`Chat with ${a.agentName}`} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="chat-head">
        <AgentAvatar size={28} sleeping={activity === 'asleep' || activity === 'paused'} />
        <div>
          <b>{a.agentName}</b>
          <span className={`chat-state ${activity}`}>{activity === 'working' ? 'working…' : activity}</span>
        </div>
        <button className="icon-btn" aria-label="Close chat" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask {a.agentName} anything about this board: <i>“group these into topics”</i>, <i>“clean up the duplicates”</i>, <i>“what are we missing?”</i>
          </div>
        )}
        {messages.map((m) => {
          const mine = m.authorType === 'human'
          const st = mine ? statusFor(m) : undefined
          return (
            <div key={m.id} className={`chat-msg ${mine ? 'me' : 'them'}`}>
              {!mine && <AgentAvatar size={22} />}
              <div className="chat-bubble">{m.body}</div>
              {mine && <Avatar authorId={m.authorId} authorName={m.authorName} authorType="human" size={22} />}
              {st && <span className="chat-status">{STATUS[st]}</span>}
            </div>
          )
        })}
        {thinking && (
          <div className="chat-thinking">
            <span className="dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            {thinking}
          </div>
        )}
      </div>

      {activity === 'asleep' && wakeMessage && (
        <button className="btn small ghost chat-wake" onClick={onCopyWake}>
          {wakeCopied ? 'Copied ✓ Paste it to the agent' : '💤 Copy wake-up message'}
        </button>
      )}

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          autoFocus
          rows={2}
          value={text}
          placeholder={`Message ${a.agentName}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
            if (e.key === 'Escape') onClose()
          }}
        />
        <button className="send" type="submit" disabled={!text.trim()} aria-label="Send">
          ↑
        </button>
      </form>
    </div>
  )
}
