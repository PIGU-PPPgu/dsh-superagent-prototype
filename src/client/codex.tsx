/** Superagent panel for local Codex conversations, grouped by main task. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'

const PAGE_SIZE = 20
const stages: Record<string, { zh: string; en: string }> = {
  progress: { zh: '最近进展', en: 'Recent progress' },
  reportedComplete: { zh: '报告完成', en: 'Reported complete' },
  needsYou: { zh: '需你处理', en: 'Needs you' },
  blocked: { zh: '报告受阻', en: 'Reported blocked' },
  failed: { zh: '报告失败', en: 'Reported failed' },
  unknown: { zh: '待核对', en: 'Uncertain' },
}
const timeText = (value: string | undefined, chinese: boolean): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(chinese ? 'zh-CN' : 'en-US', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : value
}

export function CodexPage() {
  const { call, t, navigate } = usePanel()
  const { restarts } = usePanelData()
  const chinese = t('tab.codex') === 'Codex 观察'
  const [offset, setOffset] = useState(0)
  const [scope, setScope] = useState<'recent' | 'all'>('recent')
  const { data, error, reload } = usePoll(() => call('GET codex', { query: { offset, limit: PAGE_SIZE, scope } }),
    [call, restarts, offset, scope], 10_000)
  const toggle = useAction((enabled: boolean) => call('POST codex/monitor', { body: { enabled } }), { reload })
  const autoHandoff = useAction((enabled: boolean) => call('POST codex/auto-handoff', { body: { enabled } }), { reload })
  const acknowledge = useAction((id: string, itemId: string, at: string) =>
    call('POST codex/attention/:id/ack', { id, body: { itemId, at } }), { reload })
  const monitor = data?.monitor
  const listed = scope === 'recent' ? (monitor?.recentTotal ?? monitor?.total ?? 0) : (monitor?.total ?? 0)
  const linkedChildren = Math.max(0, (monitor?.childTotal ?? 0) - (monitor?.unlinkedTotal ?? 0))
  const changeScope = () => { setOffset(0); setScope(scope === 'recent' ? 'all' : 'recent') }

  return <div className="dt-codex">
    <div className="dt-row-buttons"><h2>{t('tab.codex')}</h2>
      <Button variant={monitor?.enabled ? 'outline' : undefined} size="sm" disabled={toggle.busy}
        onClick={() => { void toggle.run(!monitor?.enabled) }}>
        {monitor?.enabled ? (chinese ? '暂停监控' : 'Pause monitoring') : (chinese ? '开始监控' : 'Start monitoring')}
      </Button>
      <Button variant={monitor?.autoHandoffEnabled ? 'outline' : undefined} size="sm" disabled={autoHandoff.busy}
        onClick={() => { void autoHandoff.run(!monitor?.autoHandoffEnabled) }}>
        {monitor?.autoHandoffEnabled ? (chinese ? '关闭自动接单' : 'Disable auto handoff')
          : (chinese ? '开启自动接单' : 'Enable auto handoff')}
      </Button>
    </div>
    {error && <p className="dt-error" role="alert">{error.message}</p>}
    {monitor?.error && <p className="dt-error" role="alert">{monitor.error}</p>}
    {monitor?.enabled && <p className="dt-hint">{chinese
      ? '最近 7 天 ' + (monitor.recentTotal ?? monitor.total) + ' / 共 ' + monitor.total + ' 个主会话 · '
        + linkedChildren + ' 个子线程归入主会话'
        + (monitor.withoutParentTotal ? ' · ' + monitor.withoutParentTotal + ' 条无父会话记录' : '')
        + (monitor.unresolvedParentTotal ? ' · ' + monitor.unresolvedParentTotal + ' 条父会话未找到' : '')
        + (monitor.withoutParentTotal === undefined && monitor.unresolvedParentTotal === undefined
          && monitor.unlinkedTotal ? ' · ' + monitor.unlinkedTotal + ' 个未归属' : '')
        + (monitor.unclassifiedTotal ? ' · ' + monitor.unclassifiedTotal + ' 条来源未识别' : '')
        + ' · 上次扫描 ' + timeText(monitor.scannedAt, true)
        + ' · 历史观察'
      : 'Last 7 days: ' + (monitor.recentTotal ?? monitor.total) + ' / ' + monitor.total + ' main conversations · '
        + linkedChildren + ' child threads grouped'
        + (monitor.withoutParentTotal ? ' · ' + monitor.withoutParentTotal + ' without parent ID' : '')
        + (monitor.unresolvedParentTotal ? ' · ' + monitor.unresolvedParentTotal + ' parent not found' : '')
        + (monitor.withoutParentTotal === undefined && monitor.unresolvedParentTotal === undefined
          && monitor.unlinkedTotal ? ' · ' + monitor.unlinkedTotal + ' unlinked' : '')
        + (monitor.unclassifiedTotal ? ' · ' + monitor.unclassifiedTotal + ' unclassified' : '')
        + ' · scanned ' + timeText(monitor.scannedAt, false)
        + ' · stored history'}</p>}
    {!monitor?.enabled && <p className="dt-hint">{chinese
      ? '启用后扫描本机已存储的 Codex 历史，并用当前 DSH 模型归纳变化的主会话。'
      : 'Scan stored Codex history and summarize changed main conversations with the current DSH model.'}</p>}

    {!!monitor?.attentionTotal && <section>
      <h3>{chinese ? '需要你处理' : 'Needs your attention'} · {monitor.attentionTotal}</h3>
      <ul className="dt-list dt-cards">{monitor.attention.map(thread => <li className="dt-row dt-att" key={thread.id}>
        <div className="dt-row-main">
          <strong>{thread.title}</strong>
          <p className="dt-row-quote dt-clamp">{thread.attention?.decision.reason}</p>
          <p className="dt-row-quote dt-clamp">{thread.attention?.decision.action}</p>
          <div className="dt-row-meta"><span className="dt-mono">{thread.id}</span>
            <span>{timeText(thread.attention?.at, chinese)}</span></div>
          <div className="dt-row-buttons"><Button variant="outline" size="sm" disabled={acknowledge.busy}
            onClick={() => { if (thread.attention) void acknowledge.run(thread.id, thread.attention.itemId,
              thread.attention.at) }}>{chinese ? '关闭提醒' : 'Dismiss'}</Button></div>
        </div>
      </li>)}</ul>
    </section>}

    {!!monitor?.total && <section>
      <div className="dt-row-buttons"><h3>{scope === 'recent'
        ? (chinese ? '最近主会话' : 'Recent conversations')
        : (chinese ? '全部主会话' : 'All main conversations')} · {listed}</h3>
        <Button variant="outline" size="sm" onClick={changeScope}>{scope === 'recent'
          ? (chinese ? '查看全部' : 'Show all') : (chinese ? '只看最近' : 'Show recent')}</Button></div>
      <ul className="dt-list dt-cards">{monitor.threads.map(thread => <li className="dt-row" key={thread.id}>
        <div className="dt-row-main">
          <div className="dt-row-title"><strong>{thread.title}</strong></div>
          {thread.summary && <p className="dt-row-quote dt-clamp">{thread.summary}</p>}
          {thread.error && <p className="dt-error">{chinese ? '归纳暂不可用' : 'Summary unavailable'}</p>}
          {thread.handoffError && <p className="dt-error" role="alert">{chinese ? '自动接单暂不可用'
            : 'Automatic handoff unavailable'}</p>}
          <div className="dt-row-meta"><span>{thread.stage ? (chinese ? stages[thread.stage]?.zh : stages[thread.stage]?.en)
            : (chinese ? '尚未归纳' : 'Not summarized')}</span>
            <span>{timeText(thread.activityAt ?? thread.updatedAt, chinese)}</span>
            {!!thread.childCount && <span>{thread.childCount} {chinese ? '个子线程' : 'child threads'}</span>}
            {thread.archived && <span>{chinese ? '已归档' : 'Archived'}</span>}
            <span className="dt-mono">{thread.id}</span></div>
          {thread.handoffTicketId && <div className="dt-row-buttons"><Button variant="outline" size="sm"
            onClick={() => navigate({ page: 'execution', id: thread.handoffTicketId! })}>{chinese ? '查看工单'
              : 'Open ticket'}</Button></div>}
        </div>
      </li>)}</ul>
      <div className="dt-row-buttons">
        {offset > 0 && <Button variant="outline" size="sm" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          {chinese ? '上一页' : 'Previous'}</Button>}
        {monitor.nextOffset !== undefined && <Button variant="outline" size="sm" onClick={() => setOffset(monitor.nextOffset!)}>
          {chinese ? '下一页' : 'Next'}</Button>}
      </div>
    </section>}
  </div>
}
