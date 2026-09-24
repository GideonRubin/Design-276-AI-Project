import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { app } from './app.js'

mkdirSync('data', { recursive: true })
const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, () => console.log(`API ready on http://localhost:${port}/api  (docs: /api/docs)`))
