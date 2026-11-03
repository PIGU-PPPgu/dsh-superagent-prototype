/** Background, read-only observation of every locally indexed Codex conversation. */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { family, record } from '../kv.ts'
import { ticketStage, type TicketStage } from '../core/index.ts'
import { CodexStdioReadRpc } from '../codex/stdio.ts'
import { listLocalCodexInventory } from '../codex/local-inventory.ts'
import { listAllCodexThreads, readLatestCodexTurn, readRecentCodexMessages, type MonitoredCodexThread } from '../codex/monitor-read.ts'
import { buildCodexTriagePrompt, hasUserDecisionRequest, parseCodexTriageDecision, userDecisionRequest,
  type CodexTriageDecision, type CodexTriageInput,
  type CodexTriageStage } from '../codex/triage.ts'
import type { Store } from './store.ts'

const POLL_MS = 30_000
const RESCAN_MS = 5 * 60_000
const CONTEXT_MESSAGES = 12
const CONTEXT_CHARS = 2_000
const CHILD_STATUS_HOURS = 24
const CHILD_STATUS_PER_SCAN = 60
const CHILD_STATUS_CONCURRENCY = 8
const MonitorKey = record<StoredMonitor>('codex-monitor-v1')
const AuditKey = family<{ at: string; model: string; prompt: string; response: string }, [threadId: string, itemId: string]>(
  'codex-monitor-audit:')

interface StoredMessage { id: string; turnId?: string; role: 'user' | 'assistant'; text: string }
interface Attention { decision: CodexTriageDecision; at: string; itemId: string; acknowledgedAt?: string }
interface Assessment { decision: CodexTriageDecision; at: string; itemId: string; version: 4 }
interface ChildTurn { updatedAt?: string; checkedAt: string; turnId?: string; status?: string; error?: string }
interface HandoffRecord { itemId: string; at: string; ticketId: string }
interface StoredThread extends MonitoredCodexThread {
  seenAt: string
  checkedAt?: string
  present: boolean
  baselined?: boolean
  suppressBaselineAlert?: boolean
  lastItemId?: string
  lastAssistantItemId?: string
  userDecisionRequested?: boolean
  latestTurnId?: string
  latestTurnStatus?: string
  context: StoredMessage[]
  assessment?: Assessment
  attention?: Attention
  autoHandoffBaselineItemId?: string
  autoHandoffFreshItemId?: string
  autoHandoffReadComplete?: boolean
  autoHandoff?: { itemId: string; at: string; ticketId?: string; error?: string }
  handoffs?: HandoffRecord[]
  error?: string
}
interface StoredMonitor {
  version: 1
  enabled: boolean
  autoHandoffEnabled?: boolean
  autoHandoffEnabledAt?: string
  initialized: boolean
  scannedAt?: string
  error?: string
  threads: Record<string, StoredThread>
  childStats?: Record<string, { count: number; lastAt?: string; errors?: number; checked?: number; readErrors?: number }>
  childTurns?: Record<string, ChildTurn>
  inventoryTotal?: number
  inventoryChildTotal?: number
  inventoryRecentChildTotal?: number
  inventoryCheckedRecentChildTotal?: number
  inventoryUnclassifiedTotal?: number
  inventoryUnlinkedTotal?: number
  inventoryUnlinkedChildErrorsTotal?: number
  inventoryWithoutParentTotal?: number
  inventoryUnresolvedParentTotal?: number
}
export interface CodexMonitorThreadView {
  id: string
  title: string
  sourceKind: string
  parentThreadId?: string
  repository?: string
  archived: boolean
  updatedAt?: string
  latestTurnId?: string
  latestTurnStatus?: string
  present: boolean
  stage?: CodexTriageStage
  summary?: string
  childCount?: number
  childErrors?: number
  childReadErrors?: number
  activityAt?: string
  error?: string
  attention?: Attention
  handoffTicketId?: string
  handoffStage?: TicketStage
  handoffError?: string
}
export interface CodexMonitorView {
  enabled: boolean
  autoHandoffEnabled?: boolean
  scannedAt?: string
  error?: string
  total: number
  threadTotal?: number
  childTotal?: number
  recentChildTotal?: number
  checkedRecentChildTotal?: number
  childReadErrorsTotal?: number
  archivedTotal?: number
  unlinkedTotal?: number
  unlinkedChildErrors?: number
  withoutParentTotal?: number
  unresolvedParentTotal?: number
  unclassifiedTotal?: number
  recentTotal?: number
  attentionTotal: number
  attention: CodexMonitorThreadView[]
  managedTotal: number
  managed: CodexMonitorThreadView[]
  threads: CodexMonitorThreadView[]
  nextOffset?: number
}
type ReadRpc = Pick<CodexStdioReadRpc, 'request' | 'close'>
export interface CodexFailureCandidate {
  threadId: string
  itemId: string
  title: string
  summary: string
  evidence: string
  stage?: 'failed' | 'blocked'
  turnId?: string
  repository?: string
  messages: { role: 'user' | 'assistant'; text: string }[]
}
export interface CodexMonitorDeps {
  store: Pick<Store, 'get' | 'set' | 'settings' | 'tickets'>
  context: Pick<Context, 'llm' | 'sessionController'>
  connect?: (signal: AbortSignal) => Promise<ReadRpc>
  inventory?: (codexHome: string, signal: AbortSignal) => Promise<MonitoredCodexThread[]>
  codexHome?: string
  pollMs?: number
  now?: () => Date
  autoHandoff?: (candidate: CodexFailureCandidate, signal: AbortSignal) => Promise<string>
}

const initial = (): StoredMonitor => ({ version: 1, enabled: false, initialized: false, threads: {} })
const errorText = (_error: unknown) => 'Codex inventory unavailable'
const isChild = (row: MonitoredCodexThread): boolean =>
  !!row.parentThreadId || row.sourceKind.startsWith('subAgent')
const isMain = (row: MonitoredCodexThread): boolean => !isChild(row) && row.sourceKind !== 'unknown'
const contextOf = (previous: readonly StoredMessage[], added: readonly StoredMessage[]): StoredMessage[] => {
  const byId = new Map(previous.map(item => [item.id, item]))
  for (const item of added) byId.set(item.id, { ...item, text: item.text.slice(0, CONTEXT_CHARS) })
  return [...byId.values()].slice(-CONTEXT_MESSAGES)
}
const maxTime = (first?: string, second?: string): string | undefined =>
  [first, second].filter((value): value is string => !!value).sort().at(-1)
function combineInventory(local: readonly MonitoredCodexThread[], rpc: readonly MonitoredCodexThread[]): MonitoredCodexThread[] {
  const joined = new Map(local.map(row => [row.id, row]))
  for (const row of rpc) {
    const file = joined.get(row.id)
    joined.set(row.id, file ? {
      ...file, ...row, archived: file.archived,
      name: row.name ?? file.name,
      sourceKind: row.sourceKind === 'unknown' ? file.sourceKind : row.sourceKind,
      parentThreadId: row.parentThreadId ?? file.parentThreadId,
      repository: row.repository ?? file.repository,
      updatedAt: maxTime(file.updatedAt, row.updatedAt),
    } : row)
  }
  return [...joined.values()]
}
function childCounts(rows: readonly MonitoredCodexThread[], turns: Readonly<Record<string, ChildTurn>> = {}) {
  const byId = new Map(rows.map(row => [row.id, row]))
  const stats: Record<string, { count: number; lastAt?: string; errors: number; checked: number; readErrors: number }> = {}
  let withoutParent = 0
  let unresolvedParent = 0
  let unlinkedErrors = 0
  for (const row of rows.filter(isChild)) {
    if (!row.parentThreadId) {
      withoutParent++
      unlinkedErrors += Number(turns[row.id]?.status === 'failed')
      continue
    }
    let parent: string | undefined = row.parentThreadId
    const visited = new Set([row.id])
    while (parent && !visited.has(parent)) {
      const found = byId.get(parent)
      if (!found || isMain(found)) break
      visited.add(parent)
      parent = found.parentThreadId
    }
    if (!parent || !byId.has(parent) || !isMain(byId.get(parent)!)) {
      unresolvedParent++
      unlinkedErrors += Number(turns[row.id]?.status === 'failed')
      continue
    }
    const current = stats[parent] ?? { count: 0, errors: 0, checked: 0, readErrors: 0 }
    stats[parent] = { count: current.count + 1,
      errors: current.errors + Number(turns[row.id]?.status === 'failed'),
      checked: current.checked + Number(!!turns[row.id]?.status),
      readErrors: current.readErrors + Number(!!turns[row.id]?.error),
      ...(maxTime(current.lastAt, row.updatedAt)
      ? { lastAt: maxTime(current.lastAt, row.updatedAt) } : {}) }
  }
  return { stats, unlinked: withoutParent + unresolvedParent, withoutParent, unresolvedParent, unlinkedErrors }
}

/** The monitor never resumes, subscribes to, messages, or interrupts a Codex thread. */
export class CodexMonitor {
  private readonly connect: (signal: AbortSignal) => Promise<ReadRpc>
  private readonly inventory: (codexHome: string, signal: AbortSignal) => Promise<MonitoredCodexThread[]>
  private readonly codexHome: string
  private readonly pollMs: number
  private readonly now: () => Date
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private controller = new AbortController()
  private started = false

  constructor(private readonly deps: CodexMonitorDeps) {
    this.connect = deps.connect ?? (signal => CodexStdioReadRpc.connect({ timeoutMs: 30_000, signal }))
    this.inventory = deps.inventory ?? listLocalCodexInventory
    this.codexHome = deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.pollMs = deps.pollMs ?? POLL_MS
    this.now = deps.now ?? (() => new Date())
  }
  private state(): StoredMonitor { return this.deps.store.get(MonitorKey) ?? initial() }
  private save(value: StoredMonitor): void { this.deps.store.set(MonitorKey, value) }

  view(offset = 0, limit = 50, scope: 'recent' | 'all' = 'recent'): CodexMonitorView {
    const state = this.state()
    const present = Object.values(state.threads).filter(row => row.present)
    const roots = present.filter(isMain)
    const childStats = state.childStats ?? {}
    const activityAt = (row: StoredThread) => [row.updatedAt ?? row.seenAt,
      childStats[row.id]?.lastAt ?? ''].sort().at(-1)!
    roots.sort((a, b) => Number(a.archived) - Number(b.archived) || activityAt(b).localeCompare(activityAt(a)))
    const recentCutoff = this.now().getTime() - 7 * 86_400_000
    const recent = roots.filter(row => !row.archived && Date.parse(activityAt(row)) >= recentCutoff)
    const shown = scope === 'all' ? roots : recent
    const display = (row: StoredThread): CodexMonitorThreadView => ({
      id: row.id, title: row.name ?? row.id, sourceKind: row.sourceKind, archived: row.archived,
      present: row.present, ...(row.parentThreadId ? { parentThreadId: row.parentThreadId } : {}),
      ...(row.repository ? { repository: row.repository } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(row.latestTurnId ? { latestTurnId: row.latestTurnId } : {}),
      ...(row.latestTurnStatus ? { latestTurnStatus: row.latestTurnStatus } : {}),
      ...(row.assessment?.decision.stage ? { stage: row.assessment.decision.stage } : {}),
      ...(row.assessment?.decision.summary ? { summary: row.assessment.decision.summary } : {}),
      childCount: childStats[row.id]?.count ?? 0,
      childErrors: childStats[row.id]?.errors ?? 0,
      childReadErrors: childStats[row.id]?.readErrors ?? 0,
      activityAt: activityAt(row),
      ...(row.error ? { error: row.error } : {}),
      ...(row.attention ? { attention: row.attention } : {}),
      ...(row.autoHandoff?.ticketId ? { handoffTicketId: row.autoHandoff.ticketId } : {}),
      ...(row.autoHandoff?.ticketId && this.deps.store.tickets.get(row.autoHandoff.ticketId)
        ? { handoffStage: ticketStage(this.deps.store.tickets.get(row.autoHandoff.ticketId)!) } : {}),
      ...(row.autoHandoff?.error ? { handoffError: row.autoHandoff.error } : {}),
    })
    const attention = roots.filter(row => !row.archived && row.attention?.decision.needsAttention
      && !row.attention.acknowledgedAt
      && !(row.autoHandoff?.ticketId && row.autoHandoff.itemId === row.attention.itemId
        && row.attention.decision.stage !== 'needsYou'))
    const managed = roots.flatMap(row => {
      const history = row.handoffs ?? (row.autoHandoff?.ticketId ? [row.autoHandoff as HandoffRecord] : [])
      return history.map(handoff => {
        const ticket = this.deps.store.tickets.get(handoff.ticketId)
        const report = ticket?.assignments.at(-1)?.report
        const { summary: _currentSummary, ...rowView } = display(row)
        const summary = report?.summary ?? (handoff.itemId === row.assessment?.itemId ? row.assessment.decision.summary : undefined)
        return { ...rowView, title: ticket?.title ?? row.name ?? row.id,
          ...(summary ? { summary } : {}),
          handoffTicketId: handoff.ticketId,
          ...(ticket ? { handoffStage: ticketStage(ticket) } : {}),
          activityAt: ticket?.updatedAt ?? handoff.at }
      })
    }).sort((a, b) => (b.activityAt ?? '').localeCompare(a.activityAt ?? ''))
    return { enabled: state.enabled, autoHandoffEnabled: !!state.autoHandoffEnabled,
      ...(state.scannedAt ? { scannedAt: state.scannedAt } : {}),
      ...(state.error ? { error: state.error } : {}), total: roots.length,
      threadTotal: state.inventoryTotal ?? present.length,
      childTotal: state.inventoryChildTotal ?? present.filter(isChild).length,
      recentChildTotal: state.inventoryRecentChildTotal ?? 0,
      checkedRecentChildTotal: state.inventoryCheckedRecentChildTotal ?? 0,
      childReadErrorsTotal: Object.values(state.childTurns ?? {}).filter(row => row.error).length,
      archivedTotal: roots.filter(row => row.archived).length,
      recentTotal: recent.length,
      unlinkedTotal: state.inventoryUnlinkedTotal ?? 0,
      unlinkedChildErrors: state.inventoryUnlinkedChildErrorsTotal ?? 0,
      ...(state.inventoryWithoutParentTotal !== undefined
        ? { withoutParentTotal: state.inventoryWithoutParentTotal } : {}),
      ...(state.inventoryUnresolvedParentTotal !== undefined
        ? { unresolvedParentTotal: state.inventoryUnresolvedParentTotal } : {}),
      unclassifiedTotal: state.inventoryUnclassifiedTotal ?? present.filter(row => row.sourceKind === 'unknown').length,
      attentionTotal: attention.length, attention: attention.slice(0, 50).map(display),
      managedTotal: managed.length, managed: managed.slice(0, 50),
      threads: shown.slice(offset, offset + limit).map(display),
      ...(offset + limit < shown.length ? { nextOffset: offset + limit } : {}) }
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
  setAutoHandoff(enabled: boolean): CodexMonitorView {
    const state = this.state()
    const starting = enabled && !state.autoHandoffEnabled
    this.save({ ...state, autoHandoffEnabled: enabled,
      ...(starting ? { autoHandoffEnabledAt: this.now().toISOString(),
        threads: Object.fromEntries(Object.entries(state.threads).map(([id, row]) =>
          [id, { ...row, autoHandoffBaselineItemId: row.lastItemId ?? '', autoHandoffFreshItemId: undefined }])) } : {}) })
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

  /** Read only recent child turn metadata, bounded per scan; the parent remains responsible for child work. */
  private async scanChildTurns(rows: readonly MonitoredCodexThread[], rpc: ReadRpc, previous: StoredMonitor,
    at: string, signal: AbortSignal): Promise<Record<string, ChildTurn>> {
    const cutoff = Date.parse(at) - CHILD_STATUS_HOURS * 3_600_000
    const children = rows.filter(row => isChild(row) && !row.archived && row.updatedAt
      && Date.parse(row.updatedAt) >= cutoff)
    const known = previous.childTurns ?? {}
    const discovered = new Set(rows.filter(isChild).map(row => row.id))
    const kept: Record<string, ChildTurn> = Object.fromEntries(Object.entries(known)
      .filter(([id]) => discovered.has(id)))
    const due = children.filter(row => !known[row.id] || known[row.id]?.updatedAt !== row.updatedAt
      || Date.parse(at) - Date.parse(known[row.id]?.checkedAt ?? '') >= RESCAN_MS)
      .sort((a, b) => (known[a.id]?.checkedAt ? Date.parse(known[a.id]!.checkedAt) : 0)
        - (known[b.id]?.checkedAt ? Date.parse(known[b.id]!.checkedAt) : 0)
        || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, CHILD_STATUS_PER_SCAN)
    for (let index = 0; index < due.length; index += CHILD_STATUS_CONCURRENCY) {
      const batch = due.slice(index, index + CHILD_STATUS_CONCURRENCY)
      const results = await Promise.all(batch.map(async row => {
        try {
          const turn = await readLatestCodexTurn(rpc, row.id, signal)
          return { id: row.id, value: { updatedAt: row.updatedAt, checkedAt: at,
            ...(turn ? { turnId: turn.id, status: turn.status } : {}) } satisfies ChildTurn }
        } catch (error) {
          if (signal.aborted) throw error
          return { id: row.id, value: { updatedAt: row.updatedAt, checkedAt: at,
            ...(known[row.id]?.turnId ? { turnId: known[row.id]!.turnId } : {}),
            ...(known[row.id]?.status ? { status: known[row.id]!.status } : {}),
            error: 'Codex child turn unavailable' } satisfies ChildTurn }
        }
      }))
      signal.throwIfAborted()
      for (const result of results) kept[result.id] = result.value
    }
    return kept
  }

  /** One complete inventory scan; errors preserve the last successful view and are shown on the panel. */
  async scanOnce(signal: AbortSignal = this.controller.signal): Promise<void> {
    signal.throwIfAborted()
    const rpc = await this.connect(signal)
    try {
      const fromRpc = await listAllCodexThreads(rpc, signal)
      let fromDisk: MonitoredCodexThread[] = []
      let inventoryError: string | undefined
      try { fromDisk = await this.inventory(this.codexHome, signal) }
      catch {
        if (signal.aborted) throw new Error('Codex inventory cancelled')
        inventoryError = 'Codex local file inventory unavailable'
      }
      const discovered = combineInventory(fromDisk, fromRpc)
      const initialized = this.state().initialized
      const seenAt = this.now().toISOString()
      const ids = new Set(discovered.map(row => row.id))
      const current = this.state()
      const discoveredById = new Map(discovered.map(row => [row.id, row]))
      const threads: Record<string, StoredThread> = Object.fromEntries(
        Object.entries(current.threads).filter(([id, row]) => isMain(discoveredById.get(id) ?? row)))
      const recentCutoff = Date.parse(seenAt) - 7 * 86_400_000
      for (const candidate of discovered.filter(isMain)) {
        if (!candidate.archived && candidate.updatedAt && Date.parse(candidate.updatedAt) >= recentCutoff) continue
        const previous = threads[candidate.id]
        if (previous && previous.updatedAt === candidate.updatedAt && previous.name === candidate.name
          && previous.archived === candidate.archived && previous.present) continue
        threads[candidate.id] = { ...(previous ?? { context: [] }), ...candidate, seenAt, checkedAt: seenAt,
          present: true, baselined: previous?.baselined ?? false,
          ...(!previous?.baselined ? { suppressBaselineAlert: true } : {}) }
      }
      const childTurns = inventoryError ? current.childTurns ?? {}
        : await this.scanChildTurns(discovered, rpc, current, seenAt, signal)
      const { stats, unlinked, withoutParent, unresolvedParent, unlinkedErrors } = childCounts(discovered, childTurns)
      const recentChildren = discovered.filter(row => isChild(row) && !row.archived && row.updatedAt
        && Date.parse(row.updatedAt) >= Date.parse(seenAt) - CHILD_STATUS_HOURS * 3_600_000)
      this.save({ ...current, threads,
        childTurns,
        childStats: inventoryError ? current.childStats : stats,
        inventoryTotal: inventoryError ? current.inventoryTotal : discovered.length,
        inventoryChildTotal: inventoryError ? current.inventoryChildTotal : discovered.filter(isChild).length,
        inventoryRecentChildTotal: inventoryError ? current.inventoryRecentChildTotal : recentChildren.length,
        inventoryCheckedRecentChildTotal: inventoryError ? current.inventoryCheckedRecentChildTotal
          : recentChildren.filter(row => childTurns[row.id]?.updatedAt === row.updatedAt && !childTurns[row.id]?.error).length,
        inventoryUnclassifiedTotal: inventoryError ? current.inventoryUnclassifiedTotal
          : discovered.filter(row => row.sourceKind === 'unknown').length,
        inventoryUnlinkedTotal: inventoryError ? current.inventoryUnlinkedTotal : unlinked,
        inventoryUnlinkedChildErrorsTotal: inventoryError ? current.inventoryUnlinkedChildErrorsTotal : unlinkedErrors,
        inventoryWithoutParentTotal: inventoryError ? current.inventoryWithoutParentTotal : withoutParent,
        inventoryUnresolvedParentTotal: inventoryError ? current.inventoryUnresolvedParentTotal : unresolvedParent,
        ...(inventoryError ? { error: inventoryError } : {}) })
      const recentRoots = discovered.filter(row => isMain(row) && !row.archived && row.updatedAt
        && Date.parse(row.updatedAt) >= recentCutoff)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      for (const candidate of recentRoots) {
        signal.throwIfAborted()
        const previous = this.state().threads[candidate.id]
        const changed = !previous || previous.updatedAt !== candidate.updatedAt
          || (previous.error !== undefined && previous.error !== 'Codex model analysis unavailable')
          || !previous.checkedAt || Date.parse(seenAt) - Date.parse(previous.checkedAt) >= RESCAN_MS
          || (!candidate.archived && previous.assessment?.version !== 4
            && previous.error !== 'Codex model analysis unavailable')
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
          const newUser = recent.messages.some(message => message.role === 'user')
          const latestAssistantId = recent.latestAssistantItemId ?? (newAssistant ? undefined : previous?.lastAssistantItemId)
          const latestContext = context.at(-1)
          const assistantRequest = latestContext?.role === 'assistant'
            ? userDecisionRequest([...recent.messages].reverse().find(message => message.role === 'assistant')?.text
              ?? latestContext.text) : undefined
          const statusChanged = recent.latestTurnStatus === 'failed'
            && (previous?.latestTurnStatus !== recent.latestTurnStatus || previous.latestTurnId !== recent.latestTurnId)
          let attention = previous?.attention
          let assessment = previous?.assessment
          const reconcile = previous?.assessment?.version !== 4
          if (!candidate.archived && (context.at(-1)?.role === 'assistant' || statusChanged)
            && (newAssistant || statusChanged || reconcile)) {
            const input: CodexTriageInput = { threadId: candidate.id, title: candidate.name,
              sourceKind: candidate.sourceKind, parentThreadId: candidate.parentThreadId,
              latestTurnStatus: recent.latestTurnStatus,
              messages: statusChanged && !newAssistant ? [] : context.map(({ role, text }) => ({ role, text })) }
            const prompt = buildCodexTriagePrompt(input)
            const itemId = statusChanged && !newAssistant ? (recent.latestTurnId ?? candidate.id)
              : (latestAssistantId ?? context.at(-1)?.id ?? recent.latestTurnId ?? candidate.id)
            const decision = await this.triage(prompt, input, signal, candidate.id, itemId, seenAt).catch(error => {
              if (!assistantRequest || signal.aborted) throw error
              return { needsAttention: true, stage: 'needsYou', kind: assistantRequest.kind,
                reason: '最新助手消息需要你处理', action: '打开原会话处理请求',
                summary: '等待处理最新助手请求', evidence: assistantRequest.evidence } as CodexTriageDecision
            })
            const classified: CodexTriageDecision = assistantRequest && decision.stage !== 'needsYou'
              ? { needsAttention: true, stage: 'needsYou', kind: assistantRequest.kind,
                reason: '最新助手消息需要你处理', action: '打开原会话处理请求',
                summary: decision.summary, evidence: assistantRequest.evidence } : decision
            const fresh = previous?.baselined ? newAssistant || statusChanged
              : initialized && !previous?.suppressBaselineAlert
                && Date.parse(candidate.updatedAt ?? seenAt) >= Date.parse(seenAt) - 10 * 60_000
            const visible = classified.needsAttention && !fresh && !previous?.attention
              ? { ...classified, needsAttention: false, kind: 'none' as const, stage: 'unknown' as const,
                reason: '历史请求未确认', action: '无需处理' } : classified
            assessment = { decision: visible, at: seenAt, itemId, version: 4 }
            attention = visible.needsAttention && (fresh || !!previous?.attention)
              ? { decision: visible, at: seenAt, itemId } : undefined
          } else if ((newUser || reconcile) && context.at(-1)?.role === 'user') {
            const itemId = context.at(-1)?.id ?? recent.newestItemId ?? candidate.id
            assessment = { version: 4, at: seenAt, itemId, decision: { needsAttention: false,
              kind: 'none', stage: 'progress', summary: '最近记录为用户消息，等待后续进展',
              reason: '已收到用户消息', action: '无需处理' } }
            attention = undefined
          }
          next = { ...candidate, seenAt, checkedAt: seenAt, present: true, baselined: true, context,
            ...(previous?.autoHandoffBaselineItemId !== undefined
              ? { autoHandoffBaselineItemId: previous.autoHandoffBaselineItemId } : {}),
            ...(previous?.autoHandoff ? { autoHandoff: previous.autoHandoff } : {}),
            ...(previous?.handoffs ? { handoffs: previous.handoffs } : {}),
            autoHandoffReadComplete: recent.complete,
            ...(this.state().autoHandoffEnabled && newAssistant && recent.complete
              && (previous?.baselined || candidate.updatedAt &&
                Date.parse(candidate.updatedAt) > Date.parse(this.state().autoHandoffEnabledAt ?? ''))
              ? { autoHandoffFreshItemId: recent.latestAssistantItemId }
              : !reconcile && previous?.autoHandoffFreshItemId
                ? { autoHandoffFreshItemId: previous.autoHandoffFreshItemId } : {}),
            ...(recent.newestItemId ? { lastItemId: recent.newestItemId } : {}),
            ...(latestAssistantId ? { lastAssistantItemId: latestAssistantId } : {}),
            userDecisionRequested: !!assistantRequest || !!previous?.userDecisionRequested && !newAssistant,
            ...(recent.latestTurnId ? { latestTurnId: recent.latestTurnId } : {}),
            ...(recent.latestTurnStatus ? { latestTurnStatus: recent.latestTurnStatus } : {}),
            ...(assessment ? { assessment } : {}),
            ...(attention ? { attention } : {}) }
        } catch (error) {
          if (signal.aborted) throw error
          next = { ...(previous ?? { ...candidate, context: [] }), ...candidate,
            seenAt, ...(readDone ? { checkedAt: seenAt } : {}), present: true,
            ...(!previous?.baselined && !initialized ? { suppressBaselineAlert: true } : {}),
            error: readDone ? 'Codex model analysis unavailable' : 'Codex history read unavailable' }
        }
        signal.throwIfAborted()
        this.commitThread(candidate.id, next)
      }
      signal.throwIfAborted()
      const latest = this.state()
      const nextThreads = { ...latest.threads }
      if (!inventoryError) for (const [id, row] of Object.entries(nextThreads)) {
        if (!ids.has(id)) nextThreads[id] = { ...row, present: false }
      }
      this.save({ ...latest, threads: nextThreads, initialized: true, scannedAt: seenAt,
        ...(inventoryError ? { error: inventoryError } : { error: undefined }) })
      await this.processAutoHandoffs(signal)
    } finally { rpc.close() }
  }

  /** New, evidenced failures may start a separate DSH Ticket; all old history remains a baseline. */
  private async processAutoHandoffs(signal: AbortSignal): Promise<void> {
    const state = this.state(), handler = this.deps.autoHandoff
    if (!state.enabled || !state.autoHandoffEnabled || !state.autoHandoffEnabledAt || !handler) return
    for (const [threadId, row] of Object.entries(state.threads)) {
      const assessment = row.assessment, previous = row.autoHandoff
      if (!row.present || row.archived || !isMain(row) || row.error
        || (assessment?.decision.stage !== 'failed' && assessment?.decision.stage !== 'blocked')
        || !assessment.decision.evidence || row.context.at(-1)?.role !== 'assistant'
        || !row.context.at(-1)?.text.includes(assessment.decision.evidence)
        || row.userDecisionRequested
        || hasUserDecisionRequest(row.context.at(-1)!.text)
        || !row.autoHandoffReadComplete || row.autoHandoffFreshItemId !== assessment.itemId
        || assessment.itemId !== row.context.at(-1)?.id
        || Date.parse(assessment.at) <= Date.parse(state.autoHandoffEnabledAt)
        || row.autoHandoffBaselineItemId === assessment.itemId
        || (row.autoHandoffBaselineItemId === undefined || row.autoHandoffBaselineItemId === '')
          && (!row.updatedAt || Date.parse(row.updatedAt) <= Date.parse(state.autoHandoffEnabledAt))
        || previous?.itemId === assessment.itemId && (previous.ticketId
          || previous.error && Date.parse(this.now().toISOString()) - Date.parse(previous.at) < RESCAN_MS)) continue
      signal.throwIfAborted()
      const at = this.now().toISOString()
      try {
        const ticketId = await handler({ threadId, itemId: assessment.itemId, title: row.name ?? threadId,
          summary: assessment.decision.summary ?? 'Codex reported a failure',
          evidence: assessment.decision.evidence,
          stage: assessment.decision.stage,
          ...(row.context.at(-1)?.turnId ? { turnId: row.context.at(-1)?.turnId } : {}),
          ...(row.repository ? { repository: row.repository } : {}),
          messages: row.context.map(({ role, text }) => ({ role, text })) }, signal)
        const current = this.state().threads[threadId] ?? row
        const history = current.handoffs ?? (current.autoHandoff?.ticketId ? [current.autoHandoff as HandoffRecord] : [])
        this.commitThread(threadId, { ...current, autoHandoff: { itemId: assessment.itemId, at, ticketId },
          handoffs: history.some(handoff => handoff.ticketId === ticketId)
            ? history : [...history, { itemId: assessment.itemId, at, ticketId }] })
      } catch (error) {
        if (signal.aborted) throw error
        const current = this.state().threads[threadId] ?? row
        this.commitThread(threadId, { ...current, autoHandoff: { itemId: assessment.itemId, at,
          error: 'Codex handoff unavailable' } })
      }
    }
  }

  private async triage(prompt: string, input: CodexTriageInput, signal: AbortSignal, threadId: string, itemId: string, at: string):
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
    const decision = parseCodexTriageDecision(response.trim(), input)
    if (!decision.stage || !decision.summary) throw new Error('Codex triage result lacks progress')
    return decision
  }
}
