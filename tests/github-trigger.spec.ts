import { describe, expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, githubChannel, issueTrigger, pullTrigger } from '../src/sources/github-trigger.ts'

const issue = (binding?: string) => issueTrigger({ number: 7, title: 'Broken', body: '', user: { login: 'alice' },
  created_at: '2026-09-01T00:00:00Z', html_url: `https://github.com/${binding ?? 'acme'}/widgets/issues/7` }, 'agent-bot', binding)

describe('github bindings', () => {
  it('keeps the trigger and channel shapes of calls without a binding', () => {
    expect(githubChannel(7, 'https://github.com/acme/widgets/issues/7')).toEqual({ source: 'github', thread: 'github:7',
      address: { number: '7', url: 'https://github.com/acme/widgets/issues/7' } })
    expect(issue()).toEqual({ id: key('github-issue', '7'), source: 'github', threads: [{ source: 'github', id: '7' }],
      actor: { source: 'github', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'Broken\n\n',
      channel: githubChannel(7, 'https://github.com/acme/widgets/issues/7'),
      url: 'https://github.com/acme/widgets/issues/7', meta: { number: 7, isPr: false, kind: 'issue' } })
  })

  it('separates Issues, PRs, comments, and PR CI in two bindings with the same number', () => {
    const first = issue('binding-a')
    const second = issue('binding-b')
    expect(first.threads[0]!.id).toBe('binding-a:7')
    expect(second.threads[0]!.id).toBe('binding-b:7')
    expect(first.id).not.toBe(second.id)
    expect(first.channel).toMatchObject({ thread: 'github:binding-a:7', address: { bindingId: 'binding-a' } })
    expect(first.meta).toMatchObject({ bindingId: 'binding-a' })
    const pull = { number: 7, title: 'Fix', body: '', user: { login: 'carol' }, created_at: '2026-09-01T00:00:00Z',
      html_url: 'https://github.com/acme/widgets/pull/7' }
    expect(pullTrigger(pull, 'agent-bot', 'binding-a').id).not.toBe(pullTrigger(pull, 'agent-bot', 'binding-b').id)
    expect(pullTrigger(pull, 'agent-bot', 'binding-a')).toMatchObject({ threads: [{ id: 'binding-a:7' }],
      meta: { isPr: true, bindingId: 'binding-a', prAuthor: 'carol' } })

    const comment = { id: 9, body: 'x', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-9',
      created_at: '2026-09-01T00:00:00Z' }
    const firstComment = commentTrigger(comment, { number: 7, isPr: false }, 'conversation', 'agent-bot', 'binding-a')
    const secondComment = commentTrigger(comment, { number: 7, isPr: false }, 'conversation', 'agent-bot', 'binding-b')
    expect(firstComment.id).not.toBe(secondComment.id)
    expect(firstComment.channel).toMatchObject({ thread: 'github:binding-a:7', address: { bindingId: 'binding-a' } })
    expect(firstComment.meta).toMatchObject({ bindingId: 'binding-a' })

    const pr = { number: 7, html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'carol' } }
    expect(ciTrigger(pr, 2, 'failed', 'binding-a').id).not.toBe(ciTrigger(pr, 2, 'failed', 'binding-b').id)
    expect(ciTrigger(pr, 2, 'failed', 'binding-a')).toMatchObject({ threads: [{ id: 'binding-a:7' }],
      channel: { thread: 'github:binding-a:7', address: { bindingId: 'binding-a' } }, meta: { bindingId: 'binding-a' } })
  })

  it('separates default-branch CI for two bindings with the same branch', () => {
    const first = branchCiTrigger('main', 'abc', 3, 'failed', 'https://github.com/acme/widgets/commit/abc', 'binding-a')
    const second = branchCiTrigger('main', 'abc', 3, 'failed', 'https://github.com/acme/widgets/commit/abc', 'binding-b')
    expect(first.threads[0]!.id).toBe('binding-a:ci:main')
    expect(second.threads[0]!.id).toBe('binding-b:ci:main')
    expect(first.id).not.toBe(second.id)
    expect(first.meta).toMatchObject({ bindingId: 'binding-a' })
  })
})
