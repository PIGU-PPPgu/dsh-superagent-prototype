#!/usr/bin/env node
/** File handoff for a native Codex automation. It never calls Codex or approves a request. */
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, join } from 'node:path'
import lockfile from 'proper-lockfile'

const [, , command, stateDir, intentId, detail] = process.argv
const fail = message => { throw new Error(message) }
if (!isAbsolute(stateDir ?? '')) fail('An absolute DSH state directory is required')
const root = join(stateDir, 'codex-control')
const receipts = join(root, 'receipts')
for (const path of [root, receipts]) {
  if (!existsSync(path)) fail('The Codex control directory is unavailable')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || process.platform !== 'win32' && (stat.mode & 0o077
      || typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    fail('The Codex control directory must be private and owned by this user')
  }
}
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const atomic = (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}
const queue = () => {
  const path = join(root, 'queue.json')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && stat.mode & 0o077) {
    fail('The Codex control queue is unavailable')
  }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value?.version !== 1 || !Array.isArray(value.actions)) fail('Invalid Codex control queue')
  return value.actions.filter(action => validId(action.id) && typeof action.threadId === 'string'
    && typeof action.basedOnItemId === 'string' && typeof action.text === 'string'
    && action.text.length <= 1000 && action.status === 'queued')
}
const receiptPath = id => join(receipts, `${id}.json`)
const pending = () => queue().filter(action => !existsSync(receiptPath(action.id)))
const authoritative = action => {
  const db = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'), { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key='codex-control-v1'").get()
    const state = row ? JSON.parse(row.value) : undefined
    const saved = state?.intents?.[action.id]
    const owned = db.prepare(`SELECT 1 FROM ticket AS ticket JOIN trigger AS origin
      ON origin.id = json_extract(ticket.value, '$.origin.triggerId')
      WHERE json_extract(ticket.value, '$.ended') IS NULL
        AND json_extract(origin.value, '$.source') = 'codex'
        AND json_extract(origin.value, '$.meta.threadId') = ? LIMIT 1`).get(action.threadId)
    return state?.enabled === true && saved?.status === 'queued' && saved.threadId === action.threadId
      && saved.basedOnItemId === action.basedOnItemId && saved.text === action.text
      && saved.priority === action.priority && !owned
  } finally { db.close() }
}
if (command === 'list') {
  process.stdout.write(JSON.stringify({ version: 1, actions: pending() }) + '\n')
} else if (command === 'claim') {
  if (!validId(intentId)) fail('Invalid intent ID')
  const release = lockfile.lockSync(root, { stale: 30_000 })
  try {
    const action = pending().find(item => item.id === intentId)
    if (!action) fail('The intent is no longer queued or was already claimed')
    if (!authoritative(action)) fail('The DSH Router no longer authorizes this intent')
    writeFileSync(receiptPath(intentId), JSON.stringify({ version: 1, intentId, threadId: action.threadId,
      status: 'dispatching', at: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' })
    process.stdout.write(JSON.stringify(action) + '\n')
  } finally { release() }
} else if (command === 'sent' || command === 'failed') {
  if (!validId(intentId)) fail('Invalid intent ID')
  const release = lockfile.lockSync(root, { stale: 30_000 })
  try {
    const path = receiptPath(intentId)
    if (!existsSync(path) || !lstatSync(path).isFile()) fail('The intent has not been claimed')
    const claim = JSON.parse(readFileSync(path, 'utf8'))
    if (claim?.intentId !== intentId || typeof claim.threadId !== 'string') fail('Invalid intent receipt')
    if (claim.status !== 'dispatching' && claim.status !== command) fail('The intent already has a different result')
    if (claim.status === 'dispatching') atomic(path, { version: 1, intentId, threadId: claim.threadId, status: command,
      at: new Date().toISOString(), ...(command === 'failed' ? { error: String(detail ?? 'Native delivery failed').slice(0, 300) } : {}) })
    process.stdout.write(JSON.stringify({ intentId, status: command }) + '\n')
  } finally { release() }
} else if (command === 'heartbeat') {
  atomic(join(root, 'bridge.json'), { version: 1, at: new Date().toISOString(), sendMessage: true })
  process.stdout.write(JSON.stringify({ ready: true }) + '\n')
} else fail('Use list, claim, sent, failed, or heartbeat')
