/** DSH panel view of the separately configured, history-only Codex file bridge. */
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'

const stateName: Record<string, string> = { unknown: '未知', missing: '没有记录', unavailable: '读取失败',
  running: '运行中', waitingForApproval: '等待批准', idle: '空闲', systemError: '系统错误' }

export function CodexPage() {
  const { call, t } = usePanel()
  const { restarts } = usePanelData()
  const chinese = t('tab.codex') === 'Codex 观察'
  const { data, error, reload } = usePoll(() => call('GET codex'), [call, restarts], 10_000)
  const tasks = data?.observation?.tasks ?? []
  return <div className="dt-codex">
    <div className="dt-row-buttons"><h2>{t('tab.codex')}</h2><Button variant="outline" size="sm" onClick={() => { void reload() }}>
      {chinese ? '刷新' : 'Refresh'}</Button></div>
    <p className="dt-hint">{chinese
      ? '这里读取本机桥接的白名单与历史快照。独立的 Codex App Server 无法证明 Codex Desktop 此刻的运行状态；不会给已有线程发消息。'
      : 'This reads the local bridge allowlist and stored-history snapshot. A separate Codex App Server cannot prove live Codex Desktop status; it never sends messages to existing threads.'}</p>
    {error && <p className="dt-error" role="alert">{error.message}</p>}
    {data && !data.configured && <p className="dt-hint">{chinese
      ? '尚未配置本机桥。先在 Mac 的仓库中运行 pnpm codex:local，在本机页面选线程并导出，然后重启 DSH。自定义数据目录时需设置页面给出的两个环境变量。'
      : 'No local bridge is configured. Run pnpm codex:local in the repository on your Mac, select threads and export, then restart DSH. A custom data directory also needs the two environment variables shown there.'}</p>}
    {data?.configured && !tasks.length && <p className="dt-hint">{chinese ? '白名单中没有可显示的线程。' : 'No allowlisted threads to display.'}</p>}
    {!!tasks.length && <div className="dt-table-wrap"><table className="dt-table">
      <thead><tr><th>{chinese ? '任务' : 'Task'}</th><th>{chinese ? '线程 ID' : 'Thread ID'}</th>
        <th>{chinese ? '状态' : 'State'}</th><th>{chinese ? '已存储进度' : 'Stored progress'}</th>
        <th>{chinese ? '采样时间' : 'Captured at'}</th></tr></thead>
      <tbody>{tasks.map(task => <tr key={task.taskId}><td>{task.label || task.taskId}</td><td className="dt-mono">{task.threadId}</td>
        <td>{task.statusSource === 'historyOnly' ? (chinese ? '未知（历史）' : 'Unknown (history)')
          : chinese ? stateName[task.state] ?? task.state : task.state}</td>
        <td className="dt-mono">{task.latestTurn ? `${task.latestTurn.id} / ${task.latestTurn.lastItemId ?? '—'}` : '—'}</td>
        <td>{task.capturedAt ?? '—'}</td></tr>)}</tbody>
    </table></div>}
    <p className="dt-hint">{chinese
      ? '本机 GUI 无需模型 API key。DSH 主会话要调用 orchestrator_codex_threads，请先在 DSH 自身配置模型 API；当前只读试验没有控制接口。'
      : 'The local GUI needs no model API key. To use orchestrator_codex_threads in the DSH main Session, configure a model API in DSH itself. This read-only trial has no control API.'}</p>
  </div>
}
