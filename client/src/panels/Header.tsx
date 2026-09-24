import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useBoard } from '../store/board'
import { ReportDialog } from './ReportDialog'
import { exportBoardPdf } from '../lib/exportPdf'

const COLLAPSE_KEY = 'wall.menuCollapsed'

export function Header({ onImported }: { onImported: () => void }) {
  const board = useBoard((s) => s.board)
  const saveState = useBoard((s) => s.saveState)
  const [copied, setCopied] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState<{ id: string | null } | null>(null)
  const agentsCount = useBoard((s) => s.agents.length)
  const reports = useBoard((s) => s.reports)
  const synced = useBoard((s) => s.synced)
  const [readyNotice, setReadyNotice] = useState<{ id: string; agentName: string } | null>(null)
  const agentDeletions = useBoard((s) => s.agentDeletions)
  const sid = useBoard((s) => s.sid)
  const [dismissedDeletions, setDismissedDeletions] = useState<Set<string>>(() => new Set())
  const [restoring, setRestoring] = useState<string | null>(null)
  // The newest agent deletion from the last few minutes that nobody has restored or dismissed.
  const deletion = agentDeletions.find((d) => !d.restoredAt && !dismissedDeletions.has(d.id) && Date.now() - d.at < 10 * 60_000) ?? null
  const seenReady = useRef<Set<string> | null>(null)

  // Tell everyone on the board when a report finishes (reports already done at load don't count).
  useEffect(() => {
    if (!synced) return // wait for the real list, or every old report would look new
    const ready = reports.filter((r) => r.status === 'ready')
    if (!seenReady.current) {
      seenReady.current = new Set(ready.map((r) => r.id))
      return
    }
    for (const r of ready) {
      if (seenReady.current.has(r.id)) continue
      seenReady.current.add(r.id)
      setReadyNotice({ id: r.id, agentName: r.agentName })
    }
  }, [reports, synced])

  // Close the export menu on outside click.
  useEffect(() => {
    if (!exportOpen) return
    const close = () => setExportOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [exportOpen])
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(COLLAPSE_KEY)
    return saved === null ? window.matchMedia('(max-width: 760px)').matches : saved === '1'
  })
  const fileRef = useRef<HTMLInputElement>(null)
  if (!board) return null

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      return !c
    })
  }

  const copy = async () => {
    await navigator.clipboard.writeText(board.id).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const onFile = async (f: File | undefined) => {
    if (!f) return
    try {
      const json = JSON.parse(await f.text())
      if (!confirm(`Replace everything on #${board.id} with the contents of ${f.name}?`)) return
      await api.importFile(board.id, json)
      setImportMsg('Imported ✓')
      onImported()
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Import failed')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
      setTimeout(() => setImportMsg(null), 3000)
    }
  }

  return (
    <>
      <header className="hdr hdr-left" onPointerDown={(e) => e.stopPropagation()}>
        <Link to="/" className="brand" title="All boards">
          DESIGN <span>276</span>
        </Link>
        <span className="hdr-sep" />
        {/* Boards are known by their ID; click to copy it and share the board. */}
        <button className="id-chip board-id" onClick={copy} title="Copy board ID">
          #{board.id} <span>{copied ? 'copied ✓' : '⧉'}</span>
        </button>
      </header>

      <header className={`hdr hdr-right${collapsed ? ' collapsed' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
        <span className={`save save-${saveState}`} role="status" title={saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Offline, retrying'}>
          <i />
          <span className="save-label">{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Offline, retrying'}</span>
        </span>
        <div className="hdr-menu" aria-hidden={collapsed}>
          {importMsg && <span className="import-msg">{importMsg}</span>}
          <span className="export-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button className="hdr-btn" aria-expanded={exportOpen} onClick={() => setExportOpen((o) => !o)} tabIndex={collapsed ? -1 : 0}>
              ↓ Export
            </button>
            {exportOpen && (
              <div className="export-menu" role="menu">
                <button
                  role="menuitem"
                  className="export-item"
                  disabled={pdfBusy}
                  onClick={async () => {
                    setPdfBusy(true)
                    try {
                      await exportBoardPdf()
                      setExportOpen(false)
                    } catch (err) {
                      setImportMsg(err instanceof Error ? err.message : 'PDF export failed')
                      setTimeout(() => setImportMsg(null), 3000)
                    } finally {
                      setPdfBusy(false)
                    }
                  }}
                >
                  <b>{pdfBusy ? 'Rendering…' : '🖼 Board as PDF'}</b>
                  <span>The whole wall, ready to share or print</span>
                </button>
                <button
                  role="menuitem"
                  className="export-item"
                  disabled={!agentsCount}
                  title={agentsCount ? undefined : 'Invite an agent first'}
                  onClick={() => {
                    setExportOpen(false)
                    setReportOpen({ id: null })
                  }}
                >
                  <b>📄 Report by an agent…</b>
                  <span>{agentsCount ? 'A short, plain-language summary of each topic' : 'Needs a connected agent'}</span>
                </button>
                <a role="menuitem" className="export-item" href={api.exportUrl(board.id)} download={`${board.id}.board.json`} onClick={() => setExportOpen(false)}>
                  <b>{'{ }'} Board file</b>
                  <span>.board.json, to back up or import elsewhere</span>
                </a>
              </div>
            )}
          </span>
          <button className="hdr-btn" onClick={() => fileRef.current?.click()} title="Load a .board.json file" tabIndex={collapsed ? -1 : 0}>
            ↑ Import
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        <button className="icon-btn hdr-toggle" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-label={collapsed ? 'Show menu' : 'Hide menu'} title={collapsed ? 'Show menu' : 'Hide menu'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 4l-4 4 4 4" />
          </svg>
        </button>
      </header>

      {/* Portal: the header's backdrop-filter would otherwise trap the fixed-position modal. */}
      {reportOpen &&
        createPortal(
          <ReportDialog
            openReportId={reportOpen.id}
            onClose={() => {
              setReportOpen(null)
              setReadyNotice(null) // it finished while you were watching: no need to announce it
            }}
          />,
          document.body,
        )}
      {deletion &&
        createPortal(
          <div className="report-toast deletion-toast" role="status">
            🤖 {deletion.agentName} removed {deletion.count} {deletion.count === 1 ? 'item' : 'items'}
            {deletion.reason && <span className="deletion-reason">“{deletion.reason}”</span>}
            <button
              className="btn small"
              disabled={restoring === deletion.id}
              onClick={async () => {
                setRestoring(deletion.id)
                await api.restoreDeletion(board.id, deletion.id, sid).catch(() => {})
                setRestoring(null)
                setDismissedDeletions((s) => new Set([...s, deletion.id]))
              }}
            >
              {restoring === deletion.id ? 'Restoring…' : '↺ Restore'}
            </button>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setDismissedDeletions((s) => new Set([...s, deletion.id]))}>
              ✕
            </button>
          </div>,
          document.body,
        )}
      {readyNotice &&
        !reportOpen &&
        createPortal(
          <div className="report-toast" role="status">
            📄 {readyNotice.agentName} finished the report
            <button
              className="btn small"
              onClick={() => {
                setReportOpen({ id: readyNotice.id })
                setReadyNotice(null)
              }}
            >
              Open
            </button>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setReadyNotice(null)}>
              ✕
            </button>
          </div>,
          document.body,
        )}
    </>
  )
}
