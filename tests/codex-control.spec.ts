import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { CodexControl, CODEX_VERIFY_MESSAGE } from '../src/app/codex-control.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('persists ordered Codex follow-ups and never resends an uncertain dispatch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-control-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    let now = new Date('2026-11-03T05:00:00Z')
    const control = new CodexControl({ store, stateDir: directory, now: () => now })
    expect(control.view()).toMatchObject({ enabled: false, bridgeReady: false, intents: [] })
    control.setEnabled(true)
    const first = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-one', text: 'Continue the task.',
      reason: 'Latest assistant reported a technical failure', priority: 1, source: 'router' })
    const second = control.enqueue({ threadId: 'thread-two', basedOnItemId: 'item-two', text: 'Check the result.',
      reason: 'Router found a pending follow-up', priority: 3, source: 'router' })
    expect(control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-one', text: 'Continue the task.',
      reason: 'Latest assistant reported a technical failure', source: 'router' }).id).toBe(first.id)
    const queue = () => JSON.parse(readFileSync(join(control.directory, 'queue.json'), 'utf8')) as {
      actions: { id: string }[] }
    expect(queue().actions.map(intent => intent.id)).toEqual([second.id, first.id])
    expect(statSync(join(control.directory, 'queue.json')).mode & 0o777).toBe(0o600)
    control.reorder(first.id, 3)
    expect(control.view().intents).toHaveLength(2)
    now = new Date('2026-11-03T05:01:00Z')
    const receipt = join(control.directory, 'receipts', `${first.id}.json`)
    writeFileSync(receipt, JSON.stringify({ version: 1, intentId: first.id, threadId: first.threadId,
      status: 'dispatching', at: now.toISOString() }))
    control.sync()
    expect(control.view().intents.find(intent => intent.id === first.id)?.status).toBe('dispatching')
    expect(queue().actions.map(intent => intent.id)).toEqual([second.id])
    control.sync()
    expect(queue().actions.map(intent => intent.id)).toEqual([second.id])
    now = new Date('2026-11-03T05:02:00Z')
    writeFileSync(receipt, JSON.stringify({ version: 1, intentId: first.id, threadId: first.threadId,
      status: 'sent', at: now.toISOString() }))
    control.sync()
    expect(control.view().intents.find(intent => intent.id === first.id)?.status).toBe('sent')
    writeFileSync(receipt, JSON.stringify({ version: 1, intentId: first.id, threadId: first.threadId,
      status: 'dispatching', at: '2026-11-03T05:03:00Z' }))
    control.sync()
    expect(control.view().intents.find(intent => intent.id === first.id)?.status).toBe('sent')
    expect(() => control.cancel(first.id)).toThrow('Only queued')
    control.setEnabled(false)
    expect(queue().actions).toEqual([])
  } finally { store.close() }
})

it('lets DSH claim once and disables every legacy external write command', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-bridge-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const control = new CodexControl({ store, stateDir: directory })
    control.setEnabled(true)
    const intent = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-one',
      text: 'Continue the task.', reason: 'Router decision', source: 'router' })
    const script = join(process.cwd(), 'scripts', 'codex-control-bridge.mjs')
    const call = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
      [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Record<string, unknown>
    expect(call('list', directory).actions).toMatchObject([{ id: intent.id }])
    for (const command of ['claim', 'sent', 'failed', 'heartbeat']) expect(() => call(command, directory, intent.id)).toThrow()
    expect(control.claim(intent.id)).toMatchObject({ id: intent.id, status: 'dispatching', deliveryId: expect.any(String) })
    expect(call('list', directory).actions).toEqual([])
    expect(() => control.claim(intent.id)).toThrow('no longer queued')
    expect(() => control.cancel(intent.id)).toThrow('Only queued')
    expect(control.finish(intent.id, 'sent')).toMatchObject({ status: 'sent' })
    expect(() => control.finish(intent.id, 'failed')).toThrow('not dispatching')
    control.sync()
    expect(control.view().intents[0]?.status).toBe('sent')
    control.setBridgeAvailable(true)
    expect(control.view().bridgeReady).toBe(true)
    const later = control.enqueue({ threadId: 'thread-two', basedOnItemId: 'item-two',
      text: 'Review the latest user task.', reason: 'Router decision', source: 'router' })
    expect(call('list', directory).actions).toMatchObject([{ id: later.id }])
    const staleProjection = readFileSync(join(control.directory, 'queue.json'), 'utf8')
    control.setEnabled(false)
    writeFileSync(join(control.directory, 'queue.json'), staleProjection, { mode: 0o600 })
    expect(() => control.claim(later.id)).toThrow()
    control.setEnabled(true)
    const retried = control.enqueue({ threadId: 'thread-two', basedOnItemId: 'item-two',
      text: 'Review the latest user task.', reason: 'Router decision', source: 'router' })
    expect(retried.id).not.toBe(later.id)
    expect(retried.status).toBe('queued')
  } finally { store.close() }
})

it('refuses a stale native claim after a DSH Ticket takes ownership of the conversation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-owned-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const control = new CodexControl({ store, stateDir: directory })
    control.setEnabled(true)
    const intent = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-one',
      text: 'Continue the task.', reason: 'Router decision', source: 'router' })
    const origin: Trigger = { id: 'origin-one', source: 'codex', threads: [{ source: 'codex', id: 'thread-one' }],
      actor: { source: 'codex', id: 'local-codex-monitor' }, human: true, at: new Date().toISOString(),
      text: 'Task', meta: { threadId: 'thread-one' } }
    store.triggers.save(origin)
    store.tickets.save({ id: 'ticket-one', origin: { triggerId: origin.id, triggerIds: [origin.id] },
      assignments: [], inputs: [], undelivered: [] } as unknown as Ticket)
    expect(() => control.claim(intent.id)).toThrow()
    control.sync()
    expect(control.view().intents[0]?.status).toBe('cancelled')
  } finally { store.close() }
})

it('defaults legacy authorization to zero and persists revocation across a control restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-authorization-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    store.set('codex-control-v1', { version: 1, enabled: true, intents: {} })
    const control = new CodexControl({ store, stateDir: directory })
    const prepared = { threadId: 'thread-one', basedOnItemId: 'item-one', text: 'Continue the task.',
      reason: 'Router decision', source: 'router' as const, token: control.view().token }
    expect(prepared.token).toBe(0)
    control.setEnabled(false)
    expect(() => control.enqueue(prepared)).toThrow('disabled')
    control.setEnabled(true)
    const restarted = new CodexControl({ store, stateDir: directory })
    expect(restarted.view().token).toBe(control.view().token)
    expect(restarted.view().token).not.toBe(prepared.token)
    expect(() => restarted.enqueue(prepared)).toThrow('authorization changed')
    expect(restarted.view().intents).toEqual([])
    expect(restarted.enqueue({ ...prepared, token: restarted.view().token }).status).toBe('queued')
  } finally { store.close() }
})

it('accepts verify only with fixed message and 32-hex verificationRequestId', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-verify-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    const control = new CodexControl({ store, stateDir: directory })
    control.setEnabled(true)
    const requestId = 'a'.repeat(32)
    const verify = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-one',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification check', source: 'router', operation: 'verify', verificationRequestId: requestId })
    expect(verify.operation).toBe('verify')
    expect(verify.verificationRequestId).toBe(requestId)
    expect(verify.status).toBe('queued')
    expect(() => control.enqueue({ threadId: 'thread-two', basedOnItemId: 'item-two',
      text: 'Custom verification message', reason: 'DSH check', source: 'router', operation: 'verify', verificationRequestId: requestId }))
      .toThrow('fixed read-only message')
    expect(() => control.enqueue({ threadId: 'thread-three', basedOnItemId: 'item-three',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH check', source: 'router', operation: 'verify', verificationRequestId: 'short' }))
      .toThrow()
    expect(() => control.enqueue({ threadId: 'thread-four', basedOnItemId: 'item-four',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH check', source: 'router', operation: 'verify' })).toThrow()
    expect(() => control.enqueue({ threadId: 'thread-five', basedOnItemId: 'item-five',
      text: 'Regular message', reason: 'DSH check', source: 'router', verificationRequestId: requestId }))
      .toThrow('Only verification targets')
  } finally { store.close() }
})

it('deduplicates verify by same verificationRequestId even after sent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-verify-dedup-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    let now = new Date('2026-11-03T05:00:00Z')
    const control = new CodexControl({ store, stateDir: directory, now: () => now })
    control.setEnabled(true)
    const requestId = 'b'.repeat(32)
    const first = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-one',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification', source: 'router', operation: 'verify', verificationRequestId: requestId })
    const duplicate = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-one',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification retry', source: 'router', operation: 'verify', verificationRequestId: requestId })
    expect(duplicate.id).toBe(first.id)
    const claimed = control.claim(first.id)
    control.finish(claimed.id, 'sent', { turnId: 'turn-a' })
    now = new Date('2026-11-03T05:01:00Z')
    const afterSent = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-two',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification after head change', source: 'router', operation: 'verify', verificationRequestId: requestId })
    expect(afterSent.id).toBe(first.id)
    const differentRequest = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'item-two',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH verification new request', source: 'router', operation: 'verify', verificationRequestId: 'c'.repeat(32) })
    expect(differentRequest.id).not.toBe(first.id)
  } finally { store.close() }
})

it('keeps separate verify intents for different verificationRequestIds with independent receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-verify-multi-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  try {
    let now = new Date('2026-11-03T05:00:00Z')
    const control = new CodexControl({ store, stateDir: directory, now: () => now })
    control.setEnabled(true)
    const requestA = 'a'.repeat(32), requestB = 'b'.repeat(32)
    const intentA = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'head-one',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH verify A', source: 'router', operation: 'verify', verificationRequestId: requestA })
    const claimedA = control.claim(intentA.id)
    control.finish(claimedA.id, 'sent', { turnId: 'turn-a' })
    now = new Date('2026-11-03T05:01:00Z')
    const intentB = control.enqueue({ threadId: 'thread-one', basedOnItemId: 'head-one',
      text: CODEX_VERIFY_MESSAGE, reason: 'DSH verify B', source: 'router', operation: 'verify', verificationRequestId: requestB })
    expect(intentB.id).not.toBe(intentA.id)
    const view = control.view()
    expect(view.intents).toHaveLength(2)
    expect(view.intents.find(i => i.id === intentA.id)).toMatchObject({ status: 'sent', verificationRequestId: requestA, turnId: 'turn-a' })
    expect(view.intents.find(i => i.id === intentB.id)).toMatchObject({ status: 'queued', verificationRequestId: requestB })
  } finally { store.close() }
})
