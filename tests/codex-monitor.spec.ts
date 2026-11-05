import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexMonitor, type CodexFailureCandidate, type CodexMonitorDeps } from '../src/app/codex-monitor.ts'
import { Store } from '../src/app/store.ts'
import { CodexRouter } from '../src/app/codex-router.ts'
import type { Ticket } from '../src/core/index.ts'
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
  let userReply = false
  let assistantText = '请检查发布结果'
  let oldAssistantText = '正在处理'
  let subagent = false
  let childCount = 0
  let failedChildId: string | undefined
  let failedChildReadId: string | undefined
  let childUpdatesWithPhase = false
  let toolAfterAssistant = false
  let includeRpcRoot = true
  let updatedAtOverride: number | undefined
  let localRows: MonitoredCodexThread[] = []
  let decisionText: string | undefined
  let finishKind = 'stop'
  let modelGate: Promise<void> | undefined
  const requests: string[] = []
  const rpc = {
    request: vi.fn(async (method: string, params: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => {
      requests.push(method)
      if (method === 'thread/list') return { data: params.archived ? [] : [...(includeRpcRoot ? [{
        id: 'thread-a', name: 'Release task', source: subagent
          ? { subAgent: { thread_spawn: { parent_thread_id: 'parent-a' } } } : 'vscode',
        updatedAt: updatedAtOverride ?? 1793530000 + (freezeUpdatedAt ? 0 : phase * 30),
      }] : []), ...Array.from({ length: childCount }, (_, index) => ({
        id: 'child-' + index, source: { subAgent: { thread_spawn: { parent_thread_id: 'thread-a' } } },
        updatedAt: 1793530000 + (childUpdatesWithPhase && index < 60 ? phase * 30 : 0),
      }))], nextCursor: null }
      if (method === 'thread/turns/list') {
        if (params.threadId === failedChildReadId) throw new Error('child read failed')
        return { data: [{ id: latestTurnId,
          status: params.threadId === failedChildId ? 'failed' : latestTurnStatus }] }
      }
      if (method === 'thread/items/list') {
        if (failRead) throw new Error('read failed')
        if (longHistory) { longBaselineSeen = true; return { data: Array.from({ length: 13 }, (_, index) => ({
          turnId: 'turn-a', item: { id: `baseline-${13 - index}`, type: 'agentMessage', text: '旧进展' },
        })), nextCursor: null } }
        return { data: [
          ...(phase && toolAfterAssistant ? [{ turnId: latestTurnId, item: { id: `tool-new-${phase}`,
            type: 'commandExecution' } }] : []),
          ...(phase && !suppressNewAssistant ? [{ turnId: latestTurnId, item: { id: `answer-new-${phase}`, type: 'agentMessage',
            text: assistantText } }] : []),
          ...(phase === 2 && userReply ? [{ turnId: latestTurnId, item: { id: 'reply-new-2', type: 'userMessage',
            content: [{ type: 'text', text: '我已答复，请继续' }] } }] : []),
          ...(phase > 1 && !suppressNewAssistant ? [{ turnId: 'turn-a', item: { id: 'answer-new-1', type: 'agentMessage',
            text: '请检查发布结果' } }] : []),
          ...(longBaselineSeen ? [{ turnId: 'turn-a', item: { id: 'baseline-13', type: 'agentMessage',
            text: '旧进展' } }] : []),
          ...missingAnchor ? [] : [{ turnId: 'turn-a', item: { id: 'answer-old', type: 'agentMessage', text: oldAssistantText } },
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
    if (finishKind) yield { type: 'finish', reason: { kind: finishKind } }
  })
  const context = { llm: { stream }, sessionController: { modelCatalog: async () =>
    ({ default: { provider: 'magpie', model: 'test-model' } }) } } as unknown as CodexMonitorDeps['context']
  const connect = vi.fn(async () => rpc as unknown as Awaited<ReturnType<NonNullable<CodexMonitorDeps['connect']>>>)
  const inventory = vi.fn(async () => localRows)
  const autoHandoff = vi.fn(async (candidate: CodexFailureCandidate): Promise<{ triggerId: string } | { waiting: true }> =>
    ({ triggerId: `trigger-${candidate.itemId}` }))
  const monitor = new CodexMonitor({ store, context, connect, inventory, now: () => now, autoHandoff })
  return { store, monitor, rpc, stream, connect, inventory, autoHandoff, requests, setPhase: (value: number) => { phase = value },
    setFailRead: (value: boolean) => { failRead = value },
    setMissingAnchor: (value: boolean) => { missingAnchor = value },
    setLongHistory: (value: boolean) => { longHistory = value },
    setFreezeUpdatedAt: (value: boolean) => { freezeUpdatedAt = value },
    advanceMinutes: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000) },
    setTurn: (id: string, status: string) => { latestTurnId = id; latestTurnStatus = status },
    setSuppressNewAssistant: (value: boolean) => { suppressNewAssistant = value },
    setUserReply: (value: boolean) => { userReply = value },
    setAssistantText: (value: string) => { assistantText = value },
    setOldAssistantText: (value: string) => { oldAssistantText = value },
    setSubagent: (value: boolean) => { subagent = value },
    setChildCount: (value: number) => { childCount = value },
    setFailedChild: (value: string) => { failedChildId = value },
    setFailedChildRead: (value: string | undefined) => { failedChildReadId = value },
    setChildUpdatesWithPhase: (value: boolean) => { childUpdatesWithPhase = value },
    setToolAfterAssistant: (value: boolean) => { toolAfterAssistant = value },
    setIncludeRpcRoot: (value: boolean) => { includeRpcRoot = value },
    setUpdatedAt: (value: string) => { updatedAtOverride = Date.parse(value) / 1000 },
    setLocalRows: (rows: MonitoredCodexThread[]) => { localRows = rows },
    setDecision: (value: string) => { decisionText = value },
    setFinishKind: (value: string) => { finishKind = value },
    holdModel: () => {
      let release!: () => void
      modelGate = new Promise<void>(resolve => { release = resolve })
      return () => { release(); modelGate = undefined }
    } }
}

it('automatically hands off only a new assistant-evidenced failure, once per item', async () => {
  const { monitor, autoHandoff, setDecision, setPhase, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '新进展报告失败', action: '检查失败', summary: '发布任务失败', evidence: '请检查发布结果' }))
  setPhase(1)
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ autoHandoffEnabled: true,
    threads: [{ stage: 'failed', summary: '发布任务失败' }] })
  expect(autoHandoff).toHaveBeenCalledTimes(1)
  expect(autoHandoff.mock.calls[0]?.[0]).toMatchObject({ threadId: 'thread-a', itemId: 'answer-new-1',
    summary: '发布任务失败' })
  expect(monitor.view().threads[0]).toMatchObject({ handoffTriggerId: 'trigger-answer-new-1' })
  expect(monitor.view().threads[0]?.handoffTicketId).toBeUndefined()
  monitor.handoffDecision('trigger-answer-new-1', { kind: 'accept', ticketId: 'ticket-codex' })
  expect(monitor.view().threads[0]?.handoffTicketId).toBe('ticket-codex')
  await monitor.scanOnce()
  expect(autoHandoff).toHaveBeenCalledTimes(1)
})

it('keeps the assistant item as the handoff evidence when a tool item follows it', async () => {
  const { monitor, autoHandoff, setDecision, setPhase, setToolAfterAssistant, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '构建失败', action: '检查构建', summary: '构建失败', evidence: '请检查发布结果' }))
  setPhase(1)
  setToolAfterAssistant(true)
  await monitor.scanOnce()
  expect(autoHandoff).toHaveBeenCalledTimes(1)
  expect(autoHandoff.mock.calls[0]?.[0]).toMatchObject({ itemId: 'answer-new-1' })
})

it('waits for a safe Desktop state before intake and retries on a later scan', async () => {
  const { monitor, autoHandoff, setDecision, setPhase, advanceMinutes } = fixture()
  autoHandoff.mockResolvedValueOnce({ waiting: true })
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '构建失败', action: '检查构建', summary: '构建失败', evidence: '请检查发布结果' }))
  setPhase(1)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.handoffTriggerId).toBeUndefined()
  await monitor.scanOnce()
  expect(autoHandoff).toHaveBeenCalledTimes(2)
  expect(monitor.view().threads[0]?.handoffTriggerId).toBe('trigger-answer-new-1')
})

it('does not repeat an ignored candidate or accept one after auto intake is disabled', async () => {
  const { monitor, autoHandoff, setDecision, setPhase, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '构建失败', action: '检查构建', summary: '构建失败', evidence: '请检查发布结果' }))
  setPhase(1)
  await monitor.scanOnce()
  const triggerId = monitor.view().threads[0]!.handoffTriggerId!
  monitor.handoffDecision(triggerId, { kind: 'ignore' })
  await monitor.scanOnce()
  expect(autoHandoff).toHaveBeenCalledTimes(1)
  monitor.setAutoHandoff(false)
  expect(() => monitor.handoffDecision(triggerId, { kind: 'accept', ticketId: 'late-ticket' })).toThrow('disabled')
})

it.each([
  ['Outcome: 已完成31项测试。无字段或数据需要学校确认。', '需要学校确认'],
  ['Outcome: 已部署。Risk: 你确认个人 Token Plan 额度已用尽，本轮未购买额度。', '你确认'],
  ['Outcome: 巡检已恢复。只读写请求门禁阻挡。下一步由 Academy、审批及媒体负责人补齐合成实例。', '请求门禁阻挡。下一步由 Academy、审批'],
])('reclassifies an old false approval for %s without keeping its old user gate', async (message, evidence) => {
  const { store, monitor, setOldAssistantText, setDecision } = fixture()
  setOldAssistantText(message)
  monitor.setEnabled(true); await monitor.scanOnce()
  const state = JSON.parse(store.db.prepare("select value from kv where key='codex-monitor-v1'").get()!.value as string)
  const decision = { needsAttention: true, stage: 'needsYou', kind: 'approval', reason: '最新助手消息需要你处理',
    action: '打开原会话处理请求', summary: '等待处理', evidence }
  state.threads['thread-a'].assessment = { version: 4, at: state.scannedAt, itemId: 'answer-old', decision }
  state.threads['thread-a'].attention = { at: state.scannedAt, itemId: 'answer-old', decision }
  state.threads['thread-a'].userDecisionRequested = true
  store.set('codex-monitor-v1', state)
  setDecision(JSON.stringify({ needsAttention: false, stage: 'reportedComplete', kind: 'none',
    reason: '已完成，本句不是用户待办', action: '无需处理', summary: '当前限定工作已完成' }))
  await monitor.scanOnce()
  expect(monitor.view().needsYouTotal).toBe(0)
  expect(monitor.view().attentionTotal).toBe(0)
  expect(monitor.routeHead('thread-a')).toMatchObject({ stage: 'reportedComplete', needsYou: false })
})

it('hands a fresh routine question to DSH without a human alert or a duplicate ticket', async () => {
  const { store, monitor, autoHandoff, setPhase, setDecision, setAssistantText, advanceMinutes } = fixture()
  monitor.setEnabled(true); await monitor.scanOnce(); monitor.setAutoHandoff(true)
  advanceMinutes(1); setPhase(1)
  setAssistantText('CI已通过，先查日志还是补验证，请你决定。')
  setDecision(JSON.stringify({ needsAttention: false, stage: 'needsAgent', kind: 'none',
    reason: '属于既有授权内的可回退选择', action: '先核对日志再补验证', summary: '验证顺序由DSH安排', evidence: '先查日志还是补验证' }))
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ attentionTotal: 0, needsYouTotal: 0 })
  expect(monitor.routeHead('thread-a')).toMatchObject({ stage: 'needsAgent', needsYou: false })
  expect(autoHandoff).not.toHaveBeenCalled()
  const relay = vi.fn(), router = new CodexRouter({ store, monitor, relay })
  expect(router.refresh()).toMatchObject({ needsYou: 0, needsAgent: 1, priorities: [
    expect.objectContaining({ kind: 'needsAgent', task: 'continue', threadId: 'thread-a' }),
  ] })
})

it('suppresses an unverified old question while preserving its control guard', async () => {
  const { store, monitor } = fixture()
  monitor.setEnabled(true); await monitor.scanOnce()
  const state = JSON.parse(store.db.prepare("select value from kv where key='codex-monitor-v1'").get()!.value as string)
  state.threads['thread-a'].context = []
  state.threads['thread-a'].assessment = { version: 5, itemId: 'unknown-head', decision: { needsAttention: false,
    stage: 'unknown', kind: 'none', reason: '没有可核实历史', action: '先核对', summary: '历史待核对' } }
  state.threads['thread-a'].attention = { itemId: 'old-request', at: state.scannedAt,
    decision: { needsAttention: true, stage: 'needsYou', kind: 'question', reason: '旧请求', action: '请提供资料', evidence: '请提供' } }
  state.threads['thread-a'].userDecisionRequested = true
  store.set('codex-monitor-v1', state)
  expect(monitor.view()).toMatchObject({ attentionTotal: 0, needsYouTotal: 0 })
  expect(monitor.routeHead('thread-a')?.needsYou).toBe(true)
  const router = new CodexRouter({ store, monitor })
  expect(router.refresh().priorities).toContainEqual(expect.objectContaining({ kind: 'needsAgent', task: 'verify' }))
})

it('keeps a real user pause across status questions and automation until a human resumes', async () => {
  const { monitor, rpc, setDecision, advanceMinutes } = fixture()
  monitor.setEnabled(true); await monitor.scanOnce()
  setDecision(JSON.stringify({ needsAttention: false, stage: 'needsAgent', kind: 'none',
    reason: '常规继续', action: '继续检查', summary: '可继续检查', evidence: '正在处理' }))
  const original = rpc.request.getMockImplementation()!
  const extra: unknown[] = []
  rpc.request.mockImplementation(async (method, params, signal) => {
    const result = await original(method, params, signal)
    return method === 'thread/items/list' ? { ...(result as { data: unknown[] }),
      data: [...extra, ...(result as { data: unknown[] }).data] } : result
  })
  const add = async (id: string, message: string) => {
    extra.unshift({ turnId: 'turn-a', item: { id, type: 'userMessage', content: [{ type: 'text', text: message }] } })
    advanceMinutes(6); await monitor.scanOnce()
  }
  await add('pause-request', '暂停当前任务，等我说继续。')
  expect(monitor.routeHead('thread-a')).toMatchObject({ needsYou: true, pausedByUser: true })
  expect(monitor.view().needsYouTotal).toBe(0)
  await add('status-question', '现在进度如何？')
  expect(monitor.routeHead('thread-a')?.pausedByUser).toBe(true)
  await add('status-with-continue', '继续检查的结果怎么样了？')
  expect(monitor.routeHead('thread-a')?.pausedByUser).toBe(true)
  await add('conditional-resume', '继续检查前必须先得到我的同意。')
  expect(monitor.routeHead('thread-a')).toMatchObject({ needsYou: true, pausedByUser: true })
  await add('english-conditional-resume', 'Continue only after I approve it.')
  expect(monitor.routeHead('thread-a')?.pausedByUser).toBe(true)
  await add('automated-resume', 'DSH Superagent coordination for this existing conversation. Router message: 现在继续。')
  expect(monitor.routeHead('thread-a')?.pausedByUser).toBe(true)
  await add('human-resume', '请继续检查。')
  expect(monitor.routeHead('thread-a')).toMatchObject({ needsYou: false })
  expect(monitor.routeHead('thread-a')?.pausedByUser).toBeUndefined()
  await add('quoted-pause', '引用日志：\n暂停当前任务，等我说继续。')
  expect(monitor.routeHead('thread-a')?.pausedByUser).toBeUndefined()
  await add('short-pause', '先暂停一下。')
  expect(monitor.routeHead('thread-a')).toMatchObject({ needsYou: true, pausedByUser: true })
})

it('records ignore durably and preserves a newer pending candidate when an older one is ignored again', async () => {
  const { monitor, setDecision, setPhase, advanceMinutes } = fixture()
  monitor.setEnabled(true); await monitor.scanOnce(); monitor.setAutoHandoff(true)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '构建失败', action: '检查构建', summary: '构建失败', evidence: '请检查发布结果' }))
  advanceMinutes(1); setPhase(1); await monitor.scanOnce()
  const first = monitor.view().threads[0]!.handoffTriggerId!
  advanceMinutes(6); await monitor.scanOnce()
  monitor.handoffDecision(first, { kind: 'ignore' })
  expect(() => monitor.handoffDecision(first, { kind: 'accept', ticketId: 'late-ticket' })).toThrow('stale')
  advanceMinutes(1); setPhase(2); await monitor.scanOnce()
  const second = monitor.view().threads[0]!.handoffTriggerId!
  expect(second).not.toBe(first)
  monitor.handoffDecision(first, { kind: 'ignore' })
  expect(monitor.view().threads[0]!.handoffTriggerId).toBe(second)
})

it('relays a new DSH Ticket result even while the original Codex item stays unchanged', async () => {
  const { store, monitor, setDecision, setPhase, advanceMinutes } = fixture()
  monitor.setEnabled(true); await monitor.scanOnce(); monitor.setAutoHandoff(true)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '构建失败', action: '检查构建', summary: '构建失败', evidence: '请检查发布结果' }))
  advanceMinutes(1); setPhase(1); await monitor.scanOnce()
  const triggerId = monitor.view().threads[0]!.handoffTriggerId!
  monitor.handoffDecision(triggerId, { kind: 'accept', ticketId: 'ticket-result' })
  const ticket = { id: 'ticket-result', title: 'Diagnosis', updatedAt: '2026-11-01T12:31:00Z',
    assignments: [{ id: 'assignment-result', state: 'running', createdAt: '2026-11-01T12:31:00Z',
      report: { state: 'waiting', summary: 'First result', at: '2026-11-01T12:31:00Z' } }] } as Ticket
  store.tickets.save(ticket)
  const relay = vi.fn(), router = new CodexRouter({ store, monitor, relay })
  router.refresh()
  const before = monitor.view().managed[0]!
  store.tickets.save({ ...ticket, assignments: [{ ...ticket.assignments[0]!, report: {
    state: 'waiting', summary: 'New result', at: '2026-11-01T12:32:00Z' } }] })
  const after = monitor.view().managed[0]!
  expect(after.assessmentItemId).toBe(before.assessmentItemId)
  expect(after.handoffReportId).not.toBe(before.handoffReportId)
  router.refresh()
  expect(relay).toHaveBeenCalledTimes(2)
  expect(router.view().priorities).toContainEqual(expect.objectContaining({ kind: 'ticketResult', summary: 'New result' }))
  router.refresh()
  expect(relay).toHaveBeenCalledTimes(2)
})

it('refuses a late accept after a newer user message but preserves the candidate for idempotent lookup', async () => {
  const { monitor, autoHandoff, setDecision, setPhase, setUserReply, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '构建失败', action: '检查构建', summary: '构建失败', evidence: '请检查发布结果' }))
  setPhase(1)
  await monitor.scanOnce()
  const triggerId = monitor.view().threads[0]!.handoffTriggerId!
  setPhase(2)
  setUserReply(true)
  await monitor.scanOnce()
  expect(() => monitor.handoffDecision(triggerId, { kind: 'accept', ticketId: 'late-ticket' })).toThrow('stale')
  expect(autoHandoff).toHaveBeenCalledTimes(2)
  expect(monitor.view().threads[0]?.handoffTriggerId).toBe('trigger-answer-new-2')
  expect(monitor.view().threads[0]?.handoffTicketId).toBeUndefined()
})

it('hands an assistant-evidenced technical blocker to DSH without treating approval as a blocker', async () => {
  const { monitor, autoHandoff, setDecision, setPhase, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'blocked', kind: 'blocked',
    reason: '构建工具报错', action: '修复构建工具', summary: '构建被工具错误阻塞', evidence: '请检查发布结果' }))
  setPhase(1)
  await monitor.scanOnce()
  expect(autoHandoff.mock.calls[0]?.[0]).toMatchObject({ stage: 'blocked', itemId: 'answer-new-1' })
  expect(monitor.view().attentionTotal).toBe(1)
  expect(monitor.view().managedTotal).toBe(0)
  expect(monitor.view().threads[0]?.handoffTriggerId).toBe('trigger-answer-new-1')
})

it('never dispatches a mixed failure or blocker that asks for human approval', async () => {
  for (const [stage, kind] of [['failed', 'failure'], ['blocked', 'blocked']] as const) {
    const { monitor, autoHandoff, setDecision, setPhase, setAssistantText, advanceMinutes } = fixture()
    monitor.setEnabled(true)
    await monitor.scanOnce()
    monitor.setAutoHandoff(true)
    advanceMinutes(1)
    setAssistantText('构建失败，需要你批准安装工具后继续。')
    setDecision(JSON.stringify({ needsAttention: true, stage, kind,
      reason: '构建失败', action: '修复构建', summary: '构建受阻', evidence: '构建失败' }))
    setPhase(1)
    await monitor.scanOnce()
    expect(autoHandoff).not.toHaveBeenCalled()
    expect(monitor.view().attentionTotal).toBe(1)
    expect(monitor.view().attention[0]?.attention?.decision).toMatchObject({ stage: 'needsYou', kind: 'approval' })
  }
})

it('finds a direct approval request beyond the stored message preview and keeps it for the person', async () => {
  const { monitor, autoHandoff, setDecision, setPhase, setAssistantText, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setAssistantText(`构建失败。${'x'.repeat(2_100)} Can you approve installing the missing tool?`)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '构建失败', action: '修复构建', summary: '构建失败', evidence: '构建失败' }))
  setPhase(1)
  await monitor.scanOnce()
  expect(autoHandoff).not.toHaveBeenCalled()
  expect(monitor.view().attention[0]?.attention?.decision).toMatchObject({ stage: 'needsYou', kind: 'approval' })
})

it('still alerts on a direct approval request when model output is unavailable', async () => {
  const { monitor, autoHandoff, setDecision, setPhase, setAssistantText } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  setAssistantText('构建失败，需要你批准安装工具后继续。')
  setDecision('not json')
  setPhase(1)
  await monitor.scanOnce()
  expect(autoHandoff).not.toHaveBeenCalled()
  expect(monitor.view().attention[0]?.attention?.decision).toMatchObject({ stage: 'needsYou', kind: 'approval' })
})

it('shows a newer user decision after an earlier Codex item was handed to DSH', async () => {
  const { monitor, setDecision, setPhase, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '构建失败', action: '检查构建', summary: '构建失败', evidence: '请检查发布结果' }))
  setPhase(1)
  await monitor.scanOnce()
  monitor.handoffDecision('trigger-answer-new-1', { kind: 'accept', ticketId: 'ticket-first' })
  setDecision(reviewDecision)
  setPhase(2)
  await monitor.scanOnce()
  expect(monitor.view().managedTotal).toBe(1)
  expect(monitor.view().attentionTotal).toBe(1)
  expect(monitor.view().attention[0]?.attention?.itemId).toBe('answer-new-2')
})

it('keeps separate DSH tickets from two failed items in the same Codex conversation', async () => {
  const { store, monitor, autoHandoff, setDecision, setPhase, advanceMinutes } = fixture()
  autoHandoff.mockResolvedValueOnce({ triggerId: 'trigger-one' }).mockResolvedValueOnce({ triggerId: 'trigger-two' })
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '执行失败', action: '修复任务', summary: '第二次失败摘要', evidence: '请检查发布结果' }))
  advanceMinutes(1)
  setPhase(1)
  await monitor.scanOnce()
  monitor.handoffDecision('trigger-one', { kind: 'accept', ticketId: 'ticket-one' })
  advanceMinutes(1)
  setPhase(2)
  await monitor.scanOnce()
  monitor.handoffDecision('trigger-two', { kind: 'accept', ticketId: 'ticket-two' })
  store.tickets.save({ id: 'ticket-one', title: '第一次修复', updatedAt: '2026-11-01T12:31:00Z',
    ended: { at: '2026-11-01T12:31:00Z', by: 'executor', outcome: 'completed' },
    assignments: [{ report: { state: 'ready', summary: '第一次修复已完成', at: '2026-11-01T12:31:00Z' } }] } as Ticket)
  store.tickets.save({ id: 'ticket-two', title: '第二次修复', updatedAt: '2026-11-01T12:32:00Z',
    assignments: [] } as unknown as Ticket)
  const managed = monitor.view().managed
  expect(managed.map(row => row.handoffTicketId)).toEqual(['ticket-two', 'ticket-one'])
  expect(managed.map(row => row.title)).toEqual(['第二次修复', '第一次修复'])
  expect(managed[1]?.summary).toBe('第一次修复已完成')
  expect(monitor.view().managedTotal).toBe(2)
})

it('does not hand off a historical failure when auto intake is enabled later', async () => {
  const { monitor, autoHandoff, setDecision } = fixture()
  monitor.setEnabled(true)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '旧进展报告失败', action: '检查失败', summary: '旧任务失败', evidence: '正在处理' }))
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  await monitor.scanOnce()
  expect(autoHandoff).not.toHaveBeenCalled()
})

it('does not hand off an old failure if its assessment timestamp is refreshed without a new message', async () => {
  const { store, monitor, autoHandoff, setDecision, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '旧进展报告失败', action: '检查失败', summary: '旧任务失败', evidence: '正在处理' }))
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  const state = store.get('codex-monitor-v1') as { threads: Record<string, { assessment: { at: string } }> }
  state.threads['thread-a']!.assessment.at = '2026-11-01T12:31:00.000Z'
  store.set('codex-monitor-v1', state)
  await monitor.scanOnce()
  expect(autoHandoff).not.toHaveBeenCalled()
})

it('does not dispatch an old assistant item during assessment version migration', async () => {
  const { store, monitor, autoHandoff, setDecision, advanceMinutes } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  const state = store.get('codex-monitor-v1') as { threads: Record<string, {
    assessment: { version: number }; autoHandoffBaselineItemId?: string; autoHandoffFreshItemId?: string }> }
  state.threads['thread-a']!.assessment.version = 2
  state.threads['thread-a']!.autoHandoffBaselineItemId = 'tool-old'
  state.threads['thread-a']!.autoHandoffFreshItemId = 'answer-old'
  store.set('codex-monitor-v1', state)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '旧失败', action: '检查失败', summary: '旧任务失败', evidence: '正在处理' }))
  await monitor.scanOnce()
  expect(autoHandoff).not.toHaveBeenCalled()
})

it('does not hand off a thread first discovered after enabling with an older update time', async () => {
  const { monitor, autoHandoff, setDecision } = fixture()
  monitor.setEnabled(true)
  monitor.setAutoHandoff(true)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '旧进展报告失败', action: '检查失败', summary: '旧任务失败', evidence: '正在处理' }))
  await monitor.scanOnce()
  expect(autoHandoff).not.toHaveBeenCalled()
})

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
  expect(monitor.routeHead('thread-a')?.needsYou).toBe(true)
  const restarted = new CodexMonitor({ store, context: { llm: { stream }, sessionController: {
    modelCatalog: async () => ({ default: { provider: 'magpie', model: 'test-model' } }),
  } } as unknown as CodexMonitorDeps['context'], connect: async () => rpc as unknown as
    Awaited<ReturnType<NonNullable<CodexMonitorDeps['connect']>>>, inventory: async () => [] })
  await restarted.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  expect(restarted.view().attentionTotal).toBe(0)
})

it('lets the DSH router read bounded persisted messages from a monitored main conversation', async () => {
  const { monitor, connect, setOldAssistantText } = fixture()
  setOldAssistantText('进展'.repeat(900))
  monitor.setEnabled(true)
  await monitor.scanOnce()
  const history = await monitor.readHistory('thread-a', 2, new AbortController().signal)
  expect(history).toMatchObject({ source: 'persisted Codex history', threadId: 'thread-a', complete: true,
    messages: [{ role: 'user' }, { role: 'assistant', chars: 1_800 }] })
  expect(history.messages[1]?.text).toHaveLength(1_200)
  expect(connect).toHaveBeenCalledTimes(2)
  await expect(monitor.readHistory('unknown', 2, new AbortController().signal)).rejects.toThrow('not monitored')
  expect(connect).toHaveBeenCalledTimes(2)
})

it('cancels an active history read when monitoring is disabled or stopped', async () => {
  for (const action of ['disable', 'stop']) {
    const { monitor, rpc } = fixture()
    monitor.setEnabled(true)
    await monitor.scanOnce()
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    rpc.request.mockImplementationOnce(async (_method, _params, signal) => {
      started()
      return await new Promise<never>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('read cancelled')), { once: true })
      })
    })
    const reading = monitor.readHistory('thread-a', 2, new AbortController().signal)
    const rejected = expect(reading).rejects.toThrow()
    await entered
    if (action === 'disable') monitor.setEnabled(false)
    else await monitor.stop()
    await rejected
    expect(rpc.close).toHaveBeenCalledTimes(2)
  }
})

it('marks an empty history window incomplete when the item search limit is exhausted', async () => {
  const { monitor, rpc } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  let page = 0
  rpc.request.mockImplementation(async method => method === 'thread/turns/list' ? { data: [] } : {
    data: Array.from({ length: 100 }, (_, index) => ({ turnId: 'turn-a', item: {
      id: `tool-${page}-${index}`, type: 'commandExecution' } })), nextCursor: `older-${++page}` })
  expect(await monitor.readHistory('thread-a', 8, new AbortController().signal)).toMatchObject({
    complete: false, messages: [] })
  expect(page).toBe(10)
})

it('keeps an unanswered request through progress commentary in the same turn', async () => {
  const { monitor, setPhase, setDecision, setAssistantText } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setDecision(reviewDecision)
  await monitor.scanOnce()
  const pending = monitor.view().attention[0]!.attention!
  setPhase(2)
  setAssistantText('正在核查发布结果')
  setDecision(progressDecision)
  await monitor.scanOnce()
  expect(monitor.view().attention[0]?.attention?.itemId).toBe(pending.itemId)
  expect(monitor.view().threads[0]?.stage).toBe('progress')
  expect(monitor.routeHead('thread-a')?.needsYou).toBe(true)
})

it('does not create a second alert when the same request is restated in one turn', async () => {
  const { monitor, setPhase, setDecision } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setDecision(reviewDecision)
  await monitor.scanOnce()
  const pending = monitor.view().attention[0]!.attention!
  setPhase(2)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'review',
    reason: '请审阅结果', action: '确认发布结果', summary: '发布结果待审阅', evidence: '请检查发布结果' }))
  await monitor.scanOnce()
  expect(monitor.view().attention[0]?.attention?.itemId).toBe(pending.itemId)
})

it('clears a pending request when the assistant reports completion', async () => {
  const { monitor, setPhase, setDecision, setAssistantText } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setDecision(reviewDecision)
  await monitor.scanOnce()
  setPhase(2)
  setAssistantText('结果已完成，无需你确认。')
  setDecision(JSON.stringify({ needsAttention: false, stage: 'reportedComplete', kind: 'none',
    reason: '已完成', action: '无需处理', summary: '发布结果已完成' }))
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(0)
  expect(monitor.routeHead('thread-a')?.needsYou).toBe(false)
})

it('clears an unanswered request when a new user answer arrives', async () => {
  const { monitor, setPhase, setDecision, setAssistantText, setUserReply, setTurn } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setDecision(reviewDecision)
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(1)
  setPhase(2)
  setTurn('turn-b', 'completed')
  setUserReply(true)
  setAssistantText('已收到答复，继续处理')
  setDecision(progressDecision)
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(0)
  expect(monitor.view().threads[0]?.stage).toBe('progress')
})

it('keeps approval pending while reporting a later technical failure', async () => {
  for (const acknowledged of [false, true]) {
    const { monitor, autoHandoff, setPhase, setDecision, setAssistantText } = fixture()
    await monitor.scanOnce()
    monitor.setAutoHandoff(true)
    setPhase(1)
    setAssistantText('请批准安装工具 A')
    setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'approval',
      reason: '工具 A 待批准', action: '批准工具 A', summary: '等待批准工具 A', evidence: '请批准' }))
    await monitor.scanOnce()
    const approval = monitor.view().attention[0]!.attention!
    if (acknowledged) monitor.acknowledge('thread-a', approval.itemId, approval.at)
    setPhase(2)
    setAssistantText('构建失败：找不到编译器')
    setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
      reason: '编译器缺失', action: '检查构建环境', summary: '构建失败', evidence: '找不到编译器' }))
    await monitor.scanOnce()
    expect(monitor.view().threads[0]).toMatchObject({ stage: 'failed', assessmentEvidence: '找不到编译器' })
    expect(monitor.routeHead('thread-a')?.needsYou).toBe(true)
    expect(monitor.view().attentionTotal).toBe(acknowledged ? 0 : 1)
    expect(autoHandoff).not.toHaveBeenCalled()
  }
})

it('does not let confirmation of one approval hide a different approval with the same short quote', async () => {
  const { monitor, stream, setPhase, setDecision, setAssistantText, holdModel } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setAssistantText(`请批准执行以下操作：${'说明'.repeat(150)}安装工具 A`)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'approval',
    reason: '工具 A 待批准', action: '批准工具 A', summary: '等待批准工具 A', evidence: '请批准' }))
  await monitor.scanOnce()
  const first = monitor.view().attention[0]!.attention!
  setPhase(2)
  setAssistantText(`请批准执行以下操作：${'说明'.repeat(150)}安装工具 B`)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'approval',
    reason: '工具 B 待批准', action: '批准工具 B', summary: '等待批准工具 B', evidence: '请批准' }))
  const release = holdModel()
  const scanning = monitor.scanOnce()
  await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(3))
  monitor.acknowledge('thread-a', first.itemId, first.at)
  release()
  await scanning
  const second = monitor.view().attention[0]!.attention!
  expect(second.itemId).not.toBe(first.itemId)
  expect(second.requestKey).not.toBe(first.requestKey)
  expect(monitor.view().attentionTotal).toBe(1)
  monitor.acknowledge('thread-a', first.itemId, first.at)
  expect(monitor.view().attentionTotal).toBe(1)
})

it('does not reopen the same approval when only earlier progress changes', async () => {
  for (const evidence of ['请批准', '请批准安装工具 A。']) for (const acknowledged of [false, true]) {
    const { monitor, setPhase, setDecision, setAssistantText } = fixture()
    await monitor.scanOnce()
    setPhase(1)
    setAssistantText('已检查 1 个文件。请批准安装工具 A。')
    setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'approval',
      reason: '工具待批准', action: '批准工具 A', summary: '等待批准', evidence }))
    await monitor.scanOnce()
    const first = monitor.view().attention[0]!.attention!
    if (acknowledged) monitor.acknowledge('thread-a', first.itemId, first.at)
    setPhase(2)
    setAssistantText('已检查 2 个文件。请批准安装工具 A。')
    await monitor.scanOnce()
    const current = monitor.view().threads[0]!.attention!
    expect(current.itemId).toBe(first.itemId)
    expect(current.requestKey).toBe(first.requestKey)
    expect(monitor.view().attentionTotal).toBe(acknowledged ? 0 : 1)
  }
})

it('distinguishes approvals whose operation appears before the evidence quote', async () => {
  const { monitor, stream, setPhase, setDecision, setAssistantText, holdModel } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  setAssistantText('安装工具 A，请批准后我会继续执行剩余任务。')
  setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'approval',
    reason: '工具 A 待批准', action: '批准工具 A', summary: '等待批准工具 A', evidence: '请批准' }))
  await monitor.scanOnce()
  const first = monitor.view().attention[0]!.attention!
  setPhase(2)
  setAssistantText('安装工具 B，请批准后我会继续执行剩余任务。')
  setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'approval',
    reason: '工具 B 待批准', action: '批准工具 B', summary: '等待批准工具 B', evidence: '请批准' }))
  const release = holdModel()
  const scanning = monitor.scanOnce()
  await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(3))
  monitor.acknowledge('thread-a', first.itemId, first.at)
  release()
  await scanning
  expect(monitor.view().attentionTotal).toBe(1)
  expect(monitor.view().attention[0]?.attention?.itemId).not.toBe(first.itemId)
  expect(monitor.view().attention[0]?.attention?.requestKey).not.toBe(first.requestKey)
})

it('keeps a historical baseline approval as an auto-handoff blocker', async () => {
  const { monitor, autoHandoff, setOldAssistantText, setAssistantText,
    setDecision, setPhase, advanceMinutes } = fixture()
  setOldAssistantText('请批准安装工具 A')
  setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'approval',
    reason: '工具 A 待批准', action: '批准工具 A', summary: '等待批准工具 A', evidence: '请批准' }))
  monitor.setEnabled(true)
  await monitor.scanOnce()
  expect(monitor.view().attentionTotal).toBe(0)
  expect(monitor.routeHead('thread-a')?.needsYou).toBe(true)
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setPhase(1)
  setAssistantText('构建失败：编译器缺失')
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '编译器缺失', action: '检查环境', summary: '构建失败', evidence: '编译器缺失' }))
  await monitor.scanOnce()
  expect(monitor.view().threads[0]?.stage).toBe('failed')
  expect(monitor.routeHead('thread-a')?.needsYou).toBe(true)
  expect(autoHandoff).not.toHaveBeenCalled()
})

it('distinguishes technical failures with the same short evidence quote', async () => {
  for (const [firstText, secondText] of [
    ['构建失败：编译器缺失', '构建失败：磁盘空间耗尽'],
    ['编译器缺失导致构建失败，接下来会继续检查环境。', '磁盘空间耗尽导致构建失败，接下来会继续检查环境。'],
  ]) {
    const { monitor, setPhase, setDecision, setAssistantText } = fixture()
    await monitor.scanOnce()
    setPhase(1)
    setAssistantText(firstText!)
    setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
      reason: '编译器缺失', action: '检查编译器', summary: '构建失败：编译器缺失', evidence: '构建失败' }))
    await monitor.scanOnce()
    const first = monitor.view().threads[0]!.assessmentKey
    setPhase(2)
    setAssistantText(secondText!)
    setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
      reason: '磁盘空间耗尽', action: '清理磁盘', summary: '构建失败：磁盘空间耗尽', evidence: '构建失败' }))
    await monitor.scanOnce()
    expect(monitor.view().threads[0]?.assessmentKey).not.toBe(first)
  }
})

it('uses a complete, validated decision when the model reaches its token limit', async () => {
  const { monitor, setFinishKind } = fixture()
  setFinishKind('max-tokens')
  await monitor.scanOnce()
  expect(monitor.view().threads[0]).toMatchObject({ stage: 'progress', summary: '正在处理发布任务' })
  expect(monitor.view().threads[0]?.error).toBeUndefined()
})

it('rejects failed, aborted and missing model finishes even when the JSON is complete', async () => {
  for (const kind of ['error', 'aborted', '', 'length']) {
    const { monitor, setFinishKind } = fixture()
    setFinishKind(kind)
    await monitor.scanOnce()
    expect(monitor.view().threads[0]?.error).toBe('Codex model analysis unavailable')
  }
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
  expect(monitor.routeHead('thread-a')?.needsYou).toBe(true)
})

it('does not dismiss a newer alert using the version of an older visible alert', async () => {
  const { monitor, setPhase, setAssistantText, setDecision } = fixture()
  await monitor.scanOnce()
  setPhase(1)
  await monitor.scanOnce()
  const old = monitor.view().attention[0]!.attention!
  setPhase(2)
  setAssistantText('请审阅第二次发布结果')
  setDecision(JSON.stringify({ needsAttention: true, stage: 'needsYou', kind: 'review',
    reason: '第二次结果待审阅', action: '检查第二次发布结果', summary: '第二次发布结果已提交审阅',
    evidence: '请审阅第二次发布结果' }))
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

it('counts failed child turn snapshots under the parent without opening child tickets', async () => {
  const { monitor, stream, autoHandoff, setChildCount, setFailedChild } = fixture()
  setChildCount(3)
  setFailedChild('child-1')
  await monitor.scanOnce()
  expect(monitor.view().threads[0]).toMatchObject({ childCount: 3, childErrors: 1 })
  expect(stream).toHaveBeenCalledTimes(1)
  expect(autoHandoff).not.toHaveBeenCalled()
})

it('checks recent child turns in bounded batches and eventually includes later failures', async () => {
  const { monitor, requests, setChildCount, setFailedChild, setChildUpdatesWithPhase, setPhase } = fixture()
  setChildCount(80)
  setFailedChild('child-75')
  setChildUpdatesWithPhase(true)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]).toMatchObject({ childCount: 80, childErrors: 0 })
  expect(monitor.view()).toMatchObject({ recentChildTotal: 80, checkedRecentChildTotal: 60 })
  expect(requests.filter(method => method === 'thread/turns/list')).toHaveLength(61)
  setPhase(1)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]).toMatchObject({ childCount: 80, childErrors: 1 })
  expect(monitor.view()).toMatchObject({ recentChildTotal: 80, checkedRecentChildTotal: 60 })
  expect(requests.filter(method => method === 'thread/turns/list')).toHaveLength(122)
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ recentChildTotal: 80, checkedRecentChildTotal: 80 })
})

it('shows child read failures, retries them, and preserves a known failure after the activity window', async () => {
  const { monitor, setChildCount, setFailedChild, setFailedChildRead, advanceMinutes } = fixture()
  setChildCount(1)
  setFailedChildRead('child-0')
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ childReadErrorsTotal: 1, threads: [{ childReadErrors: 1, childErrors: 0 }] })
  setFailedChildRead(undefined)
  setFailedChild('child-0')
  advanceMinutes(6)
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ childReadErrorsTotal: 0, threads: [{ childReadErrors: 0, childErrors: 1 }] })
  advanceMinutes(24 * 60)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]).toMatchObject({ childErrors: 1 })
})

it('keeps the last known child failure during a transient turn read error', async () => {
  const { monitor, setChildCount, setFailedChild, setFailedChildRead, advanceMinutes } = fixture()
  setChildCount(1)
  setFailedChild('child-0')
  await monitor.scanOnce()
  expect(monitor.view().threads[0]).toMatchObject({ childErrors: 1, childReadErrors: 0 })
  setFailedChildRead('child-0')
  advanceMinutes(6)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]).toMatchObject({ childErrors: 1, childReadErrors: 1 })
  setFailedChildRead(undefined)
  setFailedChild('none')
  advanceMinutes(6)
  await monitor.scanOnce()
  expect(monitor.view().threads[0]).toMatchObject({ childErrors: 0, childReadErrors: 0 })
})

it('preserves the local repository when the RPC inventory has no Git origin', async () => {
  const { monitor, autoHandoff, setLocalRows, setDecision, setPhase, advanceMinutes } = fixture()
  setLocalRows([{ id: 'thread-a', name: 'Release task', sourceKind: 'vscode', archived: false,
    repository: 'acme/widgets', updatedAt: '2026-11-01T10:46:40Z' }])
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  advanceMinutes(1)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '执行失败', action: '修复问题', summary: '仓库构建失败', evidence: '请检查发布结果' }))
  setPhase(1)
  await monitor.scanOnce()
  expect(autoHandoff.mock.calls[0]?.[0]).toMatchObject({ repository: 'acme/widgets' })
})

it('distinguishes child threads without a parent ID from those whose parent is unavailable', async () => {
  const { monitor, setLocalRows, setFailedChild } = fixture()
  setFailedChild('child-other')
  setLocalRows([
    { id: 'child-other', sourceKind: 'subAgentOther', archived: false, updatedAt: '2026-11-01T12:00:00Z' },
    { id: 'child-review', sourceKind: 'subAgentReview', archived: false },
    { id: 'child-missing', sourceKind: 'subAgentThreadSpawn', parentThreadId: 'missing-root', archived: false },
  ])
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ total: 1, childTotal: 3, unlinkedTotal: 3,
    withoutParentTotal: 2, unresolvedParentTotal: 1, unlinkedChildErrors: 1 })
})

it('groups nested children and leaves parent cycles unresolved', async () => {
  const { monitor, setLocalRows } = fixture()
  setLocalRows([
    { id: 'child-direct', sourceKind: 'subAgentThreadSpawn', parentThreadId: 'thread-a', archived: false },
    { id: 'child-nested', sourceKind: 'subAgentThreadSpawn', parentThreadId: 'child-direct', archived: false },
    { id: 'child-cycle-a', sourceKind: 'subAgentThreadSpawn', parentThreadId: 'child-cycle-b', archived: false },
    { id: 'child-cycle-b', sourceKind: 'subAgentThreadSpawn', parentThreadId: 'child-cycle-a', archived: false },
    { id: 'child-no-parent', sourceKind: 'subAgentOther', archived: false },
  ])
  await monitor.scanOnce()
  expect(monitor.view()).toMatchObject({ childTotal: 5, unlinkedTotal: 3,
    withoutParentTotal: 1, unresolvedParentTotal: 2 })
  expect(monitor.view().threads[0]).toMatchObject({ id: 'thread-a', childCount: 2 })
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

it('rebaselines a lost incremental anchor without dispatching missed history', async () => {
  const { monitor, stream, autoHandoff, setDecision, setPhase, setMissingAnchor } = fixture()
  monitor.setEnabled(true)
  await monitor.scanOnce()
  monitor.setAutoHandoff(true)
  setDecision(JSON.stringify({ needsAttention: true, stage: 'failed', kind: 'failure',
    reason: '执行失败', action: '检查失败', summary: '历史失败', evidence: '请检查发布结果' }))
  setPhase(1)
  setMissingAnchor(true)
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(1)
  expect(monitor.view().threads[0]?.error).toContain('new baseline')
  await monitor.scanOnce()
  expect(stream).toHaveBeenCalledTimes(2)
  expect(monitor.view().threads[0]?.error).toBeUndefined()
  expect(monitor.view().threads[0]?.stage).toBe('unknown')
  expect(autoHandoff).not.toHaveBeenCalled()
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
