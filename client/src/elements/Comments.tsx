import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { Comment, Element } from '../../../shared/schema'
import { uid } from '../../../shared/ids'
import { actions, useBoard } from '../store/board'
import { Avatar } from './Avatar'
import { MentionText } from '../panels/ThreadPanel'
import { MentionTextarea } from '../lib/MentionTextarea'

/** Where a comment's tail points, in world coords. */
export function anchorPoint(c: Pick<Comment, 'anchor'>, elements: Record<string, Element>) {
  if (c.anchor.type === 'point') return { x: c.anchor.x, y: c.anchor.y }
  const el = elements[c.anchor.elementId]
  if (!el) return null
  return { x: el.x + c.anchor.dx, y: el.y + c.anchor.dy }
}

/** A curved wedge from a base point (just inside the bubble's edge) to the anchor point. */
function tailPath(bx: number, by: number, ax: number, ay: number, width = 10) {
  const dx = ax - bx
  const dy = ay - by
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * width
  const ny = (dx / len) * width
  // Bend the tail a little so it feels drawn rather than ruled.
  const cx = bx + dx * 0.55 + nx * 0.35
  const cy = by + dy * 0.55 + ny * 0.35
  return `M${bx + nx} ${by + ny} Q${cx} ${cy} ${ax} ${ay} Q${cx - nx * 0.5} ${cy - ny * 0.5} ${bx - nx} ${by - ny} Z`
}

/**
 * Where the tail leaves the bubble: the point on the bubble's edge closest to the anchor,
 * nudged a few px inside so the bubble covers the tail's base. null = anchor is under the bubble.
 */
function tailBase(box: { x: number; y: number; w: number; h: number }, ax: number, ay: number) {
  const r = 18 // stay clear of the rounded corners
  const px = Math.min(Math.max(ax, box.x + r), box.x + box.w - r)
  const py = Math.min(Math.max(ay, box.y + r), box.y + box.h - r)
  const inside = ax > box.x && ax < box.x + box.w && ay > box.y && ay < box.y + box.h
  if (inside) return null
  // Snap to the nearest edge, then step 8px back inside.
  const dl = Math.abs(ax - box.x)
  const dr = Math.abs(ax - (box.x + box.w))
  const dt = Math.abs(ay - box.y)
  const db = Math.abs(ay - (box.y + box.h))
  const outX = ax < box.x || ax > box.x + box.w
  const outY = ay < box.y || ay > box.y + box.h
  const INSET = 8
  if (outX && (!outY || Math.min(dl, dr) >= Math.min(dt, db))) {
    return ax < box.x ? { x: box.x + INSET, y: py } : { x: box.x + box.w - INSET, y: py }
  }
  return ay < box.y ? { x: px, y: box.y + INSET } : { x: px, y: box.y + box.h - INSET }
}

/** Track an element's size (in world units, since it lives inside the scaled world layer). */
function useSize<T extends HTMLElement>(remountKey: unknown = null) {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 220, h: 64 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setSize((s) => (s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [remountKey])
  return [ref, size] as const
}

interface BubbleProps {
  c: Comment
  a: { x: number; y: number }
  replyCount: number
  open: boolean
  collapsed: boolean
  selected: boolean
}

const Bubble = memo(function Bubble({ c, a, replyCount, open, collapsed, selected, agentNames }: BubbleProps & { agentNames: string[] }) {
  const bx = a.x + c.bubbleDx
  const by = a.y + c.bubbleDy
  const [ref, size] = useSize<HTMLDivElement>(collapsed)

  // Resolved threads vanish from the canvas (the header's "Resolved" toggle brings them back).
  if (collapsed) return null
  const base = tailBase({ x: bx, y: by, ...size }, a.x, a.y)

  return (
    <>
      <svg className="tail" style={{ overflow: 'visible' }}>
        {base && <path d={tailPath(base.x, base.y, a.x, a.y)} className={`tail-path${c.resolved ? ' resolved' : ''}`} />}
        <circle cx={a.x} cy={a.y} r={4} className="anchor-dot" />
      </svg>
      {/* Drag the dot to re-attach the comment somewhere else (another note, or a free spot). */}
      <span className="anchor-handle" data-anchor={c.id} style={{ transform: `translate(${a.x}px, ${a.y}px)` }} title="Drag to move what this comment points at" />
      <div
        ref={ref}
        className={`bubble${open ? ' open' : ''}${c.resolved ? ' resolved' : ''}${selected ? ' selected' : ''}${c.authorType === 'agent' ? ' by-agent' : ''}`}
        data-comment={c.id}
        style={{ transform: `translate(${bx}px, ${by}px)` }}
      >
        <Avatar authorId={c.authorId} authorName={c.authorName} authorType={c.authorType} size={26} />
        <div className="bubble-text">
          <div className="bubble-author">
            {c.authorName}
            {c.authorType === 'agent' && <span className="bot-pill">agent</span>}
          </div>
          <div className="bubble-body">
            <MentionText body={c.body} names={agentNames} />
          </div>
        </div>
        {replyCount > 0 && <span className="reply-count">{replyCount}</span>}
      </div>
    </>
  )
})

function DraftBubble({ anchor }: { anchor: Comment['anchor'] }) {
  const elements = useBoard((s) => s.elements)
  const me = useBoard((s) => s.me)
  const agents = useBoard((s) => s.agents)
  const [body, setBody] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const [formRef, draftSize] = useSize<HTMLFormElement>()
  const a = anchorPoint({ anchor }, elements)
  if (!a || !me) return null
  const bx = a.x + 36
  const by = a.y - 64
  const base = tailBase({ x: bx, y: by, ...draftSize }, a.x, a.y)

  const submit = () => {
    const text = body.trim()
    if (!text) return
    const c: Comment = {
      id: uid('c_'),
      anchor,
      bubbleDx: 36,
      bubbleDy: -64,
      body: text,
      resolved: false,
      dmInviteId: null,
      authorId: me.id,
      authorName: me.name,
      authorType: 'human',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 0,
      deleted: false,
    }
    actions.upsertComment(c)
    actions.markFresh(c.id)
    useBoard.setState({ draftComment: null })
    if (!useBoard.getState().toolLocked) actions.setTool('select')
  }

  return (
    <>
      <svg className="tail" style={{ overflow: 'visible' }}>
        {base && <path d={tailPath(base.x, base.y, a.x, a.y)} className="tail-path" />}
        <circle cx={a.x} cy={a.y} r={4} className="anchor-dot" />
      </svg>
      <form
        ref={formRef}
        className="bubble draft"
        style={{ transform: `translate(${bx}px, ${by}px)` }}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Avatar authorId={me.id} authorName={me.name} authorType="human" size={26} />
        <MentionTextarea
          ref={ref}
          counterZoom
          autoFocus
          rows={2}
          value={body}
          placeholder={agents.length ? 'Say something… type @ to ask an agent' : 'Say something nice…'}
          onChange={setBody}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') useBoard.setState({ draftComment: null })
          }}
        />
        <button className="send" type="submit" disabled={!body.trim()} aria-label="Post comment">
          ↑
        </button>
      </form>
    </>
  )
}

export function CommentLayer() {
  const comments = useBoard((s) => s.comments)
  const replies = useBoard((s) => s.replies)
  const elements = useBoard((s) => s.elements)
  const openId = useBoard((s) => s.openThreadId)
  const showResolved = useBoard((s) => s.showResolved)
  const draft = useBoard((s) => s.draftComment)
  const fresh = useBoard((s) => s.freshIds)
  const glideIds = useBoard((s) => s.glideIds)
  const commentSelection = useBoard((s) => s.commentSelection)
  const agentNamesKey = useBoard((s) => s.agents.map((a) => a.agentName).join('\u0000'))
  const agentNames = agentNamesKey ? agentNamesKey.split('\u0000') : []

  const counts: Record<string, number> = {}
  for (const r of Object.values(replies)) counts[r.commentId] = (counts[r.commentId] ?? 0) + 1

  return (
    <div className="comment-layer">
      {Object.values(comments)
        .filter((c) => !c.dmInviteId) // direct conversations live in the agent's chat bubble, not on the canvas
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((c) => {
          const a = anchorPoint(c, elements)
          if (!a) return null
          return (
            <div
              key={c.id}
              className={[fresh.has(c.id) && 'fresh-comment', c.anchor.type === 'element' && glideIds.has(c.anchor.elementId) && 'glide-comment'].filter(Boolean).join(' ') || undefined}
            >
              <Bubble c={c} a={a} replyCount={counts[c.id] ?? 0} open={openId === c.id} collapsed={c.resolved && !showResolved && openId !== c.id}
                selected={commentSelection.includes(c.id)}
                agentNames={agentNames}
              />
            </div>
          )
        })}
      {draft && <DraftBubble anchor={draft.anchor} />}
    </div>
  )
}
