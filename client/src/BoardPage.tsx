import { useCallback, useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from './lib/api'
import { loadProfile, rememberBoard, tabSessionId } from './lib/profile'
import { actions, useBoard } from './store/board'
import { startSync } from './store/sync'
import { Canvas, zoomToFit } from './canvas/Canvas'
import { Toolbar } from './panels/Toolbar'
import { StyleBar } from './panels/StyleBar'
import { Header } from './panels/Header'
import { ThreadPanel } from './panels/ThreadPanel'
import { PresenceCorner } from './panels/PresenceCorner'
import { ZoomControls } from './panels/ZoomControls'
import './styles/board.css'

type Status = 'loading' | 'ready' | 'missing' | 'error'

export function BoardPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const profile = loadProfile()
  const [status, setStatus] = useState<Status>('loading')
  const [reloadKey, setReloadKey] = useState(0)
  const empty = useBoard((s) => s.board !== null && Object.keys(s.elements).length === 0 && Object.keys(s.comments).length === 0)

  useEffect(() => {
    if (!profile) return
    let stop: (() => void) | null = null
    let cancelled = false
    setStatus('loading')
    api.putParticipant(profile).catch(() => {})
    api
      .getBoard(id)
      .then((snap) => {
        if (cancelled) return
        actions.load(snap, profile, tabSessionId())
        rememberBoard(id)
        zoomToFit()
        setStatus('ready')
        stop = startSync(id)
      })
      .catch((err) => {
        if (cancelled) return
        setStatus(err instanceof ApiError && err.status === 404 ? 'missing' : 'error')
      })
    return () => {
      cancelled = true
      stop?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadKey])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (useBoard.getState().saveState === 'offline') e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      actions.reset()
    }
  }, [])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  if (!profile) return <Navigate to={`/?next=${encodeURIComponent(id)}`} replace />

  if (status === 'missing' || status === 'error') {
    return (
      <main className="board-msg">
        <h1>{status === 'missing' ? <>No board called “{id}”.</> : 'Hmm, the wall is not answering.'}</h1>
        <div className="onb-actions">
          {status === 'missing' ? (
            <button className="btn" onClick={() => api.createBoard(id).then(reload)}>
              Create it ✦
            </button>
          ) : (
            <button className="btn" onClick={reload}>
              Try again
            </button>
          )}
          <button className="btn ghost" onClick={() => navigate('/')}>
            ← Pick another
          </button>
        </div>
      </main>
    )
  }

  return (
    <div className="board-page">
      <Canvas />
      {status === 'loading' && <div className="loading">pinning things up…</div>}
      {status === 'ready' && empty && (
        <div className="empty">
          <div className="empty-title">A blank wall. Go make a mess. ✏️</div>
          <div className="empty-sub">
            Press <span className="kbd">N</span> for a sticky note, <span className="kbd">B</span> for a topic, or double-click anywhere to comment.
          </div>
        </div>
      )}
      <Header onImported={reload} />
      <StyleBar />
      <Toolbar />
      <ZoomControls />
      <PresenceCorner />
      <ThreadPanel />
    </div>
  )
}
