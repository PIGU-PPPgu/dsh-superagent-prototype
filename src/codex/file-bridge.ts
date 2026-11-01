/** File boundary for a Mac-side producer; this package never opens or controls a Codex thread. */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { CodexThreadSnapshotSchema, CodexWatchlistSchema, type CodexObservation, type CodexReadBackend,
  type CodexReadBatch } from './model.ts'
import { CodexObserver } from './observer.ts'

const BridgeFileSchema = z.object({
  version: z.literal(1),
  capturedAt: z.iso.datetime({ offset: true }),
  statusSource: z.enum(['sameHost', 'historyOnly']),
  threads: z.array(CodexThreadSnapshotSchema.omit({ capturedAt: true, statusSource: true })).max(100),
}).strict().superRefine(({ threads }, context) => {
  const seen = new Set<string>()
  for (const [index, thread] of threads.entries()) {
    if (seen.has(thread.id)) context.addIssue({ code: 'custom', path: ['threads', index, 'id'], message: 'Duplicate thread ID' })
    seen.add(thread.id)
  }
})

/** Reads one atomically replaced bridge snapshot and returns only requested thread IDs. */
export class CodexFileBackend implements CodexReadBackend {
  constructor(private readonly path: string) {}
  async readThreads(threadIds: readonly string[], signal: AbortSignal): Promise<CodexReadBatch> {
    const raw = await readFile(this.path, { encoding: 'utf8', signal })
    const file = BridgeFileSchema.parse(JSON.parse(raw) as unknown)
    const allowed = new Set(threadIds)
    return { threads: file.threads.filter(thread => allowed.has(thread.id)).map(thread => ({
      ...thread, capturedAt: file.capturedAt, statusSource: file.statusSource,
    })) }
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
    const text = await readFile(this.watchlistPath, { encoding: 'utf8', signal })
    if (text !== this.watchlistText || !this.observer) {
      const watchlist = CodexWatchlistSchema.parse(JSON.parse(text) as unknown)
      this.observer = new CodexObserver(watchlist, new CodexFileBackend(this.snapshotPath), this.now)
      this.watchlistText = text
    }
    return this.observer.refresh(signal)
  }
}
