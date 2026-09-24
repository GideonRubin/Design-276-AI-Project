import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { AgentAvatar } from '../lib/Portrait'
import { useBoard } from '../store/board'

const REPORT_CSS = `
  body { font: 15px/1.55 'Space Grotesk', ui-sans-serif, system-ui, sans-serif; color: #1b1b1b; max-width: 760px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 30px; letter-spacing: -0.02em; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 28px 0 8px; padding-top: 14px; border-top: 1.5px solid #e4ded0; }
  h3 { font-size: 16px; margin: 18px 0 6px; }
  ul, ol { padding-left: 22px; } li { margin: 3px 0; }
  blockquote { margin: 10px 0; padding: 6px 14px; border-left: 3px solid #ffc83d; background: #fffaf0; }
  code { background: #f2eee3; padding: 1px 5px; border-radius: 4px; }
  .meta { color: #8a857a; font-size: 12px; margin-bottom: 24px; }
`

/** Print (→ "Save as PDF") the report from a hidden iframe, so no popup is needed. */
function printReport(html: string, title: string) {
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>${REPORT_CSS}</style></head><body>${html}</body></html>`)
  doc.close()
  setTimeout(() => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    setTimeout(() => frame.remove(), 2000)
  }, 250)
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ReportDialog({ onClose, openReportId }: { onClose: () => void; openReportId?: string | null }) {
  const board = useBoard((s) => s.board)!
  const sid = useBoard((s) => s.sid)
  const agents = useBoard((s) => s.agents)
  const reports = useBoard((s) => s.reports)
  const [pick, setPick] = useState<string | null>(agents.find((a) => a.listening)?.id ?? agents[0]?.id ?? null)
  const [pendingId, setPendingId] = useState<string | null>(openReportId ?? null)
  const [full, setFull] = useState<{ id: string; markdown: string; agentName: string; completedAt: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pending = reports.find((r) => r.id === pendingId) ?? null

  // When the report we're waiting on (or opened) is ready, fetch it.
  useEffect(() => {
    if (!pendingId || (pending && pending.status !== 'ready') || full?.id === pendingId) return
    api
      .getReport(board.id, pendingId)
      .then((r) => r.markdown && setFull({ id: r.id, markdown: r.markdown, agentName: r.agentName, completedAt: r.completedAt }))
      .catch(() => {})
  }, [pendingId, pending?.status, board.id, full?.id])

  const html = useMemo(() => (full ? renderMarkdown(full.markdown) : ''), [full])

  const ask = async () => {
    if (!pick) return
    setBusy(true)
    setError(null)
    try {
      const { id } = await api.requestReport(board.id, { sid, inviteId: pick })
      setPendingId(id)
      useBoard.setState({
        reports: [
          { id, agentName: agents.find((a) => a.id === pick)?.agentName ?? 'Agent', inviteId: pick, requestedBy: 'you', status: 'requested', createdAt: Date.now(), completedAt: null },
          ...useBoard.getState().reports,
        ],
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't request the report.")
    } finally {
      setBusy(false)
    }
  }

  const agentFor = (inviteId: string) => agents.find((a) => a.id === inviteId)
  const title = `${board.title || 'Untitled wall'} — report`
  const ready = reports.filter((r) => r.status === 'ready')

  return (
    <div className="modal-scrim" onPointerDown={onClose}>
      <div className="modal report-modal" role="dialog" aria-label="Board report" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        {full ? (
          <>
            <div className="report-meta">
              📄 Written by 🤖 {full.agentName}
              {full.completedAt ? ` · ${new Date(full.completedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
            </div>
            <article className="report-body" dangerouslySetInnerHTML={{ __html: html }} />
            <div className="invite-actions">
              <button className="btn" onClick={() => printReport(`<div class="meta">${board.id} · by ${full.agentName}</div>${html}`, title)}>
                Save as PDF
              </button>
              <button className="btn ghost" onClick={() => download(`${board.id}-report.md`, full.markdown, 'text/markdown')}>
                ↓ Markdown
              </button>
              <button className="btn ghost" onClick={() => navigator.clipboard.writeText(full.markdown).catch(() => {})}>
                Copy
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setFull(null)
                  setPendingId(null)
                }}
              >
                New report
              </button>
            </div>
          </>
        ) : pending ? (
          <div className="report-wait">
            <AgentAvatar size={56} sleeping={!agentFor(pending.inviteId)?.listening} />
            <h2>
              {pending.status === 'writing'
                ? `${pending.agentName} is writing the report…`
                : agentFor(pending.inviteId)?.listening
                  ? `Sending to ${pending.agentName}…`
                  : `${pending.agentName} is asleep`}
            </h2>
            <p>
              {pending.status === 'writing'
                ? 'It has the whole board: every topic, note, arrow and thread. This usually takes a minute.'
                : agentFor(pending.inviteId)?.listening
                  ? 'It will pick this up in a moment.'
                  : 'The request is waiting in its inbox. Wake it from its card in the bottom-right corner (hover it and copy the wake-up message).'}
            </p>
            <span className="dots big" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <p className="report-hint">You can close this; you'll get a notice when the report is ready.</p>
          </div>
        ) : (
          <>
            <div className="modal-head">
              <span className="report-icon">📄</span>
              <div>
                <h2>Board report</h2>
                <p>A connected agent reads the whole wall and writes up each topic: main points, relationships, open questions, and next steps.</p>
              </div>
            </div>
            {agents.length === 0 ? (
              <div className="wake-note">No agents on this board yet. Invite one from the top-right menu first.</div>
            ) : (
              <>
                <div className="report-agents" role="radiogroup" aria-label="Which agent writes it">
                  {agents.map((a) => (
                    <label key={a.id} className={`report-agent${pick === a.id ? ' on' : ''}`}>
                      <input type="radio" name="agent" checked={pick === a.id} onChange={() => setPick(a.id)} />
                      <AgentAvatar size={30} sleeping={!a.listening} />
                      <span className="mention-name">{a.agentName}</span>
                      <span className="mention-hint">{a.listening ? 'listening' : 'asleep · will need waking'}</span>
                    </label>
                  ))}
                </div>
                {error && <div className="invite-error">{error}</div>}
                <button className="btn" disabled={!pick || busy} onClick={ask}>
                  Write the report ✦
                </button>
              </>
            )}
            {ready.length > 0 && (
              <div className="report-past">
                <div className="wake-label">Earlier reports</div>
                {ready.map((r) => (
                  <button key={r.id} className="recent-chip" onClick={() => setPendingId(r.id)}>
                    {r.agentName} · {new Date(r.completedAt ?? r.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
