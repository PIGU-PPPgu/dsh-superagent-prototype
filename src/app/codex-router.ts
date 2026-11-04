/** Global, bounded digest of persisted Codex conversations for the DSH Router and panel. */
import { key } from '../core/index.ts'
import { record } from '../kv.ts'
import type { CodexMonitor, CodexMonitorThreadView } from './codex-monitor.ts'
import type { Store } from './store.ts'

export interface CodexRouterPriority {
  threadId: string
  title: string
  summary: string
  kind: 'needsYou' | 'technical' | 'ticketNeedsYou' | 'ticketResult' | 'ticketEnded' | 'reportedComplete' | 'childFailure'
  source: 'persisted Codex history' | 'DSH ticket state'
  ticketId?: string
}
export interface CodexRouterBrief {
  asOf?: string
  mainTotal: number
  recentTotal: number
  childTotal: number
  childChecked: number
  needsYou: number
  technical: number
  managed: number
  priorities: CodexRouterPriority[]
  recent: { threadId: string; title: string; summary: string; stage?: string }[]
}
interface StoredBrief { fingerprint: string; value: CodexRouterBrief }
const BriefKey = record<StoredBrief>('codex-router-brief-v1')

const compact = (text: string | undefined, limit = 140): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
const sortedFacts = (rows: unknown[][]): string[] => rows.map(row => JSON.stringify(row)).sort()
const item = (row: CodexMonitorThreadView, kind: CodexRouterPriority['kind']): CodexRouterPriority => ({
  source: kind === 'ticketNeedsYou' || kind === 'ticketResult' || kind === 'ticketEnded'
    ? 'DSH ticket state' : 'persisted Codex history',
  threadId: row.id, title: compact(row.title, 100), summary: compact(
    kind === 'needsYou' || kind === 'technical' ? row.attention?.decision.action ?? row.attention?.decision.reason
      : kind === 'childFailure' ? `${row.childErrors} child turn(s) have a stored failed status`
        : row.summary), kind,
  ...(row.handoffTicketId ? { ticketId: row.handoffTicketId } : {}),
})

/** The source remains a history snapshot; this Router never infers Desktop runtime state from it. */
export class CodexRouter {
  constructor(private readonly deps: { store: Pick<Store, 'get' | 'set' | 'atomic'>;
    monitor: Pick<CodexMonitor, 'view'>; relay?: (id: string, text: string) => void }) {}

  view(): CodexRouterBrief { return this.deps.store.get(BriefKey)?.value ?? {
    mainTotal: 0, recentTotal: 0, childTotal: 0, childChecked: 0, needsYou: 0, technical: 0,
    managed: 0, priorities: [], recent: [] } }

  /** Save one report only when conversation meaning changes, and deliver it to the DSH main Session. */
  refresh(): CodexRouterBrief {
    const monitor = this.deps.monitor.view(0, 1000, 'recent')
    const human = monitor.attention.filter(row => row.attention?.decision.stage === 'needsYou')
    const technical = monitor.threads.filter(row => row.stage === 'failed' || row.stage === 'blocked')
    // A phase change is not a result: it must not hide a result already sent, or
    // turn the digest into a feed of every working-to-idle transition. The report
    // identity below, rather than its model-written summary, deduplicates scans.
    const results = monitor.managed.filter(row => row.handoffStage?.stage === 'idle')
    const completed = [
      ...monitor.threads.filter(row => row.stage === 'reportedComplete').map(row => ({ row, kind: 'reportedComplete' as const })),
      ...monitor.managed.filter(row => row.handoffStage?.stage === 'ended').map(row => ({ row, kind: 'ticketEnded' as const })),
    ].sort((a, b) => (b.row.activityAt ?? b.row.updatedAt ?? '').localeCompare(a.row.activityAt ?? a.row.updatedAt ?? ''))
    const priorities = [
      ...human.map(row => item(row, 'needsYou')),
      ...monitor.managed.filter(row => row.handoffStage?.stage === 'person').map(row => item(row, 'ticketNeedsYou')),
      ...technical.map(row => ({ ...item(row, 'technical'), summary: compact(row.summary) })),
      ...monitor.threads.filter(row => (row.childErrors ?? 0) > 0 && row.stage !== 'reportedComplete')
        .map(row => item(row, 'childFailure')),
      ...results.map(row => item(row, 'ticketResult')),
      ...completed.map(({ row, kind }) => item(row, kind)),
    ].slice(0, 12)
    const recent = monitor.threads.filter(row => row.summary).slice(0, 5)
      .map(row => ({ threadId: row.id, title: compact(row.title, 100), summary: compact(row.summary),
        ...(row.stage ? { stage: row.stage } : {}) }))
    const value: CodexRouterBrief = { ...(monitor.scannedAt ? { asOf: monitor.scannedAt } : {}),
      mainTotal: monitor.total, recentTotal: monitor.recentTotal ?? 0,
      childTotal: monitor.childTotal ?? 0, childChecked: monitor.checkedRecentChildTotal ?? 0,
      needsYou: human.length, technical: technical.length,
      managed: monitor.managedTotal, priorities, recent }
    const fingerprint = key('codex-router-brief', JSON.stringify({
      attention: sortedFacts(human.map(row => [row.id, row.latestTurnId, row.attention?.decision.kind,
        row.attention?.requestKey ?? [row.attention?.decision.evidence, row.attention?.decision.action]])),
      technical: sortedFacts(technical.map(row => [row.id, row.latestTurnId,
        row.stage, row.assessmentKey ?? [row.assessmentEvidence, row.summary]])),
      managed: sortedFacts(monitor.managed.filter(row => row.handoffStage?.stage === 'person')
        .map(row => [row.handoffTicketId, row.handoffStage?.stage,
          row.handoffStage && 'action' in row.handoffStage ? row.handoffStage.action : undefined])),
      results: sortedFacts(results.map(row => [row.handoffTicketId, row.handoffReportId])),
      completed: sortedFacts(completed.map(({ row, kind }) => [kind, row.id, row.handoffTicketId,
        kind === 'ticketEnded' ? row.handoffReportId : row.assessmentItemId ?? row.latestTurnId])),
      childFailure: sortedFacts(monitor.threads.filter(row => (row.childErrors ?? 0) > 0
        && row.stage !== 'reportedComplete').map(row => [row.id, row.childErrors])),
    }))
    const previous = this.deps.store.get(BriefKey)
    this.deps.store.atomic(() => {
      this.deps.store.set(BriefKey, { fingerprint, value })
      if (previous?.fingerprint !== fingerprint && this.deps.relay) this.deps.relay(`codex-router:${fingerprint}`,
        JSON.stringify({ kind: 'codex_supervisor_digest', ...value,
          source: 'persisted Codex history', instruction: 'Prioritize decisions and results. Read selected messages with orchestrator_codex_route operation=history; never assume live Desktop status or approve requests.' }))
    })
    return value
  }
}
