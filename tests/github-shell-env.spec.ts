import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { GITHUB_BINDING_ENV, registerGithubShellEnv } from '../src/app/github-shell-env.ts'
import { githubBindingOf } from '../src/sources/github-binding.ts'
import type { Store } from '../src/app/store.ts'

it('resolves the calling worker and its subagent to the ticket GitHub binding', () => {
  let resolve!: (execution: ToolExecution) => Readonly<Partial<Record<string, string>>>
  const register = vi.fn((contributor: { resolve: typeof resolve }) => { resolve = contributor.resolve; return () => {} })
  const agents = new Map([['subagent', { session: { header: { parentSession: 'worker-secondary' } } }]])
  const ctx = { inject: (_names: string[], bind: (child: unknown) => void) => bind({ shellEnv: { register },
    effect: (apply: () => unknown) => apply() }), agents: { get: (id: string) => agents.get(id) } } as unknown as Context
  const store = { tickets: { get: (id: string) => id === 'secondary' ? { origin: { triggerId: 'source' } } : undefined },
    triggers: { get: (id: string) => id === 'source' ? { source: 'github', meta: { bindingId: 'intellibrain' } } : undefined } } as unknown as Pick<Store, 'tickets' | 'triggers'>
  registerGithubShellEnv(ctx, store, 'orchestrator-main')
  const from = (id?: string) => resolve({ agent: id ? { id } : undefined } as unknown as ToolExecution)
  expect(register).toHaveBeenCalledTimes(1)
  expect(from('orchestrator-main')).toEqual({ [GITHUB_BINDING_ENV]: 'default' })
  expect(from('worker-secondary')).toEqual({ [GITHUB_BINDING_ENV]: 'intellibrain' })
  expect(from('subagent')).toEqual({ [GITHUB_BINDING_ENV]: 'intellibrain' })
  expect(from('worker-missing')).toEqual({ [GITHUB_BINDING_ENV]: 'unavailable' })
  expect(from('unrelated')).toEqual({})
  expect(from()).toEqual({})
})

it('resolves internal Codex handoffs from their githubBinding value', () => {
  const codex = (githubBinding: unknown) => ({ id: String(githubBinding), source: 'codex', threads: [],
    actor: { source: 'codex', id: 'local-codex-monitor' }, human: true, at: '', text: '', meta: { githubBinding } })
  expect(githubBindingOf(codex('default'))).toEqual({ available: true })
  expect(githubBindingOf(codex('other'))).toEqual({ id: 'other', available: true })
  expect(githubBindingOf(codex('unavailable'))).toEqual({ available: false })
  expect(githubBindingOf({ ...codex('default'), meta: { githubBinding: 'default', workspaceMode: 'analysis' } }))
    .toEqual({ available: false })
  expect(githubBindingOf(codex(undefined))).toEqual({ available: false })
  expect(githubBindingOf(codex(42))).toEqual({ available: false })
})
