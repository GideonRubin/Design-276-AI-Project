import { useEffect, useState } from 'react'

/** True while the media query matches (e.g. '(max-width: 760px)'). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatches(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return matches
}

/** Breakpoint where the board switches to its compact layout. */
export const NARROW = '(max-width: 760px)'
