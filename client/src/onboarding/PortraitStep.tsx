import { useMemo, useRef, useState } from 'react'
import type { Stroke } from '../../../shared/schema'
import { strokePath } from '../lib/Portrait'

interface Props {
  name: string
  color: string
  initial: Stroke[]
  onReroll: () => void
  onBack: (s: Stroke[]) => void
  onDone: (s: Stroke[]) => void
}

const SIZE = 300

export function PortraitStep({ name, color, initial, onReroll, onBack, onDone }: Props) {
  const [strokes, setStrokes] = useState<Stroke[]>(initial)
  const [live, setLive] = useState<Stroke | null>(null)
  const ref = useRef<SVGSVGElement>(null)

  const toUnit = (e: React.PointerEvent): [number, number, number] => {
    const r = ref.current!.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    const pressure = e.pointerType === 'pen' ? e.pressure : 0.5
    return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, pressure]
  }

  const paths = useMemo(() => strokes.map((s) => strokePath(s, 0.03)), [strokes])
  const livePath = live ? strokePath(live, 0.03) : ''

  return (
    <div className="onb-form">
      <h1>Now draw yourself{name ? `, ${name}` : ''}.</h1>
      <p className="onb-sub">A face, a doodle, a symbol. Scribbles welcome. This is how people will spot you on the wall.</p>

      <div className="portrait-wrap">
        <svg
          ref={ref}
          className="portrait-pad"
          width={SIZE}
          height={SIZE}
          viewBox="0 0 1 1"
          style={{ ['--c' as string]: color }}
          onPointerDown={(e) => {
            ;(e.target as Element).setPointerCapture(e.pointerId)
            setLive([toUnit(e)])
          }}
          onPointerMove={(e) => {
            if (!live) return
            setLive((s) => (s ? [...s, toUnit(e)] : s))
          }}
          onPointerUp={() => {
            if (live && live.length) setStrokes((s) => [...s, live])
            setLive(null)
          }}
          onPointerCancel={() => setLive(null)}
        >
          <defs>
            <clipPath id="pad-clip">
              <circle cx="0.5" cy="0.5" r="0.5" />
            </clipPath>
          </defs>
          <circle cx="0.5" cy="0.5" r="0.5" fill="#fff" />
          <circle cx="0.5" cy="0.5" r="0.5" fill={color} opacity="0.08" />
          <g clipPath="url(#pad-clip)">
            {paths.map((d, i) => (
              <path key={i} d={d} fill={color} />
            ))}
            {livePath && <path d={livePath} fill={color} />}
          </g>
          <circle cx="0.5" cy="0.5" r="0.494" fill="none" stroke={color} strokeWidth="0.012" strokeDasharray={strokes.length ? 'none' : '0.02 0.02'} />
        </svg>
        {!strokes.length && !live && <div className="portrait-hint">draw here ✎</div>}

        <div className="portrait-tools">
          <button className="icon-btn" title="Clear" disabled={!strokes.length} onClick={() => setStrokes([])}>
            ⌫
          </button>
          <button className="icon-btn dice" title="New color" onClick={onReroll}>
            <span className="swatch" style={{ background: color }} />
          </button>
        </div>
      </div>

      <div className="onb-actions">
        <button className="btn ghost" onClick={() => onBack(strokes)}>
          ← Back
        </button>
        <button className="btn" disabled={!strokes.length} onClick={() => onDone(strokes)}>
          That's me <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  )
}
