import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, ConfigError } from '../config.mjs'

const base = () => ({
  feishu: { userId: 'ou_abc123', operators: ['ou_abc123'], chatId: '' },
})

test('defaults apply when fields are omitted', () => {
  const config = parseConfig({ feishu: { userId: 'ou_abc123' } })
  assert.equal(config.orchestrator.baseUrl, 'http://127.0.0.1:61104')
  assert.equal(config.feishu.pollSeconds, 45)
  assert.equal(config.feishu.push.minIntervalSeconds, 120)
  assert.equal(config.feishu.push.onChange, true)
  assert.deepEqual(config.feishu.operators, [])
  assert.deepEqual(config.feishu.readers, [])
})

test('readers always include operators', () => {
  const config = parseConfig({ feishu: { operators: ['ou_a1'], readers: ['ou_b2'], userId: 'ou_a1' } })
  assert.deepEqual(config.feishu.readers, ['ou_a1', 'ou_b2'])
})

test('rejects non-loopback orchestrator URL', () => {
  assert.throws(() => parseConfig({ ...base(), orchestrator: { url: 'https://evil.example' } }), ConfigError)
})

test('rejects malformed chat and user ids', () => {
  assert.throws(() => parseConfig({ feishu: { chatId: 'bad' } }), ConfigError)
  assert.throws(() => parseConfig({ feishu: { userId: 'oc_wrong' } }), ConfigError)
})

test('rejects malformed operator ids', () => {
  assert.throws(() => parseConfig({ feishu: { operators: ['not-an-openid'] } }), ConfigError)
})

test('validates daily clock and quiet window', () => {
  assert.throws(() => parseConfig({ ...base(), feishu: { ...base().feishu, push: { dailyAt: '25:00' } } }), ConfigError)
  assert.equal(parseConfig({ ...base(), feishu: { ...base().feishu, push: { dailyAt: '09:30' } } }).feishu.push.dailyAt, '09:30')
})
