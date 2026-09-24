// Usage: npm run seed -- path/to/file.board.json [board-id]
import { mkdirSync, readFileSync } from 'node:fs'
import { app } from './app.js'

mkdirSync('data', { recursive: true })
const [file, idArg] = process.argv.slice(2)
if (!file) {
  console.error('Usage: npm run seed -- file.board.json [board-id]')
  process.exit(1)
}
const json = JSON.parse(readFileSync(file, 'utf8'))
const id = idArg ?? json?.board?.id
const res = await app.request(`/api/boards/${id}/import`, { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' } })
console.log(res.status, await res.json())
