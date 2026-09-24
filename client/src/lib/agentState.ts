import type { AgentPresence, PromptStatus } from '../../../shared/schema'

/**
 * What an agent is doing right now, from the board's point of view:
 * - paused:    someone paused it
 * - listening: it has an inbox request open (an @mention reaches it instantly)
 * - working:   it's busy: it made API calls recently, or picked up a message it hasn't answered yet
 * - asleep:    none of the above; it has stopped checking in and needs waking
 */
export type AgentActivity = 'paused' | 'listening' | 'working' | 'asleep'

/** Recent API calls mean it's busy (reading the board, adding notes, replying). */
const RECENT_CALL_MS = 90_000
/** It picked up a message and is presumably composing an answer (LLM turns can take a while). */
const THINKING_MS = 10 * 60_000

export function agentActivity(a: AgentPresence, prompts: PromptStatus[], now = Date.now()): AgentActivity {
  if (a.paused) return 'paused'
  if (a.listening) return 'listening'
  if (a.lastUsedAt !== null && now - a.lastUsedAt < RECENT_CALL_MS) return 'working'
  if (prompts.some((p) => p.inviteId === a.id && p.status === 'seen' && now - p.at < THINKING_MS)) return 'working'
  return 'asleep'
}

/** Awake = will get a message soon without anyone waking it. */
export const isAwake = (s: AgentActivity) => s === 'listening' || s === 'working'
