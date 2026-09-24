import { useBoard } from '../store/board'
import { rectOf, unionRect } from '../elements/geometry'

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const

export function SelectionOverlay() {
  const selection = useBoard((s) => s.selection)
  const elements = useBoard((s) => s.elements)
  const z = useBoard((s) => s.camera.z)
  const editingId = useBoard((s) => s.editingId)

  const els = selection.map((id) => elements[id]).filter(Boolean)
  if (!els.length) return null
  const inv = 1 / z

  if (els.length === 1) {
    const el = els[0]
    const pad = 6 * inv
    const hs = 10 * inv
    return (
      <div
        className="selection"
        style={{
          transform: `translate(${el.x - pad}px, ${el.y - pad}px) rotate(${el.rotation}deg)`,
          transformOrigin: `${el.w / 2 + pad}px ${el.h / 2 + pad}px`,
          width: el.w + pad * 2,
          height: el.h + pad * 2,
          borderWidth: 1.5 * inv,
          zIndex: 100000,
        }}
      >
        {editingId !== el.id &&
          CORNERS.map((c) => (
            <span
              key={c}
              className={`handle handle-${c}`}
              data-handle={c}
              style={{ width: hs, height: hs, borderWidth: 1.5 * inv, margin: -hs / 2, borderRadius: 3 * inv }}
            />
          ))}
        {editingId !== el.id && el.kind !== 'text' && el.shape !== 'line' && el.shape !== 'arrow' && el.role !== 'section' && (
          <span className="handle-rotate" data-handle="rotate" style={{ width: hs * 1.2, height: hs * 1.2, top: -26 * inv, marginLeft: (-hs * 1.2) / 2, borderWidth: 1.5 * inv }} />
        )}
      </div>
    )
  }

  const r = unionRect(els.map(rectOf))!
  const pad = 8 * inv
  return (
    <div
      className="selection group"
      style={{
        transform: `translate(${r.x - pad}px, ${r.y - pad}px)`,
        width: r.w + pad * 2,
        height: r.h + pad * 2,
        borderWidth: 1.5 * inv,
        zIndex: 100000,
      }}
    />
  )
}
