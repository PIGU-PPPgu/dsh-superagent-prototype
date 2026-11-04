/** Chat command parsing and execution. Queries read the management API; operations call only panel-level routes. */
import {
  HELP, renderAttention, renderDigest, renderHealth, renderStatus, renderTickets, renderThreads,
} from './report.mjs'

const ON = new Set(['开', '开启', '打开', 'on', 'enable'])
const OFF = new Set(['关', '关闭', 'off', 'disable'])

/** Strips Feishu mention placeholders and surrounding whitespace so `@bot 状态` parses like `状态`. */
export function normalize(text) {
  return String(text ?? '')
    .replace(/@_user_\d+/g, ' ')
    .replace(/^\s*(?:@[^\s@]+\s+)+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const TABLE = [
  { names: ['帮助', 'help', '?', '？'], command: 'help' },
  { names: ['状态', 'status', 'state'], command: 'status' },
  { names: ['简报', 'digest', 'brief'], command: 'digest' },
  { names: ['待办', 'todo', 'attention'], command: 'todo' },
  { names: ['工单', 'tickets', 'ticket'], command: 'tickets' },
  { names: ['会话', 'threads', 'sessions'], command: 'threads' },
  { names: ['健康', 'health'], command: 'health' },
  { names: ['暂停', 'pause'], command: 'pause', operate: true },
  { names: ['继续', '恢复', 'resume'], command: 'resume', operate: true },
  { names: ['停止', 'stop'], command: 'stop', operate: true, args: 1 },
  { names: ['重试', 'retry'], command: 'retry', operate: true, args: 1 },
  { names: ['已读', 'ack'], command: 'ack', operate: true, args: 1 },
  { names: ['取消', 'cancel'], command: 'cancel', operate: true, args: 1 },
  { names: ['监控', 'monitor'], command: 'monitor', operate: true, args: 1 },
  { names: ['自动接单', 'handoff'], command: 'handoff', operate: true, args: 1 },
  { names: ['会话控制', 'control'], command: 'control', operate: true, args: 1 },
]

/** Returns `{ command, args, operate }`, or `undefined` for text that is not a command (never answered). */
export function parseCommand(raw) {
  const text = normalize(raw)
  if (!text) return undefined
  const parts = text.split(' ')
  const head = parts[0].toLowerCase()
  const entry = TABLE.find(item => item.names.some(name => name.toLowerCase() === head))
  if (!entry) return undefined
  const args = parts.slice(1)
  if (entry.args && args.length < entry.args) return { command: 'usage', args: [entry.names[0]], operate: !!entry.operate }
  return { command: entry.command, args, operate: !!entry.operate }
}

const TICKET_STATE = { 全部: 'ended', 已结束: 'ended', 结束: 'ended', 进行中: 'working', 待人: 'person', 等人: 'person', 空闲: 'idle', 打开: 'open' }

/** Resolves an ID prefix against candidates; ambiguous or unknown prefixes are refused rather than guessed. */
export function resolveId(prefix, candidates) {
  const value = String(prefix ?? '').trim()
  if (value.length < 4) throw new Error('ID 至少给前 4 位')
  const hits = candidates.filter(id => id === value || id.startsWith(value))
  if (!hits.length) throw new Error(`找不到以 ${value} 开头的对象`)
  if (hits.length > 1) throw new Error(`${value} 匹配到 ${hits.length} 个对象，请多给几位`)
  return hits[0]
}

async function ticketIds(orchestrator) {
  const pages = await Promise.all(['open', 'person', 'ended'].map(state => orchestrator.tickets(state, 200)))
  return [...new Set(pages.flatMap(page => (page.items ?? []).map(item => item.id)))]
}

const toggle = async (args, apply, name) => {
  const word = String(args[0] ?? '').toLowerCase()
  if (!ON.has(word) && !OFF.has(word)) throw new Error(`用法：${name} 开 或 ${name} 关`)
  const enabled = ON.has(word)
  await apply(enabled)
  return `${name}已${enabled ? '开启' : '关闭'}。`
}

/**
 * Executes a parsed command and returns the Markdown answer.
 * `canOperate` comes from the sender's open_id; without it operations are refused before any API call.
 */
export async function executeCommand(parsed, { orchestrator, canOperate = false } = {}) {
  if (!parsed) return undefined
  if (parsed.operate && !canOperate) return '你没有操作权限（只配置了查询）。让管理员把你的 open_id 加进 feishu.operators。'
  const { command, args } = parsed
  switch (command) {
    case 'usage': return `用法不完整，发「帮助」查看命令；这条需要参数：${args[0]} <ID>`
    case 'help': return HELP
    case 'status': return renderStatus(await orchestrator.snapshot())
    case 'digest': return renderDigest(await orchestrator.snapshot())
    case 'todo': return renderAttention(await orchestrator.snapshot())
    case 'threads': return renderThreads(await orchestrator.snapshot())
    case 'health': return renderHealth(await orchestrator.snapshot())
    case 'tickets': {
      const state = TICKET_STATE[args[0]] ?? args[0] ?? 'open'
      if (!['open', 'person', 'working', 'idle', 'ended'].includes(state)) return '工单筛选只支持：open / person / working / idle / ended（或「待人」「进行中」「已结束」）。'
      return renderTickets(await orchestrator.tickets(state))
    }
    case 'pause': await orchestrator.pause(true); return '执行器已暂停：新工单不再开工，进行中的会话保持原样。'
    case 'resume': await orchestrator.pause(false); return '执行器已恢复。'
    case 'stop': case 'retry': {
      const id = resolveId(args[0], await ticketIds(orchestrator))
      if (command === 'stop') { await orchestrator.stopTicket(id); return `已停止工单 ${id}。` }
      await orchestrator.retryTicket(id); return `已重试工单 ${id}。`
    }
    case 'cancel': {
      const codex = await orchestrator.codex()
      const intents = (codex.control?.intents ?? []).map(item => item.id)
      const id = resolveId(args[0], intents)
      await orchestrator.cancelIntent(id)
      return `已取消控制意图 ${id}；已领取或已送达的操作不会撤回。`
    }
    case 'ack': {
      const codex = await orchestrator.codex()
      const rows = [...(codex.monitor?.attention ?? []), ...(codex.monitor?.threads ?? [])]
      const id = resolveId(args[0], rows.map(row => row.id))
      const row = rows.find(item => item.id === id)
      const itemId = row?.attention?.itemId ?? row?.assessmentItemId ?? row?.latestTurnId
      if (!itemId) throw new Error('这条会话没有可确认的提醒')
      await orchestrator.ackAttention(id, itemId, new Date().toISOString())
      return `已确认会话 ${id.slice(0, 8)} 的提醒。`
    }
    case 'monitor': return toggle(args, enabled => orchestrator.setMonitor(enabled), 'Codex 监控')
    case 'handoff': return toggle(args, enabled => orchestrator.setAutoHandoff(enabled), '自动接单')
    case 'control': return toggle(args, enabled => orchestrator.setControl(enabled), '会话控制')
    default: return undefined
  }
}
