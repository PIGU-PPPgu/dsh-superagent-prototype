import { key } from '../../src/core/index.ts'
import { KV, record } from '../../src/kv.ts'
import type { Store } from '../../src/app/store.ts'
import type { CodexRoutingContext } from '../../src/app/codex-monitor.ts'

export const testCodexRoutingContext = (threadId: string, headItemId: string): CodexRoutingContext => ({
  threadId, title: 'Build task', headItemId, contextId: 'a'.repeat(32), readAt: '2026-11-05T08:00:00Z',
  userMessageIds: ['user-goal'], project: { name: 'Build project' },
  initialRequest: { id: 'user-goal', turnId: 'initial-turn', role: 'user', text: 'Complete the build and verification; do not push.' },
  messages: [], documents: [], coverage: { initialRequestFound: true, recentComplete: false, gaps: [] },
})

interface FixtureMonitor { version: 1; enabled: boolean; initialized: boolean; scannedAt?: string;
  autoHandoffEnabled?: boolean; autoHandoffEnabledAt?: string; autoHandoffRevision?: number; threads: Record<string, Record<string, unknown>> }
const MonitorKey = record<FixtureMonitor>('codex-monitor-v1')
const initial = (): FixtureMonitor => ({ version: 1, enabled: false, initialized: false, threads: {} })

/** Simulate an evidenced scan for tests of main-Session candidate decisions. */
export function seedCodexCandidate(store: Pick<Store, 'get' | 'set'>, threadId: string, itemId: string): void {
  const state = store.get(MonitorKey) ?? initial()
  const enabledAt = state.autoHandoffEnabledAt ?? state.scannedAt ?? '2026-11-03T05:00:00Z'
  store.set(KV.codex.intake(key('codex-handoff', threadId, itemId)), {
    threadId, itemId, generation: `${state.autoHandoffRevision ?? 0}:${enabledAt}` })
  store.set(MonitorKey, { ...state, enabled: true, autoHandoffEnabled: true, autoHandoffEnabledAt: enabledAt, initialized: true,
    threads: { ...state.threads, [threadId]: { id: threadId, name: 'Codex task', sourceKind: 'vscode', archived: false,
      present: true, baselined: true, seenAt: enabledAt, checkedAt: enabledAt, lastItemId: itemId, lastAssistantItemId: itemId,
      autoHandoffBaselineItemId: 'baseline', autoHandoffFreshItemId: itemId, autoHandoffReadComplete: true,
      context: [{ id: itemId, role: 'assistant', text: 'The build failed' }],
      assessment: { version: 5, at: enabledAt, itemId,
        decision: { needsAttention: true, kind: 'failure', stage: 'failed', reason: 'Build failed',
          action: 'Investigate', summary: 'Build failed', evidence: 'The build failed' } },
      autoHandoff: { itemId, at: enabledAt, triggerId: key('codex-handoff', threadId, itemId), enabledAt } } } })
}
