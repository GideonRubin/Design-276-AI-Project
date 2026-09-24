import { actions, useBoard, type Tool } from '../store/board'

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
}

const TOOLS: Array<{ tool: Tool; label: string; key: string; group?: boolean }> = [
  { tool: 'select', label: 'Select', key: 'V' },
  { tool: 'hand', label: 'Hand', key: 'H' },
  { tool: 'note', label: 'Sticky note', key: 'N', group: true },
  { tool: 'comment', label: 'Comment', key: 'C' },
  { tool: 'topic', label: 'Topic', key: 'B' },
  { tool: 'rect', label: 'Rectangle', key: 'R', group: true },
  { tool: 'arrow', label: 'Arrow', key: 'A' },
  { tool: 'line', label: 'Line', key: 'L' },
  { tool: 'text', label: 'Text', key: 'T' },
]

export function Toolbar() {
  const tool = useBoard((s) => s.tool)
  const locked = useBoard((s) => s.toolLocked)
  return (
    <nav className="toolbar" aria-label="Tools" onPointerDown={(e) => e.stopPropagation()}>
      {TOOLS.map((t) => (
        <span key={t.tool} className="tool-wrap">
          {t.group && <span className="tool-sep" />}
          <button
            className={`tool tool-${t.tool}`}
            aria-pressed={tool === t.tool}
            aria-label={`${t.label} (${t.key})`}
            onClick={() => actions.setTool(t.tool)}
            onDoubleClick={() => actions.setTool(t.tool, true)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill={t.tool === 'note' ? 'currentColor' : 'none'} fillOpacity={t.tool === 'note' ? 0.15 : 1} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {I[t.tool]}
            </svg>
            {tool === t.tool && locked && <span className="lock-dot" title="Tool locked (double-clicked)" />}
            <span className="tip">
              {t.label} <span className="kbd">{t.key}</span>
            </span>
          </button>
        </span>
      ))}
    </nav>
  )
}
