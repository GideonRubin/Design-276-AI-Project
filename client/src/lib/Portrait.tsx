import { useId, useMemo } from 'react'
import { getStroke } from 'perfect-freehand'
import type { Stroke } from '../../../shared/schema'

/** perfect-freehand outline → SVG path. Coordinates are in a 0..1 unit square. */
export function strokePath(points: Stroke, size = 0.035): string {
  // perfect-freehand assumes pixel-ish units, so work at 100× and scale back down.
  const S = 100
  const scaled = points.map(([x, y, p]) => [x * S, y * S, p])
  const outline = getStroke(scaled, { size: size * S, thinning: 0.55, smoothing: 0.6, streamline: 0.45, simulatePressure: points.every((p) => p[2] === 0.5) }).map(
    ([x, y]) => [x / S, y / S],
  )
  if (!outline.length) return ''
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]
      acc.push(x0.toFixed(4), y0.toFixed(4), ((x0 + x1) / 2).toFixed(4), ((y0 + y1) / 2).toFixed(4))
      return acc
    },
    ['M', outline[0][0].toFixed(4), outline[0][1].toFixed(4), 'Q'],
  )
  return d.join(' ') + ' Z'
}

interface Props {
  sketch: Stroke[]
  color: string
  size?: number
  ring?: boolean
  className?: string
  title?: string
}

/** A person's self-portrait: their strokes, in their color, inside a circle. */
export function Portrait({ sketch, color, size = 40, ring = true, className, title }: Props) {
  const clip = useId()
  const paths = useMemo(() => sketch.map((s) => strokePath(s)), [sketch])
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 1 1"
      role="img"
      aria-label={title ?? 'portrait'}
      style={{ display: 'block', flex: 'none' }}
    >
      <defs>
        <clipPath id={clip}>
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
      </defs>
      <circle cx="0.5" cy="0.5" r="0.5" fill="#fff" />
      <circle cx="0.5" cy="0.5" r="0.5" fill={color} opacity="0.12" />
      <g clipPath={`url(#${clip})`}>
        {paths.map((d, i) => (
          <path key={i} d={d} fill={color} />
        ))}
      </g>
      {ring && <circle cx="0.5" cy="0.5" r="0.485" fill="none" stroke={color} strokeWidth="0.03" />}
    </svg>
  )
}

export function AgentAvatar({ size = 40, sleeping = false }: { size?: number; sleeping?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={sleeping ? 'sleeping agent' : 'agent'} style={{ display: 'block', flex: 'none' }}>
      <circle cx="20" cy="20" r="19" fill="#fff" stroke="#1b1b1b" strokeWidth="1.5" strokeDasharray="3 2.5" />
      <rect x="11" y="13" width="18" height="15" rx="4" fill="#1b1b1b" />
      {sleeping ? (
        // Closed eyes: little downward arcs.
        <g fill="none" stroke="#ffd84d" strokeWidth="1.6" strokeLinecap="round">
          <path d="M13.8 20.2q2.2 1.8 4.4 0" />
          <path d="M21.8 20.2q2.2 1.8 4.4 0" />
        </g>
      ) : (
        <>
          <circle cx="16" cy="20" r="2.2" fill="#ffd84d" />
          <circle cx="24" cy="20" r="2.2" fill="#ffd84d" />
        </>
      )}
      <line x1="20" y1="13" x2="20" y2="9" stroke="#1b1b1b" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="20" cy="8.5" r="1.8" fill={sleeping ? '#b9b2a3' : '#ff6b5b'} />
    </svg>
  )
}
