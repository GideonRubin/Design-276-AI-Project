import { useEffect, useState } from 'react'
import { actions, useBoard, type Tool } from '../store/board'
import { NARROW, useMediaQuery } from '../lib/useMediaQuery'

const I = {
  select: <path d="M5 3l12 9-5.5 1L14 19l-2.5 1-2.5-6L5 17z" />,
  hand: <path d="M8 11V5.5a1.5 1.5 0 013 0V10m0-5.5a1.5 1.5 0 013 0V10m0-3.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-1a6 6 0 01-5-2.7L3.6 14a1.5 1.5 0 012.4-1.8L8 14" />,
  rect: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  topic: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3.5" strokeDasharray="3 2.4" />
      <path d="M7 8.5h6" strokeWidth="2.4" />
    </>
  ),
  ellipse: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />,
  diamond: <path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" />,
  arrow: <path d="M4 20L19 5m0 0h-8m8 0v8" />,
  line: <path d="M4 20L20 4" />,
  pen: <path d="M4 20c3-1 4-5 6-8s5-6 7-6 2 2 0 4-6 4-6 7 4 2 7 1" />,
  text: <path d="M5 6V4.5h14V6M12 4.5v15m-3 0h6" />,
  note: <path d="M5 4h14v10l-5 6H5z M14 20v-6h5" />,
  comment: <path d="M5 5h14a2 2 0 012 2v8a2 2 0 01-2 2h-8l-4 3.5V17H5a2 2 0 01-2-2V7a2 2 0 012-2z" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
}

interface ToolDef {
  tool: Tool
  label: string
  key: string
  group?: boolean
  /** Main actions stay visible on small screens; the rest fold into "⋯". */
  primary?: boolean
}

const TOOLS: ToolDef[] = [
  { tool: 'select', label: 'Select', key: 'V', primary: true },
  { tool: 'hand', label: 'Hand', key: 'H', primary: true },
  { tool: 'topic', label: 'Topic', key: 'B', group: true, primary: true },
  { tool: 'note', label: 'Sticky note', key: 'N', primary: true },
  { tool: 'comment', label: 'Comment', key: 'C', primary: true },
  { tool: 'rect', label: 'Rectangle', key: 'R', group: true },
  { tool: 'arrow', label: 'Arrow', key: 'A' },
  { tool: 'line', label: 'Line', key: 'L' },
  { tool: 'text', label: 'Text', key: 'T' },
]

function Icon({ name }: { name: keyof typeof I }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill={name === 'note' ? 'currentColor' : 'none'}
      fillOpacity={name === 'note' ? 0.15 : 1}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {I[name]}
    </svg>
  )
}

function ToolButton({ t, active, locked, onPick }: { t: ToolDef; active: boolean; locked: boolean; onPick?: () => void }) {
  return (
    <button
      className={`tool tool-${t.tool}`}
      aria-pressed={active}
      aria-label={`${t.label} (${t.key})`}
      onClick={() => {
        actions.setTool(t.tool)
        onPick?.()
      }}
      onDoubleClick={() => actions.setTool(t.tool, true)}
    >
      <Icon name={t.tool as keyof typeof I} />
      {active && locked && <span className="lock-dot" title="Tool locked (double-clicked)" />}
      <span className="tip">
        {t.label} <span className="kbd">{t.key}</span>
      </span>
    </button>
  )
}

export function Toolbar() {
  const tool = useBoard((s) => s.tool)
  const locked = useBoard((s) => s.toolLocked)
  const narrow = useMediaQuery(NARROW)
  const [moreOpen, setMoreOpen] = useState(false)

  useEffect(() => {
    if (!moreOpen) return
    const close = () => setMoreOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [moreOpen])

  const shown = narrow ? TOOLS.filter((t) => t.primary) : TOOLS
  const folded = narrow ? TOOLS.filter((t) => !t.primary) : []
  const activeFolded = folded.find((t) => t.tool === tool)

  return (
    <nav className={`toolbar${narrow ? ' narrow' : ''}`} aria-label="Tools" onPointerDown={(e) => e.stopPropagation()}>
      {shown.map((t) => (
        <span key={t.tool} className="tool-wrap">
          {t.group && <span className="tool-sep" />}
          <ToolButton t={t} active={tool === t.tool} locked={locked} />
        </span>
      ))}
      {folded.length > 0 && (
        <span className="tool-wrap more-wrap">
          <span className="tool-sep" />
          <button
            className="tool tool-more"
            aria-pressed={Boolean(activeFolded)}
            aria-expanded={moreOpen}
            aria-label="More tools"
            onClick={() => setMoreOpen((o) => !o)}
          >
            {/* Show the active folded tool, so you can always see which tool you're on. */}
            <Icon name={(activeFolded?.tool as keyof typeof I) ?? 'more'} />
          </button>
          {moreOpen && (
            <span className="tool-more-menu" role="menu">
              {folded.map((t) => (
                <ToolButton key={t.tool} t={t} active={tool === t.tool} locked={locked} onPick={() => setMoreOpen(false)} />
              ))}
            </span>
          )}
        </span>
      )}
    </nav>
  )
}
