import { Hono } from 'hono'
import { Participant } from '../../../shared/schema.js'
import { getParticipant, putParticipant } from '../db.js'

export const participants = new Hono()

participants.get('/:pid', async (c) => {
  const p = await getParticipant(c.req.param('pid'))
  if (!p) return c.json({ error: 'participant not found' }, 404)
  return c.json(p)
})

participants.put('/:pid', async (c) => {
  const body = await c.req.json()
  const p = Participant.parse({ ...body, id: c.req.param('pid') })
  if (JSON.stringify(p.sketch).length > 60_000) return c.json({ error: 'Sketch is too detailed.' }, 413)
  await putParticipant(p)
  return c.json(p)
})
