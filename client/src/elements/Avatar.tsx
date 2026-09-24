import type { AuthorType } from '../../../shared/schema'
import { usePerson } from '../lib/people'
import { AgentAvatar, Portrait } from '../lib/Portrait'

interface Props {
  authorId: string | null
  authorName: string
  authorType: AuthorType
  size?: number
}

export function Avatar({ authorId, authorName, authorType, size = 28 }: Props) {
  const person = usePerson(authorType === 'human' ? authorId : null)
  if (authorType === 'agent') return <AgentAvatar size={size} />
  if (person) return <Portrait sketch={person.sketch} color={person.color} size={size} title={authorName} />
  return (
    <span className="initial-avatar" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-label={authorName}>
      {authorName.slice(0, 1).toUpperCase()}
    </span>
  )
}
