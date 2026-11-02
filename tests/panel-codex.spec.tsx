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

it('links a Codex handoff to its ticket and shows a failed handoff', async () => {
  server.codex = { enabled: true, autoHandoffEnabled: true, total: 2, recentTotal: 2,
    attentionTotal: 0, attention: [], threads: [
      { id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true, handoffTicketId: 't1' },
      { id: 'thread-b', title: '构建任务', sourceKind: 'cli', archived: false, present: true, handoffError: 'Codex handoff unavailable' },
    ] }
  await mount()
  await click(tab(zh['tab.codex']))
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
    attention: [{ id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true, attention }],
    threads: [{ id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true, attention }] }
  await mount()
  expect(text()).toContain('最近 7 天 1 / 共 1 个主会话 · 1 个需处理')
  expect(text()).toContain('检查发布结果')
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('需要你处理')
  expect(text()).toContain('检查发布结果')
  expect(text()).toContain('历史观察')
  await click('关闭提醒')
  expect(server.requests.some(request => request.path === 'codex/attention/thread-a/ack' && request.method === 'POST'
    && (request.body as { itemId?: string })?.itemId === 'item-new')).toBe(true)
  expect(text()).not.toContain('需要你处理')
})

it('shows main conversation summaries and groups child threads', async () => {
  server.codex = { enabled: true, scannedAt: '2026-11-01T12:00:00Z', total: 2, recentTotal: 1,
    threadTotal: 33, childTotal: 31, attentionTotal: 0, attention: [], threads: [{
      id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true,
      stage: 'progress', summary: '正在核查发布结果', childCount: 31, activityAt: '2026-11-01T12:00:00Z',
    }] }
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('最近 7 天 1 / 共 2 个主会话')
  expect(text()).toContain('31 个子线程归入主会话')
  expect(text()).toContain('正在核查发布结果')
  expect(text()).toContain('31 个子线程')
  await click('查看全部')
  expect(server.requests.some(request => request.path.includes('codex?') && request.path.includes('scope=all'))).toBe(true)
})

it('shows why child threads cannot be grouped under a main conversation', async () => {
  server.codex = { enabled: true, total: 1, recentTotal: 1, childTotal: 28, unlinkedTotal: 27,
    withoutParentTotal: 26, unresolvedParentTotal: 1,
    attentionTotal: 0, attention: [], threads: [{ id: 'thread-a', title: '发布任务',
      sourceKind: 'vscode', archived: false, present: true, childCount: 1 }] }
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('1 个子线程归入主会话')
  expect(text()).toContain('26 条无父会话记录')
  expect(text()).toContain('1 条父会话未找到')
  expect(text()).not.toContain('28 个子线程归入主会话')
})
