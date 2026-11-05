import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodexDesktopIpc, type CodexDesktopState } from '../src/codex/desktop-ipc.ts'
import type { CodexMonitor } from '../src/app/codex-monitor.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { testCodexRoutingContext } from './fixtures/codex.ts'

let host: Host
beforeEach(async () => { host = await startRuntime() })
afterEach(async () => { await host.stop(); vi.restoreAllMocks() })

function setup() {
  const threadId = randomUUID(), turnId = randomUUID()
  host.runtime.store.set('codex-monitor-v1', { version: 1, enabled: true, initialized: true, threads: {
    [threadId]: { id: threadId, sourceKind: 'vscode', archived: false, present: true,
      baselined: true, lastItemId: 'head-a', context: [], updatedAt: new Date().toISOString() },
  } })
  const monitor = (host.runtime as unknown as { codexMonitor: CodexMonitor }).codexMonitor
  const context = testCodexRoutingContext(threadId, 'head-a')
  vi.spyOn(monitor, 'requireProjectContext').mockResolvedValue(context)
  vi.spyOn(monitor, 'readHistory').mockResolvedValue({ threadId, title: 'Task', source: 'persisted Codex history',
    readAt: new Date().toISOString(), complete: false, headItemId: 'head-a', messages: [] })
  const state: CodexDesktopState = { threadId, clientId: randomUUID(), revision: 1, status: 'active',
    activeTurnId: turnId, pendingRequests: 0, supportsUntrustedAppInput: true, workspaceKind: 'project',
    permissionsKnown: true, permissionsHash: 'permissions', settingsHash: 'settings' }
  const client = { readState: vi.fn(async () => state), close: vi.fn(), startText: vi.fn(),
    interruptTurn: vi.fn(async () => ({ turnId, settingsPreserved: true })) }
  vi.spyOn(CodexDesktopIpc, 'connect').mockResolvedValue(client as unknown as CodexDesktopIpc)
  host.runtime.codexControl.setBridgeAvailable(true)
  host.runtime.codexControl.setEnabled(true)
  const run = (extra = {}) => host.runTool(host.runtime.masterId, 'orchestrator_codex_route', {
    operation: 'interrupt', thread_id: threadId, base_item_id: 'head-a', active_turn_id: turnId,
    context_id: context.contextId, reason: 'Reprioritize authorized work', ...extra,
  })
  return { state, client, run }
}

it('lets the DSH main Session queue one exact-turn interrupt without sending a user message', async () => {
  const test = setup()
  const result = await test.run() as { intent: { id: string; expectedTurnId: string } }
  expect(result.intent.expectedTurnId).toBe(test.state.activeTurnId)
  await vi.waitFor(() => expect(host.runtime.codexControl.view().intents[0]?.status).toBe('sent'))
  expect(test.client.interruptTurn).toHaveBeenCalledOnce()
  expect(test.client.startText).not.toHaveBeenCalled()
  expect(host.controller.prompt).not.toHaveBeenCalled()
})

it('refuses a replaced active turn, pending approvals and text hidden in an interrupt', async () => {
  const test = setup()
  await expect(test.run({ active_turn_id: randomUUID() })).rejects.toThrow('active Codex turn changed')
  test.state.pendingRequests = 1
  await expect(test.run()).rejects.toThrow('needs a person')
  test.state.pendingRequests = 0
  await expect(test.run({ message: 'Send text too' })).rejects.toThrow('does not send a message')
  expect(host.runtime.codexControl.view().intents).toEqual([])
  expect(test.client.interruptTurn).not.toHaveBeenCalled()
})

it.each([false, true])('revokes an interrupt prepared before disable even if re-enabled: %s', async reenable => {
  const test = setup()
  const entered = Promise.withResolvers<void>()
  const snapshot = Promise.withResolvers<CodexDesktopState>()
  test.client.readState.mockImplementationOnce(async () => {
    entered.resolve()
    return snapshot.promise
  })
  const rejected = expect(test.run()).rejects.toThrow(reenable ? 'authorization changed' : 'disabled')
  await entered.promise
  host.runtime.codexControl.setEnabled(false)
  if (reenable) host.runtime.codexControl.setEnabled(true)
  snapshot.resolve(test.state)
  await rejected
  expect(host.runtime.codexControl.view().intents).toEqual([])
  expect(test.client.interruptTurn).not.toHaveBeenCalled()
  expect(test.client.startText).not.toHaveBeenCalled()
})
