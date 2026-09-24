import { useEffect } from 'react'

const GAP = 24

/**
 * The bottom row holds three things: zoom (left), tools (center), people (right).
 * When they don't fit side by side (window too narrow, or lots of people/agents),
 * set `board-crowded` on <body>: zoom moves under the header and people lift above
 * the toolbar. It measures real widths, so it adapts to however many cards there are.
 * Also exposes the people corner's height as --presence-h for panels that sit above it.
 */
export function useCrowdedLayout(active: boolean) {
  useEffect(() => {
    if (!active) return
    const body = document.body
    let raf = 0

    const measure = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const width = (sel: string) => document.querySelector<HTMLElement>(sel)?.offsetWidth ?? 0
        const toolbar = width('.toolbar')
        const zoom = width('.zoom')
        const people = document.querySelector<HTMLElement>('.presence')
        const side = window.innerWidth / 2 - toolbar / 2 // free space on each side of the centered toolbar
        const crowded = side < zoom + GAP || side < (people?.offsetWidth ?? 0) + GAP
        body.classList.toggle('board-crowded', crowded)
        body.style.setProperty('--presence-h', `${people?.offsetHeight ?? 0}px`)
      })
    }

    measure()
    // Widths don't depend on the crowded arrangement (only positions do), so this can't flip-flop.
    const ro = new ResizeObserver(measure)
    for (const sel of ['.toolbar', '.zoom', '.presence']) {
      const el = document.querySelector(sel)
      if (el) ro.observe(el)
    }
    window.addEventListener('resize', measure)
    // Cards come and go (people join, agents are invited): re-check when the corner's children change.
    const mo = new MutationObserver(measure)
    const people = document.querySelector('.presence')
    if (people) mo.observe(people, { childList: true })

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', measure)
      body.classList.remove('board-crowded')
    }
  }, [active])
}
