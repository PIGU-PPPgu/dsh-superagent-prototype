import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionItems, fingerprint, renderPush, renderAttention } from '../report.mjs'
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

test('fingerprint ignores DSH internal (technical/childFailure/health/needsAgent)', () => {
  const base = snapshot([{ kind: 'needsYou', threadId: 't1', title: 'x', summary: 's' }])
  const withTechnical = snapshot([
    { kind: 'needsYou', threadId: 't1', title: 'x', summary: 's' },
    { kind: 'technical', threadId: 't2', title: 'tech', summary: 'tech issue' },
  ])
  const withAgent = snapshot([
    { kind: 'needsYou', threadId: 't1', title: 'x', summary: 's' },
    { kind: 'needsAgent', threadId: 't3', title: 'agent', summary: 'agent handling' },
  ])
  // DSH内部处理项不改变fingerprint
  assert.equal(fingerprint(base), fingerprint(withTechnical))
  assert.equal(fingerprint(base), fingerprint(withAgent))
})

test('fingerprint changes when human attention or results change', () => {
  const needsYou1 = snapshot([{ kind: 'needsYou', threadId: 't1', title: 'x', summary: 's' }])
  const needsYou2 = snapshot([{ kind: 'needsYou', threadId: 't2', title: 'x', summary: 's' }])
  const withResult = snapshot([
    { kind: 'needsYou', threadId: 't1', title: 'x', summary: 's' },
    { kind: 'ticketResult', threadId: 't1', ticketId: 'k1', title: 'done', summary: 'finished' },
  ])
  // 真人待办或结果变化时fingerprint必须改变
  assert.notEqual(fingerprint(needsYou1), fingerprint(needsYou2))
  assert.notEqual(fingerprint(needsYou1), fingerprint(withResult))
})

test('renderPush only shows human attention and results, not DSH internal', () => {
  const out = renderPush(snapshot([
    { kind: 'needsYou', threadId: 't1', title: 'A', summary: 's1' },
    { kind: 'technical', threadId: 't2', title: 'Tech', summary: 'tech issue' },
    { kind: 'needsAgent', threadId: 't3', title: 'Agent', summary: 'agent work' },
    { kind: 'ticketResult', threadId: 't1', ticketId: 'k1', title: 'Done', summary: 'result' },
  ]))
  // 应显示1条待办、1条结果、2条DSH处理
  assert.match(out, /待你处理 1 条/)
  assert.match(out, /新结果 1 条/)
  assert.match(out, /DSH处理中 2 条/)
  // 展示内容只包含真人待办和结果，不包含technical/needsAgent
  assert.match(out, /等你决定.*A/)
  assert.match(out, /工单有结果.*Done/)
  assert.doesNotMatch(out, /Tech/)
  assert.doesNotMatch(out, /Agent/)
})

test('renderAttention only shows human attention items, not DSH internal or results', () => {
  const out = renderAttention(snapshot([
    { kind: 'needsYou', threadId: 't1', title: 'A', summary: 's1' },
    { kind: 'technical', threadId: 't2', title: 'Tech', summary: 'tech issue' },
    { kind: 'needsAgent', threadId: 't3', title: 'Agent', summary: 'agent work' },
    { kind: 'ticketResult', threadId: 't1', ticketId: 'k1', title: 'Done', summary: 'result' },
  ]))
  // 待办清单只包含真人待办
  assert.match(out, /等你决定.*A/)
  // 不包含DSH内部处理和结果
  assert.doesNotMatch(out, /Tech/)
  assert.doesNotMatch(out, /Agent/)
  assert.doesNotMatch(out, /Done/)
})

test('renderPush shows empty message when no human attention or results', () => {
  const out = renderPush(snapshot([
    { kind: 'technical', threadId: 't2', title: 'Tech', summary: 'tech issue' },
    { kind: 'needsAgent', threadId: 't3', title: 'Agent', summary: 'agent work' },
  ]))
  assert.match(out, /待你处理 0 条/)
  assert.match(out, /新结果 0 条/)
  assert.match(out, /当前无人工待办或新结果/)
})
