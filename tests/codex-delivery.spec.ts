import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexControl, CODEX_VERIFY_MESSAGE } from '../src/app/codex-control.ts'
import type { CodexRouteHead } from '../src/app/codex-monitor.ts'
import { CodexDelivery } from '../src/app/codex-delivery.ts'
import { Store } from '../src/app/store.ts'
import { CodexDesktopIpcError, type CodexDesktopState } from '../src/codex/desktop-ipc.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-delivery-')), store = new Store(join(directory, 'orchestrator.sqlite'))
  const control = new CodexControl({ store, stateDir: directory }), lifetime = new AbortController()
  let paused = false
  const state: CodexDesktopState = { threadId: 'thread-a', clientId: 'owner', supportsUntrustedAppInput: true,
    revision: 0, status: 'idle', pendingRequests: 0, workspaceKind: 'project', permissionsKnown: true,
    permissionsHash: 'permissions', settingsHash: 'settings' }
  const client = { readState: vi.fn(async (_threadId: string, _signal?: AbortSignal) => state as CodexDesktopState | undefined), close: vi.fn(),
    interruptTurn: vi.fn(async (_state: CodexDesktopState, _signal?: AbortSignal, _canSend?: () => boolean) => ({
      turnId: 'turn-a', settingsPreserved: true as boolean | undefined })),
    startText: vi.fn(async (_state: CodexDesktopState, _text: string, id: string, _signal?: AbortSignal, _canSend?: () => boolean) => ({
      clientUserMessageId: id, turnId: 'turn-a', settingsPreserved: true as boolean | undefined })) }
  const monitor = { routeHead: vi.fn((): CodexRouteHead => ({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: false, lastItemId: 'head-a' })),
    readHistory: vi.fn(async () => ({ threadId: 'thread-a', title: 'Task', source: 'persisted Codex history' as const,
      readAt: '', complete: false, headItemId: 'head-a', messages: [] })) }
  const relay = vi.fn(), connect = vi.fn(async () => client)
  const delivery = new CodexDelivery({ control, monitor, signal: lifetime.signal, paused: () => paused, relay, connect })
  const enqueue = () => control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a', text: 'Continue authorized work',
    reason: 'DSH router decision', source: 'router' })
  cleanups.push(async () => { await delivery.stop(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { control, state, client, monitor, relay, connect, delivery, enqueue, setPaused: (value: boolean) => { paused = value } }
}

it('probes while disabled and sends a DSH-authored intent once when enabled', async () => {
  const test = fixture()
  await test.delivery.request()
  expect(test.control.view()).toMatchObject({ enabled: false, bridgeReady: true })
  expect(test.client.startText).not.toHaveBeenCalled()
  test.control.setEnabled(true)
  const intent = test.enqueue()
  await test.delivery.request()
  expect(test.control.view().intents[0]).toMatchObject({ id: intent.id, status: 'sent', turnId: 'turn-a' })
  expect(test.client.startText).toHaveBeenCalledWith(test.state, intent.text, expect.any(String), expect.any(AbortSignal), expect.any(Function))
  await test.delivery.request()
  expect(test.client.startText).toHaveBeenCalledOnce()
  expect(JSON.parse(test.relay.mock.calls[0]![1])).toMatchObject({ kind: 'codex_delivery', status: 'sent', settingsVerified: true })
})

it('interrupts only the exact active turn and never sends text as an interruption', async () => {
  const test = fixture(); test.control.setEnabled(true)
  const activeTurnId = '01a1a47c-b3c1-7282-9521-46fd3e44f1f0'
  test.state.status = 'active'; test.state.activeTurnId = activeTurnId
  const intent = test.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a', text: 'Reprioritize this task',
    reason: 'DSH changed work priority', source: 'router', operation: 'interrupt', expectedTurnId: activeTurnId })
  await test.delivery.request(); await test.delivery.request()
  expect(test.client.interruptTurn).toHaveBeenCalledOnce()
  expect(test.client.startText).not.toHaveBeenCalled()
  expect(test.control.view().intents[0]).toMatchObject({ id: intent.id, status: 'sent' })
  expect(JSON.parse(test.relay.mock.calls[0]![1])).toMatchObject({ status: 'interrupted', settingsVerified: true })
})

it('rejects an interrupt for a replaced turn and holds it for a human request', async () => {
  const test = fixture(); test.control.setEnabled(true)
  const expectedTurnId = '01a1a47c-b3c1-7282-9521-46fd3e44f1f0'
  test.state.status = 'active'; test.state.activeTurnId = expectedTurnId; test.state.pendingRequests = 1
  test.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a', text: 'Pause this work',
    reason: 'DSH reprioritization', source: 'router', operation: 'interrupt', expectedTurnId })
  await test.delivery.request()
  expect(test.control.view().intents[0]?.status).toBe('queued')
  test.state.pendingRequests = 0; test.state.activeTurnId = '01a1a47c-b3c1-7282-9521-46fd3e44f1f1'
  await test.delivery.request()
  expect(test.control.view().intents[0]).toMatchObject({ status: 'failed', error: 'stale-active-turn' })
  expect(test.client.interruptTurn).not.toHaveBeenCalled()
})

it('can deliver to an idle conversation while an earlier conversation stays busy', async () => {
  const test = fixture(); test.control.setEnabled(true)
  const busy = test.enqueue()
  test.control.reorder(busy.id, 3)
  const later = test.control.enqueue({ threadId: 'thread-b', basedOnItemId: 'head-a', text: 'Report authorized progress',
    reason: 'DSH status check', source: 'router' })
  test.client.readState.mockImplementation(async threadId => ({ ...test.state, threadId,
    status: threadId === busy.threadId ? 'active' : 'idle' }))
  await test.delivery.request()
  expect(test.control.view().intents.find(row => row.id === busy.id)?.status).toBe('queued')
  expect(test.control.view().intents.find(row => row.id === later.id)?.status).toBe('sent')
  expect(test.client.startText).toHaveBeenCalledOnce()
})

it('holds an unavailable owner, reconnects, and continues to another conversation', async () => {
  const test = fixture(); test.control.setEnabled(true)
  const held = test.enqueue(); test.control.reorder(held.id, 3)
  const ready = test.control.enqueue({ threadId: 'thread-b', basedOnItemId: 'head-a', text: 'Report progress',
    reason: 'DSH status check', source: 'router' })
  test.client.readState.mockImplementation(async threadId => {
    if (threadId === held.threadId) throw new CodexDesktopIpcError('request-timeout')
    return { ...test.state, threadId }
  })
  await test.delivery.request()
  expect(test.connect).toHaveBeenCalledTimes(2)
  expect(test.control.view().intents.find(row => row.id === held.id)?.status).toBe('queued')
  expect(test.control.view().intents.find(row => row.id === ready.id)?.status).toBe('sent')
})

it('visits conversations beyond a full batch of busy owners on the next pass', async () => {
  const test = fixture(); test.control.setEnabled(true)
  for (let index = 0; index < 9; index++) test.control.enqueue({ threadId: `busy-${index}`,
    basedOnItemId: 'head-a', text: 'Report progress', reason: 'DSH check', source: 'router', priority: 3 })
  const ready = test.control.enqueue({ threadId: 'thread-b', basedOnItemId: 'head-a', text: 'Report progress',
    reason: 'DSH check', source: 'router', priority: 0 })
  test.client.readState.mockImplementation(async threadId => ({ ...test.state, threadId,
    status: threadId.startsWith('busy-') ? 'active' : 'idle' }))
  await test.delivery.request()
  expect(test.client.startText).not.toHaveBeenCalled()
  await test.delivery.request()
  expect(test.control.view().intents.find(row => row.id === ready.id)?.status).toBe('sent')
})

it('keeps active or approval-waiting conversations queued until idle', async () => {
  const test = fixture(); test.control.setEnabled(true); test.enqueue()
  test.state.status = 'active'
  await test.delivery.request()
  expect(test.control.view().intents[0]?.status).toBe('queued')
  test.state.status = 'idle'; test.state.pendingRequests = 1
  await test.delivery.request()
  expect(test.client.startText).not.toHaveBeenCalled()
  test.state.pendingRequests = 0
  await test.delivery.request()
  expect(test.control.view().intents[0]?.status).toBe('sent')
})

it('rejects stale history without sending and never retries an uncertain dispatch', async () => {
  const stale = fixture(); stale.control.setEnabled(true); stale.enqueue()
  stale.monitor.readHistory.mockResolvedValue({ threadId: 'thread-a', title: 'Task', source: 'persisted Codex history',
    readAt: '', complete: false, headItemId: 'new-head', messages: [] })
  await stale.delivery.request()
  expect(stale.control.view().intents[0]).toMatchObject({ status: 'failed', error: 'stale-history-head' })
  expect(stale.client.startText).not.toHaveBeenCalled()
  const uncertain = fixture(); uncertain.control.setEnabled(true); uncertain.enqueue()
  uncertain.client.startText.mockRejectedValue(new CodexDesktopIpcError('delivery-uncertain'))
  await uncertain.delivery.request(); await uncertain.delivery.request()
  expect(uncertain.control.view().intents[0]?.status).toBe('dispatching')
  expect(uncertain.client.startText).toHaveBeenCalledOnce()
})

it('keeps the send receipt and disables further control when settings cannot be verified', async () => {
  const test = fixture(); test.control.setEnabled(true); test.enqueue()
  test.client.startText.mockResolvedValue({ clientUserMessageId: 'message', turnId: 'turn-a', settingsPreserved: false })
  await test.delivery.request()
  expect(test.control.view()).toMatchObject({ enabled: false, intents: [{ status: 'sent' }] })
  expect(JSON.parse(test.relay.mock.calls[0]![1])).toMatchObject({ status: 'sent', controlDisabled: true })
})

it('stops an in-flight state read before claiming or sending', async () => {
  const test = fixture(); test.control.setEnabled(true); test.enqueue()
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  test.client.readState.mockImplementation(async (_threadId?: string, signal?: AbortSignal) => {
    entered()
    return await new Promise<never>((_resolve, reject) => signal!.addEventListener('abort',
      () => reject(new CodexDesktopIpcError('cancelled')), { once: true }))
  })
  const running = test.delivery.request(); await reading; await test.delivery.stop(); await running
  expect(test.client.startText).not.toHaveBeenCalled()
  expect(test.client.close).toHaveBeenCalledOnce()
  expect(test.control.view().intents[0]?.status).toBe('queued')
})

it('holds queued work during a DSH pause, including a pause during final send preparation', async () => {
  const test = fixture(); test.control.setEnabled(true); test.enqueue(); test.setPaused(true)
  await test.delivery.request()
  expect(test.connect).not.toHaveBeenCalled()
  test.setPaused(false)
  test.client.startText.mockImplementation(async (_state, _text, _id, _signal, canSend) => {
    test.setPaused(true)
    if (!canSend!()) throw new CodexDesktopIpcError('delivery-held')
    throw new Error('must not reach the wire')
  })
  await test.delivery.request()
  expect(test.control.view().intents[0]).toMatchObject({ status: 'queued' })
  expect(test.control.view().intents[0]).not.toHaveProperty('deliveryId')
  expect(test.relay).not.toHaveBeenCalled()
})

it('sends fixed verify once to needsYou with matching verificationRequestId, refuses ordinary followup and mismatched ID', async () => {
  const test = fixture(); test.control.setEnabled(true)
  const requestId = '0123456789abcdef0123456789abcdef'
  test.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: true, verificationRequestId: requestId, lastItemId: 'head-a' })
  const verify = test.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  await test.delivery.request()
  expect(test.control.view().intents[0]).toMatchObject({ id: verify.id, status: 'sent' })
  expect(test.client.startText).toHaveBeenCalledOnce()
  const followup = test.enqueue()
  await test.delivery.request()
  expect(test.control.view().intents.find(row => row.id === followup.id)).toMatchObject({ status: 'failed', error: 'person-required' })
  expect(test.client.startText).toHaveBeenCalledOnce()
  const wrongId = test.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification wrong ID', source: 'router', operation: 'verify', verificationRequestId: 'b'.repeat(32) })
  await test.delivery.request()
  expect(test.control.view().intents.find(row => row.id === wrongId.id)).toMatchObject({ status: 'failed', error: 'verification-request-changed' })
})

it('refuses verify to needsYou without verificationRequestId in head', async () => {
  const test = fixture(); test.control.setEnabled(true)
  const requestId = 'c'.repeat(32)
  test.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: true, lastItemId: 'head-a' })
  test.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  await test.delivery.request()
  expect(test.control.view().intents[0]).toMatchObject({ status: 'failed', error: 'verification-request-changed' })
  expect(test.client.startText).not.toHaveBeenCalled()
})

it('refuses verify when user paused, approval pending, active, or unknown regardless of verificationRequestId', async () => {
  const requestId = 'd'.repeat(32)
  const pausedTest = fixture(); pausedTest.control.setEnabled(true)
  pausedTest.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, pausedByUser: true, needsYou: false, verificationRequestId: requestId, lastItemId: 'head-a' })
  pausedTest.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  await pausedTest.delivery.request()
  expect(pausedTest.control.view().intents[0]).toMatchObject({ status: 'failed', error: 'stale-history-head' })
  expect(pausedTest.client.startText).not.toHaveBeenCalled()

  const approvalTest = fixture(); approvalTest.control.setEnabled(true)
  approvalTest.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: true, verificationRequestId: requestId, lastItemId: 'head-a' })
  approvalTest.state.pendingRequests = 1
  approvalTest.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  await approvalTest.delivery.request()
  expect(approvalTest.control.view().intents[0]?.status).toBe('queued')

  const activeTest = fixture(); activeTest.control.setEnabled(true)
  activeTest.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: true, verificationRequestId: requestId, lastItemId: 'head-a' })
  activeTest.state.status = 'active'
  activeTest.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  await activeTest.delivery.request()
  expect(activeTest.control.view().intents[0]?.status).toBe('queued')

  const unknownTest = fixture(); unknownTest.control.setEnabled(true)
  unknownTest.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: true, verificationRequestId: requestId, lastItemId: 'head-a' })
  unknownTest.state.status = 'unknown'
  unknownTest.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  await unknownTest.delivery.request()
  expect(unknownTest.control.view().intents[0]?.status).toBe('failed')
})

it('blocks verify when verificationRequestId changed after claim or during send', async () => {
  const requestId = 'e'.repeat(32)
  const changedTest = fixture(); changedTest.control.setEnabled(true)
  changedTest.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: true, verificationRequestId: requestId, lastItemId: 'head-a' })
  changedTest.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  changedTest.client.startText.mockImplementation(async (_state, _text, _id, _signal, canSend) => {
    changedTest.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
      archived: false, ready: true, needsYou: true, verificationRequestId: 'f'.repeat(32), lastItemId: 'head-a' })
    if (!canSend!()) throw new CodexDesktopIpcError('delivery-held')
    throw new Error('must not reach wire')
  })
  await changedTest.delivery.request()
  expect(changedTest.control.view().intents[0]).toMatchObject({ status: 'queued' })
  expect(changedTest.control.view().intents[0]).not.toHaveProperty('deliveryId')

  const removedTest = fixture(); removedTest.control.setEnabled(true)
  removedTest.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: true, verificationRequestId: requestId, lastItemId: 'head-a' })
  removedTest.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  removedTest.client.startText.mockImplementation(async (_state, _text, _id, _signal, canSend) => {
    removedTest.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
      archived: false, ready: true, needsYou: false, lastItemId: 'head-a' })
    if (!canSend!()) throw new CodexDesktopIpcError('delivery-held')
    throw new Error('must not reach wire')
  })
  await removedTest.delivery.request()
  expect(removedTest.control.view().intents[0]).toMatchObject({ status: 'queued' })
})

it('rejects invalid verify with non-fixed text or tampered persistent verificationRequestId', async () => {
  const requestId = '0123456789abcdef0123456789abcdef'
  const test = fixture(); test.control.setEnabled(true)
  test.monitor.routeHead.mockReturnValue({ threadId: 'thread-a', title: 'Task', present: true,
    archived: false, ready: true, needsYou: true, verificationRequestId: requestId, lastItemId: 'head-a' })
  expect(() => test.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: 'Custom verify text', reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: 'invalid' }))
    .toThrow()
  expect(() => test.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: 'Custom verify text', reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId }))
    .toThrow('fixed read-only message')
  const tampered = test.control.enqueue({ threadId: 'thread-a', basedOnItemId: 'head-a',
    text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
  const state = test.control['deps'].store.get('codex-control-v1') as { version: number; enabled: boolean; intents: Record<string, { text: string }> }
  state.intents[tampered.id]!.text = 'Tampered message'
  test.control['deps'].store.set('codex-control-v1', state)
  test.control['syncUnlocked']()
  await test.delivery.request()
  expect(test.control.view().intents[0]).toMatchObject({ status: 'failed', error: 'invalid-verification' })
  expect(test.client.startText).not.toHaveBeenCalled()
})
