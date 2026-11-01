/** Superagent panel for automatic, history-based observation of local Codex conversations. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'

const PAGE_SIZE = 50

export function CodexPage() {
  const { call, t } = usePanel()
  const { restarts } = usePanelData()
  const chinese = t('tab.codex') === 'Codex 观察'
  const [offset, setOffset] = useState(0)
  const { data, error, reload } = usePoll(() => call('GET codex', { query: { offset, limit: PAGE_SIZE } }),
    [call, restarts, offset], 10_000)
  const toggle = useAction((enabled: boolean) => call('POST codex/monitor', { body: { enabled } }), { reload })
  const acknowledge = useAction((id: string, itemId: string, at: string) =>
    call('POST codex/attention/:id/ack', { id, body: { itemId, at } }), { reload })
  const monitor = data?.monitor

  return <div className="dt-codex">
    <div className="dt-row-buttons"><h2>{t('tab.codex')}</h2>
      <Button variant={monitor?.enabled ? 'outline' : undefined} size="sm" disabled={toggle.busy}
        onClick={() => { void toggle.run(!monitor?.enabled) }}>
        {monitor?.enabled ? (chinese ? '暂停监控' : 'Pause monitoring') : (chinese ? '开始监控' : 'Start monitoring')}
      </Button>
    </div>
    {error && <p className="dt-error" role="alert">{error.message}</p>}
    {monitor?.error && <p className="dt-error" role="alert">{monitor.error}</p>}
    {monitor?.enabled && <p className="dt-hint">{chinese
      ? `已发现 ${monitor.total} 条对话；上次扫描 ${monitor.scannedAt ?? '尚未完成'}。数据来自已存储历史，不能证明 Desktop 的实时运行状态。`
      : `Found ${monitor.total} conversations; last scan ${monitor.scannedAt ?? 'pending'}. Stored history does not prove live Desktop status.`}</p>}
    {!monitor?.enabled && <p className="dt-hint">{chinese
      ? '启用后约每 30 秒扫描本机 Codex 历史；首次建立基线，之后把变化的用户与助手消息交给当前 DSH 模型判断。'
      : 'Scan local Codex history about every 30 seconds. After the first baseline, changed user and assistant messages go to the current DSH model.'}</p>}

    {!!monitor?.attentionTotal && <section>
      <h3>{chinese ? '需要你处理' : 'Needs your attention'} · {monitor.attentionTotal}</h3>
      <ul className="dt-list dt-cards">{monitor.attention.map(thread => <li className="dt-row dt-att" key={thread.id}>
        <div className="dt-row-main">
          <strong>{thread.title}</strong>
          <small className="dt-mono">{thread.id}</small>
          <p>{thread.attention?.decision.reason}</p>
          <p>{thread.attention?.decision.action}</p>
          <div className="dt-row-buttons"><Button variant="outline" size="sm" disabled={acknowledge.busy}
            onClick={() => { if (thread.attention) void acknowledge.run(thread.id, thread.attention.itemId,
              thread.attention.at) }}>{chinese ? '关闭提醒' : 'Dismiss'}</Button></div>
        </div>
      </li>)}</ul>
    </section>}

    {!!monitor?.total && <section>
      <h3>{chinese ? '全部对话' : 'All conversations'} · {monitor.total}</h3>
      <div className="dt-table-wrap"><table className="dt-table">
        <thead><tr><th>{chinese ? '对话' : 'Conversation'}</th><th>{chinese ? '来源' : 'Source'}</th>
          <th>{chinese ? '最近更新' : 'Updated'}</th><th>{chinese ? '观察' : 'Observation'}</th></tr></thead>
        <tbody>{monitor.threads.map(thread => <tr key={thread.id}>
          <td><strong>{thread.title}</strong><br /><small className="dt-mono">{thread.id}</small>
            {thread.parentThreadId && <><br /><small>{chinese ? '父线程' : 'Parent'}: {thread.parentThreadId}</small></>}</td>
          <td>{thread.sourceKind}{thread.archived ? (chinese ? ' · 已归档' : ' · Archived') : ''}</td>
          <td>{thread.updatedAt ?? '—'}</td>
          <td>{thread.error ? (chinese ? '监控异常' : 'Monitor error') : thread.attention?.decision.needsAttention
            && !thread.attention.acknowledgedAt ? (chinese ? '需处理' : 'Needs attention') : '—'}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="dt-row-buttons">
        {offset > 0 && <Button variant="outline" size="sm" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          {chinese ? '上一页' : 'Previous'}</Button>}
        {monitor.nextOffset !== undefined && <Button variant="outline" size="sm" onClick={() => setOffset(monitor.nextOffset!)}>
          {chinese ? '下一页' : 'Next'}</Button>}
      </div>
    </section>}
  </div>
}
