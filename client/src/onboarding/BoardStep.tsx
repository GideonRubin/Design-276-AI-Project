import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BOARD_ID_RE, friendlyBoardId, normalizeBoardId } from '../../../shared/ids'
import { api, ApiError } from '../lib/api'
import { Portrait } from '../lib/Portrait'
import { recentBoards, type Profile } from '../lib/profile'

interface Props {
  profile: Profile
  returning: boolean
  onEditProfile: () => void
}

export function BoardStep({ profile, returning, onEditProfile }: Props) {
  const navigate = useNavigate()
  const recent = recentBoards()
  const [value, setValue] = useState(recent[0] ?? '')
  const [missing, setMissing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const id = normalizeBoardId(value)
  const valid = BOARD_ID_RE.test(id)

  const open = async (target: string) => {
    setBusy(true)
    setError(null)
    setMissing(null)
    try {
      await api.getBoard(target)
      navigate(`/b/${target}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(target)
      else setError("Couldn't reach the wall. Is the server running?")
    } finally {
      setBusy(false)
    }
  }

  const create = async (target?: string) => {
    setBusy(true)
    setError(null)
    try {
      const b = await api.createBoard(target ?? friendlyBoardId())
      navigate(`/b/${b.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the board.")
      setBusy(false)
    }
  }

  return (
    <form
      className="onb-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) open(id)
      }}
    >
      <button type="button" className="me-chip" onClick={onEditProfile} title="Edit your name and portrait">
        <Portrait sketch={profile.sketch} color={profile.color} size={returning ? 88 : 64} />
        <span>{returning ? <>Welcome back, <b>{profile.name}</b></> : <>Nice to meet you, <b>{profile.name}</b></>}</span>
      </button>

      <h1>Which wall are we working on?</h1>
      <p className="onb-sub">Enter a board ID, or start a fresh one.</p>

      <input
        className="onb-input mono"
        autoFocus
        value={value}
        placeholder="e.g. sunny-otter-42"
        aria-label="Board ID"
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value)
          setMissing(null)
        }}
      />

      {recent.length > 0 && (
        <div className="recent">
          <span>Recent</span>
          {recent.map((r) => (
            <button type="button" key={r} className="recent-chip" onClick={() => open(r)}>
              {r}
            </button>
          ))}
        </div>
      )}

      {missing && (
        <div className="missing" role="status">
          <span>
            No board called <b>{missing}</b> yet.
          </span>
          <button type="button" className="btn small" disabled={busy} onClick={() => create(missing)}>
            Create it ✦
          </button>
        </div>
      )}
      {error && <div className="missing error">{error}</div>}

      <div className="onb-actions">
        <button className="btn" type="submit" disabled={!valid || busy}>
          Open board <span aria-hidden>→</span>
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => create()}>
          + New board
        </button>
      </div>
    </form>
  )
}
