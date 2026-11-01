/** File boundary for a Mac-side producer; this package never opens or controls a Codex thread. */
import { z } from 'zod'
import { CodexIdSchema, CodexThreadSnapshotSchema, CodexWatchlistSchema, type CodexObservation, type CodexReadBackend,
  type CodexReadBatch } from './model.ts'
import { CodexObserver } from './observer.ts'
import { MAX_CODEX_SNAPSHOT_BYTES, MAX_CODEX_WATCHLIST_BYTES, readPrivateText } from './private-file.ts'

const ThreadRecordSchema = CodexThreadSnapshotSchema.omit({ capturedAt: true, statusSource: true })
const BridgeFileSchema = z.object({
  version: z.literal(1),
  capturedAt: z.iso.datetime({ offset: true }),
  // A file cannot prove which Codex process owns a live turn. Refuse sameHost even when the producer writes it.
  statusSource: z.literal('historyOnly'),
  threads: z.array(z.unknown()).max(100),
  failures: z.array(z.unknown()).max(100).optional(),
}).strict()

/** Reads the operator-owned task mapping. It cannot expand through data in the bridge snapshot. */
export async function readCodexWatchlistFile(path: string, signal: AbortSignal): Promise<z.infer<typeof CodexWatchlistSchema>> {
  const text = await readPrivateText(path, MAX_CODEX_WATCHLIST_BYTES, 'watchlist', signal)
  try { return CodexWatchlistSchema.parse(JSON.parse(text) as unknown) }
  catch { throw new Error('Codex watchlist file is unavailable or invalid') }
}

/** Reads one atomically replaced bridge snapshot and returns only requested thread IDs. */
export class CodexFileBackend implements CodexReadBackend {
  constructor(private readonly path: string) {}
  async readThreads(threadIds: readonly string[], signal: AbortSignal): Promise<CodexReadBatch> {
    const raw = await readPrivateText(this.path, MAX_CODEX_SNAPSHOT_BYTES, 'snapshot', signal)
    let file: z.infer<typeof BridgeFileSchema>
    try { file = BridgeFileSchema.parse(JSON.parse(raw) as unknown) }
    catch { throw new Error('Codex snapshot file is unavailable or invalid') }
    const allowed = new Set(threadIds)
    const threads = new Map<string, z.infer<typeof ThreadRecordSchema>>()
    const failures = new Set<string>()
    const seen = new Set<string>()
    for (const value of file.threads) {
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !allowed.has(value.id)) continue
      if (seen.has(value.id)) { threads.delete(value.id); failures.add(value.id); continue }
      seen.add(value.id)
      const parsed = ThreadRecordSchema.safeParse(value)
      if (parsed.success) threads.set(value.id, parsed.data)
      else failures.add(value.id)
    }
    for (const failure of file.failures ?? []) {
      if (!failure || typeof failure !== 'object' || !('id' in failure) || typeof failure.id !== 'string'
        || !allowed.has(failure.id) || !CodexIdSchema.safeParse(failure.id).success) continue
      threads.delete(failure.id); failures.add(failure.id)
    }
    return { threads: [...threads.values()].map(thread => ({ ...thread, capturedAt: file.capturedAt, statusSource: 'historyOnly' })),
      failures: [...failures].map(id => ({ id, error: 'Codex read unavailable' })) }
  }
}

/** Reloads the explicit task-to-thread mapping on demand; a mapping edit starts a new deduplication baseline. */
export class CodexFileMonitor {
  private watchlistText?: string
  private observer?: CodexObserver
  private inFlight?: Promise<CodexObservation>
  constructor(private readonly watchlistPath: string, private readonly snapshotPath: string,
    private readonly now: () => Date = () => new Date()) {}

  refresh(signal: AbortSignal = new AbortController().signal): Promise<CodexObservation> {
    if (this.inFlight) return this.inFlight
    const running = this.collect(signal)
    this.inFlight = running
    void running.finally(() => { if (this.inFlight === running) this.inFlight = undefined }).catch(() => {})
    return running
  }

  private async collect(signal: AbortSignal): Promise<CodexObservation> {
    const text = await readPrivateText(this.watchlistPath, MAX_CODEX_WATCHLIST_BYTES, 'watchlist', signal)
    if (text !== this.watchlistText || !this.observer) {
      let watchlist: z.infer<typeof CodexWatchlistSchema>
      try { watchlist = CodexWatchlistSchema.parse(JSON.parse(text) as unknown) }
      catch { throw new Error('Codex watchlist file is unavailable or invalid') }
      this.observer = new CodexObserver(watchlist, new CodexFileBackend(this.snapshotPath), this.now)
      this.watchlistText = text
    }
    return this.observer.refresh(signal)
  }
}
