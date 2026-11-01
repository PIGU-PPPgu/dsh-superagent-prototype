#!/usr/bin/env node
/** Manual Mac-local export. A separately spawned app-server only supplies stored history. */
import { CodexStdioReadRpc, exportCodexHistorySnapshot } from '../lib/codex-read.js'

const [watchlistPath, snapshotPath, extra] = process.argv.slice(2)
if (!watchlistPath || !snapshotPath || extra) {
  process.stderr.write('Usage: node scripts/codex-export-snapshot.mjs /absolute/watchlist.json /absolute/snapshot.json\n')
  process.exitCode = 2
} else {
  let rpc
  try {
    rpc = await CodexStdioReadRpc.connect()
    const result = await exportCodexHistorySnapshot(watchlistPath, snapshotPath, rpc)
    process.stdout.write(`History-only snapshot written: ${result.threads} threads; ${result.unavailable} unavailable. Live status is unverified.\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Codex read failed'}\n`)
    process.exitCode = 1
  } finally { rpc?.close() }
}
