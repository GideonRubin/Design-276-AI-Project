import { mkdirSync } from 'node:fs'
import { ready } from './db.js'

mkdirSync('data', { recursive: true })
await ready()
console.log('Database is up to date.')
