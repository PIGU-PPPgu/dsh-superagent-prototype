/** Background, read-only observation of every locally indexed Codex conversation. */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { family, record } from '../kv.ts'
import { CodexStdioReadRpc } from '../codex/stdio.ts'
import { listAllCodexThreads, readRecentCodexMessages, type MonitoredCodexThread } from '../codex/monitor-read.ts'
import { buildCodexTriagePrompt, parseCodexTriageDecision, type CodexTriageDecision } from '../codex/triage.ts'
import type { Store } from './store.ts'

const POLL_MS = 30_000
const RESCAN_MS = 5 * 60_000
const CONTEXT_MESSAGES = 12
const CONTEXT_CHARS = 2_000
const MonitorKey = record<StoredMonitor>('codex-monitor-v1')
const AuditKey = family<{ at: string; model: string; prompt: string; response: string }, [threadId: string, itemId: string]>(
  'codex-monitor-audit:')

interface StoredMessage { id: string; role: 'user' | 'assistant'; text: string }
interface Attention { decision: CodexTriageDecision; at: string; itemId: string; acknowledgedAt?: string }
interface StoredThread extends MonitoredCodexThread {
  seenAt: string
  checkedAt?: string
  present: boolean
  baselined?: boolean
  lastItemId?: string
  latestTurnId?: string
  latestTurnStatus?: string
  context: StoredMessage[]
  attention?: Attention
  error?: string
}
interface StoredMonitor {
  version: 1
  enabled: boolean
  initialized: boolean
  scannedAt?: string
  error?: string
  threads: Record<string, StoredThread>
}
export interface CodexMonitorThreadView {
  id: string
  title: string
  sourceKind: string
  parentThreadId?: string
  archived: boolean
  updatedAt?: string
  latestTurnId?: string
  latestTurnStatus?: string
  present: boolean
  error?: string
  attention?: Attention
}
export interface CodexMonitorView {
  enabled: boolean
  scannedAt?: string
  error?: string
  total: number
  attentionTotal: number
  attention: CodexMonitorThreadView[]
  threads: CodexMonitorThreadView[]
  nextOffset?: number
}
type ReadRpc = Pick<CodexStdioReadRpc, 'request' | 'close'>
export interface CodexMonitorDeps {
  store: Pick<Store, 'get' | 'set' | 'settings'>
  context: Pick<Context, 'llm' | 'sessionController'>
  connect?: (signal: AbortSignal) => Promise<ReadRpc>
  pollMs?: number
  now?: () => Date
}

const initial = (): StoredMonitor => ({ version: 1, enabled: false, initialized: false, threads: {} })
const errorText = (_error: unknown) => 'Codex inventory unavailable'
const contextOf = (previous: readonly StoredMessage[], added: readonly StoredMessage[]): StoredMessage[] => {
  const byId = new Map(previous.map(item => [item.id, item]))
  for (const item of added) byId.set(item.id, { ...item, text: item.text.slice(0, CONTEXT_CHARS) })
  return [...byId.values()].slice(-CONTEXT_MESSAGES)
}

/** The monitor never resumes, subscribes to, messages, or interrupts a Codex thread. */
export class CodexMonitor {
  private readonly connect: (signal: AbortSignal) => Promise<ReadRpc>
  private readonly pollMs: number
  private readonly now: () => Date
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private controller = new AbortController()
  private started = false

  constructor(private readonly deps: CodexMonitorDeps) {
    this.connect = deps.connect ?? (signal => CodexStdioReadRpc.connect({ timeoutMs: 30_000, signal }))
    this.pollMs = deps.pollMs ?? POLL_MS
    this.now = deps.now ?? (() => new Date())
  }
  private state(): StoredMonitor { return this.deps.store.get(MonitorKey) ?? initial() }
  private save(value: StoredMonitor): void { this.deps.store.set(MonitorKey, value) }

  view(offset = 0, limit = 50): CodexMonitorView {
    const state = this.state()
    const rows = Object.values(state.threads).filter(row => row.present).sort((a, b) =>
      (b.updatedAt ?? b.seenAt).localeCompare(a.updatedAt ?? a.seenAt))
    const display = (row: StoredThread): CodexMonitorThreadView => ({
      id: row.id, title: row.name ?? row.id, sourceKind: row.sourceKind, archived: row.archived,
      present: row.present, ...(row.parentThreadId ? { parentThreadId: row.parentThreadId } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(row.latestTurnId ? { latestTurnId: row.latestTurnId } : {}),
      ...(row.latestTurnStatus ? { latestTurnStatus: row.latestTurnStatus } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.attention ? { attention: row.attention } : {}),
    })
    const attention = rows.filter(row => row.attention?.decision.needsAttention && !row.attention.acknowledgedAt)
    return { enabled: state.enabled, ...(state.scannedAt ? { scannedAt: state.scannedAt } : {}),
      ...(state.error ? { error: state.error } : {}), total: rows.length, attentionTotal: attention.length,
      attention: attention.slice(0, 50).map(display), threads: rows.slice(offset, offset + limit).map(display),
      ...(offset + limit < rows.length ? { nextOffset: offset + limit } : {}) }
  }
  setEnabled(enabled: boolean): CodexMonitorView {
    const state = this.state()
    this.save({ ...state, enabled })
    if (!enabled) { this.controller.abort(); if (this.timer) clearTimeout(this.timer) }
    else if (this.started) {
      if (this.controller.signal.aborted) this.controller = new AbortController()
      this.schedule(0)
    }
    return this.view()
  }
  acknowledge(threadId: string, itemId: string, at: string): CodexMonitorView {
    const state = this.state()
    const row = state.threads[threadId]
    if (!row?.attention || row.attention.itemId !== itemId || row.attention.at !== at) return this.view()
    state.threads[threadId] = { ...row, attention: { ...row.attention, acknowledgedAt: this.now().toISOString() } }
    this.save(state)
    return this.view()
  }
  start(): void {
    if (this.started) return
    this.started = true
    if (this.state().enabled) this.schedule(0)
  }
  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.controller.abort()
    await this.running?.catch(() => {})
  }
  private schedule(delay: number): void {
    if (!this.started || !this.state().enabled) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.tick() }, delay)
  }
  private async tick(): Promise<void> {
    if (this.running || !this.state().enabled) return
    const signal = this.controller.signal
    this.running = this.scanOnce(signal).catch(error => {
      if (signal.aborted) return
      this.save({ ...this.state(), error: errorText(error) })
    })
    await this.running
    this.running = undefined
    this.schedule(this.pollMs)
  }
  private commitThread(id: string, row: StoredThread): void {
    const current = this.state()
    const acknowledged = current.threads[id]?.attention
    const attention = row.attention && acknowledged?.itemId === row.attention.itemId && acknowledged.acknowledgedAt
      ? { ...row.attention, acknowledgedAt: acknowledged.acknowledgedAt } : row.attention
    this.save({ ...current, threads: { ...current.threads,
      [id]: { ...row, ...(attention ? { attention } : {}) } } })
  }

  /** One complete inventory scan; errors preserve the last successful view and are shown on the panel. */
  async scanOnce(signal: AbortSignal = this.controller.signal): Promise<void> {
    signal.throwIfAborted()
    const rpc = await this.connect(signal)
    try {
      const discovered = await listAllCodexThreads(rpc, signal)
      const initialized = this.state().initialized
      const seenAt = this.now().toISOString()
      const ids = new Set(discovered.map(row => row.id))
      for (const candidate of discovered) {
        signal.throwIfAborted()
        const previous = this.state().threads[candidate.id]
        const changed = !previous || previous.updatedAt !== candidate.updatedAt || previous.error !== undefined
          || !previous.checkedAt || Date.parse(seenAt) - Date.parse(previous.checkedAt) >= RESCAN_MS
        if (!changed) {
          if (!previous.present || previous.name !== candidate.name || previous.archived !== candidate.archived
            || previous.sourceKind !== candidate.sourceKind || previous.parentThreadId !== candidate.parentThreadId) {
            this.commitThread(candidate.id, { ...previous, ...candidate, present: true, seenAt })
          }
          continue
        }
        let next: StoredThread
        let readDone = false
        try {
          const recent = await readRecentCodexMessages(rpc, candidate.id, signal,
            previous?.lastItemId ? { sinceItemId: previous.lastItemId } : {})
          readDone = true
          if (previous?.baselined && !recent.complete) {
            signal.throwIfAborted()
            this.commitThread(candidate.id, { ...previous, ...candidate, seenAt, present: true,
              error: 'Codex history delta exceeded the safe window' })
            continue
          }
          const context = contextOf(previous?.context ?? [], recent.messages)
          const newAssistant = recent.messages.some(message => message.role === 'assistant')
          const statusChanged = recent.latestTurnStatus === 'failed'
            && (previous?.latestTurnStatus !== recent.latestTurnStatus || previous.latestTurnId !== recent.latestTurnId)
          let attention = previous?.attention
          if (initialized && (!previous || previous.baselined) && (newAssistant && context.length || statusChanged)) {
            const prompt = buildCodexTriagePrompt({ threadId: candidate.id, title: candidate.name,
              sourceKind: candidate.sourceKind, parentThreadId: candidate.parentThreadId,
              latestTurnStatus: recent.latestTurnStatus,
              messages: context.map(({ role, text }) => ({ role, text })) })
            const itemId = statusChanged && !newAssistant ? (recent.latestTurnId ?? candidate.id)
              : (recent.newestItemId ?? recent.latestTurnId ?? candidate.id)
            const decision = await this.triage(prompt, signal, candidate.id, itemId, seenAt)
            // A later routine update does not dismiss a question the person has not handled.
            const addressedToParent = !!candidate.parentThreadId && decision.kind === 'review'
            attention = decision.needsAttention && !addressedToParent ? { decision, at: seenAt, itemId } : previous?.attention
          }
          next = { ...candidate, seenAt, checkedAt: seenAt, present: true, baselined: true, context,
            ...(recent.newestItemId ? { lastItemId: recent.newestItemId } : {}),
            ...(recent.latestTurnId ? { latestTurnId: recent.latestTurnId } : {}),
            ...(recent.latestTurnStatus ? { latestTurnStatus: recent.latestTurnStatus } : {}),
            ...(attention ? { attention } : {}) }
        } catch (error) {
          if (signal.aborted) throw error
          next = { ...(previous ?? { ...candidate, context: [] }), ...candidate,
            seenAt, present: true, error: readDone ? 'Codex model analysis unavailable' : 'Codex history read unavailable' }
        }
        signal.throwIfAborted()
        this.commitThread(candidate.id, next)
      }
      signal.throwIfAborted()
      const current = this.state()
      const threads = { ...current.threads }
      for (const [id, row] of Object.entries(threads)) if (!ids.has(id)) threads[id] = { ...row, present: false }
      this.save({ ...current, threads, initialized: true, scannedAt: seenAt, error: undefined })
    } finally { rpc.close() }
  }

  private async triage(prompt: string, signal: AbortSignal, threadId: string, itemId: string, at: string):
    Promise<CodexTriageDecision> {
    const selection = this.deps.store.settings().eval.model
      ?? (await this.deps.context.sessionController.modelCatalog()).default
    const model = selection.provider + '/' + selection.model
    this.deps.store.set(AuditKey(threadId, itemId), { at, model, prompt, response: '' })
    let response = ''
    let finish: string | undefined
    try {
      for await (const chunk of this.deps.context.llm.stream({ provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) } : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 400, signal })) {
        if (chunk.type === 'text-delta') {
          response += chunk.text
          if (response.length > 8_000) throw new Error('Codex triage response exceeded its limit')
        }
        if (chunk.type === 'finish') finish = chunk.reason.kind
      }
    } finally {
      this.deps.store.set(AuditKey(threadId, itemId), { at, model, prompt, response })
    }
    if (finish !== 'stop') throw new Error('Codex triage model did not finish')
    return parseCodexTriageDecision(response.trim())
  }
}
