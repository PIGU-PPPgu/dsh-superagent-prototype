// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, tab, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('enables automatic observation from the Codex panel', async () => {
  await mount()
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('首次建立基线')
  await click('开始监控')
  expect(server.requests).toContainEqual({ path: 'codex/monitor', method: 'POST', body: { enabled: true } })
  expect(text()).toContain('暂停监控')
})

it('surfaces an actionable Codex conversation on the overview and lets the person acknowledge it', async () => {
  const attention = { decision: { needsAttention: true as const, kind: 'review' as const,
    reason: '结果待审阅', action: '检查发布结果' }, at: '2026-11-01T12:00:00Z', itemId: 'item-new' }
  server.codex = { enabled: true, scannedAt: '2026-11-01T12:00:00Z', total: 1, attentionTotal: 1,
    attention: [{ id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true, attention }],
    threads: [{ id: 'thread-a', title: '发布任务', sourceKind: 'vscode', archived: false, present: true, attention }] }
  await mount()
  expect(text()).toContain('Codex 观察1')
  await click(tab(zh['tab.codex']))
  expect(text()).toContain('需要你处理')
  expect(text()).toContain('检查发布结果')
  expect(text()).toContain('数据来自已存储历史，不能证明 Desktop 的实时运行状态')
  await click('关闭提醒')
  expect(server.requests.some(request => request.path === 'codex/attention/thread-a/ack' && request.method === 'POST'
    && (request.body as { itemId?: string })?.itemId === 'item-new')).toBe(true)
  expect(text()).not.toContain('需要你处理')
})
