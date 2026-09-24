import { useEffect, useRef, useState } from 'react'
import type { PromptStatus, Reply } from '../../../shared/schema'
import { uid } from '../../../shared/ids'
import { actions, useBoard } from '../store/board'
import { Avatar } from '../elements/Avatar'
import { MentionTextarea } from '../lib/MentionTextarea'
import { agentActivity } from '../lib/agentState'

const timeAgo = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const STATUS_LABEL: Record<PromptStatus['status'], string> = { queued: 'waiting', seen: 'reading…', answered: 'replied' }

/** Highlight @mentions of agents (and @agents) in a message body. */
export function MentionText({ body, names }: { body: string; names: string[] }) {
  const alts = [...names, 'agents', 'all']
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(@(?:${alts.join('|')}))(?![\\w])`, 'gi')
  const parts = body.split(re)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className="mention">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  )
}

function Message({ authorId, authorName, authorType, createdAt, body, onDelete, prompts, agentNames }: {
  authorId: string | null
  authorName: string
  authorType: 'human' | 'agent'
  createdAt: number
  body: string
  onDelete?: () => void
  prompts: PromptStatus[]
  agentNames: string[]
}) {
  return (
    <div className={`msg${authorType === 'agent' ? ' by-agent' : ''}`}>
      <Avatar authorId={authorId} authorName={authorName} authorType={authorType} size={34} />
      <div className="msg-main">
        <div className="msg-meta">
          <b>{authorName}</b>
          {authorType === 'agent' && <span className="bot-pill">agent</span>}
          <span>{timeAgo(createdAt)}</span>
          {onDelete && (
            <button className="msg-delete" onClick={onDelete} title="Delete">
              ×
            </button>
          )}
        </div>
        <div className="msg-body">
          <MentionText body={body} names={agentNames} />
        </div>
        {prompts.length > 0 && (
          <div className="msg-prompts">
            {prompts.map((p) => (
              <span key={p.inviteId} className={`prompt-chip ${p.status}`} title={`Sent to ${p.agentName}`}>
                → 🤖 {p.agentName} · {STATUS_LABEL[p.status]}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function ThreadPanel() {
  const id = useBoard((s) => s.openThreadId)
  const comment = useBoard((s) => (id ? s.comments[id] : undefined))
  const allReplies = useBoard((s) => s.replies)
  const elements = useBoard((s) => s.elements)
  const me = useBoard((s) => s.me)
  const agents = useBoard((s) => s.agents)
  const allPrompts = useBoard((s) => s.prompts)
  const [body, setBody] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const agentNames = [...new Set([...agents.map((a) => a.agentName), ...allPrompts.map((p) => p.agentName)])]

  const replies = Object.values(allReplies)
    .filter((r) => r.commentId === id)
    .sort((a, b) => a.createdAt - b.createdAt)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [replies.length, id])

  useEffect(() => setBody(''), [id])

  if (!comment || !me) return null

  const threadPrompts = allPrompts.filter((p) => p.commentId === comment.id)
  const promptsFor = (replyId: string) => threadPrompts.filter((p) => p.replyId === replyId)
  // One indicator per agent: reading beats waiting.
  const pendingByAgent = new Map<string, PromptStatus>()
  for (const p of threadPrompts) {
    if (p.status === 'answered') continue
    const cur = pendingByAgent.get(p.agentName)
    if (!cur || (p.status === 'seen' && cur.status === 'queued')) pendingByAgent.set(p.agentName, p)
  }
  const pausedNames = new Set(agents.filter((a) => a.paused).map((a) => a.agentName))
  const listeningNames = new Set(agents.filter((a) => a.listening && !a.paused).map((a) => a.agentName))
  const workingNames = new Set(agents.filter((a) => agentActivity(a, allPrompts) === 'working').map((a) => a.agentName))
  const liveAgentNames = new Set(agents.map((a) => a.agentName))

  const mention = (name: string) => {
    const tag = `@${name} `
    setBody((b) => (b.includes(`@${name}`) ? b : b && !b.endsWith(' ') ? `${b} ${tag}` : `${b}${tag}`))
    inputRef.current?.focus()
  }

  const target = comment.anchor.type === 'element' ? elements[comment.anchor.elementId] : null
  const targetLabel = target
    ? `${target.kind === 'shape' ? target.shape : target.kind}${target.text ? `: “${target.text.slice(0, 40)}${target.text.length > 40 ? '…' : ''}”` : ''}`
    : 'a spot on the wall'

  const send = () => {
    const text = body.trim()
    if (!text) return
    const r: Reply = {
      id: uid('r_'),
      commentId: comment.id,
      body: text,
      authorId: me.id,
      authorName: me.name,
      authorType: 'human',
      createdAt: Date.now(),
      version: 0,
      deleted: false,
    }
    actions.addReply(r)
    setBody('')
  }

  return (
    <aside className="thread" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <header>
        <div>
          <div className="thread-title">Thread</div>
          <div className="thread-target">on {targetLabel}</div>
        </div>
        <button
          className={`btn small ${comment.resolved ? 'ghost' : ''}`}
          onClick={() => {
            const resolving = !comment.resolved
            actions.upsertComment({ ...comment, resolved: resolving })
            // Resolving makes the thread disappear, so close it too.
            if (resolving && !useBoard.getState().showResolved) {
              actions.openThread(null)
              actions.selectComments([])
            }
          }}
        >
          {comment.resolved ? 'Reopen' : '✓ Resolve'}
        </button>
        {comment.resolved && (
          <button
            className="icon-btn thread-delete"
            title="Delete this resolved thread"
            aria-label="Delete thread"
            onClick={() => {
              actions.checkpoint()
              actions.deleteComment(comment.id)
            }}
          >
            🗑
          </button>
        )}
        <button className="icon-btn" onClick={() => actions.openThread(null)} aria-label="Close thread">
          ✕
        </button>
      </header>

      <div className="thread-list" ref={listRef}>
        <Message
          {...comment}
          prompts={promptsFor('')}
          agentNames={agentNames}
          onDelete={
            comment.authorId === me.id
              ? () => {
                  if (confirm('Delete this whole thread?')) actions.deleteComment(comment.id)
                }
              : undefined
          }
        />
        {replies.map((r) => (
          <Message
            key={r.id}
            {...r}
            prompts={promptsFor(r.id)}
            agentNames={agentNames}
            onDelete={r.authorId === me.id ? () => actions.deleteReply(r.id) : undefined}
          />
        ))}
        {[...pendingByAgent.values()].map((p) => (
          <div key={p.inviteId} className={`thinking ${p.status}${(p.status === 'queued' && !listeningNames.has(p.agentName) && !workingNames.has(p.agentName)) || pausedNames.has(p.agentName) ? ' stalled' : ''}`}>
            <span className="dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            {pausedNames.has(p.agentName)
              ? `${p.agentName} is paused. It'll get this when someone resumes it (▶ on its card).`
              : p.status === 'seen'
              ? `${p.agentName} is thinking…`
              : listeningNames.has(p.agentName)
                ? `Sending to ${p.agentName}…`
                : workingNames.has(p.agentName)
                  ? `${p.agentName} is busy with something else. It'll pick this up when it checks in next.`
                : liveAgentNames.has(p.agentName)
                  ? `${p.agentName} isn't listening right now. It'll get this when it checks in (click its card to wake it).`
                  : `${p.agentName} isn't connected right now`}
          </div>
        ))}
      </div>

      {agents.length > 0 && (
        <div className="ask-row">
          <span>Ask</span>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`ask-chip${a.listening ? '' : ' idle'}`}
              title={a.listening ? `Ask ${a.agentName}` : `${a.agentName} isn't listening right now; your message will wait for it`}
              onClick={() => mention(a.agentName)}
            >
              🤖 @{a.agentName}
            </button>
          ))}
        </div>
      )}
      <form
        className="thread-compose"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <MentionTextarea
          ref={inputRef}
          rows={2}
          value={body}
          placeholder={agents.length ? 'Reply… type @ to ask an agent' : 'Reply…'}
          onChange={setBody}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
            if (e.key === 'Escape') actions.openThread(null)
          }}
        />
        <button className="btn small" type="submit" disabled={!body.trim()}>
          Send
        </button>
      </form>
    </aside>
  )
}
