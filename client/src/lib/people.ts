import { create } from 'zustand'
import type { Stroke } from '../../../shared/schema'
import { useBoard } from '../store/board'
import { api } from './api'

interface Person {
  name: string
  color: string
  sketch: Stroke[]
}

const usePeople = create<Record<string, Person | null>>(() => ({}))
const inflight = new Set<string>()

/** Look up someone's portrait by participant id: me → presence → cache → fetch once. */
export function usePerson(id: string | null): Person | null {
  const me = useBoard((s) => s.me)
  const fromPresence = useBoard((s) => (id ? s.presence.find((p) => p.id === id) : undefined))
  const cached = usePeople((s) => (id ? s[id] : undefined))
  if (!id) return null
  if (me && me.id === id) return me
  if (fromPresence) return fromPresence
  if (cached !== undefined) return cached
  if (!inflight.has(id)) {
    inflight.add(id)
    api
      .getParticipant(id)
      .then((p) => usePeople.setState({ [id]: { name: p.name, color: p.color, sketch: p.sketch } }))
      .catch(() => usePeople.setState({ [id]: null }))
  }
  return null
}
