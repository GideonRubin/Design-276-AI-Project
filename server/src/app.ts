import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ZodError, z } from 'zod'
import { NotFound, ready } from './db.js'
import { boards } from './routes/boards.js'
import { participants } from './routes/participants.js'
import { agent } from './routes/agent.js'
import { openapi } from './openapi.js'
import { leaveSession } from './invites.js'

export const app = new Hono().basePath('/api')

app.use('*', cors())
app.use('*', async (_c, next) => {
  await ready()
  await next()
})

app.get('/health', (c) => c.json({ ok: true }))
app.route('/boards', boards)
app.route('/participants', participants)
app.route('/agent', agent)

// Sent via sendBeacon when a board tab closes, so that tab's invites pause immediately.
app.post('/sessions/:sid/leave', async (c) => {
  await leaveSession(c.req.param('sid'), c.req.query('run') ?? null)
  return c.json({ ok: true })
})

app.get('/openapi.json', (c) => c.json(openapi))
app.get('/docs', (c) =>
  c.html(`<!doctype html><html><head><title>Wall · Agent API</title><meta charset="utf-8"/></head>
<body><script id="api-reference" data-url="/api/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>`),
)

app.onError((err, c) => {
  if (err instanceof NotFound) return c.json({ error: err.message }, 404)
  if (err instanceof ZodError) return c.json({ error: 'Invalid request', details: z.prettifyError(err) }, 400)
  if (err instanceof SyntaxError) return c.json({ error: 'Body must be valid JSON' }, 400)
  console.error(err)
  return c.json({ error: 'Something went wrong' }, 500)
})

app.notFound((c) => c.json({ error: 'No such endpoint. See /api/docs' }, 404))

export default app
