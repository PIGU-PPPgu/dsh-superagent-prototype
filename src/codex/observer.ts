/** Allowlist-bound, idempotent read model for existing Codex threads. */
import { CodexThreadSnapshotSchema, CodexWatchlistSchema, type CodexObservation, type CodexReadBackend,
  type CodexTaskState, type CodexTaskView, type CodexThreadSnapshot, type CodexWatchlist } from './model.ts'

export const CODEX_MAX_AGE_MS = 120_000

function stateOf(snapshot: CodexThreadSnapshot, now: number, maxAgeMs: number): CodexTaskState {
  // A separate app-server process can read stored history while the Desktop process owns an active turn.
  // Its `notLoaded` or `idle` result is therefore not evidence about that Desktop turn.
  if (snapshot.statusSource !== 'sameHost' || snapshot.status.type === 'notLoaded'
    || now - Date.parse(snapshot.capturedAt) > maxAgeMs || Date.parse(snapshot.capturedAt) > now + 10_000) return 'unknown'
  if (snapshot.status.type === 'systemError') return 'systemError'
  if (snapshot.status.type === 'idle') return 'idle'
  return snapshot.status.activeFlags?.includes('waitingOnApproval') ? 'waitingForApproval' : 'running'
}

/** No Codex text is sent to DSH's Engine, so an observed thread cannot create or resume a Ticket. */
export class CodexObserver {
  readonly watchlist: CodexWatchlist
  private readonly signatures = new Map<string, string>()
  private inFlight?: Promise<CodexObservation>

  constructor(watchlist: unknown, private readonly backend: CodexReadBackend,
    private readonly now: () => Date = () => new Date(), private readonly maxAgeMs = CODEX_MAX_AGE_MS) {
    this.watchlist = CodexWatchlistSchema.parse(watchlist)
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('maxAgeMs must be non-negative and finite')
  }

  refresh(signal: AbortSignal = new AbortController().signal): Promise<CodexObservation> {
    if (this.inFlight) return this.inFlight
    const running = this.collect(signal)
    this.inFlight = running
    void running.finally(() => { if (this.inFlight === running) this.inFlight = undefined }).catch(() => {})
    return running
  }

  private async collect(signal: AbortSignal): Promise<CodexObservation> {
    const observedAt = this.now().toISOString()
    const ids = this.watchlist.tasks.map(task => task.threadId)
    const allowed = new Set(ids)
    const snapshots = new Map<string, CodexThreadSnapshot>()
    const errors = new Map<string, string>()
    try {
      const batch = await this.backend.readThreads(ids, signal)
      for (const value of batch.threads) {
        const snapshot = CodexThreadSnapshotSchema.parse(value)
        if (!allowed.has(snapshot.id)) continue // Never expose an unlisted thread.
        if (snapshots.has(snapshot.id)) throw new Error(`Duplicate Codex snapshot: ${snapshot.id}`)
        snapshots.set(snapshot.id, snapshot)
      }
      for (const failure of batch.failures ?? []) {
        if (!allowed.has(failure.id)) continue
        if (snapshots.has(failure.id) || errors.has(failure.id)) throw new Error(`Conflicting Codex result: ${failure.id}`)
        errors.set(failure.id, failure.error.slice(0, 300))
      }
    } catch (error) {
      const message = String(error).slice(0, 300)
      for (const id of ids) errors.set(id, message)
      snapshots.clear()
    }
    const tasks: CodexTaskView[] = this.watchlist.tasks.map(task => {
      const base = { taskId: task.taskId, threadId: task.threadId, ...(task.label ? { label: task.label } : {}) }
      const error = errors.get(task.threadId)
      if (error !== undefined) return { ...base, state: 'unavailable', stale: true, error }
      const snapshot = snapshots.get(task.threadId)
      if (!snapshot) return { ...base, state: 'missing', stale: true }
      const age = Date.parse(observedAt) - Date.parse(snapshot.capturedAt)
      const stale = age > this.maxAgeMs || age < -10_000
      return { ...base, state: stateOf(snapshot, Date.parse(observedAt), this.maxAgeMs), stale,
        statusSource: snapshot.statusSource, rawStatus: snapshot.status.type, capturedAt: snapshot.capturedAt,
        ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}), ...(snapshot.name ? { name: snapshot.name } : {}),
        ...(snapshot.latestTurn ? { latestTurn: snapshot.latestTurn } : {}) }
    })
    // Poll timestamps do not create changes. A new turn, status, approval flag, or progress item does.
    const changes = tasks.flatMap(task => {
      const signature = JSON.stringify({ state: task.state, rawStatus: task.rawStatus, stale: task.stale,
        source: task.statusSource, name: task.name, turn: task.latestTurn, error: task.error })
      const previous = this.signatures.get(task.threadId)
      this.signatures.set(task.threadId, signature)
      return previous === signature ? [] : [{ taskId: task.taskId, threadId: task.threadId,
        kind: previous === undefined ? 'new' as const : 'changed' as const }]
    })
    return { observedAt, tasks, changes }
  }
}
