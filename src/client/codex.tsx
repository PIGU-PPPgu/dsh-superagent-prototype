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
  needsAgent: { zh: 'DSH 待处理', en: 'For DSH' },
  blocked: { zh: '报告受阻', en: 'Reported blocked' },
  failed: { zh: '报告失败', en: 'Reported failed' },
  unknown: { zh: '待核对', en: 'Uncertain' },
}
const supervisionPhases = {
  awaitingReply: ['等待 Codex 回复', 'Awaiting Codex'], needsReview: ['待 DSH 判断', 'For DSH review'],
  waiting: ['暂缓跟进', 'Waiting'], continued: ['已排下一步', 'Next step queued'],
  completed: ['已完成', 'Completed'], stopped: ['已停止跟进', 'Supervision stopped'],
} as const
const workState = (stage: { stage: string; action?: string } | undefined, chinese: boolean): string => {
  if (!stage) return chinese ? '已接单' : 'Accepted'
  if (stage.stage === 'person') {
    const action = {
      answer: { zh: '待回答', en: 'Needs an answer' }, review: { zh: '待审阅', en: 'Needs review' },
      blocked: { zh: '受阻待处理', en: 'Blocked' }, failed: { zh: '失败待处理', en: 'Failed' },
      delivery: { zh: '输入未送达', en: 'Delivery failed' },
    }[stage.action ?? '']
    return action ? (chinese ? action.zh : action.en) : (chinese ? '需要你处理' : 'Needs you')
  }
  if (stage.stage === 'ended') return chinese ? '已结束' : 'Ended'
  if (stage.stage === 'idle') return chinese ? '等待后续' : 'Idle'
  return stage.action === 'queued' ? (chinese ? '排队中' : 'Queued') : (chinese ? '执行中' : 'Working')
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
  const controlToggle = useAction((enabled: boolean) => call('POST codex/control', { body: { enabled } }), { reload })
  const acknowledge = useAction((id: string, itemId: string, at: string) =>
    call('POST codex/attention/:id/ack', { id, body: { itemId, at } }), { reload })
  const monitor = data?.monitor
  const router = data?.router
  const control = data?.control
  const human = monitor?.attention.filter(thread => thread.attention?.decision.stage === 'needsYou') ?? []
  const humanTotal = monitor?.needsYouTotal ?? monitor?.attentionTotal ?? 0
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
    {monitor?.enabled && <div className="dt-hint">
      <div>{chinese
        ? `最近 7 天 ${monitor.recentTotal ?? monitor.total} / 共 ${monitor.total} 个主会话 · ${linkedChildren} 个子线程 · ${humanTotal} 个需要你 · ${monitor.managedTotal ?? 0} 个 DSH 工单`
        : `Last 7 days: ${monitor.recentTotal ?? monitor.total} / ${monitor.total} main conversations · ${linkedChildren} child threads · ${humanTotal} need you · ${monitor.managedTotal ?? 0} DSH tickets`}</div>
      <div>{chinese ? `历史快照 · 上次扫描 ${timeText(monitor.scannedAt, true)}`
        : `Stored history · scanned ${timeText(monitor.scannedAt, false)}`}</div>
      {!!monitor.recentChildTotal && <div>{chinese
        ? `近 24 小时子线程状态已核对 ${monitor.checkedRecentChildTotal ?? 0} / ${monitor.recentChildTotal}`
        : `Recent child turns checked: ${monitor.checkedRecentChildTotal ?? 0} / ${monitor.recentChildTotal}`}</div>}
      {!!(monitor.unlinkedTotal || monitor.unclassifiedTotal || monitor.unlinkedChildErrors || monitor.childReadErrorsTotal) && <div>{chinese
        ? [monitor.withoutParentTotal ? `${monitor.withoutParentTotal} 条子线程无父会话 ID` : '',
          monitor.unresolvedParentTotal ? `${monitor.unresolvedParentTotal} 条父会话未找到` : '',
          monitor.unlinkedChildErrors ? `${monitor.unlinkedChildErrors} 条未归属子线程历史失败` : '',
          monitor.childReadErrorsTotal ? `${monitor.childReadErrorsTotal} 条子线程状态读取异常` : '',
          monitor.unclassifiedTotal ? `${monitor.unclassifiedTotal} 条来源未识别` : ''].filter(Boolean).join(' · ')
        : [monitor.withoutParentTotal ? `${monitor.withoutParentTotal} child threads without parent ID` : '',
          monitor.unresolvedParentTotal ? `${monitor.unresolvedParentTotal} parent threads not found` : '',
          monitor.unlinkedChildErrors ? `${monitor.unlinkedChildErrors} unlinked child failures in history` : '',
          monitor.childReadErrorsTotal ? `${monitor.childReadErrorsTotal} child turn reads failed` : '',
          monitor.unclassifiedTotal ? `${monitor.unclassifiedTotal} unclassified` : ''].filter(Boolean).join(' · ')}</div>}
    </div>}
    {!monitor?.enabled && <p className="dt-hint">{chinese
      ? '启用后扫描本机已存储的 Codex 历史，并用当前 DSH 模型归纳变化的主会话。'
      : 'Scan stored Codex history and summarize changed main conversations with the current DSH model.'}</p>}

    {monitor?.enabled && <section>
      <h3>{chinese ? '路由简报' : 'Router brief'}</h3>
      {router?.priorities.length ? <ul className="dt-list dt-cards">{router.priorities.slice(0, 3).map(item =>
        <li className="dt-row" key={`${item.kind}:${item.threadId}:${item.ticketId ?? ''}`}><div className="dt-row-main">
          <strong>{item.title}</strong>
          <p className="dt-row-quote dt-clamp">{item.summary}</p>
          <div className="dt-row-meta"><span>{item.kind === 'needsYou' ? (chinese ? '需要你' : 'Needs you')
            : item.kind === 'needsAgent' ? (chinese ? '由 DSH 处理' : 'Handled by DSH')
            : item.kind === 'ticketNeedsYou' ? (chinese ? 'DSH 工单待处理' : 'DSH ticket needs you')
              : item.kind === 'technical' ? (chinese ? '技术异常' : 'Technical issue')
                : item.kind === 'ticketEnded' ? (chinese ? '工单已结束' : 'Ticket ended')
                  : item.kind === 'reportedComplete' ? (chinese ? '报告完成' : 'Reported complete')
                    : item.kind === 'ticketResult' ? (chinese ? '工单结果' : 'Ticket result')
                      : (chinese ? '子线程历史失败' : 'Child failure in history')}</span></div>
          {item.ticketId && <div className="dt-row-buttons"><Button variant="outline" size="sm"
            onClick={() => navigate({ page: 'execution', id: item.ticketId! })}>{chinese ? '查看工单' : 'Open ticket'}</Button></div>}
        </div></li>)}</ul> : <p className="dt-hint">{router?.recent.length
        ? (chinese ? `最近记录：${router.recent[0]!.title} · ${router.recent[0]!.summary}`
          : `Latest: ${router.recent[0]!.title} · ${router.recent[0]!.summary}`)
        : (chinese ? '等待新的会话变化。' : 'Waiting for conversation changes.')}</p>}
    </section>}

    {control && <section>
      <div className="dt-row-buttons"><h3>{chinese ? '会话控制' : 'Session control'}</h3>
        <Button variant="outline" size="sm" disabled={controlToggle.busy || !control.bridgeReady && !control.enabled}
          onClick={() => { void controlToggle.run(!control.enabled) }}>
          {control.enabled ? (chinese ? '关闭控制' : 'Disable control')
            : (chinese ? '开启控制' : 'Enable control')}
        </Button></div>
      <p className="dt-hint">{control.bridgeReady
        ? (chinese ? '已连接 Codex Desktop · 审批仍由你处理' : 'Codex Desktop connected · approvals stay with you')
        : (chinese ? '等待 Codex Desktop 连接' : 'Waiting for Codex Desktop')}</p>
      {!!control.intents.length && <ul className="dt-list dt-cards">{control.intents.slice(0, 5).map(intent =>
        <li className="dt-row" key={intent.id}><div className="dt-row-main">
          <strong>{intent.delegation?.project ?? intent.threadId}</strong>
          <p className="dt-row-quote dt-clamp">{intent.delegation?.goal ?? intent.reason}</p>
          {intent.delegation && <details><summary>{chinese ? '派发详情' : 'Delegation'}</summary>
            <p>{intent.delegation.action}</p><p>{intent.delegation.doneWhen}</p>
            {intent.supervision?.reason && <p>{intent.supervision.reason}</p>}</details>}
          <div className="dt-row-meta"><span>{intent.operation === 'verify' ? (chinese ? '核实请求' : 'Verify request') : intent.operation === 'interrupt'
            ? (chinese ? '中断' : 'Interrupt') : (chinese ? '后续消息' : 'Follow-up')}</span>
            <span>{intent.status === 'sent' && intent.supervision
              ? supervisionPhases[intent.supervision.phase][chinese ? 0 : 1] : intent.status}</span>
            <span>{timeText(intent.supervision?.decidedAt ?? intent.supervision?.response?.observedAt ?? intent.updatedAt, chinese)}</span></div>
        </div></li>)}</ul>}
    </section>}

    {!!humanTotal && <section>
      <h3>{chinese ? '需要你处理' : 'Needs your attention'} · {humanTotal}</h3>
      <ul className="dt-list dt-cards">{human.map(thread => <li className="dt-row dt-att" key={thread.id}>
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

    {!!monitor?.autoHandoffEnabled && <section>
      <h3>{chinese ? '已交给 DSH' : 'Managed by DSH'} · {monitor.managedTotal ?? 0}</h3>
      {monitor.managed?.length ? <ul className="dt-list dt-cards">{monitor.managed.map(thread => <li className="dt-row"
        key={`${thread.id}:${thread.handoffTicketId}`}>
        <div className="dt-row-main">
          <strong>{thread.title}</strong>
          {thread.summary && <p className="dt-row-quote dt-clamp">{thread.summary}</p>}
          <div className="dt-row-meta"><span>{workState(thread.handoffStage, chinese)} · {chinese ? 'DSH 当前状态' : 'DSH state'}</span>
            <span>{timeText(thread.activityAt ?? thread.updatedAt, chinese)}</span></div>
          {thread.handoffTicketId && <div className="dt-row-buttons"><Button variant="outline" size="sm"
            onClick={() => navigate({ page: 'execution', id: thread.handoffTicketId! })}>{chinese ? '查看工单'
              : 'Open ticket'}</Button></div>}
        </div>
      </li>)}</ul> : <p className="dt-hint">{chinese ? '尚无符合自动接单条件的新失败或技术阻塞。'
        : 'No new failure or technical blocker qualifies for automatic work yet.'}</p>}
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
          <div className="dt-row-meta"><span>{thread.pausedByUser ? (chinese ? '按用户要求暂停' : 'Paused by user')
            : thread.stage ? (chinese ? stages[thread.stage]?.zh : stages[thread.stage]?.en)
            : (chinese ? '尚未归纳' : 'Not summarized')}</span>
            <span>{timeText(thread.activityAt ?? thread.updatedAt, chinese)}</span>
            {thread.repository && <span>{thread.repository}</span>}
            {!!thread.childCount && <span>{thread.childCount} {chinese ? '个子线程' : 'child threads'}</span>}
            {!!thread.childErrors && <span>{thread.childErrors} {chinese ? '个子线程历史失败' : 'child failures in history'}</span>}
            {!!thread.childReadErrors && <span>{thread.childReadErrors} {chinese ? '个子线程读取异常' : 'child reads failed'}</span>}
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
