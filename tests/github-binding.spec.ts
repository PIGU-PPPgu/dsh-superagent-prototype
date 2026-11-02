import { expect, it, vi } from 'vitest'
import { record } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { githubBindingContext } from '../src/sources/github-binding.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'

it('keeps each GitHub account, cursor, thread and ticket in its own binding', () => {
  const deployment = testDeployment({ githubBindings: { other: { repository: 'acme/other', github: {
    cli: '/path/other-gh', login: 'other-agent', noreply: '8+other-agent@users.noreply.github.com' } } } })
  const stored = new Map<string, unknown>()
  const threads = [
    { key: 'github:7', ref: { source: 'github', id: '7' } },
    { key: 'github:other:7', ref: { source: 'github', id: 'other:7' } },
  ]
  const tickets = [
    { id: 'primary', origin: { triggerId: 'primary-trigger' }, follows: [{ thread: 'github:7' }] },
    { id: 'secondary', origin: { triggerId: 'secondary-trigger' }, follows: [{ thread: 'github:other:7' }] },
  ]
  const bindThread = vi.fn()
  const base = {
    deployment, commands: new Commands(() => deployment, {}, new AbortController().signal), ready: Promise.resolve(),
    configured: () => true, config: () => ({}), receive: vi.fn(), atomic: (work: () => unknown) => work(),
    state: { get: (key: string) => stored.get(key), set: (key: string, value: unknown) => { stored.set(key, value) },
      keys: () => [] },
    threads: { get: (key: string) => threads.find(thread => thread.key === key), subscribed: () => threads,
      describe: vi.fn(), patch: vi.fn() },
    tickets: { get: (id: string) => tickets.find(ticket => ticket.id === id), open: () => tickets,
      bindThread, threadClosed: vi.fn() },
    triggers: { get: (id: string) => ({ source: 'github', meta: id === 'secondary-trigger'
      ? { bindingId: 'other' } : {} }), latest: vi.fn() },
    notify: vi.fn(), report: vi.fn(),
  } as unknown as SourceContext

  const primary = githubBindingContext(base)
  const secondary = githubBindingContext(base, 'other')
  expect(primary.commands.repository).toBe('acme/widgets')
  expect(secondary.commands.repository).toBe('acme/other')
  expect(secondary.commands.binding.github.cli).toBe('/path/other-gh')
  primary.state.set(record('github-since'), 'first')
  secondary.state.set(record('github-since'), 'second')
  expect(stored.get('github-since')).toBe('first')
  expect(stored.get('github-binding:other:github-since')).toBe('second')
  expect(primary.threads.subscribed('github').map(thread => thread.ref.id)).toEqual(['7'])
  expect(secondary.threads.subscribed('github').map(thread => thread.ref.id)).toEqual(['7'])
  expect(primary.tickets.open().map(ticket => ticket.id)).toEqual(['primary'])
  expect(secondary.tickets.open().map(ticket => ticket.id)).toEqual(['secondary'])
  expect(secondary.tickets.open()[0]?.follows?.[0]?.thread).toBe('github:7')
  secondary.tickets.bindThread('secondary', { source: 'github', id: '8' }, true)
  expect(bindThread).toHaveBeenCalledWith('secondary', { source: 'github', id: 'other:8' }, true)
  expect(() => githubBindingContext(base, 'missing')).toThrow('unavailable')
})
