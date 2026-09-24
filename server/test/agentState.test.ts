import { describe, expect, it } from 'vitest'
import { agentActivity } from '../../client/src/lib/agentState'
import type { AgentPresence, PromptStatus } from '../../shared/schema'

const NOW = 1_000_000_000
const agent = (over: Partial<AgentPresence> = {}): AgentPresence => ({
  id: 'ai_1', agentName: 'Designer', hostPid: 'p', createdAt: 0, lastUsedAt: null, listening: false, persona: 'Designer', paused: false, pausedBy: null, ...over,
})
const prompt = (over: Partial<PromptStatus> = {}): PromptStatus => ({
  inviteId: 'ai_1', agentName: 'Designer', commentId: 'c', replyId: '', status: 'seen', at: NOW - 60_000, ...over,
})

describe('agent activity', () => {
  it('is working (not asleep) while it is making API calls between inbox checks', () => {
    expect(agentActivity(agent({ lastUsedAt: NOW - 20_000 }), [], NOW)).toBe('working')
  })
  it('is working while it has picked up a message it has not answered yet', () => {
    expect(agentActivity(agent({ lastUsedAt: NOW - 5 * 60_000 }), [prompt()], NOW)).toBe('working')
  })
  it('is asleep only when idle', () => {
    expect(agentActivity(agent({ lastUsedAt: NOW - 5 * 60_000 }), [prompt({ status: 'answered' })], NOW)).toBe('asleep')
    expect(agentActivity(agent(), [prompt({ at: NOW - 20 * 60_000 })], NOW)).toBe('asleep')
  })
  it('prefers paused, then listening', () => {
    expect(agentActivity(agent({ paused: true, listening: true }), [], NOW)).toBe('paused')
    expect(agentActivity(agent({ listening: true, lastUsedAt: NOW }), [], NOW)).toBe('listening')
  })
})
