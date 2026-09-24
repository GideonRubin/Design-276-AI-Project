import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { loadProfile, newProfileId, randomColor, saveProfile, type Profile } from '../lib/profile'
import type { Stroke } from '../../../shared/schema'
import { NameStep } from './NameStep'
import { PortraitStep } from './PortraitStep'
import { BoardStep } from './BoardStep'
import './onboarding.css'

type Step = 'name' | 'portrait' | 'board'

export function Onboarding() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [existing] = useState(loadProfile)
  const editing = params.get('edit') === '1'
  const next = params.get('next')

  const [step, setStep] = useState<Step>(existing && !editing ? 'board' : 'name')
  const [dir, setDir] = useState<1 | -1>(1)
  const [name, setName] = useState(existing?.name ?? '')
  const [color, setColor] = useState(existing?.color ?? randomColor())
  const [sketch, setSketch] = useState<Stroke[]>(existing?.sketch ?? [])
  const [profile, setProfile] = useState<Profile | null>(existing && !editing ? existing : null)
  const returning = Boolean(existing && !editing)

  const go = (s: Step, d: 1 | -1 = 1) => {
    setDir(d)
    setStep(s)
  }

  const finishProfile = (strokes: Stroke[]) => {
    const p: Profile = { id: existing?.id ?? newProfileId(), name: name.trim(), color, sketch: strokes }
    saveProfile(p)
    setProfile(p)
    api.putParticipant(p).catch(() => {}) // the board page retries on entry
    if (next) navigate(`/b/${next}`, { replace: true })
    else go('board')
  }

  const index = { name: 1, portrait: 2, board: 3 }[step]

  return (
    <main className="onb">
      <div className="onb-brand">
        DESIGN <span>276</span>
      </div>
      {!returning && (
        <div className="onb-progress" aria-label={`Step ${index} of 3`}>
          {[1, 2, 3].map((i) => (
            <span key={i} data-on={i <= index} />
          ))}
          <em>{index} / 3</em>
        </div>
      )}

      <div key={step} className="onb-step" data-dir={dir}>
        {step === 'name' && <NameStep name={name} onChange={setName} onNext={() => go('portrait')} />}
        {step === 'portrait' && (
          <PortraitStep
            name={name.trim()}
            color={color}
            onReroll={() => setColor((c) => randomColor(c))}
            initial={sketch}
            onBack={(s) => {
              setSketch(s)
              go('name', -1)
            }}
            onDone={(s) => {
              setSketch(s)
              finishProfile(s)
            }}
          />
        )}
        {step === 'board' && profile && (
          <BoardStep profile={profile} returning={returning} onEditProfile={() => navigate('/?edit=1')} />
        )}
      </div>
    </main>
  )
}
