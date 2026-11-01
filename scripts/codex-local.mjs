#!/usr/bin/env node
/** Run the history-only dashboard on this machine. It does not require an API key or DSH service. */
import { startCodexLocalServer } from '../lib/codex-local.js'

const rawPort = process.env.CODEX_READONLY_PORT
const port = rawPort === undefined ? undefined : Number(rawPort)
if (rawPort !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
  process.stderr.write('CODEX_READONLY_PORT must be a TCP port between 1 and 65535.\n')
  process.exitCode = 2
} else {
  try {
    const server = await startCodexLocalServer({ ...(port === undefined ? {} : { port }),
      ...(process.env.CODEX_READONLY_DIR ? { directory: process.env.CODEX_READONLY_DIR } : {}) })
    process.stdout.write(`Codex history-only dashboard: ${server.url}\nPrivate data: ${server.directory}\nPress Ctrl+C to stop.\n`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => { process.exitCode = 0 }) })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Could not start Codex local dashboard'}\n`)
    process.exitCode = 1
  }
}
