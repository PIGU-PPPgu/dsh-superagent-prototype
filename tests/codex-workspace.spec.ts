import { expect, it, vi } from 'vitest'
import { afterEach, beforeEach } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import type { CodexFailureCandidate, CodexHistoryView, CodexMonitor } from '../src/app/codex-monitor.ts'
import { seedCodexCandidate } from './fixtures/codex.ts'
import { Commands } from '../src/infra/commands.ts'
import { key } from '../src/core/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

let h: Host
beforeEach(async () => {
  h = await startRuntime()
  const internal = h.runtime as unknown as {
    codexMonitor: CodexMonitor
    codexDesktopStatus(threadId: string, signal: AbortSignal): Promise<Record<string, unknown>>
  }
  vi.spyOn(internal.codexMonitor, 'readHistory').mockImplementation(async threadId =>
    ({ threadId, title: threadId, source: 'persisted Codex history', readAt: new Date().toISOString(), complete: true,
      headItemId: internal.codexMonitor.routeHead(threadId)?.lastItemId, messages: [] }) satisfies CodexHistoryView)
  vi.spyOn(internal, 'codexDesktopStatus').mockResolvedValue({ available: true, status: 'idle', pendingRequests: 0 })
})
afterEach(async () => { await h.stop() })

async function codexTicket(workspaceMode: 'analysis' | 'execute', repository = 'acme/widgets', stage?: 'failed' | 'blocked') {
  h.subprocess.spawn.mockClear()
  const candidate: CodexFailureCandidate = { threadId: `thread-${workspaceMode}-${repository.replace(/\W/g, '-')}`, itemId: 'item', title: 'Codex handoff',
    summary: 'Failure', evidence: 'Reported', repository, messages: [], ...(stage ? { stage } : {}) }
  seedCodexCandidate(h.runtime.store, candidate.threadId, candidate.itemId)
  const triggerId = key('codex-handoff', candidate.threadId, candidate.itemId)
  const trigger = { id: triggerId, source: 'codex', threads: [{ source: 'codex', id: key('codex-intake', candidate.threadId, candidate.itemId) }],
    actor: { source: 'codex', id: 'local-codex-monitor' }, human: false, addressed: 'direct' as const,
    at: new Date().toISOString(), text: JSON.stringify({ kind: stage === 'blocked' ? 'Codex historical technical blocker' : 'Codex historical failure',
      threadId: candidate.threadId, title: candidate.title, evidence: candidate.evidence }),
    meta: { threadId: candidate.threadId, itemId: candidate.itemId, codexAutoIntake: true, stage,
      repository, githubBinding: workspaceMode === 'execute' ? 'default' : 'unavailable', workspaceMode } }
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: triggerId, title: 'Codex recovery',
    worktree_name: 'codex-recovery', acknowledgement: 'Investigating the reported failure.' })
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  await h.runtime.idle()
  return { ticket, trigger }
}

it('creates an independent empty Codex analysis workspace with no default clone', async () => {
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, prepare: 'git clone bad-default "$DSH_SUPERAGENT_DIR"' } })
  const { ticket } = await codexTicket('analysis', 'another/project')
  const commands = h.subprocess.spawn.mock.calls.map(([spec]) => spec as { argv: string[]; cwd?: string; env?: Record<string, string> })
  expect(commands.some(command => command.argv.includes('clone'))).toBe(false)
  expect(commands.some(command => command.argv.includes('sh'))).toBe(false)
  expect(commands.some(command => command.cwd === ticket.execution!.directory && command.argv[0] === 'git')).toBe(true)
})

it('clones always the bound repository before starting the Codex execute workspace', async () => {
  const { ticket } = await codexTicket('execute', 'acme/widgets')
  const commands = h.subprocess.spawn.mock.calls.map(([spec]) => spec as { argv: string[]; env?: Record<string, string> })
  expect(commands).toContainEqual(expect.objectContaining({ argv: ['git', 'clone', 'https://github.com/acme/widgets.git', ticket.execution!.directory],
    env: expect.objectContaining({ DSH_SUPERAGENT_GITHUB_BINDING: 'default' }) }))
  await expect(h.runTool(`worker-${ticket.id}`, 'orchestrator_thread_follow', { thread: 'feishu:oc_team:om_1', reason: 'related' }))
    .rejects.toThrow('Codex tickets cannot follow external threads')
})

it('accepts an evidenced technical blockage with a bounded repair mandate', async () => {
  const { ticket, trigger } = await codexTicket('execute', 'acme/widgets', 'blocked')
  expect(ticket.mandate.scope).toContain('technical blockage')
  expect(trigger.text).toContain('Codex historical technical blocker')
  expect(ticket.channels).toEqual([])
})

it('keeps routine Codex worker progress out of the main Session and does not contact the original conversation', async () => {
  const { ticket } = await codexTicket('analysis', 'another/project')
  h.deliveries.mockClear()
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'Panel status' }))
    .toMatchObject({ notification: 'internal_only' })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).some(item => item.ticket_id === ticket.id)).toBe(false)
  await expect(h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'No PR', pr_number: 7 }))
    .rejects.toThrow('Codex analysis tickets cannot declare a GitHub pull request')
  await expect(h.runTool(`worker-${ticket.id}`, 'orchestrator_thread_follow', { thread: 'github:7', reason: 'related' }))
    .rejects.toThrow('Codex tickets cannot follow external threads')
  await expect(h.runTool(`worker-${ticket.id}`, 'orchestrator_thread_follow', { thread: 'feishu:oc_team:om_1', reason: 'related' }))
    .rejects.toThrow('Codex tickets cannot follow external threads')
  const gh = vi.mocked(Commands.prototype.gh)
  gh.mockClear()
  await expect(h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: 'github/issues/1', offset: 0 }))
    .rejects.toThrow('This Codex ticket cannot read that external source')
  await expect(h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: 'feishu/other', offset: 0 }))
    .rejects.toThrow('This Codex ticket cannot read that external source')
  expect(gh).not.toHaveBeenCalled()
  expect(h.relays(`worker-${ticket.id}`)).toEqual([])
  expect(h.controller.prompt).not.toHaveBeenCalled()
})

it('relays a Codex worker human-action question to the DSH main Session', async () => {
  const { ticket } = await codexTicket('analysis', 'another/project')
  h.deliveries.mockClear()
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'Need access',
    human_action: 'May I inspect the local configuration?' })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_attention')).toEqual([
    expect.objectContaining({ state: 'progress', read: `ticket/${ticket.id}/result` }),
  ])
  expect(h.controller.prompt).not.toHaveBeenCalled()
})

it('relays the same Codex question again after its prior attention was cleared', async () => {
  const { ticket } = await codexTicket('analysis', 'another/project')
  const sessionId = `worker-${ticket.id}`
  const question = { state: 'progress', summary: 'Need access', human_action: 'May I inspect the local configuration?' }
  h.deliveries.mockClear()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  try {
    await h.runTool(sessionId, 'orchestrator_report', question)
    await h.runtime.idle()
    const first = h.runtime.store.tickets.get(ticket.id)!.attention!
    vi.setSystemTime(Date.now() + 1000)
    await h.runTool(sessionId, 'orchestrator_report', question)
    await h.runtime.idle()
    expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_attention')).toHaveLength(1)
    await h.runTool(sessionId, 'orchestrator_report', { ...question, human_action: null })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)!.attention).toBeUndefined()
    vi.setSystemTime(Date.now() + 1000)
    await h.runTool(sessionId, 'orchestrator_report', question)
    await h.runtime.idle()
    const second = h.runtime.store.tickets.get(ticket.id)!.attention!
    expect(second.id).not.toBe(first.id)
    expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_attention')).toHaveLength(2)
    expect(h.deliveries.mock.calls.map(([call]) => call.id)).toEqual([
      h.runtime.sessions.promptedId(`attention:${ticket.id}:${first.id}`),
      h.runtime.sessions.promptedId(`attention:${ticket.id}:${second.id}`),
    ])
  } finally { vi.useRealTimers() }
})

it('deduplicates identical Codex failure result relays', async () => {
  const { ticket } = await codexTicket('analysis', 'another/project')
  const sessionId = `worker-${ticket.id}`
  const report = { state: 'failed', summary: 'The local tool is unavailable' }
  h.deliveries.mockClear()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  try {
    await h.runTool(sessionId, 'orchestrator_report', report)
    await h.runtime.idle()
    vi.setSystemTime(Date.now() + 1000)
    await h.runTool(sessionId, 'orchestrator_report', report)
    await h.runtime.idle()
    expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toEqual([
      expect.objectContaining(report),
    ])
  } finally { vi.useRealTimers() }
})

it('relays a Codex Ticket idle result to the DSH main Session exactly once', async () => {
  const { ticket } = await codexTicket('analysis', 'another/project')
  const sessionId = `worker-${ticket.id}`
  h.deliveries.mockClear()
  const agent = h.agents.get(sessionId)! as unknown as Agent
  agent.session.snapshotEvents = () => [{ type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'Diagnosis complete; the lock file is inconsistent.' }] } } }] as never
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Diagnosis complete; the lock file is inconsistent.' })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toEqual([
    expect.objectContaining({ state: 'ready', summary: 'Diagnosis complete; the lock file is inconsistent.' }),
  ])
  h.deliveries.mockClear()
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toEqual([])
  expect(h.controller.prompt).not.toHaveBeenCalled()
})

it('keeps an idle Codex worker report without an external conversation message', async () => {
  const { ticket } = await codexTicket('analysis', 'another/project')
  const sessionId = `worker-${ticket.id}`
  h.deliveries.mockClear()
  const agent = h.agents.get(sessionId)! as unknown as Agent
  const idleAgent = agent as Agent & { status: string }
  idleAgent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('waiting'))
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toEqual([
    expect.objectContaining({ state: 'waiting', ticket: expect.objectContaining({ ticket_id: ticket.id }) }),
  ])
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toHaveLength(1)
  expect(h.relays(sessionId)).toEqual([])
  expect(h.controller.prompt).not.toHaveBeenCalled()
})

it('relays a terminal Codex worker launch failure to the DSH main Session exactly once', async () => {
  const { ticket } = await codexTicket('analysis', 'another/project')
  const sessionId = `worker-${ticket.id}`
  h.deliveries.mockClear()
  const agent = h.agents.get(sessionId)! as unknown as Agent
  h.ctx.emit('agent/error', { agent, error: new Error('Worker executable is missing') } as never)
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('failed'))
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toEqual([
    expect.objectContaining({ state: 'failed', summary: 'Error: Worker executable is missing',
      ticket: expect.objectContaining({ ticket_id: ticket.id }) }),
  ])
  h.ctx.emit('agent/error', { agent, error: new Error('Worker executable is missing') } as never)
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toHaveLength(1)
  expect(h.relays(sessionId)).toEqual([])
  expect(h.controller.prompt).not.toHaveBeenCalled()
})
