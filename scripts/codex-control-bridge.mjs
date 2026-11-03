#!/usr/bin/env node
/** Legacy queue inspection only. DSH now owns claiming, delivery and connection probes. */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const [, , command, stateDir] = process.argv
const fail = message => { throw new Error(message) }
if (command !== 'list') fail('External Codex delivery is disabled; use the DSH in-process adapter')
if (!isAbsolute(stateDir ?? '')) fail('An absolute DSH state directory is required')
const root = join(stateDir, 'codex-control'), receipts = join(root, 'receipts')
for (const path of [root, receipts]) {
  if (!existsSync(path)) fail('The Codex control directory is unavailable')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077
    || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('The Codex control directory must be private')
}
const path = join(root, 'queue.json'), stat = lstatSync(path)
if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && stat.mode & 0o077) fail('The Codex queue is unavailable')
const queue = JSON.parse(readFileSync(path, 'utf8'))
if (queue?.version !== 1 || !Array.isArray(queue.actions)) fail('Invalid Codex control queue')
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
process.stdout.write(JSON.stringify({ version: 1, actions: queue.actions.filter(action => validId(action.id)
  && action.status === 'queued' && !existsSync(join(receipts, `${action.id}.json`))) }) + '\n')
