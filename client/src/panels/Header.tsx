import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { actions, useBoard } from '../store/board'
import { InviteDialog } from './InviteDialog'
import { ReportDialog } from './ReportDialog'
import { exportBoardPdf } from '../lib/exportPdf'

const COLLAPSE_KEY = 'wall.menuCollapsed'

export function Header({ onImported }: { onImported: () => void }) {
  const board = useBoard((s) => s.board)
  const saveState = useBoard((s) => s.saveState)
  const [copied, setCopied] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState<{ id: string | null } | null>(null)
  const agentsCount = useBoard((s) => s.agents.length)
  const reports = useBoard((s) => s.reports)
  const [readyNotice, setReadyNotice] = useState<{ id: string; agentName: string } | null>(null)
  const seenReady = useRef<Set<string> | null>(null)

  // Tell everyone on the board when a report finishes (reports already done at load don't count).
  useEffect(() => {
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
  }, [reports])

  // Close the export menu on outside click.
  useEffect(() => {
    if (!exportOpen) return
    const close = () => setExportOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [exportOpen])
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1')
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
      if (!confirm(`Replace everything on “${board.title}” with the contents of ${f.name}?`)) return
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
        <input
          className="title-input"
          value={board.title}
          aria-label="Board title"
          maxLength={120}
          onChange={(e) => actions.setTitle(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          size={Math.max(8, board.title.length)}
        />
        <button className="id-chip" onClick={copy} title="Copy board ID">
          #{board.id} <span>{copied ? '✓' : '⧉'}</span>
        </button>
      </header>

      <header className={`hdr hdr-right${collapsed ? ' collapsed' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
        <span className={`save save-${saveState}`} role="status" title={saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Offline, retrying'}>
          <i />
          <span className="save-label">{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Offline, retrying'}</span>
        </span>
        <div className="hdr-menu" aria-hidden={collapsed}>
          {importMsg && <span className="import-msg">{importMsg}</span>}
          <button className="hdr-btn invite" onClick={() => setInviting(true)} title="Invite an AI agent to this board" tabIndex={collapsed ? -1 : 0}>
            🤖 Invite agent
          </button>
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
                  <span>{agentsCount ? 'Main points & relationships for each topic' : 'Needs a connected agent'}</span>
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
      {inviting && createPortal(<InviteDialog onClose={() => setInviting(false)} />, document.body)}
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
