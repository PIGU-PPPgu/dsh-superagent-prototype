/** Turns orchestrator snapshots into short Chinese Markdown reports and a stable change fingerprint. */
import { createHash } from 'node:crypto'

export const KIND_LABEL = {
  needsYou: '等你决定', technical: '技术异常', ticketNeedsYou: '工单等你处理', ticketResult: '工单有结果',
  ticketEnded: '工单结束', reportedComplete: '会话已完成', childFailure: '子线程失败',
}
const RESULT_KINDS = new Set(['ticketResult', 'ticketEnded', 'reportedComplete'])
const compact = (value, limit = 60) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
const shortId = id => String(id ?? '').slice(0, 8)
const time = (date, zone = 'Asia/Shanghai') => new Date(date).toLocaleTimeString('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false })

/** Health entries that are not ready; `starting` counts as a problem only after it has been seen for a while. */
export function healthProblems(state) {
  return Object.entries(state?.health ?? {})
    .filter(([, entry]) => entry && entry.state && entry.state !== 'ready')
    .map(([name, entry]) => ({ name, state: entry.state, detail: compact(entry.detail, 80) }))
}

/** One normalized line per thing worth a person's attention, ordered by urgency. */
export function attentionItems(snapshot) {
  const priorities = snapshot.codex?.router?.priorities ?? []
  const items = priorities.map(item => ({
    kind: item.kind,
    label: KIND_LABEL[item.kind] ?? item.kind,
    id: item.ticketId ?? item.threadId,
    threadId: item.threadId,
    ticketId: item.ticketId,
    title: compact(item.title, 50),
    detail: compact(item.summary, 90),
    result: RESULT_KINDS.has(item.kind),
  }))
  for (const problem of healthProblems(snapshot.state)) {
    items.push({ kind: 'health', label: '运行异常', id: problem.name, title: problem.name, detail: `${problem.state}: ${problem.detail}`, result: false })
  }
  return items
}

/**
 * Identity of the report, independent of wording and ordering: a reworded summary or a rescan must not re-push.
 * Results and completed items stay in the fingerprint so a new result is always a new push.
 */
export function fingerprint(snapshot) {
  const items = attentionItems(snapshot).map(item => [item.kind, item.threadId ?? '', item.ticketId ?? '', item.id])
  return createHash('sha256').update(JSON.stringify({
    items: items.sort(),
    paused: snapshot.state?.paused === true,
    monitor: snapshot.codex?.monitor?.enabled === true,
  })).digest('hex').slice(0, 16)
}

function lines(items, { empty = '现在没有需要你处理的事。', limit = 10 } = {}) {
  if (!items.length) return empty
  return items.slice(0, limit).map((item, index) =>
    `${index + 1}. **${item.label}** ${item.title}\n   ${item.detail}\n   \`${shortId(item.id)}\``,
  ).join('\n') + (items.length > limit ? `\n… 还有 ${items.length - limit} 条，在面板里看。` : '')
}

export function renderPush(snapshot) {
  const items = attentionItems(snapshot)
  const waiting = items.filter(item => !item.result)
  const results = items.filter(item => item.result)
  const head = [`**Superagent 播报** ${time(snapshot.at)}`]
  if (snapshot.state?.paused) head.push('执行器已暂停。')
  head.push(`待你处理 ${waiting.length} 条，新结果 ${results.length} 条。`)
  return [...head, '', lines([...waiting, ...results]), '', '回复「待办」看详情，「帮助」看命令。'].join('\n')
}

export function renderAttention(snapshot) {
  const items = attentionItems(snapshot)
  return ['**待你处理**', '', lines(items), '', items.length ? '在 Codex 原会话或 DSH 面板里处理；这里不做审批。' : ''].join('\n')
}

export function renderStatus(snapshot) {
  const { state, overview, codex } = snapshot
  const monitor = codex?.monitor ?? {}
  const health = healthProblems(state)
  return [
    `**Superagent 状态** ${time(snapshot.at)}`,
    `- 执行器：${state?.paused ? '已暂停' : '运行中'}，进行中 ${overview?.executor?.running ?? 0}，排队 ${overview?.executor?.queued ?? 0}，上限 ${overview?.executor?.maxWorkers ?? '-'}`,
    `- Codex 监控：${monitor.enabled ? '开' : '关'}，自动接单 ${monitor.autoHandoffEnabled ? '开' : '关'}，会话控制 ${codex?.control?.enabled ? '开' : '关'}`,
    `- 本机 Codex：主会话 ${monitor.total ?? 0}，近 ${monitor.recentTotal ?? 0}，等你决定 ${monitor.attentionTotal ?? 0}，接管工单 ${monitor.managedTotal ?? 0}`,
    `- 最近扫描：${monitor.scannedAt ? new Date(monitor.scannedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知'}`,
    `- 累计接收 ${overview?.flow?.received ?? 0} 条触发，接受 ${overview?.flow?.accepted ?? 0}，评估中 ${overview?.flow?.evaluating ?? 0}`,
    health.length ? `- 异常：${health.map(item => item.name).join('、')}` : '- 各循环健康：正常',
  ].join('\n')
}

export function renderDigest(snapshot) {
  const router = snapshot.codex?.router ?? {}
  const recent = (router.recent ?? []).slice(0, 5)
  return [
    `**Codex 简报** ${time(snapshot.at)}`,
    `主会话 ${router.mainTotal ?? 0}，近期活跃 ${router.recentTotal ?? 0}，子线程 ${router.childTotal ?? 0}（已核 ${router.childChecked ?? 0}）。`,
    `等你决定 ${router.needsYou ?? 0}，技术异常 ${router.technical ?? 0}，接管工单 ${router.managed ?? 0}。`,
    '', '**优先级**', lines(attentionItems(snapshot), { limit: 12 }),
    '', '**最近进展**',
    recent.length ? recent.map(item => `- ${compact(item.title, 40)}：${compact(item.summary, 70)}`).join('\n') : '暂无摘要。',
  ].join('\n')
}

export function renderTickets(page) {
  const items = page?.items ?? []
  return [
    `**工单** 共 ${page?.total ?? 0} 个`,
    '',
    items.length ? items.map((item, index) =>
      `${index + 1}. ${compact(item.title, 50)}\n   状态 ${item.state ?? item.status ?? '-'} · \`${item.id}\``,
    ).join('\n') : '没有符合条件的工单。',
  ].join('\n')
}

export function renderThreads(snapshot) {
  const threads = snapshot.codex?.monitor?.threads ?? []
  return [
    '**近期 Codex 会话**',
    '',
    threads.length ? threads.slice(0, 10).map((item, index) =>
      `${index + 1}. ${compact(item.title, 45)}\n   ${item.stage ?? '-'} · ${compact(item.summary, 60) || '无摘要'}\n   \`${shortId(item.id)}\``,
    ).join('\n') : '监控还没扫到会话。',
  ].join('\n')
}

export function renderHealth(snapshot) {
  const entries = Object.entries(snapshot.state?.health ?? {})
  return ['**运行健康**', '', ...entries.map(([name, entry]) =>
    `- ${entry.state === 'ready' ? '✅' : '⚠️'} ${name}：${entry.state} · ${compact(entry.detail, 70)}`),
  ].join('\n')
}

export const HELP = [
  '**Superagent Reporter 命令**',
  '',
  '查询（谁被允许看配置里的 readers / operators）',
  '- `状态`：执行器、监控、健康概况',
  '- `简报`：Codex 全局简报与优先级',
  '- `待办`：需要你决定和处理的条目',
  '- `工单` / `工单 全部`：工单列表',
  '- `会话`：近期 Codex 会话',
  '- `健康`：各循环健康明细',
  '',
  '操作（仅 operators）',
  '- `暂停` / `继续`：暂停或恢复执行器',
  '- `停止 <工单ID>` / `重试 <工单ID>`',
  '- `已读 <会话ID>`：确认一条 Codex 提醒',
  '- `取消 <意图ID>`：取消尚未领取的 Codex 控制意图',
  '- `监控 开|关`、`自动接单 开|关`、`会话控制 开|关`',
  '',
  'ID 用命令输出里的前 8 位即可。审批仍在原界面完成，Reporter 不替你批准请求。',
].join('\n')
