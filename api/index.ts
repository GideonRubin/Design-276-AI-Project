import { handle } from 'hono/vercel'
import app from '../server/src/app.js'

// Agent inbox long-polls for up to 25s; give the function some headroom.
export const maxDuration = 30

const handler = handle(app)
export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
