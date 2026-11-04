// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, tab, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('enables automatic observation from the Codex panel', async () => {
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('归纳变化的主会话')
  await click('开始监控')
  expect(server.requests).toContainEqual({ path: 'codex/monitor', method: 'POST', body: { enabled: true } })
  expect(text()).toContain('暂停监控')
})

it('enables Codex auto handoff only after an explicit panel action', async () => {
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('开启自动接单')
  expect(server.requests.some(request => request.path === 'codex/auto-handoff')).toBe(false)
  await click('开启自动接单')
  expect(server.requests).toContainEqual({ path: 'codex/auto-handoff', method: 'POST', body: { enabled: true } })
  expect(text()).toContain('关闭自动接单')
  await click('关闭自动接单')
  expect(server.requests).toContainEqual({ path: 'codex/auto-handoff', method: 'POST', body: { enabled: false } })
})

it('shows the DSH Router brief and keeps native control disabled until the bridge reports ready', async () => {
  server.codex = { ...server.codex, enabled: true, total: 2, recentTotal: 2 }
  server.codexRouter = { mainTotal: 2, recentTotal: 2, childTotal: 3, childChecked: 2,
    needsYou: 1, technical: 0, managed: 1, priorities: [{ threadId: 'thread-a', title: '发布任务',
      summary: '选择发布目标', kind: 'needsYou', source: 'persisted Codex history' }], recent: [] }
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('路由简报')
  expect(text()).toContain('选择发布目标')
  expect(text()).toContain('等待 Codex Desktop 连接')
  const enable = [...document.querySelectorAll('button')].find(button => button.textContent === '开启通信')!
  expect(enable.hasAttribute('disabled')).toBe(true)
  server.codexControl = { ...server.codexControl, bridgeReady: true }
  await click(tab(zh['tab.overview']))
  await click(tab(zh['tab.codex']))
  await click('开启通信')
  expect(server.requests).toContainEqual({ path: 'codex/control', method: 'POST', body: { enabled: true } })
})

it('links a Codex handoff to its ticket and shows a failed handoff', async () => {
  server.codex = { enabled: true, autoHandoffEnabled: true, total: 2, recentTotal: 2,
    attentionTotal: 0, attention: [], managedTotal: 1,
    managed: [{ id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true,
      handoffTicketId: 't1', handoffStage: { stage: 'working' } }], threads: [
      { id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true, handoffTicketId: 't1' },
      { id: 'thread-b', title: '构建任务', sourceKind: 'cli', archived: false, present: true, handoffError: 'Codex handoff unavailable' },
    ] }
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('已交给 DSH · 1')
  expect(text()).toContain('执行中 · DSH 当前状态')
  await click('查看工单')
  expect(text()).toContain('修复回归')
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('自动接单暂不可用')
  expect(text()).not.toContain('Codex handoff unavailable')
})

it('surfaces an actionable Codex conversation on the overview and lets the person acknowledge it', async () => {
  const attention = { decision: { needsAttention: true as const, kind: 'review' as const,
    reason: '结果待审阅', action: '检查发布结果' }, at: '2026-11-01T12:00:00Z', itemId: 'item-new' }
  server.codex = { enabled: true, scannedAt: '2026-11-01T12:00:00Z', total: 1, recentTotal: 1, attentionTotal: 1,
    managedTotal: 0, managed: [],
    attention: [{ id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true, attention }],
    threads: [{ id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true, attention }] }
  await mount()
  expect(text()).toContain('最近 7 天 1 / 共 1 个主会话')
  expect(text()).toContain('1 个需处理')
  expect(text()).toContain('检查发布结果')
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('1 个需要你')
  expect(text()).toContain('需要你处理')
  expect(text()).toContain('检查发布结果')
  expect(text()).toContain('历史快照')
  await click('关闭提醒')
  expect(server.requests.some(request => request.path === 'codex/attention/thread-a/ack' && request.method === 'POST'
    && (request.body as { itemId?: string })?.itemId === 'item-new')).toBe(true)
  expect(text()).not.toContain('需要你处理')
})

it('shows main conversation summaries and groups child threads', async () => {
  server.codex = { enabled: true, scannedAt: '2026-11-01T12:00:00Z', total: 2, recentTotal: 1,
    threadTotal: 33, childTotal: 31, recentChildTotal: 31, checkedRecentChildTotal: 30, childReadErrorsTotal: 1,
    attentionTotal: 0, attention: [], managedTotal: 0, managed: [], threads: [{
      id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true,
      stage: 'progress', summary: '正在核查发布结果', childCount: 31, childErrors: 2, childReadErrors: 1,
      repository: 'acme/widgets', activityAt: '2026-11-01T12:00:00Z',
    }] }
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('最近 7 天 1 / 共 2 个主会话')
  expect(text()).toContain('31 个子线程')
  expect(text()).toContain('近 24 小时子线程状态已核对 30 / 31')
  expect(text()).toContain('2 个子线程历史失败')
  expect(text()).toContain('1 个子线程读取异常')
  expect(text()).toContain('1 条子线程状态读取异常')
  expect(text()).toContain('acme/widgets')
  expect(text()).toContain('正在核查发布结果')
  expect(text()).toContain('31 个子线程')
  await click('查看全部')
  expect(server.requests.some(request => request.path.includes('codex?') && request.path.includes('scope=all'))).toBe(true)
})

it('shows why child threads cannot be grouped under a main conversation', async () => {
  server.codex = { enabled: true, total: 1, recentTotal: 1, childTotal: 28, unlinkedTotal: 27,
    withoutParentTotal: 26, unresolvedParentTotal: 1, unlinkedChildErrors: 1,
    attentionTotal: 0, attention: [], managedTotal: 0, managed: [], threads: [{ id: 'thread-a', title: '发布任务',
      sourceKind: 'vscode', archived: false, present: true, childCount: 1 }] }
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('1 个子线程')
  expect(text()).toContain('26 条子线程无父会话 ID')
  expect(text()).toContain('1 条父会话未找到')
  expect(text()).toContain('1 条未归属子线程历史失败')
  expect(text()).not.toContain('28 个子线程 ·')
})
