/** Background, read-only observation of every locally indexed Codex conversation. */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { family, record } from '../kv.ts'
import { key, ticketStage, type TicketStage } from '../core/index.ts'
import { CodexStdioReadRpc } from '../codex/stdio.ts'
import { listLocalCodexInventory } from '../codex/local-inventory.ts'
import { listAllCodexThreads, readLatestCodexTurn, readRecentCodexMessages, type MonitoredCodexThread } from '../codex/monitor-read.ts'
import { buildCodexTriagePrompt, currentRequestText, hasUserDecisionRequest, parseCodexTriageDecision, userDecisionRequest,
  type CodexTriageDecision, type CodexTriageInput,
  type CodexTriageStage } from '../codex/triage.ts'
import type { Store } from './store.ts'
import { CODEX_VERIFY_MESSAGE, isCodexVerification, type CodexControlIntent } from './codex-control.ts'

const POLL_MS = 30_000
const RESCAN_MS = 5 * 60_000
const ASSESSMENT_VERSION = 7
const CONTEXT_MESSAGES = 12
const CONTEXT_CHARS = 2_000
const CHILD_STATUS_HOURS = 24
const CHILD_STATUS_PER_SCAN = 60
const CHILD_STATUS_CONCURRENCY = 8
const MonitorKey = record<StoredMonitor>('codex-monitor-v1')
const AuditKey = family<{ at: string; model: string; prompt: string; response: string; finish?: string }, [threadId: string, itemId: string]>(
  'codex-monitor-audit:')

interface StoredMessage { id: string; turnId?: string; role: 'user' | 'assistant'; text: string }
interface Attention { decision: CodexTriageDecision; at: string; itemId: string; requestKey?: string;
  acknowledgedAt?: string }
interface Assessment { decision: CodexTriageDecision; at: string; itemId: string; issueKey?: string; version: number }
interface ChildTurn { updatedAt?: string; checkedAt: string; turnId?: string; status?: string; error?: string }
interface HandoffRecord { itemId: string; at: string; ticketId: string }
interface AutoHandoffRecord { itemId: string; at: string; ticketId?: string; triggerId?: string; intentId?: string;
  enabledAt?: string; ignoredAt?: string; error?: string }
interface StoredThread extends MonitoredCodexThread {
  seenAt: string
  checkedAt?: string
  present: boolean
  baselined?: boolean
  suppressBaselineAlert?: boolean
  lastItemId?: string
  lastAssistantItemId?: string
  userDecisionRequested?: boolean
  unverifiedRequestId?: string
  userHold?: boolean
  latestTurnId?: string
  latestTurnStatus?: string
  context: StoredMessage[]
  assessment?: Assessment
  attention?: Attention
  autoHandoffBaselineItemId?: string
  autoHandoffFreshItemId?: string
  autoHandoffReadComplete?: boolean
  autoHandoff?: AutoHandoffRecord
  handoffs?: HandoffRecord[]
  autoHandoffRecords?: Record<string, AutoHandoffRecord>
  error?: string
}
interface StoredMonitor {
  version: 1
  enabled: boolean
  autoHandoffEnabled?: boolean
  autoHandoffEnabledAt?: string
  autoHandoffRevision?: number
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
  assessmentItemId?: string
  assessmentEvidence?: string
  assessmentKey?: string
  agentAction?: string
  summary?: string
  childCount?: number
  childErrors?: number
  childReadErrors?: number
  activityAt?: string
  error?: string
  attention?: Attention
  attentionVerified?: boolean
  pausedByUser?: boolean
  handoffTicketId?: string
  handoffTriggerId?: string
  routeIntentId?: string
  handoffStage?: TicketStage
  handoffReportId?: string
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
  needsYouTotal?: number
  attention: CodexMonitorThreadView[]
  managedTotal: number
  managed: CodexMonitorThreadView[]
  threads: CodexMonitorThreadView[]
  nextOffset?: number
}
export interface CodexRouteHead {
  threadId: string
  lastItemId?: string
  assessmentItemId?: string
  title: string
  summary?: string
  stage?: CodexTriageStage
  updatedAt?: string
  present: boolean
  archived: boolean
  needsYou: boolean
  pausedByUser?: boolean
  verificationRequestId?: string
  ready: boolean
}
export interface CodexHistoryView {
  threadId: string
  title: string
  source: 'persisted Codex history'
  readAt: string
  complete: boolean
  headItemId?: string
  messages: { id: string; turnId: string; role: 'user' | 'assistant'; text: string; chars?: number }[]
}

/** Identify the sentence containing the quoted request or failure, excluding earlier progress sentences. */
function issueKey(kind: 'human' | 'technical' | 'agent', text: string | undefined, evidence: string | undefined): string {
  const at = evidence && text ? text.lastIndexOf(evidence) : -1
  const whole = (text ?? evidence ?? '').replace(/\s+/g, ' ').trim()
  if (at < 0) return key(`codex-${kind}-issue`, whole)
  const before = text!.slice(0, at)
  const start = Math.max(...['。', '！', '？', '!', '?', '；', ';', '\n']
    .map(separator => before.lastIndexOf(separator))) + 1
  const rest = text!.slice(at)
  const stop = rest.search(/[。！？!?；;\n]/)
  const sentence = text!.slice(start, stop < 0 ? undefined : at + stop + 1).replace(/\s+/g, ' ').trim()
  const contextDependent = sentence.replace(/[。！？!?；;\s]/g, '').length <= 6
    || /(?:上述|以上|前述|该操作|above)/i.test(sentence)
    || /(?:以下|如下)(?:操作|内容|步骤)?[:：。！？!?；;]?$|following[:：。!?]?$/.test(sentence)
  return key(`codex-${kind}-issue`, contextDependent ? whole : sentence)
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
export type CodexAutoHandoffResult = { triggerId: string } | { waiting: true }
export type CodexHandoffDecision = { kind: 'accept' | 'attach'; ticketId: string } | { kind: 'ignore' }
export interface CodexMonitorDeps {
  store: Pick<Store, 'get' | 'set' | 'settings' | 'tickets'>
  context: Pick<Context, 'llm' | 'sessionController'>
  connect?: (signal: AbortSignal) => Promise<ReadRpc>
  inventory?: (codexHome: string, signal: AbortSignal) => Promise<MonitoredCodexThread[]>
  codexHome?: string
  pollMs?: number
  now?: () => Date
  autoHandoff?: (candidate: CodexFailureCandidate, signal: AbortSignal) => Promise<CodexAutoHandoffResult>
  onScan?: () => void
}

const initial = (): StoredMonitor => ({ version: 1, enabled: false, initialized: false, threads: {} })
const errorText = (_error: unknown) => 'Codex inventory unavailable'
function humanRequestId(row: StoredThread): string | undefined {
  if (row.attention?.decision.stage === 'needsYou') return key('codex-human-request', row.id,
    row.attention.itemId, row.attention.requestKey ?? row.attention.decision.evidence ?? '')
  if (!row.userDecisionRequested) return undefined
  if (row.unverifiedRequestId) return row.unverifiedRequestId
  if (row.attention) return undefined
  const assessment = row.assessment
  return assessment?.decision.stage === 'unknown' && assessment.decision.reason === '历史请求未确认' && assessment.decision.evidence
    ? key('codex-historical-request', row.id, assessment.itemId, assessment.decision.evidence) : undefined
}

/** A person's explicit pause survives status questions and DSH coordination messages. */
function userHold(messages: readonly StoredMessage[], held = false): boolean {
  for (const message of messages) {
    if (message.role !== 'user' || message.text.startsWith('DSH Superagent coordination for this existing conversation.')) continue
    const text = currentRequestText(message.text)
    const pause = /(?:^|[。！？.!?\n；;，,])\s*(?:请|先|请先|现在|暂时)?\s*(?:停止|暂停|停下|不要继续|先别继续)(?:一下)?(?:[^。！？\n]{0,48}(?:直到|等我|等你|等用户|除非)[^。！？\n]{0,24}(?:说|确认|回复|通知|允许|同意)|(?:当前|这个|本)?(?:任务|对话|工作)?(?:一下)?\s*(?:[。！!，,；;]|$))/.test(text)
      || /(?:^|[.!?\n;])\s*(?:please\s+)?(?:stop|pause|hold|do not continue)\b[^.!?\n]{0,60}\buntil\s+(?:i|you|the user)\s+(?:say|tell|allow|instruct)\b/i.test(text)
      || /^\s*(?:please\s+)?(?:stop|pause|hold|do not continue)(?:\s+(?:this|the|current))?(?:\s+(?:task|work|conversation))?[.!]?\s*$/i.test(text)
    if (pause) held = true
    else if (text.split(/[。！!\n；;，,]/).some(clause => !/[?？]|(?:怎么样|怎样|如何|到哪|吗|么|呢)(?:了)?\s*$/.test(clause)
      && !/只有|如果|除非|直到|等我|等到|(?:必须|需要|要)先.{0,24}(?:同意|批准|确认|授权|回复)|(?:继续|恢复).{0,24}(?:之前|前)\s*(?:必须|需要|请|先|要|需|得|等|应)|\b(?:before|until|unless|if|when|after|must|require)\b/i.test(clause)
      && (/^\s*(?:请|现在|可以|允许)?\s*(?:继续|恢复)(?=$|\s|执行|处理|工作|排查|检查|验证|任务|推进|修复|吧)/.test(clause)
        || /^\s*(?:please\s+)?(?:resume|continue|go ahead)(?=$|\s)/i.test(clause)))) held = false
  }
  return held
}
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
  private readonly historyReads = new Set<Promise<CodexHistoryView>>()
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

  /** Only a known main conversation may receive a router intent; the item ID is a stale-work guard. */
  routeHead(threadId: string): CodexRouteHead | undefined {
    const row = this.state().threads[threadId]
    if (!row || !isMain(row)) return undefined
    return { threadId, title: row.name ?? threadId, present: row.present, archived: row.archived,
      ready: !!row.baselined && !row.error && !!row.lastItemId,
      ...(row.lastItemId ? { lastItemId: row.lastItemId } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(row.assessment?.decision.summary ? { summary: row.assessment.decision.summary } : {}),
      ...(row.assessment?.decision.stage ? { stage: row.assessment.decision.stage } : {}),
      ...(row.assessment?.itemId ? { assessmentItemId: row.assessment.itemId } : {}),
      needsYou: row.assessment?.decision.stage === 'needsYou' || row.userDecisionRequested === true || row.userHold === true,
      ...(!row.userHold && row.assessment?.decision.stage !== 'needsYou' && humanRequestId(row)
        && (!row.attention || row.unverifiedRequestId && row.attention.decision.stage !== 'needsYou'
          || row.attention.decision.stage === 'needsYou' && !row.attention.acknowledgedAt
          && !row.context.some(message => message.role === 'assistant' && message.id === row.attention?.itemId))
        ? { verificationRequestId: humanRequestId(row) } : {}),
      ...(row.userHold ? { pausedByUser: true } : {}) }
  }

  /** Give the DSH main Session bounded stored context without claiming a live Desktop state. */
  async readHistory(threadId: string, limit: number, signal: AbortSignal): Promise<CodexHistoryView> {
    const state = this.state(), row = state.threads[threadId]
    if (!state.enabled || !row?.present || !isMain(row)) throw new Error('Codex main conversation is not monitored')
    if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('Codex history limit must be 1-12')
    const combined = AbortSignal.any([signal, this.controller.signal])
    const reading = (async (): Promise<CodexHistoryView> => {
      combined.throwIfAborted()
      const rpc = await this.connect(combined)
      try {
        combined.throwIfAborted()
        const recent = await readRecentCodexMessages(rpc, threadId, combined)
        combined.throwIfAborted()
        return { threadId, title: row.name ?? threadId, source: 'persisted Codex history',
          readAt: this.now().toISOString(), complete: recent.complete && recent.messages.length <= limit,
          ...(recent.newestItemId ? { headItemId: recent.newestItemId } : {}),
          messages: recent.messages.slice(-limit).map(message => ({
            id: message.id, turnId: message.turnId, role: message.role, text: message.text.slice(0, 1_200),
            ...(message.text.length > 1_200 ? { chars: message.text.length } : {}) })) }
      } finally { rpc.close() }
    })()
    this.historyReads.add(reading)
    try { return await reading } finally { this.historyReads.delete(reading) }
  }

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
    const verifiedAttention = (row: StoredThread) => row.attention?.decision.stage !== 'needsYou'
      || row.context.some(message => message.role === 'assistant' && message.id === row.attention?.itemId)
    const display = (row: StoredThread): CodexMonitorThreadView => ({
      id: row.id, title: row.name ?? row.id, sourceKind: row.sourceKind, archived: row.archived,
      present: row.present, ...(row.parentThreadId ? { parentThreadId: row.parentThreadId } : {}),
      ...(row.repository ? { repository: row.repository } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(row.latestTurnId ? { latestTurnId: row.latestTurnId } : {}),
      ...(row.latestTurnStatus ? { latestTurnStatus: row.latestTurnStatus } : {}),
      ...(row.assessment?.decision.stage ? { stage: row.assessment.decision.stage } : {}),
      ...(row.assessment?.itemId ? { assessmentItemId: row.assessment.itemId } : {}),
      ...(row.assessment?.decision.evidence ? { assessmentEvidence: row.assessment.decision.evidence } : {}),
      ...(row.assessment?.issueKey ? { assessmentKey: row.assessment.issueKey } : {}),
      ...(row.assessment?.decision.stage === 'needsAgent' ? { agentAction: row.assessment.decision.action } : {}),
      ...(row.assessment?.decision.summary ? { summary: row.assessment.decision.summary } : {}),
      childCount: childStats[row.id]?.count ?? 0,
      childErrors: childStats[row.id]?.errors ?? 0,
      childReadErrors: childStats[row.id]?.readErrors ?? 0,
      activityAt: activityAt(row),
      ...(row.error ? { error: row.error } : {}),
      ...(row.attention ? { attention: row.attention, attentionVerified: verifiedAttention(row) } : {}),
      ...(row.userHold ? { pausedByUser: true } : {}),
      ...(row.autoHandoff?.ticketId ? { handoffTicketId: row.autoHandoff.ticketId } : {}),
      ...(row.autoHandoff?.triggerId ? { handoffTriggerId: row.autoHandoff.triggerId } : {}),
      ...(row.autoHandoff?.intentId ? { routeIntentId: row.autoHandoff.intentId } : {}),
      ...(row.autoHandoff?.ticketId && this.deps.store.tickets.get(row.autoHandoff.ticketId)
        ? { handoffStage: ticketStage(this.deps.store.tickets.get(row.autoHandoff.ticketId)!) } : {}),
      ...(row.autoHandoff?.error ? { handoffError: row.autoHandoff.error } : {}),
    })
    const attention = roots.filter(row => !row.archived && row.attention?.decision.needsAttention
      && verifiedAttention(row)
      && !row.attention.acknowledgedAt
      && !((row.autoHandoff?.ticketId || row.autoHandoff?.intentId)
        && row.autoHandoff.itemId === row.attention.itemId
        && row.attention.decision.stage !== 'needsYou'))
    const managed = roots.flatMap(row => {
      const history = row.handoffs ?? (row.autoHandoff?.ticketId ? [row.autoHandoff as HandoffRecord] : [])
      return history.map(handoff => {
        const ticket = this.deps.store.tickets.get(handoff.ticketId)
        const assignment = ticket?.assignments.at(-1), report = assignment?.report
        const { summary: _currentSummary, ...rowView } = display(row)
        const summary = report?.summary ?? (handoff.itemId === row.assessment?.itemId ? row.assessment.decision.summary : undefined)
        return { ...rowView, title: ticket?.title ?? row.name ?? row.id,
          ...(summary ? { summary } : {}),
          handoffTicketId: handoff.ticketId,
          ...(assignment && report ? { handoffReportId: key('codex-ticket-report', assignment.id, report.state, report.summary) } : {}),
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
      attentionTotal: attention.length, needsYouTotal: attention.filter(row => row.attention?.decision.stage === 'needsYou').length,
      attention: attention.slice(0, 50).map(display),
      managedTotal: managed.length, managed: managed.slice(0, 50),
      threads: shown.slice(offset, offset + limit).map(display),
      ...(offset + limit < shown.length ? { nextOffset: offset + limit } : {}) }
  }
  setEnabled(enabled: boolean): CodexMonitorView {
    const state = this.state()
    this.save({ ...state, enabled })
    if (!enabled) { this.controller.abort(); if (this.timer) clearTimeout(this.timer) }
    else {
      if (this.controller.signal.aborted) this.controller = new AbortController()
      if (this.started) this.schedule(0)
    }
    return this.view()
  }
  setAutoHandoff(enabled: boolean): CodexMonitorView {
    const state = this.state()
    const starting = enabled && !state.autoHandoffEnabled
    this.save({ ...state, autoHandoffEnabled: enabled,
      autoHandoffRevision: (state.autoHandoffRevision ?? 0) + Number(enabled !== !!state.autoHandoffEnabled),
      ...(starting ? { autoHandoffEnabledAt: this.now().toISOString(),
        threads: Object.fromEntries(Object.entries(state.threads).map(([id, row]) =>
          [id, { ...row, autoHandoffBaselineItemId: row.lastItemId ?? '', autoHandoffFreshItemId: undefined }])) } : {}) })
    return this.view()
  }
  /** Revokes prior candidate grants even when disable and re-enable share a clock tick. */
  handoffGeneration(): string | undefined {
    const state = this.state()
    return state.enabled && state.autoHandoffEnabled && state.autoHandoffEnabledAt
      ? `${state.autoHandoffRevision ?? 0}:${state.autoHandoffEnabledAt}` : undefined
  }
  /** Reconcile a successful main-Session decision with the monitor's durable handoff history. */
  handoffDecision(triggerId: string, decision: CodexHandoffDecision): void {
    const state = this.state()
    const found = Object.entries(state.threads).find(([, row]) => row.autoHandoff?.triggerId === triggerId
      || row.autoHandoffRecords?.[triggerId])
    if (!found) throw new Error('Codex handoff candidate is no longer current')
    const [threadId, row] = found
    const current = row.autoHandoffRecords?.[triggerId] ?? row.autoHandoff!
    if (decision.kind === 'ignore') {
      const ignored = { ...current, ignoredAt: current.ignoredAt ?? this.now().toISOString(), error: undefined }
      this.commitThread(threadId, { ...row,
        ...(row.autoHandoff?.triggerId === triggerId ? { autoHandoff: ignored } : {}),
        autoHandoffRecords: { ...row.autoHandoffRecords, [triggerId]: ignored } })
      return
    }
    if (current.ticketId === decision.ticketId) return
    const fresh = state.enabled && state.autoHandoffEnabled && current.enabledAt === state.autoHandoffEnabledAt
      && row.present && !row.archived && row.assessment?.itemId === current.itemId
      && row.context.at(-1)?.id === current.itemId && row.context.at(-1)?.role === 'assistant'
      && !row.userDecisionRequested && !row.error
    if (!fresh || current.ignoredAt) throw new Error('Codex handoff candidate is stale or automatic intake is disabled')
    const previous = row.autoHandoff
    const history = row.handoffs ?? (previous?.ticketId ? [{ itemId: previous.itemId, at: previous.at, ticketId: previous.ticketId }] : [])
    this.commitThread(threadId, { ...row, autoHandoff: { ...current, ticketId: decision.ticketId, error: undefined },
      autoHandoffRecords: { ...row.autoHandoffRecords, [triggerId]: { ...current, ticketId: decision.ticketId, error: undefined } },
      handoffs: history.some(handoff => handoff.ticketId === decision.ticketId)
        ? history : [...history, { itemId: current.itemId, at: this.now().toISOString(), ticketId: decision.ticketId }] })
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
    await Promise.allSettled([this.running, ...this.historyReads])
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
          || (!candidate.archived && previous.assessment?.version !== ASSESSMENT_VERSION
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
            const anchor = recent.newestItemId
            this.commitThread(candidate.id, anchor && anchor !== previous.lastItemId
              ? { ...previous, ...candidate, seenAt, checkedAt: seenAt, present: true,
                context: contextOf([], recent.messages), lastItemId: anchor,
                lastAssistantItemId: recent.latestAssistantItemId,
                latestTurnId: recent.latestTurnId ?? previous.latestTurnId,
                latestTurnStatus: recent.latestTurnStatus ?? previous.latestTurnStatus,
                assessment: undefined, attention: undefined,
                autoHandoffFreshItemId: undefined, autoHandoffReadComplete: false,
                error: 'Codex history gap; latest items became the new baseline' }
              : { ...previous, ...candidate, seenAt, present: true,
                error: 'Codex history delta exceeded the safe window' })
            continue
          }
          const context = contextOf(previous?.context ?? [], recent.messages)
          const held = userHold(previous?.assessment?.version === ASSESSMENT_VERSION ? recent.messages : context, previous?.userHold)
          const newAssistant = recent.messages.some(message => message.role === 'assistant')
          const newUser = recent.messages.some(message => message.role === 'user'
            && !message.text.startsWith('DSH Superagent coordination for this existing conversation.'))
          const latestAssistantId = recent.latestAssistantItemId ?? (newAssistant ? undefined : previous?.lastAssistantItemId)
          const latestContext = context.at(-1)
          const latestAssistantText = latestContext?.role === 'assistant'
            ? ([...recent.messages].reverse().find(message => message.role === 'assistant')?.text
              ?? latestContext.text) : undefined
          const assistantRequest = latestAssistantText ? userDecisionRequest(latestAssistantText) : undefined
          const statusChanged = recent.latestTurnStatus === 'failed'
            && (previous?.latestTurnStatus !== recent.latestTurnStatus || previous.latestTurnId !== recent.latestTurnId)
          let attention = previous?.attention
          let assessment = previous?.assessment
          let userDecisionRequested = previous?.userDecisionRequested ?? false
          const reconcile = previous?.assessment?.version !== ASSESSMENT_VERSION
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
            const classified: CodexTriageDecision = held
              ? { needsAttention: false, kind: 'none', stage: 'unknown', reason: '遵守用户暂停', action: '保持暂停', summary: '按用户要求暂停，等待明确恢复' }
              : assistantRequest && decision.stage !== 'needsYou'
              ? { needsAttention: true, stage: 'needsYou', kind: assistantRequest.kind,
                reason: '最新助手消息需要你处理', action: '打开原会话处理请求',
                summary: decision.summary, evidence: assistantRequest.evidence } : decision
            const fresh = previous?.baselined ? newAssistant || statusChanged
              : initialized && !previous?.suppressBaselineAlert
                && Date.parse(candidate.updatedAt ?? seenAt) >= Date.parse(seenAt) - 10 * 60_000
            const visible = (classified.needsAttention || classified.stage === 'needsAgent') && !fresh && !previous?.attention
              ? { ...classified, needsAttention: false, kind: 'none' as const, stage: 'unknown' as const,
                reason: '历史请求未确认', action: '无需处理' } : classified
            assessment = { decision: visible, at: seenAt, itemId, version: ASSESSMENT_VERSION,
              ...((visible.stage === 'failed' || visible.stage === 'blocked')
                ? { issueKey: issueKey('technical', latestAssistantText, visible.evidence) }
                : visible.stage === 'needsAgent' ? { issueKey: issueKey('agent', latestAssistantText, visible.evidence) } : {}) }
            const requestKey = visible.stage === 'needsYou'
              ? issueKey('human', latestAssistantText, visible.evidence) : undefined
            const latestAttention: Attention | undefined = visible.needsAttention && (fresh || !!previous?.attention)
              ? { decision: visible, at: seenAt, itemId, ...(requestKey ? { requestKey } : {}) } : undefined
            // Keep an unanswered human request visible while retaining the latest technical assessment.
            const reclassified = reconcile && previous?.attention?.itemId === itemId
            const verificationReply = newAssistant && latestContext?.role === 'assistant' && !!latestContext.turnId
              && context.some(message => message.role === 'user' && message.turnId === latestContext.turnId && message.text === CODEX_VERIFY_MESSAGE)
              && Object.values(this.deps.store.get<{ intents: Record<string, CodexControlIntent> }>('codex-control-v1')?.intents ?? {})
                .some(intent => isCodexVerification(intent) && intent.status === 'sent' && intent.threadId === candidate.id
                  && intent.turnId === latestContext.turnId && !!previous && intent.verificationRequestId === humanRequestId(previous))
            const resolved = verificationReply && classified.stage !== 'needsYou' && !assistantRequest
              && currentRequestText(latestAssistantText ?? '').split(/[。！？!?；;\n.]/).some(clause =>
                /(?:旧|此前|之前|先前|早先|历史).{0,24}(?:请求|人工待办|审批|确认).{0,16}(?:(?:已|已经)(?:解决|失效|撤销|取消)|不再需要)|\b(?:old|previous|earlier)\s+(?:human\s+|approval\s+)?request\b.{0,40}\b(?:resolved|withdrawn|obsolete|no longer (?:needed|required))\b/i.test(clause)
                && !/未|没|无法|不能|不是|不确定|如果|假如|假设|或许|可能|只要|除非|一旦|将会|\b(?:not|if|may|might|unless|once|when|would)\b/i.test(clause))
            const pending = previous?.attention?.decision.stage === 'needsYou' && !newUser && !reclassified && !held && !resolved
            const sameRequest = visible.stage === 'needsYou'
              && previous?.attention?.decision.kind === visible.kind
              && previous.attention.requestKey === requestKey
            attention = pending && (visible.stage !== 'needsYou' || sameRequest) ? previous.attention : latestAttention
            userDecisionRequested = !held && (classified.stage === 'needsYou' || !!assistantRequest
              || !newUser && !reclassified && !resolved
              && (!!previous?.userDecisionRequested || previous?.attention?.decision.stage === 'needsYou'))
          } else if ((newUser || reconcile) && context.at(-1)?.role === 'user'
            && !context.at(-1)!.text.startsWith('DSH Superagent coordination for this existing conversation.')) {
            const itemId = context.at(-1)?.id ?? recent.newestItemId ?? candidate.id
            assessment = { version: ASSESSMENT_VERSION, at: seenAt, itemId, decision: { needsAttention: false,
              kind: 'none', stage: held ? 'unknown' : 'progress', summary: held ? '按用户要求暂停，等待明确恢复' : '最近记录为用户消息，等待后续进展',
              reason: '已收到用户消息', action: held ? '保持暂停' : '无需处理' } }
            attention = undefined
            userDecisionRequested = false
          }
          next = { ...candidate, seenAt, checkedAt: seenAt, present: true, baselined: true, context, userHold: held,
            ...(previous?.autoHandoffBaselineItemId !== undefined
              ? { autoHandoffBaselineItemId: previous.autoHandoffBaselineItemId } : {}),
            ...(previous?.autoHandoff ? { autoHandoff: previous.autoHandoff } : {}),
            ...(previous?.handoffs ? { handoffs: previous.handoffs } : {}),
      autoHandoffRecords: { ...previous?.autoHandoffRecords,
        ...(previous?.autoHandoff?.triggerId ? { [previous.autoHandoff.triggerId]: previous.autoHandoff } : {}) },
            autoHandoffReadComplete: recent.complete,
            ...(this.state().autoHandoffEnabled && newAssistant && recent.complete
              && (previous?.baselined || candidate.updatedAt &&
                Date.parse(candidate.updatedAt) > Date.parse(this.state().autoHandoffEnabledAt ?? ''))
              ? { autoHandoffFreshItemId: recent.latestAssistantItemId }
              : !reconcile && previous?.autoHandoffFreshItemId
                ? { autoHandoffFreshItemId: previous.autoHandoffFreshItemId } : {}),
            ...(recent.newestItemId ? { lastItemId: recent.newestItemId } : {}),
            ...(latestAssistantId ? { lastAssistantItemId: latestAssistantId } : {}),
            userDecisionRequested,
            ...(recent.latestTurnId ? { latestTurnId: recent.latestTurnId } : {}),
            ...(recent.latestTurnStatus ? { latestTurnStatus: recent.latestTurnStatus } : {}),
            ...(assessment ? { assessment } : {}),
            ...(attention ? { attention } : {}) }
          if (userDecisionRequested && attention?.decision.stage !== 'needsYou') {
            const requestId = previous && humanRequestId(previous) || humanRequestId(next)
            if (requestId) next.unverifiedRequestId = requestId
          }
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
      this.deps.onScan?.()
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
        || row.userDecisionRequested || row.userHold
        || hasUserDecisionRequest(row.context.at(-1)!.text)
        || !row.autoHandoffReadComplete || row.autoHandoffFreshItemId !== assessment.itemId
        || assessment.itemId !== row.context.at(-1)?.id
        || Date.parse(assessment.at) <= Date.parse(state.autoHandoffEnabledAt)
        || row.autoHandoffBaselineItemId === assessment.itemId
        || (row.autoHandoffBaselineItemId === undefined || row.autoHandoffBaselineItemId === '')
          && (!row.updatedAt || Date.parse(row.updatedAt) <= Date.parse(state.autoHandoffEnabledAt))
        || previous?.itemId === assessment.itemId && (previous.ticketId || previous.triggerId || previous.ignoredAt || previous.intentId
          || previous.error && Date.parse(this.now().toISOString()) - Date.parse(previous.at) < RESCAN_MS)) continue
      signal.throwIfAborted()
      const at = this.now().toISOString()
      try {
        const candidate = { threadId, itemId: assessment.itemId, title: row.name ?? threadId,
          summary: assessment.decision.summary ?? 'Codex reported a failure',
          evidence: assessment.decision.evidence,
          stage: assessment.decision.stage,
          ...(row.context.at(-1)?.turnId ? { turnId: row.context.at(-1)?.turnId } : {}),
          ...(row.repository ? { repository: row.repository } : {}),
          messages: row.context.map(({ role, text }) => ({ role, text })) } satisfies CodexFailureCandidate
        const result = await handler(candidate, signal)
        const current = this.state().threads[threadId] ?? row
        if ('waiting' in result) continue
        this.commitThread(threadId, { ...current, autoHandoff: { itemId: assessment.itemId, at,
          triggerId: result.triggerId, enabledAt: state.autoHandoffEnabledAt, error: undefined } })
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
      this.deps.store.set(AuditKey(threadId, itemId), { at, model, prompt, response,
        ...(finish ? { finish } : {}) })
    }
    signal.throwIfAborted()
    if (finish !== 'stop' && finish !== 'max-tokens') throw new Error('Codex triage model did not finish successfully')
    const decision = parseCodexTriageDecision(response.trim(), input)
    if (!decision.stage || !decision.summary) throw new Error('Codex triage result lacks progress')
    return decision
  }
}
