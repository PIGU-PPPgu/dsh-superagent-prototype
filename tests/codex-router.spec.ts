import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexRouter } from '../src/app/codex-router.ts'
import type { CodexMonitorView } from '../src/app/codex-monitor.ts'
import { Store } from '../src/app/store.ts'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('saves one compact global brief and relays only meaningful later changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-router-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const row = { id: 'thread-a', title: 'Build task', sourceKind: 'vscode', archived: false, present: true,
      stage: 'progress' as const, summary: 'Build is continuing', childCount: 2, childErrors: 1 }
    let current: CodexMonitorView = { enabled: true, scannedAt: '2026-11-03T01:00:00Z', total: 4,
      recentTotal: 2, childTotal: 8, checkedRecentChildTotal: 6, attentionTotal: 0, attention: [],
      managedTotal: 0, managed: [], threads: [row] }
    const relay = vi.fn()
    const router = new CodexRouter({ store, monitor: { view: () => current }, relay })
    expect(router.refresh()).toMatchObject({ mainTotal: 4, childChecked: 6,
      priorities: [{ threadId: 'thread-a', kind: 'childFailure' }] })
    expect(relay).toHaveBeenCalledTimes(1)
    current = { ...current, scannedAt: '2026-11-03T01:00:30Z' }
    router.refresh()
    expect(relay).toHaveBeenCalledTimes(1)
    current = { ...current, threads: [{ ...row, updatedAt: '2026-11-03T01:00:30Z',
      summary: 'The same item was paraphrased by the model' }] }
    router.refresh()
    expect(relay).toHaveBeenCalledTimes(1)
    current = { ...current, attentionTotal: 1, attention: [{ ...row,
      attention: { itemId: 'item-a', at: '2026-11-03T01:01:00Z',
        decision: { needsAttention: true, kind: 'question', stage: 'needsYou',
          reason: 'Need a choice', action: 'Choose a deployment target' } } }] }
    const report = router.refresh()
    expect(report.priorities[0]).toMatchObject({ kind: 'needsYou', summary: 'Choose a deployment target' })
    expect(relay).toHaveBeenCalledTimes(2)
    expect(JSON.parse(relay.mock.calls[1]![1])).toMatchObject({ kind: 'codex_supervisor_digest',
      source: 'persisted Codex history', needsYou: 1 })
    current = { ...current, attention: [{ ...row, attention: { itemId: 'item-a', at: '2026-11-03T01:01:00Z',
      decision: { needsAttention: true, kind: 'failure', stage: 'failed', reason: 'Build failed', action: 'Investigate' } } }],
    threads: [{ ...row, stage: 'failed', assessmentItemId: 'item-failed', summary: 'Build failed' }] }
    const technicalReport = router.refresh()
    expect(technicalReport).toMatchObject({ needsYou: 0, technical: 1 })
    expect(technicalReport.priorities[0]?.kind).toBe('technical')
    const beforeRoute = relay.mock.calls.length
    current = { ...current, attention: [], threads: [{ ...row, stage: 'failed',
      assessmentItemId: 'item-failed', routeIntentId: 'intent-one', summary: 'Build failed' }] }
    expect(router.refresh().technical).toBe(1)
    expect(relay).toHaveBeenCalledTimes(beforeRoute)
    expect(new CodexRouter({ store, monitor: { view: () => current } }).view()).toEqual(router.view())
  } finally { store.close() }
})

it('does not relay when the same facts change order or get a new item ID within one turn', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-router-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const request = { needsAttention: true, kind: 'question' as const, stage: 'needsYou' as const,
      reason: 'Need a choice', action: 'Choose a target', evidence: 'Choose a target' }
    const first = { id: 'thread-a', title: 'A', sourceKind: 'vscode', archived: false, present: true,
      latestTurnId: 'turn-a', stage: 'needsYou' as const, childErrors: 1,
      attention: { itemId: 'item-a', at: '2026-11-03T01:00:00Z', requestKey: 'request-a', decision: request } }
    const second = { id: 'thread-b', title: 'B', sourceKind: 'vscode', archived: false, present: true,
      stage: 'progress' as const, childErrors: 2 }
    let current: CodexMonitorView = { enabled: true, total: 2, attentionTotal: 1, attention: [first],
      managedTotal: 0, managed: [], threads: [first, second] }
    const relay = vi.fn()
    const router = new CodexRouter({ store, monitor: { view: () => current }, relay })
    router.refresh()
    current = { ...current, threads: [second, { ...first, attention: { ...first.attention,
      itemId: 'item-b' } }], attention: [{ ...first, attention: { ...first.attention, itemId: 'item-b' } }] }
    router.refresh()
    expect(relay).toHaveBeenCalledTimes(1)
    current = { ...current, attention: [{ ...first, attention: { ...first.attention,
      itemId: 'item-c', requestKey: 'request-b' } }] }
    router.refresh()
    expect(relay).toHaveBeenCalledTimes(2)
    current = { ...current, attention: [{ ...first, latestTurnId: 'turn-next', attention: { ...first.attention,
      itemId: 'item-d', requestKey: 'request-b' } }] }
    router.refresh()
    expect(relay).toHaveBeenCalledTimes(3)
  } finally { store.close() }
})

it('relays a new technical failure even when DSH accepts it in the same scan', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-router-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const row = { id: 'thread-a', title: 'Build', sourceKind: 'vscode', archived: false, present: true,
      latestTurnId: 'turn-a', stage: 'progress' as const, summary: 'Building' }
    let current: CodexMonitorView = { enabled: true, total: 1, attentionTotal: 0, attention: [],
      managedTotal: 0, managed: [], threads: [row] }
    const relay = vi.fn()
    const router = new CodexRouter({ store, monitor: { view: () => current }, relay })
    router.refresh()
    current = { ...current, managedTotal: 1, threads: [{ ...row, stage: 'failed',
      summary: 'Compiler failed', assessmentEvidence: 'build failed', assessmentKey: 'fault-a',
      handoffTicketId: 'ticket-a' }] }
    expect(router.refresh()).toMatchObject({ technical: 1,
      priorities: [{ kind: 'technical', ticketId: 'ticket-a', summary: 'Compiler failed' }] })
    expect(relay).toHaveBeenCalledTimes(2)
    router.refresh()
    expect(relay).toHaveBeenCalledTimes(2)
    current = { ...current, threads: [{ ...row, stage: 'failed', summary: 'Disk is full',
      assessmentEvidence: 'build failed', assessmentKey: 'fault-b', handoffTicketId: 'ticket-a' }] }
    router.refresh()
    expect(relay).toHaveBeenCalledTimes(3)
  } finally { store.close() }
})
