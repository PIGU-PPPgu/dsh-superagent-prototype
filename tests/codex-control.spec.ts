import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { CodexControl } from '../src/app/codex-control.ts'
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
    expect(() => control.cancel(first.id)).toThrow('Only queued')
    control.setEnabled(false)
    expect(queue().actions).toEqual([])
  } finally { store.close() }
})

it('lets the native bridge claim a queued intent exactly once and report its receipt', () => {
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
      [script, ...args], { encoding: 'utf8' })) as Record<string, unknown>
    expect(call('list', directory).actions).toMatchObject([{ id: intent.id }])
    expect(call('claim', directory, intent.id)).toMatchObject({ id: intent.id })
    expect(call('list', directory).actions).toEqual([])
    expect(() => call('claim', directory, intent.id)).toThrow()
    expect(() => control.cancel(intent.id)).toThrow('Only queued')
    expect(call('sent', directory, intent.id)).toMatchObject({ status: 'sent' })
    expect(call('sent', directory, intent.id)).toMatchObject({ status: 'sent' })
    expect(() => call('failed', directory, intent.id, 'late error')).toThrow()
    control.sync()
    expect(control.view().intents[0]?.status).toBe('sent')
    expect(call('heartbeat', directory)).toEqual({ ready: true })
    expect(control.view().bridgeReady).toBe(true)
    const later = control.enqueue({ threadId: 'thread-two', basedOnItemId: 'item-two',
      text: 'Review the latest user task.', reason: 'Router decision', source: 'router' })
    expect(call('list', directory).actions).toMatchObject([{ id: later.id }])
    const staleProjection = readFileSync(join(control.directory, 'queue.json'), 'utf8')
    control.setEnabled(false)
    writeFileSync(join(control.directory, 'queue.json'), staleProjection, { mode: 0o600 })
    expect(() => call('claim', directory, later.id)).toThrow()
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
    const script = join(process.cwd(), 'scripts', 'codex-control-bridge.mjs')
    expect(() => execFileSync(process.execPath, [script, 'claim', directory, intent.id], { encoding: 'utf8' })).toThrow()
    control.sync()
    expect(control.view().intents[0]?.status).toBe('cancelled')
  } finally { store.close() }
})
