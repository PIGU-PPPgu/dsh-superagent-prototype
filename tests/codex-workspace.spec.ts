import { expect, it, vi } from 'vitest'
import { afterEach, beforeEach } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import type { CodexFailureCandidate } from '../src/app/codex-monitor.ts'
import { Commands } from '../src/infra/commands.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

async function codexTicket(workspaceMode: 'analysis' | 'execute', repository = 'acme/widgets') {
  h.subprocess.spawn.mockClear()
  const candidate: CodexFailureCandidate = { threadId: `thread-${workspaceMode}-${repository.replace(/\W/g, '-')}`, itemId: 'item', title: 'Codex handoff',
    summary: 'Failure', evidence: 'Reported', repository, messages: [] }
  const id = await (h.runtime as unknown as { acceptCodexFailure(candidate: CodexFailureCandidate, signal: AbortSignal): Promise<string> })
    .acceptCodexFailure(candidate, new AbortController().signal)
  const ticket = h.runtime.store.tickets.get(id)!
  const trigger = h.runtime.store.triggers.get(ticket.origin.triggerId)!
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

it('keeps Codex worker reports in the Superagent panel without main-Session relays', async () => {
  const { ticket } = await codexTicket('analysis', 'another/project')
  h.deliveries.mockClear()
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'Panel status', human_action: 'A panel question?' }))
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
})
