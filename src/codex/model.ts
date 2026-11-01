/** Read-only Codex observations. These are deliberately separate from DSH Triggers and Tickets. */
import { z } from 'zod'

export const CodexIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const Id = CodexIdSchema
const Label = z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Control characters are not allowed')
const Timestamp = z.iso.datetime({ offset: true })

export const CodexWatchlistSchema = z.object({
  version: z.literal(1),
  tasks: z.array(z.object({
    taskId: Id,
    threadId: Id,
    label: Label.optional(),
  }).strict()).min(1).max(32),
}).strict().superRefine(({ tasks }, context) => {
  for (const field of ['taskId', 'threadId'] as const) {
    const seen = new Set<string>()
    for (const [index, task] of tasks.entries()) {
      if (seen.has(task[field])) context.addIssue({ code: 'custom', path: ['tasks', index, field], message: `Duplicate ${field}` })
      seen.add(task[field])
    }
  }
})
export type CodexWatchlist = z.infer<typeof CodexWatchlistSchema>

export const CodexThreadSnapshotSchema = z.object({
  id: Id,
  /** When the bridge observed this thread, not when the last turn began. */
  capturedAt: Timestamp,
  /** Only a connection to the process that owns a live turn may assert sameHost. */
  statusSource: z.enum(['sameHost', 'historyOnly']),
  status: z.object({ type: z.enum(['active', 'idle', 'notLoaded', 'systemError']),
    activeFlags: z.array(z.string().max(100)).max(16).optional() }).strict(),
  name: z.string().max(200).optional(),
  updatedAt: Timestamp.optional(),
  latestTurn: z.object({
    id: Id,
    status: z.enum(['inProgress', 'completed', 'failed', 'interrupted', 'unknown']),
    /** Stable ID of the newest visible item, if the backend supplies one. */
    lastItemId: Id.optional(),
    lastItemType: Id.max(100).optional(),
    /** Legacy bridge input. Untrusted and never exposed to DSH's main Session. */
    summary: z.string().max(500).optional(),
  }).strict().optional(),
}).strict()
export type CodexThreadSnapshot = z.infer<typeof CodexThreadSnapshotSchema>

export interface CodexReadFailure { id: string; error: string }
export interface CodexReadBatch { threads: readonly CodexThreadSnapshot[]; failures?: readonly CodexReadFailure[] }
/** A backend is given only allowlisted IDs and has no write method. */
export interface CodexReadBackend {
  readThreads(threadIds: readonly string[], signal: AbortSignal): Promise<CodexReadBatch>
}

export type CodexTaskState = 'running' | 'waitingForApproval' | 'idle' | 'systemError' | 'unknown' | 'missing' | 'unavailable'
export interface CodexTaskView {
  taskId: string
  threadId: string
  label?: string
  state: CodexTaskState
  /** `true` means the bridge observation is too old to support a live state claim. */
  stale: boolean
  statusSource?: CodexThreadSnapshot['statusSource']
  rawStatus?: CodexThreadSnapshot['status']['type']
  capturedAt?: string
  updatedAt?: string
  /** Free-form Codex name and summary text are intentionally not returned to DSH. */
  latestTurn?: Omit<NonNullable<CodexThreadSnapshot['latestTurn']>, 'summary'>
  error?: string
}
export interface CodexTaskChange { taskId: string; threadId: string; kind: 'new' | 'changed' }
export interface CodexObservation { observedAt: string; tasks: CodexTaskView[]; changes: CodexTaskChange[] }
