import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { NOTE_COLORS, SECTION_COLORS, type Element } from '../../../shared/schema'
import { actions, useBoard } from '../store/board'
import { ShapeGraphic } from './Shape'
import { usePerson } from '../lib/people'
import { isLinear, noteFontSize } from './geometry'

/** Offsets that push layers down without losing order within them: sections < arrows/lines < everything else. */
const CONNECTOR_LAYER = 1_000_000
const SECTION_LAYER = 2_000_000

interface Props {
  el: Element
  editing: boolean
  fresh: boolean
  /** Moved by someone else: animate into place. */
  glide?: boolean
}

/** Editable text that commits on blur; Escape also commits. */
function EditableText({ el, className, style, fit }: { el: Element; className: string; style?: React.CSSProperties; fit?: (text: string) => number }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    node.innerText = el.text
    node.focus()
    const range = document.createRange()
    range.selectNodeContents(node)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    // Only on entering edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = () => {
    const text = (ref.current?.innerText ?? '').replace(/\n$/, '')
    const current = useBoard.getState().elements[el.id]
    actions.edit(null)
    if (!current) return
    if (el.kind === 'text' && !text.trim()) {
      actions.deleteElements([el.id])
      return
    }
    if (text !== current.text) {
      actions.checkpoint()
      const patch: Partial<Element> = { text }
      if (el.kind === 'text' && ref.current) {
        patch.w = Math.max(ref.current.offsetWidth, 20)
        patch.h = Math.max(ref.current.offsetHeight, 20)
      }
      actions.patchElements([el.id], () => patch)
    }
  }

  return (
    <div
      ref={ref}
      className={`${className} editing`}
      style={style}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={commit}
      onInput={() => {
        // Sticky notes shrink their text live so it never spills out while typing.
        if (fit && ref.current) ref.current.style.fontSize = `${fit(ref.current.innerText)}px`
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
    />
  )
}

/** A thin strip along the top of a note in its author's portrait color. */
function AuthorStrip({ el }: { el: Element }) {
  const person = usePerson(el.authorType === 'human' ? el.authorId : null)
  const color = el.authorType === 'agent' ? 'var(--ink)' : person?.color
  if (!color) return null
  return <span className="note-strip" style={{ background: color }} title={`by ${el.authorName}`} />
}

function AgentTag({ el }: { el: Element }) {
  if (el.authorType !== 'agent') return null
  return (
    <span className="agent-tag" title={`Added by agent ${el.authorName}`}>
      <span aria-hidden>🤖</span> {el.authorName}
    </span>
  )
}

export const ElementView = memo(function ElementView({ el, editing, fresh, glide }: Props) {
  const textRef = useRef<HTMLDivElement>(null)

  // Keep text boxes' stored size in sync with what's rendered (fonts can load late).
  useEffect(() => {
    if (el.kind !== 'text' || editing || !textRef.current) return
    const node = textRef.current
    const ro = new ResizeObserver(() => {
      const w = Math.round(node.offsetWidth)
      const h = Math.round(node.offsetHeight)
      const cur = useBoard.getState().elements[el.id]
      if (cur && (Math.abs(cur.w - w) > 1 || Math.abs(cur.h - h) > 1)) actions.patchElements([el.id], () => ({ w, h }))
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [el.kind, el.id, editing])

  const base: React.CSSProperties = {
    transform: `translate(${el.x}px, ${el.y}px) rotate(${el.rotation}deg)`,
    width: el.kind === 'text' ? undefined : el.w,
    height: el.kind === 'text' ? undefined : el.h,
    // Connectors (arrows/lines) live on a layer beneath every card, shape and text; order among them still follows z.
    zIndex:
      el.role === 'section'
        ? el.z - SECTION_LAYER
        : el.kind === 'shape' && (el.shape === 'arrow' || el.shape === 'line')
          ? el.z - CONNECTOR_LAYER
          : el.z,
  }
  const agent = el.authorType === 'agent'
  const g = glide ? ' glide' : ''

  if (el.kind === 'note') {
    const bg = NOTE_COLORS[(el.style.color ?? 'yellow') as keyof typeof NOTE_COLORS] ?? NOTE_COLORS.yellow
    const fs = noteFontSize(el.text, el.w, el.h)
    return (
      <div className={`el note${fresh ? ' fresh' : ''}${agent ? ' by-agent' : ''}${g}`} data-id={el.id} style={{ ...base, ['--note' as string]: bg }}>
        <div className="note-body">
          <AuthorStrip el={el} />
          {editing ? (
            <EditableText el={el} className="note-text" style={{ fontSize: fs }} fit={(t) => noteFontSize(t, el.w, el.h)} />
          ) : (
            <div className="note-text" style={{ fontSize: fs }}>
              {el.text || <span className="placeholder">double-click to write</span>}
            </div>
          )}
        </div>
        <AgentTag el={el} />
      </div>
    )
  }

  if (el.kind === 'text') {
    const fs = el.style.fontSize ?? 30
    return (
      <div className={`el text${fresh ? ' fresh' : ''}${agent ? ' by-agent' : ''}${g}`} data-id={el.id} style={{ ...base, color: el.style.stroke }}>
        {editing ? (
          <EditableText el={el} className="text-body" style={{ fontSize: fs }} />
        ) : (
          <div ref={textRef} className="text-body" style={{ fontSize: fs }}>
            {el.text}
          </div>
        )}
        <AgentTag el={el} />
      </div>
    )
  }

  if (el.role === 'section') {
    const tint = SECTION_COLORS[(el.style.color ?? 'gray') as keyof typeof SECTION_COLORS] ?? SECTION_COLORS.gray
    return (
      <div className={`el section${fresh ? ' fresh-section' : ''}${agent ? ' by-agent' : ''}${g}`} data-id={el.id} style={{ ...base, ['--tint' as string]: tint }}>
        <div className="section-frame" />
        {editing ? (
          <EditableText el={el} className="section-title" />
        ) : (
          <div className="section-title" data-grab="">
            {el.text || <span className="placeholder">Untitled topic</span>}
          </div>
        )}
      </div>
    )
  }

  const linear = isLinear(el)
  return (
    <div className={`el shape shape-${el.shape}${linear ? ' linear' : ''}${fresh ? ' fresh' : ''}${g}`} data-id={el.id} style={base}>
      <ShapeGraphic el={el} />
      {linear && el.text && el.points.length > 1 && (
        <div
          className="arrow-label"
          style={{
            left: (el.points[0][0] + el.points[el.points.length - 1][0]) / 2,
            top: (el.points[0][1] + el.points[el.points.length - 1][1]) / 2,
            color: el.style.stroke,
          }}
        >
          {el.text}
        </div>
      )}
      {!linear &&
        (editing ? (
          <EditableText el={el} className="shape-label" style={{ color: el.style.stroke }} />
        ) : (
          el.text && (
            <div className="shape-label" style={{ color: el.style.stroke }}>
              {el.text}
            </div>
          )
        ))}
      {/* Tags on thin arrows are more noise than signal. */}
      {!linear && <AgentTag el={el} />}
    </div>
  )
})
