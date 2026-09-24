import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { AgentAvatar } from './Portrait'
import { useBoard } from '../store/board'

interface Props {
  value: string
  onChange: (v: string) => void
  /** Called for keys the mention menu didn't consume (e.g. Enter to send). */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  autoFocus?: boolean
  rows?: number
  className?: string
  /** Inside the zoomed canvas: keep the menu at screen size regardless of zoom. */
  counterZoom?: boolean
}

interface Option {
  key: string
  insert: string
  label: string
  hint: string
  sleeping?: boolean
  everyone?: boolean
}

/** The "@query" right before the caret, if any. */
function activeQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null
}

/**
 * A textarea that suggests agents when you type "@". Arrow keys to move,
 * Enter/Tab to pick, Esc to dismiss. Inserts the full name ("@Synthesis Bot ").
 */
export const MentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function MentionTextarea(
  { value, onChange, onKeyDown, placeholder, autoFocus, rows = 2, className, counterZoom },
  outerRef,
) {
  const agents = useBoard((s) => s.agents)
  const zoom = useBoard((s) => s.camera.z)
  const ref = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(outerRef, () => ref.current!)
  const [q, setQ] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)

  const query = q?.query.toLowerCase() ?? ''
  const options: Option[] = q
    ? [
        ...agents
          .filter((a) => a.agentName.toLowerCase().replace(/\s+/g, '').includes(query) || a.agentName.toLowerCase().startsWith(query))
          .map((a) => ({
            key: a.id,
            insert: `@${a.agentName} `,
            label: a.agentName,
            hint: a.paused ? 'paused · will get it when resumed' : a.listening ? 'listening' : 'asleep · will get it later',
            sleeping: !a.listening || a.paused,
          })),
        ...(agents.length > 1 && 'agents'.startsWith(query)
          ? [{ key: '*', insert: '@agents ', label: 'agents', hint: `all ${agents.length} agents`, everyone: true }]
          : []),
      ]
    : []
  const open = q !== null && dismissedAt !== q.start

  const sync = (text: string, caret: number) => {
    const next = activeQuery(text, caret)
    setQ(next)
    if (!next || next.start !== q?.start) setActive(0)
    if (!next) setDismissedAt(null)
  }

  const pick = (o: Option) => {
    if (!q || !ref.current) return
    const caret = ref.current.selectionStart
    const text = value.slice(0, q.start) + o.insert + value.slice(caret)
    onChange(text)
    setQ(null)
    const pos = q.start + o.insert.length
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="mention-wrap">
      {open && (
        <div
          className="mention-menu"
          role="listbox"
          style={counterZoom ? { scale: String(1 / zoom), transformOrigin: 'bottom left' } : undefined}
          onPointerDown={(e) => e.preventDefault()}
        >
          {options.length ? (
            options.map((o, i) => (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`mention-option${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                {o.everyone ? <span className="mention-all">∗</span> : <AgentAvatar size={22} sleeping={o.sleeping} />}
                <span className="mention-name">@{o.label}</span>
                <span className="mention-hint">{o.hint}</span>
              </button>
            ))
          ) : (
            <div className="mention-empty">
              {agents.length ? `No agent matches “${q!.query}”` : 'No agents on this board yet. Invite one from the top-right menu.'}
            </div>
          )}
        </div>
      )}
      <textarea
        ref={ref}
        className={className}
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          sync(e.target.value, e.target.selectionStart)
        }}
        onSelect={(e) => sync(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setQ(null)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (open && options.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(options[Math.min(active, options.length - 1)])
              return
            }
          }
          if (open && e.key === 'Escape') {
            e.preventDefault()
            setDismissedAt(q!.start)
            return
          }
          onKeyDown?.(e)
        }}
      />
    </div>
  )
})
