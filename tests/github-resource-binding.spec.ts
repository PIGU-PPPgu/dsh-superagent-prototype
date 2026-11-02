import { expect, it, vi } from 'vitest'
import { TextCache } from '../src/app/cache.ts'
import { readResource, type ResourceHost } from '../src/app/resources.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'

it('reads GitHub resources through the ticket account and rejects another binding', async () => {
  const deployment = testDeployment({ githubBindings: { other: { repository: 'acme/other', github: {
    cli: '/path/other-gh', login: 'other-agent', noreply: '8+other-agent@users.noreply.github.com' } } } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const tickets = new Map([['primary', { origin: { triggerId: 'primary-trigger' } }],
    ['secondary', { origin: { triggerId: 'secondary-trigger' } }]])
  const host = { commands, pages: new TextCache(100_000), masterId: 'master',
    store: { tickets: { get: (id: string) => tickets.get(id) }, triggers: { get: (id: string) => ({ source: 'github',
      meta: id === 'secondary-trigger' ? { bindingId: 'other' } : {} }) } } } as unknown as ResourceHost
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    const path = args[1] ?? ''
    const repository = path.startsWith('repos/acme/other/') ? 'acme/other' : 'acme/widgets'
    if (path.includes('/comments?')) return JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
      id: index + 1, user: { login: 'alice' }, body: `comment ${index + 1}`,
      created_at: '2026-09-01T00:00:00Z', html_url: `https://github.com/${repository}/issues/7#issuecomment-${index + 1}`,
    })))
    if (path.endsWith('/issues/7')) return JSON.stringify({ id: 7, number: 7, title: repository,
      state: 'open', body: `content from ${repository}`, user: { login: 'alice' },
      created_at: '2026-09-01T00:00:00Z', html_url: `https://github.com/${repository}/issues/7` })
    throw new Error(`Unexpected GitHub path ${path}`)
  })
  try {
    expect(JSON.stringify(await readResource(host, 'github/issues/7', 0, 4000))).toContain('content from acme/widgets')
    expect(JSON.stringify(await readResource(host, 'github/other/issues/7', 0, 4000)))
      .toContain('content from acme/other')
    expect(JSON.stringify(await readResource(host, 'github/issues/7', 0, 4000, 'secondary')))
      .toContain('content from acme/other')
    await expect(readResource(host, 'github/other/issues/7', 0, 4000, 'primary'))
      .rejects.toThrow('does not belong to this worker')
    expect(JSON.stringify(await readResource(host, 'github/other/issues/7/comments/1', 0, 4000)))
      .toContain('github/other/issues/7/comments/2')
    expect(run.mock.calls.some(([program, args]) => program === '/path/other-gh'
      && args[1] === 'repos/acme/other/issues/7')).toBe(true)
  } finally { run.mockRestore() }
})
