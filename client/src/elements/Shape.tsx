import { memo, useMemo } from 'react'
import rough from 'roughjs'
import { getStroke } from 'perfect-freehand'
import type { Element } from '../../../shared/schema'

const gen = rough.generator()
const PAD = 12

function freehandPath(points: [number, number][], size: number): string {
  const outline = getStroke(points, { size, thinning: 0.5, smoothing: 0.5, streamline: 0.4, simulatePressure: true })
  if (!outline.length) return ''
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
      return acc
    },
    ['M', outline[0][0], outline[0][1], 'Q'] as (string | number)[],
  )
  return d.join(' ') + ' Z'
}

interface PathInfo {
  d: string
  stroke: string
  strokeWidth: number
  fill?: string
}

function roughPaths(e: Element): PathInfo[] {
  const { w, h, style, seed } = e
  const opts = {
    seed: seed || 1,
    roughness: 0.9,
    bowing: 1.2,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    fill: style.fill ?? undefined,
    fillStyle: 'solid' as const,
    preserveVertices: true,
  }
  switch (e.shape) {
    case 'rect':
      return gen.toPaths(gen.rectangle(0, 0, w, h, opts))
    case 'ellipse':
      return gen.toPaths(gen.ellipse(w / 2, h / 2, w, h, opts))
    case 'diamond':
      return gen.toPaths(
        gen.polygon(
          [
            [w / 2, 0],
            [w, h / 2],
            [w / 2, h],
            [0, h / 2],
          ],
          opts,
        ),
      )
    case 'line':
    case 'arrow': {
      const [a, b] = [e.points[0] ?? [0, 0], e.points[e.points.length - 1] ?? [w, h]]
      const paths = gen.toPaths(gen.line(a[0], a[1], b[0], b[1], opts))
      if (e.shape === 'arrow') {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
        const len = 14 + style.strokeWidth * 2
        for (const s of [-1, 1]) {
          const t = ang + Math.PI + s * 0.45
          paths.push(...gen.toPaths(gen.line(b[0], b[1], b[0] + Math.cos(t) * len, b[1] + Math.sin(t) * len, { ...opts, roughness: 0.5 })))
        }
      }
      return paths
    }
    default:
      return []
  }
}

export const ShapeGraphic = memo(function ShapeGraphic({ el }: { el: Element }) {
  const { w, h, shape, style, points, seed } = el
  const paths = useMemo(
    () =>
      shape === 'pen'
        ? [{ d: freehandPath(points, style.strokeWidth * 2.4), stroke: 'none', strokeWidth: 0, fill: style.stroke }]
        : roughPaths(el),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [w, h, shape, style.stroke, style.fill, style.strokeWidth, points, seed],
  )
  const linear = shape === 'line' || shape === 'arrow' || shape === 'pen'
  const hitPath =
    linear && points.length
      ? shape === 'pen'
        ? 'M' + points.map((p) => p.join(' ')).join(' L')
        : `M${points[0].join(' ')} L${points[points.length - 1].join(' ')}`
      : null

  return (
    <svg
      className="shape-svg"
      width={w + PAD * 2}
      height={h + PAD * 2}
      viewBox={`${-PAD} ${-PAD} ${w + PAD * 2} ${h + PAD * 2}`}
      style={{ left: -PAD, top: -PAD }}
    >
      {hitPath && <path className="hit" d={hitPath} fill="none" stroke="transparent" strokeWidth={Math.max(14, style.strokeWidth * 4)} strokeLinecap="round" strokeLinejoin="round" />}
      {paths.map((p, i) => (
        <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill={p.fill ?? 'none'} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  )
})
