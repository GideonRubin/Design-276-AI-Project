import type { Board, BoardSnapshot, ChangesResponse, Op, Participant, ReportInfo } from '../../../shared/schema'
import type { Profile } from './profile'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText)
  return data as T
}

export const api = {
  getBoard: (id: string) => call<BoardSnapshot>('GET', `/boards/${encodeURIComponent(id)}`),
  createBoard: (id?: string) => call<Board>('POST', '/boards', id ? { id } : {}),
  changes: (id: string, since: number, who: { pid: string; sid: string; run: string; visible: boolean }) =>
    call<ChangesResponse>(
      'GET',
      `/boards/${encodeURIComponent(id)}/changes?since=${since}&pid=${encodeURIComponent(who.pid)}&sid=${encodeURIComponent(who.sid)}` +
        `&run=${encodeURIComponent(who.run)}&vis=${who.visible ? 1 : 0}`,
    ),
  createInvite: (id: string, body: { pid: string; sid: string; agentName: string; persona?: string; context?: string }) =>
    call<{ token: string; invite: { id: string; agentName: string; createdAt: number } }>('POST', `/boards/${encodeURIComponent(id)}/invites`, body),
  pauseAgent: (id: string, inviteId: string, sid: string, paused: boolean) =>
    call<{ ok: true }>('POST', `/boards/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}/pause`, { sid, paused }),
  revokeInvite: (id: string, inviteId: string, sid: string) =>
    call<{ ok: true }>('DELETE', `/boards/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}?sid=${encodeURIComponent(sid)}`),
  requestReport: (id: string, body: { sid: string; inviteId: string }) => call<{ id: string }>('POST', `/boards/${encodeURIComponent(id)}/reports`, body),
  getReport: (id: string, rid: string) =>
    call<ReportInfo & { markdown: string | null }>('GET', `/boards/${encodeURIComponent(id)}/reports/${encodeURIComponent(rid)}`),
  leaveBeacon: (sid: string, run: string) =>
    navigator.sendBeacon(`/api/sessions/${encodeURIComponent(sid)}/leave?run=${encodeURIComponent(run)}`),
  ops: (id: string, ops: Op[]) => call<{ version: number }>('PATCH', `/boards/${encodeURIComponent(id)}/ops`, { ops }),
  beaconOps: (id: string, ops: Op[]) =>
    navigator.sendBeacon(`/api/boards/${encodeURIComponent(id)}/ops`, JSON.stringify({ ops })),
  importFile: (id: string, file: unknown) => call<{ ok: true }>('POST', `/boards/${encodeURIComponent(id)}/import`, file),
  exportUrl: (id: string) => `/api/boards/${encodeURIComponent(id)}/export`,
  putParticipant: (p: Profile) => call<Participant>('PUT', `/participants/${encodeURIComponent(p.id)}`, p),
  getParticipant: (id: string) => call<Participant>('GET', `/participants/${encodeURIComponent(id)}`),
}
