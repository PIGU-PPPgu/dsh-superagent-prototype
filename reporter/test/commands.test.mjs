import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeCommand, normalize, parseCommand, resolveId } from '../commands.mjs'

test('normalize strips mentions and whitespace', () => {
  assert.equal(normalize('@_user_1 状态'), '状态')
  assert.equal(normalize('@机器人 @另一个人   状态'), '状态')
  assert.equal(normalize('  状态  '), '状态')
})

test('parseCommand maps chinese and english, marks operations', () => {
  assert.deepEqual(parseCommand('状态'), { command: 'status', args: [], operate: false })
  assert.deepEqual(parseCommand('stop abc12345'), { command: 'stop', args: ['abc12345'], operate: true })
  assert.deepEqual(parseCommand('监控 开'), { command: 'monitor', args: ['开'], operate: true })
  assert.deepEqual(parseCommand('hello world'), undefined)
  assert.equal(parseCommand(''), undefined)
})

test('parseCommand flags missing arguments', () => {
  const parsed = parseCommand('停止')
  assert.equal(parsed.command, 'usage')
  assert.equal(parsed.operate, true)
})

test('resolveId prefers exact and rejects ambiguity', () => {
  assert.equal(resolveId('abcdef01', ['abcdef01', 'abcdef02']), 'abcdef01')
  assert.throws(() => resolveId('abcdef0', ['abcdef01', 'abcdef02']), /匹配到 2 个/)
  assert.throws(() => resolveId('xyz', ['abcdef01']))
  assert.throws(() => resolveId('ab', ['abcdef01']))
})

function snapshot() {
  return {
    state: { paused: false, health: { runtime: { state: 'ready', detail: 'ok' }, github: { state: 'error', detail: 'boom' } } },
    overview: { executor: { running: 1, queued: 0, maxWorkers: 6 }, flow: { received: 10, accepted: 2, evaluating: 0 } },
    codex: { monitor: { enabled: true, autoHandoffEnabled: true, total: 100, recentTotal: 5, attentionTotal: 1, managedTotal: 1, scannedAt: '2026-11-04T07:00:00.000Z', threads: [] }, control: { enabled: true, intents: [{ id: 'intent-abcdef' }] } },
    at: new Date(),
  }
}

const orchestrator = overrides => ({
  snapshot: async () => snapshot(),
  pause: async () => ({}),
  setMonitor: async () => ({}),
  setAutoHandoff: async () => ({}),
  setControl: async () => ({}),
  tickets: async () => ({ items: [], total: 0 }),
  ...overrides,
})

test('queries render without an operation permission', async () => {
  const out = await executeCommand(parseCommand('状态'), { orchestrator: orchestrator() })
  assert.match(out, /Superagent 状态/)
  const health = await executeCommand(parseCommand('健康'), { orchestrator: orchestrator() })
  assert.match(health, /github/)
})

test('operations are refused without permission', async () => {
  const out = await executeCommand(parseCommand('暂停'), { orchestrator: orchestrator(), canOperate: false })
  assert.match(out, /没有操作权限/)
})

test('operations run with permission', async () => {
  let paused
  const out = await executeCommand(parseCommand('暂停'), {
    orchestrator: orchestrator({ pause: async value => { paused = value } }), canOperate: true,
  })
  assert.match(out, /已暂停/)
  assert.equal(paused, true)
})

test('toggle requires a known on/off word', async () => {
  await assert.rejects(() => executeCommand(parseCommand('监控 也许'), { orchestrator: orchestrator(), canOperate: true }), /用法/)
})

test('ack resolves an attention row and posts its item id', async () => {
  const calls = []
  const snap = snapshot()
  snap.codex.monitor.attention = [{ id: 'thread-abc123', attention: { itemId: 'msg_1' } }]
  const out = await executeCommand(parseCommand('已读 thread-abc1'), {
    orchestrator: {
      snapshot: async () => snap,
      codex: async () => snap.codex,
      ackAttention: async (...args) => calls.push(args),
    },
    canOperate: true,
  })
  assert.match(out, /已确认/)
  assert.equal(calls[0][0], 'thread-abc123')
  assert.equal(calls[0][1], 'msg_1')
})
