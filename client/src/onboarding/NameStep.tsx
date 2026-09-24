interface Props {
  name: string
  onChange: (v: string) => void
  onNext: () => void
}

export function NameStep({ name, onChange, onNext }: Props) {
  const valid = name.trim().length > 0
  return (
    <form
      className="onb-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onNext()
      }}
    >
      <h1>What should we call you?</h1>
      <p className="onb-sub">A name, a nickname, an alias. Whatever feels like you.</p>
      <input
        className="onb-input"
        autoFocus
        maxLength={40}
        value={name}
        placeholder="Type your name"
        aria-label="Your name"
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="onb-actions">
        <button className="btn" type="submit" disabled={!valid}>
          Next <span aria-hidden>→</span>
        </button>
        <span className="onb-hint">
          or press <span className="kbd">Enter</span>
        </span>
      </div>
    </form>
  )
}
