import type { Element } from './schema.js'

export const isSection = (e: Element) => e.role === 'section'

const center = (e: Element) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 })

/** Elements that belong to a section: their center is inside it (other sections and attached arrows excluded). */
export function sectionContents(section: Element, all: Iterable<Element>): Element[] {
  const out: Element[] = []
  for (const e of all) {
    if (e.id === section.id || e.deleted || isSection(e)) continue
    if (e.bindings?.start || e.bindings?.end) continue // attached arrows follow their ends anyway
    const c = center(e)
    if (c.x >= section.x && c.x <= section.x + section.w && c.y >= section.y && c.y <= section.y + section.h) out.push(e)
  }
  return out
}

export const SECTION_PAD = 32
export const SECTION_TITLE_BAND = 64

/** A frame that fits these elements, with room for a title across the top. */
export function frameAround(els: Element[]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...els.map((e) => e.x)) - SECTION_PAD
  const y = Math.min(...els.map((e) => e.y)) - SECTION_PAD - SECTION_TITLE_BAND
  const x2 = Math.max(...els.map((e) => e.x + e.w)) + SECTION_PAD
  const y2 = Math.max(...els.map((e) => e.y + e.h)) + SECTION_PAD
  return { x, y, w: x2 - x, h: y2 - y }
}
