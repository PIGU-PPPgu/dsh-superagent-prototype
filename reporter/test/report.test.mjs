import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionItems, fingerprint, renderPush } from '../report.mjs'
import { shouldPush, inQuietHours } from '../daemon.mjs'

const snapshot = items => ({
  state: { paused: false, health: { runtime: { state: 'ready', detail: 'ok' } } },
  overview: { executor: { running: 0, queued: 0, maxWorkers: 6 }, flow: { received: 0, accepted: 0, evaluating: 0 } },
  codex: { monitor: { enabled: true }, control: { enabled: true }, router: { priorities: items } },
  at: new Date('2026-11-04T07:30:00.000Z'),
})

test('fingerprint ignores summary wording but not membership', () => {
  const a = snapshot([{ kind: 'needsYou', threadId: 't1', title: 'x', summary: 'old words' }])
  const b = snapshot([{ kind: 'needsYou', threadId: 't1', title: 'x', summary: 'totally reworded' }])
  assert.equal(fingerprint(a), fingerprint(b))
  const c = snapshot([{ kind: 'needsYou', threadId: 't2', title: 'x', summary: 'old words' }])
  assert.notEqual(fingerprint(a), fingerprint(c))
})

test('attention items label results and health problems', () => {
  const items = attentionItems(snapshot([
    { kind: 'needsYou', threadId: 't1', title: 'A', summary: 's' },
    { kind: 'ticketResult', threadId: 't1', ticketId: 'k1', title: 'B', summary: 'r' },
  ]))
  assert.equal(items.filter(item => item.result).length, 1)
  assert.equal(items.find(item => item.kind === 'needsYou').label, '等你决定')
})

test('renderPush reports counts and includes help hint', () => {
  const out = renderPush(snapshot([{ kind: 'needsYou', threadId: 't1', title: 'A', summary: 's' }]))
  assert.match(out, /待你处理 1 条/)
  assert.match(out, /帮助/)
})

test('shouldPush requires change, baseline and interval', () => {
  assert.equal(shouldPush({ onChange: true, fingerprint: 'a', baseline: 'a', lastPushAt: 0, minIntervalSeconds: 0, now: 0, quiet: false }), false)
  assert.equal(shouldPush({ onChange: true, fingerprint: 'b', baseline: '', lastPushAt: 0, minIntervalSeconds: 0, now: 0, quiet: false }), false)
  assert.equal(shouldPush({ onChange: true, fingerprint: 'b', baseline: 'a', lastPushAt: 0, minIntervalSeconds: 0, now: 0, quiet: false }), true)
  assert.equal(shouldPush({ onChange: true, fingerprint: 'c', baseline: 'a', lastPushAt: 0, minIntervalSeconds: 120, now: 30_000, quiet: false }), false)
  assert.equal(shouldPush({ onChange: true, fingerprint: 'c', baseline: 'a', lastPushAt: 0, minIntervalSeconds: 120, now: 130_000, quiet: false }), true)
  assert.equal(shouldPush({ onChange: true, fingerprint: 'c', baseline: 'a', lastPushAt: 0, minIntervalSeconds: 0, now: 0, quiet: true }), false)
  assert.equal(shouldPush({ onChange: false, fingerprint: 'c', baseline: 'a', lastPushAt: 0, minIntervalSeconds: 0, now: 0, quiet: false }), false)
})

test('quiet hours handle a window that crosses midnight', () => {
  const at = (h, m) => new Date(2026, 10, 4, h, m) // local-ish; inQuietHours uses the zone's clock
  // Use fixed minutes arithmetic via a simpler assertion on the pure helper is avoided; just check both branches of the range.
  assert.equal(inQuietHours(new Date('2026-11-04T23:30:00+08:00'), '23:00', '08:00'), true)
  assert.equal(inQuietHours(new Date('2026-11-04T07:30:00+08:00'), '23:00', '08:00'), true)
  assert.equal(inQuietHours(new Date('2026-11-04T12:00:00+08:00'), '23:00', '08:00'), false)
  assert.equal(inQuietHours(new Date('2026-11-04T12:00:00+08:00'), undefined, undefined), false)
})
