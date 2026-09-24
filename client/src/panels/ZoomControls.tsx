import { actions, useBoard } from '../store/board'
import { zoomTo, zoomToFit } from '../canvas/Canvas'

export function ZoomControls() {
  const z = useBoard((s) => s.camera.z)
  const canUndo = useBoard((s) => s.undoStack.length > 0)
  const canRedo = useBoard((s) => s.redoStack.length > 0)
  return (
    <div className="zoom" onPointerDown={(e) => e.stopPropagation()}>
      <button className="icon-btn" onClick={actions.undo} disabled={!canUndo} title="Undo  ⌘Z">
        ↶
      </button>
      <button className="icon-btn" onClick={actions.redo} disabled={!canRedo} title="Redo  ⇧⌘Z">
        ↷
      </button>
      <span className="zoom-sep" />
      <button className="icon-btn" onClick={() => zoomTo(z / 1.25)} title="Zoom out">
        −
      </button>
      <button className="zoom-pct" onClick={() => zoomTo(1)} title="Reset to 100%">
        {Math.round(z * 100)}%
      </button>
      <button className="icon-btn" onClick={() => zoomTo(z * 1.25)} title="Zoom in">
        +
      </button>
      <button className="icon-btn" onClick={zoomToFit} title="Fit everything">
        ⤢
      </button>
    </div>
  )
}
