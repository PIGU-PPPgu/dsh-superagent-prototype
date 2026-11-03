import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexControl } from '../src/app/codex-control.ts'
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
    startText: vi.fn(async (_state: CodexDesktopState, _text: string, id: string, _signal?: AbortSignal, _canSend?: () => boolean) => ({
      clientUserMessageId: id, turnId: 'turn-a', settingsPreserved: true as boolean | undefined })) }
  const monitor = { routeHead: vi.fn(() => ({ threadId: 'thread-a', title: 'Task', present: true,
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
