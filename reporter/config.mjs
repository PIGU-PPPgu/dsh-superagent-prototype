/** Reporter configuration: JSON file with env overrides, validated into a complete runtime config. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const defaultDir = () => join(homedir(), '.dsh', 'state', 'superagent-reporter')
export const defaultConfigPath = () => join(defaultDir(), 'config.json')

export class ConfigError extends Error {}

const text = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback)
const ids = (value, prefix, name) => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigError(`${name} must be an array`)
  return value.map(item => {
    if (typeof item !== 'string' || !item.startsWith(prefix)) throw new ConfigError(`${name} entries must start with ${prefix}`)
    return item.trim()
  })
}
const number = (value, fallback, min, max, name) => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max}`)
  }
  return value
}
const clock = (value, name) => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ConfigError(`${name} must be HH:MM`)
  return value
}

/**
 * Reads and validates the reporter config. Unknown keys are rejected so a typo cannot silently disable a safety rule.
 * Only `feishu.operators` may run operations; `readers` additionally may query. An empty operator list disables
 * inbound commands entirely, so a fresh install is push-only until the operator's open_id is written down.
 */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('Config must be a JSON object')
  const orchestrator = raw.orchestrator ?? {}
  const feishu = raw.feishu ?? {}
  const push = feishu.push ?? {}
  const target = { chatId: text(feishu.chatId), userId: text(feishu.userId) }
  if (target.chatId && !/^oc_[A-Za-z0-9]+$/.test(target.chatId)) throw new ConfigError('feishu.chatId must be an oc_ chat ID')
  if (target.userId && !/^ou_[A-Za-z0-9]+$/.test(target.userId)) throw new ConfigError('feishu.userId must be an ou_ open_id')
  const operators = ids(feishu.operators, 'ou_', 'feishu.operators')
  const readers = [...new Set([...operators, ...ids(feishu.readers, 'ou_', 'feishu.readers')])]
  const baseUrl = text(orchestrator.url, 'http://127.0.0.1:61104').replace(/\/+$/, '')
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseUrl)) {
    throw new ConfigError('orchestrator.url must be a loopback http:// URL; the management API is same-origin only')
  }
  return {
    orchestrator: { baseUrl, timeoutMs: number(orchestrator.timeoutMs, 8000, 500, 60000, 'orchestrator.timeoutMs') },
    feishu: {
      cli: text(feishu.cli, 'lark-cli'),
      ...target,
      operators,
      readers,
      pollSeconds: number(feishu.pollSeconds, 45, 10, 3600, 'feishu.pollSeconds'),
      timeoutMs: number(feishu.timeoutMs, 30000, 1000, 120000, 'feishu.timeoutMs'),
      push: {
        onChange: push.onChange !== false,
        minIntervalSeconds: number(push.minIntervalSeconds, 120, 0, 86400, 'feishu.push.minIntervalSeconds'),
        dailyAt: clock(push.dailyAt, 'feishu.push.dailyAt'),
        // A quiet window suppresses only change pushes; the daily digest and direct command answers still arrive.
        quietFrom: clock(push.quietFrom, 'feishu.push.quietFrom'),
        quietTo: clock(push.quietTo, 'feishu.push.quietTo'),
      },
    },
    stateDir: text(raw.stateDir, defaultDir()),
  }
}

export function loadConfig(path = process.env.DSH_REPORTER_CONFIG || defaultConfigPath()) {
  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') throw new ConfigError(`No config at ${path}; copy reporter/config.example.json and fill it in`)
    throw new ConfigError(`Cannot read ${path}: ${error.message}`)
  }
  return { ...parseConfig(raw), path }
}
