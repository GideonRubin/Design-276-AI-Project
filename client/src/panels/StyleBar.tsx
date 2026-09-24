import { INK, NOTE_COLORS, SECTION_COLORS, Style, type NoteColor, type SectionColor } from '../../../shared/schema'
import { frameAround, isSection } from '../../../shared/sections'
import { uid } from '../../../shared/ids'
import { actions, useBoard } from '../store/board'
import { deleteSelection, duplicateSelection, reorder } from '../canvas/Canvas'

const INKS = [INK, '#FF5A47', '#1FA59A', '#8B6CF0', '#3A96E0', '#E8A200']
const TINT: Record<string, string> = {
  [INK]: '#EDEAE2',
  '#FF5A47': '#FFD9D4',
  '#1FA59A': '#CDEFEA',
  '#8B6CF0': '#E4DCFF',
  '#3A96E0': '#D5EAFB',
  '#E8A200': '#FFEDB8',
}

export function StyleBar() {
  const selection = useBoard((s) => s.selection)
  const elements = useBoard((s) => s.elements)
  const editingId = useBoard((s) => s.editingId)
  const comments = useBoard((s) => s.comments)
  const commentSelection = useBoard((s) => s.commentSelection)
  const els = selection.map((id) => elements[id]).filter(Boolean)
  const threads = commentSelection.map((id) => comments[id]).filter(Boolean)
  const resolvedThreads = threads.filter((c) => c.resolved)
  if ((!els.length && !threads.length) || editingId) return null

  const sections = els.filter(isSection)
  const notes = els.filter((e) => e.kind === 'note')
  const inked = els.filter((e) => e.kind !== 'note' && !isSection(e))
  const framable = els.filter((e) => !isSection(e))
  const closed = inked.filter((e) => e.shape === 'rect' || e.shape === 'ellipse' || e.shape === 'diamond')
  const first = inked[0]
  const filled = closed.length > 0 && closed.every((e) => e.style.fill)

  const apply = (ids: string[], fn: Parameters<typeof actions.patchElements>[1]) => {
    actions.checkpoint()
    actions.patchElements(ids, fn)
  }

  /** Wrap the selection in a new titled section, then edit its title. */
  const frameSelection = () => {
    const me = useBoard.getState().me!
    actions.checkpoint()
    const now = Date.now()
    const minZ = Math.min(0, ...Object.values(useBoard.getState().elements).map((e) => e.z))
    const section = {
      id: uid('e_'),
      kind: 'shape' as const,
      shape: 'rect' as const,
      role: 'section' as const,
      ...frameAround(framable),
      rotation: 0,
      z: minZ - 1,
      style: Style.parse({ color: 'gray' }),
      text: '',
      points: [],
      seed: 1,
      bindings: { start: null, end: null, startAt: null, endAt: null },
      authorId: me.id,
      authorName: me.name,
      authorType: 'human' as const,
      createdAt: now,
      updatedAt: now,
      version: 0,
      deleted: false,
    }
    actions.upsertElements([section])
    actions.markFresh(section.id)
    actions.select([section.id])
    actions.edit(section.id)
  }

  return (
    <div className="stylebar" onPointerDown={(e) => e.stopPropagation()}>
      {sections.length > 0 && (
        <div className="sb-group" aria-label="Topic color">
          {(Object.keys(SECTION_COLORS) as SectionColor[]).map((k) => (
            <button
              key={k}
              className="sb-swatch note"
              style={{ background: SECTION_COLORS[k] }}
              aria-pressed={sections.every((x) => (x.style.color ?? 'gray') === k)}
              aria-label={`topic ${k}`}
              onClick={() => apply(sections.map((x) => x.id), (x) => ({ style: { ...x.style, color: k } }))}
            />
          ))}
        </div>
      )}
      {framable.length > 0 && (
        <button className="sb-btn" title="Make a topic around the selection" onClick={frameSelection}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2">
            <rect x="1.5" y="1.5" width="13" height="13" rx="3" />
          </svg>
          Topic
        </button>
      )}
      {notes.length > 0 && (
        <div className="sb-group" aria-label="Note color">
          {(Object.keys(NOTE_COLORS) as NoteColor[]).map((k) => (
            <button
              key={k}
              className="sb-swatch note"
              style={{ background: NOTE_COLORS[k] }}
              aria-pressed={notes.every((n) => (n.style.color ?? 'yellow') === k)}
              aria-label={k}
              onClick={() => apply(notes.map((n) => n.id), (n) => ({ style: { ...n.style, color: k } }))}
            />
          ))}
        </div>
      )}
      {inked.length > 0 && (
        <div className="sb-group" aria-label="Ink">
          {INKS.map((c) => (
            <button
              key={c}
              className="sb-swatch"
              style={{ background: c }}
              aria-pressed={first?.style.stroke === c}
              aria-label={`ink ${c}`}
              onClick={() =>
                apply(inked.map((e) => e.id), (e) => ({ style: { ...e.style, stroke: c, fill: e.style.fill ? TINT[c] ?? e.style.fill : null } }))
              }
            />
          ))}
        </div>
      )}
      {closed.length > 0 && (
        <button
          className="sb-btn"
          aria-pressed={filled}
          onClick={() => apply(closed.map((e) => e.id), (e) => ({ style: { ...e.style, fill: filled ? null : TINT[e.style.stroke] ?? '#EDEAE2' } }))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16">
            <rect x="2" y="2" width="12" height="12" rx="2" fill={filled ? 'currentColor' : 'none'} fillOpacity=".3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          Fill
        </button>
      )}
      {threads.length > 0 && (
        <div className="sb-group" aria-label="Selected comments">
          <span className="sb-label">
            💬 {threads.length} {threads.length === 1 ? 'comment' : 'comments'}
          </span>
          {resolvedThreads.length > 0 && (
            <button
              className="sb-btn"
              title="Reopen"
              onClick={() => {
                resolvedThreads.forEach((c) => actions.upsertComment({ ...c, resolved: false }))
                actions.selectComments([])
              }}
            >
              ↺ Reopen
            </button>
          )}
        </div>
      )}
      {els.length === 0 ? (
        <div className="sb-group">
          <button className="sb-btn danger" title="Delete  ⌫" onClick={deleteSelection}>
            🗑 Delete
          </button>
        </div>
      ) : (
      <div className="sb-group">
        <button className="sb-btn icon" title="Bring to front  ]" onClick={() => { actions.checkpoint(); reorder('front') }}>⤒</button>
        <button className="sb-btn icon" title="Send to back  [" onClick={() => { actions.checkpoint(); reorder('back') }}>⤓</button>
        <button className="sb-btn icon" title="Duplicate  ⌘D" onClick={duplicateSelection}>⧉</button>
        <button className="sb-btn icon danger" title="Delete  ⌫" onClick={deleteSelection}>🗑</button>
      </div>
      )}
    </div>
  )
}
