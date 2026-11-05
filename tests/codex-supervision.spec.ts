import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexControl } from '../src/app/codex-control.ts'
import { CodexSupervision } from '../src/app/codex-supervision.ts'
import { Store } from '../src/app/store.ts'
import type { CodexSupervisionSnapshot } from '../src/app/codex-monitor.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-supervision-')), store = new Store(join(directory, 'orchestrator.sqlite'))
  let now = new Date('2026-11-05T08:00:00Z'), paused = false
  let control = new CodexControl({ store, stateDir: directory, now: () => now })
  control.setEnabled(true)
  const snapshots = new Map<string, CodexSupervisionSnapshot>(), relay = vi.fn()
  const monitor = { supervisionSnapshot: (id: string) => snapshots.get(id) }
  const create = () => new CodexSupervision({ control, monitor, relay, paused: () => paused, now: () => now })
  let supervision = create()
  const input = { threadId: 'thread-a', basedOnItemId: 'base-a', text: 'First step', reason: 'Authorized goal',
    source: 'router' as const, projectContextId: 'a'.repeat(32),
    delegation: { goal: 'Complete both steps', action: 'First step', doneWhen: 'Both responses verified', userItemId: 'user-goal' } }
  const first = control.enqueue(input)
  control.claim(first.id); control.finish(first.id, 'sent', { turnId: 'turn-a' })
  const reply = (text = 'First step finished; second step remains', status = 'completed', itemId = 'reply-a', turnId = 'turn-a') => {
    snapshots.set('thread-a', { head: { threadId: 'thread-a', title: 'Project', present: true, archived: false, ready: true,
      needsYou: false, lastItemId: itemId, stage: 'progress' }, latestTurnId: turnId, latestTurnStatus: status,
      messages: [{ id: 'input-a', turnId, role: 'user', text: input.text }, { id: itemId, turnId, role: 'assistant', text }] })
  }
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { input, first, snapshots, relay, reply, get control() { return control }, get supervision() { return supervision },
    current: () => control.view().intents.find(i => i.id === first.id)!, advance: (seconds: number) => { now = new Date(now.getTime() + seconds * 1000) },
    pause: (value: boolean) => { paused = value }, restart: () => {
      control = new CodexControl({ store, stateDir: directory, now: () => now }); supervision = create()
    } }
}

it.each(['progress', 'unknown'] as const)('wakes on a terminal managed reply classified %s', stage => {
  const f = fixture(); f.reply()
  f.snapshots.get('thread-a')!.head.stage = stage
  f.supervision.refresh()
  expect(f.current().supervision).toMatchObject({ phase: 'needsReview', response: { itemId: 'reply-a', turnId: 'turn-a', kind: 'reply' } })
  expect(JSON.parse(f.relay.mock.calls[0]![1])).toMatchObject({ kind: 'codex_managed_reply', goal: f.input.delegation.goal,
    doneWhen: f.input.delegation.doneWhen, response: { itemId: 'reply-a' } })
})

it('does not review an active turn or unrelated historical turn', () => {
  const active = fixture(); active.reply('Working', 'inProgress'); active.supervision.refresh()
  expect(active.relay).not.toHaveBeenCalled()
  const wrong = fixture(); wrong.reply('Other response', 'completed', 'other-reply', 'other-turn'); wrong.supervision.refresh()
  expect(wrong.relay).not.toHaveBeenCalled()
})

it('notifies once immediately and retries an unhandled review durably after two minutes', () => {
  const f = fixture(); f.reply(); f.supervision.refresh(); f.supervision.refresh()
  expect(f.relay).toHaveBeenCalledTimes(1)
  f.restart(); f.supervision.refresh()
  expect(f.relay).toHaveBeenCalledTimes(1)
  f.advance(121); f.supervision.refresh()
  expect(f.relay).toHaveBeenCalledTimes(2)
  expect(f.current().supervision?.notifications).toBe(2)
})

it('atomically links a second step and preserves the overall goal and completion criterion', () => {
  const f = fixture(); f.reply(); f.supervision.refresh()
  const parent = f.supervision.continuation('thread-a', f.first.id, 'reply-a', 'reply-a')
  const next = { ...f.input, basedOnItemId: 'reply-a', text: 'Second step', reviewIntentId: parent.id,
    responseItemId: 'reply-a', delegation: { ...f.input.delegation, action: 'Second step' } }
  const child = f.control.enqueue(next)
  expect(f.current().supervision).toMatchObject({ phase: 'continued', nextIntentId: child.id })
  expect(child.supervision?.parentIntentId).toBe(parent.id)
  expect(child.delegation).toMatchObject({ goal: parent.delegation!.goal, doneWhen: parent.delegation!.doneWhen })
  expect(f.control.enqueue(next).id).toBe(child.id)
  expect(f.control.view().intents).toHaveLength(2)
  expect(() => f.control.enqueue({ ...next, text: 'Another step' })).toThrow('already handled')
})

it('refuses old heads, old replies and replacing an unfinished goal by a shorter goal', () => {
  const f = fixture(); f.reply(); f.supervision.refresh()
  expect(() => f.supervision.continuation('thread-a', f.first.id, 'old-reply', 'reply-a')).toThrow('stale')
  expect(() => f.supervision.continuation('thread-a', f.first.id, 'reply-a', 'old-head')).toThrow('stale')
  expect(() => f.control.enqueue({ ...f.input, basedOnItemId: 'reply-a', text: 'Second', reviewIntentId: f.first.id,
    responseItemId: 'reply-a', delegation: { ...f.input.delegation, goal: 'Only first step' } })).toThrow('unchanged')
  expect(f.control.view().intents).toHaveLength(1)
})

it('requires an explicit decision and never repeats a completed review after restart', () => {
  const f = fixture(); f.reply('Both responses verified'); f.supervision.refresh()
  expect(() => f.supervision.review(f.first.id, 'stale-reply', 'complete', 'Done')).toThrow('stale')
  f.supervision.review(f.first.id, 'reply-a', 'complete', 'Both required outputs verified')
  f.restart(); f.advance(1000); f.supervision.refresh()
  expect(f.relay).toHaveBeenCalledTimes(1)
  expect(f.current().supervision?.phase).toBe('completed')
  expect(() => f.supervision.review(f.first.id, 'reply-a', 'complete', 'Again')).toThrow('already handled')
})

it('waits for a dependency, then brings the goal back without asking the user', () => {
  const f = fixture(); f.reply(); f.supervision.refresh()
  f.supervision.review(f.first.id, 'reply-a', 'wait', 'Waiting for CI', 60)
  f.advance(59); f.supervision.refresh(); expect(f.relay).toHaveBeenCalledTimes(1)
  f.advance(2); f.supervision.refresh(); expect(f.relay).toHaveBeenCalledTimes(2)
  expect(f.current().supervision?.phase).toBe('needsReview')
})

it.each(['needsYou', 'pausedByUser'] as const)('does not repeat a waiting notice while %s remains', flag => {
  const f = fixture(); f.reply(); f.supervision.refresh()
  f.supervision.review(f.first.id, 'reply-a', 'wait', 'Respecting the human boundary', 30)
  f.snapshots.get('thread-a')!.head[flag] = true
  f.advance(1000); f.supervision.refresh()
  expect(f.relay).toHaveBeenCalledTimes(1)
  f.snapshots.get('thread-a')!.head[flag] = false
  f.supervision.refresh(); expect(f.relay).toHaveBeenCalledTimes(2)
})

it('holds observations while execution or control is disabled', () => {
  const f = fixture(); f.reply(); f.pause(true); f.supervision.refresh(); expect(f.relay).not.toHaveBeenCalled()
  f.pause(false); f.control.setEnabled(false); f.supervision.refresh(); expect(f.relay).not.toHaveBeenCalled()
  f.control.setEnabled(true); f.supervision.refresh(); expect(f.relay).toHaveBeenCalledTimes(1)
})

it('stops future supervision explicitly without interrupting the native turn', () => {
  const f = fixture()
  f.supervision.review(f.first.id, undefined, 'stop', 'User changed the project scope')
  f.reply(); f.supervision.refresh()
  expect(f.current().supervision?.phase).toBe('stopped')
  expect(f.relay).not.toHaveBeenCalled()
  expect(f.current().status).toBe('sent')
})

it('does not replay old one-shot intents that were never supervised', () => {
  const f = fixture()
  const legacy = f.control.enqueue({ threadId: 'legacy-thread', basedOnItemId: 'legacy-base', text: 'Legacy one-shot', reason: 'History', source: 'router' })
  f.control.claim(legacy.id); f.control.finish(legacy.id, 'sent', { turnId: 'legacy-turn' })
  f.snapshots.set('legacy-thread', { head: { threadId: 'legacy-thread', title: 'Old', present: true, ready: true, archived: false,
    needsYou: false, lastItemId: 'legacy-response' }, latestTurnId: 'legacy-turn', latestTurnStatus: 'completed',
    messages: [{ id: 'legacy-response', turnId: 'legacy-turn', role: 'assistant', text: 'Old result' }] })
  f.supervision.refresh(); expect(f.relay).not.toHaveBeenCalled()
})

it('does not attach a new user turn to the old goal after observing the managed turn', () => {
  const f = fixture(); f.reply('Working', 'inProgress'); f.supervision.refresh()
  f.reply('Latest user instruction handled', 'completed', 'advanced-reply', 'advanced-turn'); f.supervision.refresh()
  expect(f.current().supervision?.phase).toBe('stopped')
  expect(f.current().supervision?.response).toBeUndefined()
  expect(f.relay).not.toHaveBeenCalled()
})

it.each(['needsYou', 'pausedByUser'] as const)('keeps the first reply quiet while %s is active, then resumes review', flag => {
  const f = fixture(); f.reply(); f.snapshots.get('thread-a')!.head[flag] = true
  f.supervision.refresh()
  expect(f.relay).not.toHaveBeenCalled()
  expect(f.current().supervision?.notifiedAt).toBeUndefined()
  f.snapshots.get('thread-a')!.head[flag] = false
  f.supervision.refresh(); expect(f.relay).toHaveBeenCalledTimes(1)
})

it('does not use a snapshot from another conversation', () => {
  const f = fixture(); f.reply(); f.snapshots.get('thread-a')!.head.threadId = 'wrong-thread'
  f.supervision.refresh()
  expect(f.relay).not.toHaveBeenCalled()
})

it('rebases trailing metadata without inventing another reply event', () => {
  const f = fixture(); f.reply(); f.supervision.refresh()
  f.snapshots.get('thread-a')!.head.lastItemId = 'trailing-metadata'
  const parent = f.supervision.continuation('thread-a', f.first.id, 'reply-a', 'trailing-metadata')
  expect(parent.supervision?.response?.headItemId).toBe('trailing-metadata')
  expect(f.relay).toHaveBeenCalledTimes(1)
})

it('does not lose a pending reply if durable notice creation fails', () => {
  const f = fixture(); f.reply(); f.relay.mockImplementationOnce(() => { throw new Error('notice failed') })
  expect(() => f.supervision.refresh()).toThrow('notice failed')
  expect(f.current().supervision?.notifiedAt).toBeUndefined()
  f.supervision.refresh()
  expect(f.current().supervision?.notifications).toBe(1)
})
