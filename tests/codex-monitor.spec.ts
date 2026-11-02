import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexMonitor, type CodexMonitorDeps } from '../src/app/codex-monitor.ts'
import { Store } from '../src/app/store.ts'
import type { MonitoredCodexThread } from '../src/codex/monitor-read.ts'
import { listLocalCodexInventory } from '../src/codex/local-inventory.ts'

const directories: string[] = []
const stores: Store[] = []
const progressDecision = JSON.stringify({ needsAttention: false, stage: 'progress', kind: 'none',
  reason: '仍在处理', action: '无需处理', summary: '正在处理发布任务' })
const reviewDecision = JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'review',
  reason: '结果待审阅', action: '检查发布结果', summary: '发布结果已提交审阅', evidence: '请检查发布结果' })
const failureDecision = JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
  reason: '执行失败', action: '检查失败原因', summary: '历史记录显示执行失败' })
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-monitor-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  stores.push(store)
  let phase = 0
  let failRead = false
  let missingAnchor = false
  let longHistory = false
  let longBaselineSeen = false
  let freezeUpdatedAt = false
  let now = new Date('2026-11-01T12:30:00Z')
  let latestTurnId = 'turn-a'
  let latestTurnStatus = 'completed'
  let suppressNewAssistant = false
  let subagent = false
  let childCount = 0
  let includeRpcRoot = true
  let updatedAtOverride: number | undefined
  let localRows: MonitoredCodexThread[] = []
  let decisionText: string | undefined
  let modelGate: Promise<void> | undefined
  const requests: string[] = []
  const rpc = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push(method)
      if (method === 'thread/list') return { data: params.archived ? [] : [...(includeRpcRoot ? [{
        id: 'thread-a', name: 'Release task', source: subagent
          ? { subAgent: { thread_spawn: { parent_thread_id: 'parent-a' } } } : 'vscode',
        updatedAt: updatedAtOverride ?? 1793530000 + (freezeUpdatedAt ? 0 : phase * 30),
      }] : []), ...Array.from({ length: childCount }, (_, index) => ({
        id: 'child-' + index, source: { subAgent: { thread_spawn: { parent_thread_id: 'thread-a' } } },
        updatedAt: 1793530000,
      }))], nextCursor: null }
      if (method === 'thread/turns/list') return { data: [{ id: latestTurnId, status: latestTurnStatus }] }
      if (method === 'thread/items/list') {
        if (failRead) throw new Error('read failed')
        if (longHistory) { longBaselineSeen = true; return { data: Array.from({ length: 13 }, (_, index) => ({
          turnId: 'turn-a', item: { id: `baseline-${13 - index}`, type: 'agentMessage', text: '旧进展' },
        })), nextCursor: null } }
        return { data: [
          ...(phase && !suppressNewAssistant ? [{ turnId: latestTurnId, item: { id: `answer-new-${phase}`, type: 'agentMessage',
            text: '请检查发布结果' } }] : []),
          ...(phase > 1 && !suppressNewAssistant ? [{ turnId: 'turn-a', item: { id: 'answer-new-1', type: 'agentMessage',
            text: '请检查发布结果' } }] : []),
          ...(longBaselineSeen ? [{ turnId: 'turn-a', item: { id: 'baseline-13', type: 'agentMessage',
            text: '旧进展' } }] : []),
          ...missingAnchor ? [] : [{ turnId: 'turn-a', item: { id: 'answer-old', type: 'agentMessage', text: '正在处理' } },
          { turnId: 'turn-a', item: { id: 'question-old', type: 'userMessage', content: [
            { type: 'text', text: '请处理发布' },
          ] } }],
        ], nextCursor: null }
      }
      throw new Error('Unexpected method')
    }),
    close: vi.fn(),
  }
  const stream = vi.fn(async function* () {
    await modelGate
    yield { type: 'text-delta', index: 0, text: decisionText ?? (phase ? reviewDecision : progressDecision) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const context = { llm: { stream }, sessionController: { modelCatalog: async () =>
    ({ default: { provider: 'magpie', model: 'test-model' } }) } } as unknown as CodexMonitorDeps['context']
  const connect = vi.fn(async () => rpc as unknown as Awaited<ReturnType<NonNullable<CodexMonitorDeps['connect']>>>)
  const inventory = vi.fn(async () => localRows)
  const monitor = new CodexMonitor({ store, context, connect, inventory, now: () => now })
  return { store, monitor, rpc, stream, inventory, requests, setPhase: (value: number) => { phase = value },
    setFailRead: (value: boolean) => { failRead = value },
    setMissingAnchor: (value: boolean) => { missingAnchor = value },
    setLongHistory: (value: boolean) => { longHistory = value },
    setFreezeUpdatedAt: (value: boolean) => { freezeUpdatedAt = value },
    advanceMinutes: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000) },
    setTurn: (id: string, status: string) => { latestTurnId = id; latestTurnStatus = status },
    setSuppressNewAssistant: (value: boolean) => { suppressNewAssistant = value },
    setSubagent: (value: boolean) => { subagent = value },
    setChildCount: (value: number) => { childCount = value },
    setIncludeRpcRoot: (value: boolean) => { includeRpcRoot = value },
    setUpdatedAt: (value: string) => { updatedAtOverride = Date.parse(value) / 1000 },
    setLocalRows: (rows: MonitoredCodexThread[]) => { localRows = rows },
    setDecision: (value: string) => { decisionText = value },
    holdModel: () => {
      let release!: () => void
      modelGate = new Promise<void>(resolve => { release = resolve })
      return () => { release(); modelGate = undefined }
    } }
}

it('summarizes existing conversations and alerts on later assistant action', async () => {
  const { store, monitor, rpc, stream, requests, setPhase } = fixture()
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ total: 1, attentionTotal: 0, scannedAt: '2026-11-01T12:30:00.000Z' })
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().threads[0]?.summary).toBe('正在处理发布任务')
  expect(rpc.close).toHaveBeenCalledTimes(1)

  setPhase(1)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  expect(monitor.view().attention).toMatchObject([{ id: 'thread-a',
    attention: { decision: { kind: 'review', needsAttention: true } } }])
  expect(JSON.stringify(monitor.view())).not.toContain('请处理发布')
  expect(monitor.view().threads[0]).not.toHaveProperty('context')
  expect(requests.filter(method => method === 'thread/items/list')).toHaveLength(2)

  const firstAttention = monitor.view().attention[0]!.attention!
  monitor.acknowledge('thread-a', firstAttention.itemId, firstAttention.at)
  expect(monitor.view().attentionTotal).toBe(0)
  const restarted = new CodexMonitor({ store, context: { llm: { stream }, sessionController: {
    modelCatalog: async () => ({ default: { provider: 'magpie', model: 'test-model' } }),
  } } as unknown as CodexMonitorDeps['context'], connect: async () => rpc as unknown as
    Awaited<ReturnType<NonNullable<CodexMonitorDeps['connect']>>>, inventory: async () => [] })
  await restarted.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  expect(restarted.view().attentionTotal).toBe(0)
})

it('preserves the previous checkpoint when an incremental read fails', async () => {
  const { monitor, stream, setPhase, setFailRead } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setFailRead(true)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().threads[0]?.error).toBe('Codex history read unavailable')
  setFailRead(false)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  expect(monitor.view().attentionTotal).toBe(1)
})

it('establishes a summary after a failed first read without a stale alert', async () => {
  const { monitor, stream, setPhase, setFailRead, setLongHistory } = fixture()
  setFailRead(true)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.error).toBeDefined()
  setFailRead(false)
  setLongHistory(true)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.error).toBeUndefined()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().attentionTotal).toBe(0)
  setLongHistory(false)
  setPhase(1)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
})

it('backs off invalid model decisions until the next rescan', async () => {
  const { monitor, stream, setDecision, advanceMinutes } = fixture()
  setDecision(reviewDecision)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.error).toBe('Codex model analysis unavailable')
  expect(monitor.view().attentionTotal).toBe(0)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)

  setDecision(progressDecision)
  advanceMinutes(6)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  expect(monitor.view().threads[0]?.error).toBeUndefined()
  expect(monitor.view().threads[0]?.summary).toBe('正在处理发布任务')
})

it('retries a model decision immediately when the conversation changes', async () => {
  const { monitor, stream, setDecision, setPhase } = fixture()
  setDecision(reviewDecision)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.error).toBe('Codex model analysis unavailable')
  setDecision(progressDecision)
  setPhase(1)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  expect(monitor.view().threads[0]?.error).toBeUndefined()
})

it('keeps an acknowledgement made while the model is finishing a later routine update', async () => {
  const { monitor, stream, setPhase, setDecision, holdModel } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(1)
  setPhase(2)
  setDecision(progressDecision)
  const release = holdModel()
  const scanning = monitor.scanOnce()
  await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(3))
  const firstAttention = monitor.view().attention[0]!.attention!
  monitor.acknowledge('thread-a', firstAttention.itemId, firstAttention.at)
  release()
  await scanning
  expect(monitor.view().attentionTotal).toBe(0)
  expect(monitor.view().threads[0]?.stage).toBe('progress')
})

it('does not dismiss a newer alert using the version of an older visible alert', async () => {
  const { monitor, setPhase } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  const old = monitor.view().attention[0]!.attention!
  setPhase(2)
  await monitor.scanOnce()
  const current = monitor.view().attention[0]!.attention!
  expect(current.itemId).not.toBe(old.itemId)
  monitor.acknowledge('thread-a', old.itemId, old.at)
  expect(monitor.view().attentionTotal).toBe(1)
  monitor.acknowledge('thread-a', current.itemId, current.at)
  expect(monitor.view().attentionTotal).toBe(0)
})

it('analyzes a second failed turn even when the previous turn also failed and no message arrived', async () => {
  const { monitor, stream, setPhase, setTurn, setSuppressNewAssistant, setDecision } = fixture()
  setTurn('turn-first', 'failed')
  await monitor.scanOnce()
  setSuppressNewAssistant(true)
  setDecision(failureDecision)
  setPhase(1)
  setTurn('turn-second', 'failed')
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  const first = monitor.view().attention[0]!.attention!
  monitor.acknowledge('thread-a', first.itemId, first.at)
  setPhase(2)
  setTurn('turn-third', 'failed')
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(3)
  expect(monitor.view().attentionTotal).toBe(1)
  expect(monitor.view().attention[0]!.attention!.itemId).toBe('turn-third')
})

it('groups a child thread without an independent model call or alert', async () => {
  const { monitor, stream, setPhase, setSubagent } = fixture()
  setSubagent(true)
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  setPhase(2)
  await monitor.scanOnce()
  expect(stream).not.toHaveBeenCalled()
  expect(monitor.view()).toMatchObject({ total: 0, childTotal: 1, attentionTotal: 0 })
})

it('groups 31 child threads under one main conversation without 31 model calls', async () => {
  const { monitor, stream, requests, setChildCount } = fixture()
  setChildCount(31)
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ total: 1, childTotal: 31, threadTotal: 32 })
  expect(monitor.view().threads[0]).toMatchObject({ id: 'thread-a', childCount: 31 })
  expect(stream).toHaveBeenCalledTimes(1)
  expect(requests.filter(method => method === 'thread/items/list')).toHaveLength(1)
})

it('adds a main conversation found only in the local rollout inventory', async () => {
  const { monitor, stream, inventory, setLocalRows } = fixture()
  setLocalRows([{ id: 'disk-main', name: 'Older project', sourceKind: 'vscode',
    updatedAt: '2026-11-01T11:00:00Z', archived: false }])
  await monitor.scanOnce()
  expect(inventory).toHaveBeenCalledTimes(1)
  expect(monitor.view()).toMatchObject({ total: 2, recentTotal: 2, threadTotal: 2 })
  expect(monitor.view().threads.map(thread => thread.id).sort()).toEqual(['disk-main', 'thread-a'])
  expect(stream).toHaveBeenCalledTimes(2)
})

it('establishes an old conversation baseline when it becomes active after a long history', async () => {
  const { monitor, stream, setIncludeRpcRoot, setLocalRows, setLongHistory } = fixture()
  setIncludeRpcRoot(false)
  setLocalRows([{ id: 'old-root', name: 'Older task', sourceKind: 'vscode',
    updatedAt: '2026-10-01T12:00:00Z', archived: false }])
  await monitor.scanOnce()
  expect(monitor.view(0, 50, 'all').total).toBe(1)
  expect(stream).not.toHaveBeenCalled()
  setLongHistory(true)
  setLocalRows([{ id: 'old-root', name: 'Older task', sourceKind: 'vscode',
    updatedAt: '2026-11-01T12:29:00Z', archived: false }])
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.error).toBeUndefined()
  expect(monitor.view().threads[0]?.stage).toBe('progress')
  expect(monitor.view().attentionTotal).toBe(0)
  expect(stream).toHaveBeenCalledTimes(1)
})

it('detects a resumed old rollout even when the Codex database timestamp stays stale', async () => {
  const { monitor, stream, setIncludeRpcRoot, setLocalRows } = fixture()
  setIncludeRpcRoot(false)
  const home = mkdtempSync(join(tmpdir(), 'codex-monitor-mtime-'))
  directories.push(home)
  const id = 'aaaaaaaa-1111-4111-8111-111111111111'
  const path = join(home, 'sessions', '2026', '11', '02',
    'rollout-2026-11-02T00-00-00-' + id + '.jsonl')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{}\n')
  const old = new Date('2026-10-01T00:00:00Z')
  utimesSync(path, old, old)
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec('create table threads (id text, name text, title text, source text, updated_at integer)')
  db.prepare('insert into threads values (?, ?, ?, ?, ?)').run(id, 'Older task', null, 'vscode', old.getTime() / 1000)
  db.close()
  setLocalRows(await listLocalCodexInventory(home, new AbortController().signal))
  await monitor.scanOnce()
  expect(stream).not.toHaveBeenCalled()
  const resumed = new Date('2026-11-01T12:29:00Z')
  utimesSync(path, resumed, resumed)
  setLocalRows(await listLocalCodexInventory(home, new AbortController().signal))
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().threads[0]?.stage).toBe('progress')
})

it('removes a former main conversation after it is identified as a child thread', async () => {
  const { monitor, setPhase, setSubagent } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(1)
  setSubagent(true)
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ total: 0, childTotal: 1, attentionTotal: 0 })
})

it('does not replay a recent historical request after its first baseline read failed', async () => {
  const { monitor, stream, setPhase, setFailRead, setUpdatedAt } = fixture()
  setPhase(1)
  setUpdatedAt('2026-11-01T12:29:00Z')
  setFailRead(true)
  await monitor.scanOnce()
  expect(stream).not.toHaveBeenCalled()
  setFailRead(false)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().attentionTotal).toBe(0)
  expect(monitor.view().threads[0]?.stage).toBe('unknown')
})

it('keeps the checkpoint and shows a coverage gap when the incremental anchor disappears', async () => {
  const { monitor, stream, setPhase, setMissingAnchor } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setMissingAnchor(true)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().threads[0]?.error).toContain('safe window')
  setMissingAnchor(false)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
})

it('rescans after five minutes even when Codex updatedAt has not advanced', async () => {
  const { monitor, stream, setPhase, setFreezeUpdatedAt, advanceMinutes } = fixture()
  setFreezeUpdatedAt(true)
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  advanceMinutes(6)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
})
