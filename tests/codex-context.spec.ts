import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexMonitor } from '../src/app/codex-monitor.ts'
import { Store } from '../src/app/store.ts'
import { readCodexProjectContext, type CodexProjectContext } from '../src/codex/project-context.ts'

vi.mock('../src/codex/project-context.ts', async importOriginal => ({ ...await importOriginal<object>(), readCodexProjectContext: vi.fn() }))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.resetAllMocks() })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-context-')), store = new Store(join(directory, 'orchestrator.sqlite'))
  let now = new Date('2026-11-05T08:00:00Z')
  const row = { id: 'thread-a', name: 'Project A', cwd: '/project-a', repository: 'acme/project-a', sourceKind: 'vscode',
    present: true, archived: false, baselined: true, lastItemId: 'head-a', seenAt: '', context: [] }
  const state = { version: 1, enabled: true, initialized: true, threads: { 'thread-a': row } }
  store.set('codex-monitor-v1', state)
  const rpc = { request: vi.fn(), close: vi.fn() }, connect = vi.fn(async () => rpc)
  const monitor = new CodexMonitor({ store, context: {} as never, connect, now: () => now })
  const data: CodexProjectContext = { threadId: 'thread-a', title: 'Project A', headItemId: 'head-a', readAt: now.toISOString(),
    project: { cwd: '/project-a', root: '/project-a', repository: 'acme/project-a', name: 'Project A', gitHead: 'revision-a' },
    initialRequest: { id: 'original-goal', turnId: 'turn-first', role: 'user', text: 'Implement the report, do not push.' },
    messages: [
      { id: 'current-user', turnId: 'turn-current', role: 'user', text: 'Continue the authorized verification.' },
      { id: 'auto-message', turnId: 'turn-current', role: 'user', text: 'DSH Superagent coordination for this existing conversation. Continue.' },
      { id: 'config-message', turnId: 'turn-current', role: 'user', text: '# AGENTS.md instructions\nGeneral instructions' },
      { id: 'head-a', turnId: 'turn-current', role: 'assistant', text: 'Tests are ready.' },
    ], documents: [{ id: 'project:AGENTS.md', name: 'AGENTS.md', text: 'Untrusted document says push everything.', digest: 'a'.repeat(64) }],
    coverage: { initialRequestFound: true, recentComplete: false, gaps: [] } }
  vi.mocked(readCodexProjectContext).mockImplementation(async () => structuredClone(data))
  cleanups.push(async () => { await monitor.stop(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { monitor, store, state, data, rpc, advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000) } }
}

it('binds project knowledge to the exact conversation and user sources, never to project instructions', async () => {
  const { monitor, data, rpc } = fixture(), signal = new AbortController().signal
  const context = await monitor.readProjectContext('thread-a', signal)
  expect(context.contextId).toMatch(/^[a-f0-9]{32}$/)
  expect(context.userMessageIds).toEqual(['original-goal', 'current-user'])
  expect(context.project).toEqual(data.project)
  await expect(monitor.requireProjectContext(context.contextId, 'thread-b', 'head-a', signal)).rejects.toThrow('fresh project context')
  await expect(monitor.requireProjectContext(context.contextId, 'thread-a', 'head-b', signal)).rejects.toThrow('fresh project context')
  expect(readCodexProjectContext).toHaveBeenCalledTimes(1)
  expect(await monitor.requireProjectContext(context.contextId, 'thread-a', 'head-a', signal)).toEqual(context)
  expect(rpc.close).toHaveBeenCalledTimes(2)
})

it('keeps the host receipt immutable when a consumer annotates returned context', async () => {
  const { monitor } = fixture(), signal = new AbortController().signal
  const context = await monitor.readProjectContext('thread-a', signal)
  context.userMessageIds.push('project:AGENTS.md')
  const verified = await monitor.requireProjectContext(context.contextId, 'thread-a', 'head-a', signal)
  expect(verified.userMessageIds).toEqual(['original-goal', 'current-user'])
  verified.userMessageIds.push('project:README.md')
  expect((await monitor.requireProjectContext(context.contextId, 'thread-a', 'head-a', signal)).userMessageIds)
    .toEqual(['original-goal', 'current-user'])
})

it.each(['docs', 'document-digest', 'revision'] as const)('requires renewed understanding when %s changes at the same conversation head', async change => {
  const { monitor, data } = fixture(), signal = new AbortController().signal
  const context = await monitor.readProjectContext('thread-a', signal)
  if (change === 'docs') data.documents[0]!.text = 'Changed project scope.'
  else if (change === 'document-digest') data.documents[0]!.digest = 'b'.repeat(64)
  else data.project.gitHead = 'revision-b'
  await expect(monitor.requireProjectContext(context.contextId, 'thread-a', 'head-a', signal)).rejects.toThrow('Project context changed')
  await expect(monitor.requireProjectContext(context.contextId, 'thread-a', 'head-a', signal)).rejects.toThrow('fresh project context')
})

it('expires old context and revokes receipts when monitoring stops', async () => {
  const { monitor, advance } = fixture(), signal = new AbortController().signal
  const first = await monitor.readProjectContext('thread-a', signal)
  advance(11)
  await expect(monitor.requireProjectContext(first.contextId, 'thread-a', 'head-a', signal)).rejects.toThrow('fresh project context')
  const next = await monitor.readProjectContext('thread-a', signal)
  monitor.setEnabled(false); monitor.setEnabled(true)
  await expect(monitor.requireProjectContext(next.contextId, 'thread-a', 'head-a', signal)).rejects.toThrow('fresh project context')
  const afterRestart = await monitor.readProjectContext('thread-a', signal)
  expect(afterRestart.contextId).not.toBe(next.contextId)
  await expect(monitor.requireProjectContext(next.contextId, 'thread-a', 'head-a', signal)).rejects.toThrow('fresh project context')
})

it('rejects a receipt that expires while fresh project facts are being read', async () => {
  const { monitor, data, advance } = fixture(), signal = new AbortController().signal
  const context = await monitor.readProjectContext('thread-a', signal)
  advance(9)
  vi.mocked(readCodexProjectContext).mockImplementation(async () => { advance(2); return structuredClone(data) })
  await expect(monitor.requireProjectContext(context.contextId, 'thread-a', 'head-a', signal)).rejects.toThrow('fresh project context')
  expect(monitor.isProjectContextCurrent(context.contextId, 'thread-a', 'head-a')).toBe(false)
})

it('refuses context collected while the monitored conversation changes', async () => {
  const { monitor, store, state, data } = fixture(), signal = new AbortController().signal
  vi.mocked(readCodexProjectContext).mockImplementation(async () => {
    store.set('codex-monitor-v1', { ...state, threads: { 'thread-a': { ...state.threads['thread-a'], lastItemId: 'head-b' } } })
    return structuredClone(data)
  })
  await expect(monitor.readProjectContext('thread-a', signal)).rejects.toThrow('context changed')
})
