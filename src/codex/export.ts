/** One-shot, history-only snapshot export for manual Mac-local validation. */
import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { CodexAppServerBackend, type CodexReadRpc } from './app-server.ts'
import { readCodexWatchlistFile } from './file-bridge.ts'
import { MAX_CODEX_SNAPSHOT_BYTES } from './private-file.ts'

/** Writes only the allowlisted thread projections, with a non-authoritative historyOnly status. */
export async function exportCodexHistorySnapshot(watchlistPath: string, snapshotPath: string, rpc: CodexReadRpc,
  signal: AbortSignal = new AbortController().signal): Promise<{ threads: number; unavailable: number }> {
  if (!isAbsolute(watchlistPath) || !isAbsolute(snapshotPath) || watchlistPath === snapshotPath) {
    throw new Error('Codex watchlist and snapshot must be distinct absolute paths')
  }
  const watchlist = await readCodexWatchlistFile(watchlistPath, signal)
  const batch = await new CodexAppServerBackend(rpc, 'historyOnly').readThreads(watchlist.tasks.map(task => task.threadId), signal)
  const body = JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), statusSource: 'historyOnly',
    threads: batch.threads.map(({ capturedAt: _at, statusSource: _source, name: _name, latestTurn, ...thread }) => ({
      ...thread, ...(latestTurn ? { latestTurn: { ...latestTurn, summary: undefined } } : {}),
    })),
    failures: (batch.failures ?? []).map(({ id }) => ({ id })),
  })
  if (Buffer.byteLength(body) > MAX_CODEX_SNAPSHOT_BYTES) throw new Error('Codex snapshot exceeds the file limit')
  const temporary = join(dirname(snapshotPath), `.${basename(snapshotPath)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(body)
    await handle.sync()
    await handle.close()
    await rename(temporary, snapshotPath)
  } catch {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw new Error('Codex snapshot could not be written')
  }
  return { threads: batch.threads.length, unavailable: batch.failures?.length ?? 0 }
}
