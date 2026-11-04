import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Reporter, ReporterState } from '../daemon.mjs'
import { fingerprint } from '../report.mjs'

const config = (overrides = {}) => ({
  orchestrator: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 },
  feishu: {
    cli: 'lark-cli', chatId: 'oc_test', userId: '', operators: ['ou_op'], readers: ['ou_op'],
    pollSeconds: 45, timeoutMs: 5000,
    push: { onChange: true, minIntervalSeconds: 0, dailyAt: undefined, quietFrom: undefined, quietTo: undefined },
  },
  stateDir: mkdtempSync(join(tmpdir(), 'reporter-')),
  ...overrides,
})

const snapshot = priorities => ({
  state: { paused: false, health: { runtime: { state: 'ready', detail: 'ok' } } },
  overview: { executor: { running: 0, queued: 0, maxWorkers: 6 }, flow: { received: 0, accepted: 0, evaluating: 0 } },
  codex: { monitor: { enabled: true, total: 1 }, control: { enabled: true, intents: [] }, router: { priorities } },
  at: new Date('2026-11-04T07:30:00.000Z'),
})

function harness({ priorities = [], baseline } = {}) {
  const sent = []
  const feishu = {
    send: async message => { sent.push(message); return { ok: true } },
    consume: () => () => {},
  }
  const orchestrator = { snapshot: async () => snapshot(priorities) }
  const state = new ReporterState(join(config().stateDir, 'state.json'))
  state.value.fingerprint = baseline ?? fingerprint(snapshot(priorities))
  const reporter = new Reporter(config(), { orchestrator, feishu, state, log: () => {} })
  return { reporter, sent, state }
}

test('poll pushes once when the report changes', async () => {
  const { reporter, sent } = harness({ priorities: [{ kind: 'needsYou', threadId: 't1', title: 'A', summary: 's' }], baseline: 'older-baseline' })
  await reporter.poll()
  assert.equal(sent.length, 1)
  assert.match(sent[0].markdown, /Superagent 播报/)
  assert.equal(sent[0].idempotencyKey.startsWith('reporter:'), true)
  await reporter.poll()
  assert.equal(sent.length, 1)
})

test('poll does not push an unchanged report', async () => {
  const { reporter, sent } = harness({ priorities: [] })
  await reporter.poll()
  assert.equal(sent.length, 0)
})

test('poll does not push before a baseline exists', async () => {
  const { reporter, sent } = harness({ priorities: [{ kind: 'needsYou', threadId: 't1', title: 'A', summary: 's' }], baseline: '' })
  await reporter.poll()
  assert.equal(sent.length, 0)
})

test('accepts only configured readers and chats', () => {
  const { reporter } = harness()
  const event = { type: 'im.message.receive_v1', message_id: 'om_1', event_id: 'e1', chat_id: 'oc_test', chat_type: 'group', sender_id: 'ou_op', content: '状态' }
  assert.equal(reporter.accepts(event), true)
  assert.equal(reporter.accepts({ ...event, sender_id: 'ou_stranger' }), false)
  assert.equal(reporter.accepts({ ...event, chat_id: 'oc_other' }), false)
  assert.equal(reporter.accepts({ ...event, chat_type: 'p2p', chat_id: 'oc_other' }), true)
  assert.equal(reporter.accepts({ ...event, message_type: 'text', content: 'x', type: 'other' }), false)
})

test('a command is answered once and repeated events are dropped', async () => {
  const { reporter, sent } = harness()
  const event = { type: 'im.message.receive_v1', message_id: 'om_1', event_id: 'e1', chat_id: 'oc_test', chat_type: 'group', sender_id: 'ou_op', content: '状态' }
  await reporter.handleEvent(event)
  assert.equal(sent.length, 1)
  assert.match(sent[0].markdown, /Superagent 状态/)
  await reporter.handleEvent(event)
  assert.equal(sent.length, 1)
})

test('a stranger gets no answer at all', async () => {
  const { reporter, sent } = harness()
  const event = { type: 'im.message.receive_v1', message_id: 'om_2', event_id: 'e2', chat_id: 'oc_test', chat_type: 'group', sender_id: 'ou_stranger', content: '状态' }
  await reporter.handleEvent(event)
  assert.equal(sent.length, 0)
})

test('state file survives a reload and keeps the fingerprint', () => {
  const dir = config().stateDir
  const file = join(dir, 'state.json')
  const state = new ReporterState(file)
  state.value.fingerprint = 'abc'
  state.save()
  assert.equal(new ReporterState(file).value.fingerprint, 'abc')
})
