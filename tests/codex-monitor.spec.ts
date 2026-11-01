import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexMonitor, type CodexMonitorDeps } from '../src/app/codex-monitor.ts'
import { Store } from '../src/app/store.ts'

const directories: string[] = []
const stores: Store[] = []
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
  let decisionText = '{"needsAttention":true,"kind":"review","reason":"发布结果待审阅","action":"检查发布结果"}'
  let modelGate: Promise<void> | undefined
  const requests: string[] = []
  const rpc = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push(method)
      if (method === 'thread/list') return { data: params.archived ? [] : [{
        id: 'thread-a', name: 'Release task', source: subagent
          ? { subAgent: { thread_spawn: { parent_thread_id: 'parent-a' } } } : 'vscode',
        updatedAt: 1793530000 + (freezeUpdatedAt ? 0 : phase * 30),
      }], nextCursor: null }
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
    yield { type: 'text-delta', index: 0, text: decisionText }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const context = { llm: { stream }, sessionController: { modelCatalog: async () =>
    ({ default: { provider: 'magpie', model: 'test-model' } }) } } as unknown as CodexMonitorDeps['context']
  const connect = vi.fn(async () => rpc as unknown as Awaited<ReturnType<NonNullable<CodexMonitorDeps['connect']>>>)
  const monitor = new CodexMonitor({ store, context, connect, now: () => now })
  return { store, monitor, rpc, stream, requests, setPhase: (value: number) => { phase = value },
    setFailRead: (value: boolean) => { failRead = value },
    setMissingAnchor: (value: boolean) => { missingAnchor = value },
    setLongHistory: (value: boolean) => { longHistory = value },
    setFreezeUpdatedAt: (value: boolean) => { freezeUpdatedAt = value },
    advanceMinutes: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000) },
    setTurn: (id: string, status: string) => { latestTurnId = id; latestTurnStatus = status },
    setSuppressNewAssistant: (value: boolean) => { suppressNewAssistant = value },
    setSubagent: (value: boolean) => { subagent = value },
    setDecision: (value: string) => { decisionText = value },
    holdModel: () => {
      let release!: () => void
      modelGate = new Promise<void>(resolve => { release = resolve })
      return () => { release(); modelGate = undefined }
    } }
}

it('baselines existing conversations, analyzes only later assistant changes, and persists acknowledgement', async () => {
  const { store, monitor, rpc, stream, requests, setPhase } = fixture()
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ total: 1, attentionTotal: 0, scannedAt: '2026-11-01T12:30:00.000Z' })
  expect(stream).not.toHaveBeenCalled()
  expect(rpc.close).toHaveBeenCalledTimes(1)

  setPhase(1)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().attention).toMatchObject([{ id: 'thread-a',
    attention: { decision: { kind: 'review', needsAttention: true } } }])
  expect(JSON.stringify(monitor.view())).not.toContain('请处理发布')
  expect(JSON.stringify(monitor.view())).not.toContain('请检查发布结果')
  expect(requests.filter(method => method === 'thread/items/list')).toHaveLength(2)

  const firstAttention = monitor.view().attention[0]!.attention!
  monitor.acknowledge('thread-a', firstAttention.itemId, firstAttention.at)
  expect(monitor.view().attentionTotal).toBe(0)
  const restarted = new CodexMonitor({ store, context: { llm: { stream }, sessionController: {
    modelCatalog: async () => ({ default: { provider: 'magpie', model: 'test-model' } }),
  } } as unknown as CodexMonitorDeps['context'], connect: async () => rpc as unknown as
    Awaited<ReturnType<NonNullable<CodexMonitorDeps['connect']>>> })
  await restarted.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(restarted.view().attentionTotal).toBe(0)
})

it('preserves the previous checkpoint when an incremental read fails', async () => {
  const { monitor, stream, setPhase, setFailRead } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setFailRead(true)
  await monitor.scanOnce()
  expect(stream).not.toHaveBeenCalled()
  expect(monitor.view().threads[0]?.error).toBe('Codex history read unavailable')
  setFailRead(false)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().attentionTotal).toBe(1)
})

it('establishes a baseline after a failed first read without analyzing old messages', async () => {
  const { monitor, stream, setPhase, setFailRead, setLongHistory } = fixture()
  setFailRead(true)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.error).toBeDefined()
  setFailRead(false)
  setLongHistory(true)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.error).toBeUndefined()
  expect(stream).not.toHaveBeenCalled()
  setLongHistory(false)
  setPhase(1)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
})

it('keeps an acknowledgement made while the model is finishing a later routine update', async () => {
  const { monitor, stream, setPhase, setDecision, holdModel } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(1)
  setPhase(2)
  setDecision('{"needsAttention":false,"kind":"none","reason":"普通进展","action":"无需处理"}')
  const release = holdModel()
  const scanning = monitor.scanOnce()
  await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
  const firstAttention = monitor.view().attention[0]!.attention!
  monitor.acknowledge('thread-a', firstAttention.itemId, firstAttention.at)
  release()
  await scanning
  expect(monitor.view().attentionTotal).toBe(0)
  expect(monitor.view().threads[0]?.attention?.acknowledgedAt).toBeDefined()
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
  setDecision('{"needsAttention":true,"kind":"failure","reason":"执行失败","action":"检查失败原因"}')
  setPhase(1)
  setTurn('turn-second', 'failed')
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  const first = monitor.view().attention[0]!.attention!
  monitor.acknowledge('thread-a', first.itemId, first.at)
  setPhase(2)
  setTurn('turn-third', 'failed')
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  expect(monitor.view().attentionTotal).toBe(1)
  expect(monitor.view().attention[0]!.attention!.itemId).toBe('turn-third')
})

it('keeps parent-agent review inside a subagent thread while still surfacing direct approval', async () => {
  const { monitor, setPhase, setSubagent, setDecision } = fixture()
  setSubagent(true)
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(0)
  setPhase(2)
  setDecision('{"needsAttention":true,"kind":"approval","reason":"等待用户批准","action":"批准执行"}')
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(1)
})

it('keeps the checkpoint and shows a coverage gap when the incremental anchor disappears', async () => {
  const { monitor, stream, setPhase, setMissingAnchor } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setMissingAnchor(true)
  await monitor.scanOnce()
  expect(stream).not.toHaveBeenCalled()
  expect(monitor.view().threads[0]?.error).toContain('safe window')
  setMissingAnchor(false)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
})

it('rescans after five minutes even when Codex updatedAt has not advanced', async () => {
  const { monitor, stream, setPhase, setFreezeUpdatedAt, advanceMinutes } = fixture()
  setFreezeUpdatedAt(true)
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  expect(stream).not.toHaveBeenCalled()
  advanceMinutes(6)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
})
