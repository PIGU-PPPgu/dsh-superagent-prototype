import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { isCodexUserRequest, readCodexProjectContext } from '../src/codex/project-context.ts'
import type { CodexMonitorRpc } from '../src/codex/monitor-read.ts'
import { gitEnv } from './fixtures/git.ts'

const signal = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-project-context-'))
  roots.push(root)
  return root
}

function rpcWith(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const rpc: CodexMonitorRpc = {
    request: async (method, params) => handler(method, params)
  }
  return rpc
}

it('samples the actual tracked file when the conversation cwd is a repository subdirectory', async () => {
  const root = makeRoot(), cwd = join(root, 'package')
  mkdirSync(cwd)
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnv(), stdio: 'pipe' })
  git(['init'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'user.email', 'test@example.com'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first')
  git(['add', '.']); git(['commit', '-m', 'Initial'])
  const rpc = rpcWith(method => method === 'thread/turns/list' ? { data: [] } : { data: [
    { turnId: 'turn-a', item: { id: 'head-a', type: 'agentMessage', text: 'Current progress' } },
  ], nextCursor: null })
  const input = { threadId: 'thread-a', title: 'Package task', headItemId: 'head-a', cwd }
  const first = await readCodexProjectContext(rpc, input, signal)
  writeFileSync(join(cwd, 'tracked.txt'), 'second and longer')
  const second = await readCodexProjectContext(rpc, input, signal)
  expect(first.project.worktreeState).toMatch(/^[a-f0-9]{64}$/)
  expect(second.project.worktreeState).not.toBe(first.project.worktreeState)
  git(['update-index', '--chmod=+x', 'package/tracked.txt'])
  const stagedModeChange = await readCodexProjectContext(rpc, input, signal)
  expect(stagedModeChange.project.worktreeState).not.toBe(second.project.worktreeState)
})

it('reads full project context with git, documents and messages', async () => {
  const root = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init'], { cwd: root, env: gitEnv() })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, env: gitEnv() })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, env: gitEnv() })
  writeFileSync(join(root, 'README.md'), '# Test Project\n\nThis is a test.')
  writeFileSync(join(root, 'AGENTS.md'), 'Agent instructions here.')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test-pkg', description: 'A test package' }))
  execFileSync('git', ['add', '.'], { cwd: root, env: gitEnv() })
  execFileSync('git', ['commit', '-m', 'Initial'], { cwd: root, env: gitEnv() })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: gitEnv() }).toString().trim()
  writeFileSync(join(root, 'dirty.txt'), 'uncommitted')
  
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', status: 'completed' }] }
    if (method === 'thread/items/list' && params.sortDirection === 'desc') {
      return { data: [
        { turnId: 'turn-1', item: { id: 'msg-2', type: 'agentMessage', text: 'Answer' } },
        { turnId: 'turn-1', item: { id: 'msg-1', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] } }
      ], nextCursor: null }
    }
    if (method === 'thread/items/list' && params.sortDirection === 'asc') {
      return { data: [
        { turnId: 'turn-1', item: { id: 'msg-1', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] } }
      ], nextCursor: null }
    }
    return { data: [] }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a',
    title: 'Test Thread',
    headItemId: 'msg-2',
    cwd: root,
    repository: 'owner/repo'
  }, signal)
  
  expect(result.threadId).toBe('thread-a')
  expect(result.title).toBe('Test Thread')
  expect(result.headItemId).toBe('msg-2')
  expect(result.project.cwd).toBe(root)
  expect(result.project.root).toMatch(/codex-project-context-/)
  expect(result.project.repository).toBe('owner/repo')
  expect(result.project.name).toBe('test-pkg')
  expect(result.project.description).toBe('A test package')
  expect(result.project.branch).toBe('master')
  expect(result.project.gitHead).toBe(head)
  expect(result.project.dirty).toBeUndefined()
  expect(result.project.worktreeState).toMatch(/^[0-9a-f]{64}$/)
  expect(result.initialRequest).toEqual({ id: 'msg-1', turnId: 'turn-1', role: 'user', text: 'Question' })
  expect(result.messages).toEqual([
    { id: 'msg-1', turnId: 'turn-1', role: 'user', text: 'Question' },
    { id: 'msg-2', turnId: 'turn-1', role: 'assistant', text: 'Answer' }
  ])
  expect(result.coverage).toEqual({ initialRequestFound: true, recentComplete: true, gaps: ['worktree state is metadata-only'] })
  expect(result.documents).toHaveLength(2)
  expect(result.documents[0]).toMatchObject({ id: 'project:README.md', name: 'README.md', text: '# Test Project\n\nThis is a test.' })
  expect(result.documents[1]).toMatchObject({ id: 'project:AGENTS.md', name: 'AGENTS.md', text: 'Agent instructions here.' })
})

it('rejects when headItemId does not match newestItemId', async () => {
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-new', type: 'agentMessage', text: 'New' } }
    ], nextCursor: null }
  })
  
  await expect(readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-old', cwd: '/tmp'
  }, signal)).rejects.toThrow('snapshot is stale')
})

it('handles missing cwd with gaps', async () => {
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'userMessage', content: [{ type: 'text', text: 'Q' }] } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1'
  }, signal)
  
  expect(result.project).toEqual({})
  expect(result.coverage.gaps).toContain('cwd not provided')
  expect(result.documents).toEqual([])
})

it('handles relative cwd with gap', async () => {
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: 'relative/path'
  }, signal)
  
  expect(result.project.cwd).toBe('relative/path')
  expect(result.coverage.gaps).toContain('cwd is not absolute')
})

it('handles non-existent cwd', async () => {
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: '/nonexistent/path'
  }, signal)
  
  expect(result.coverage.gaps).toContain('cwd does not exist')
})

it('handles non-git directory', async () => {
  const root = makeRoot()
  writeFileSync(join(root, 'README.md'), 'Standalone project readme')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'standalone', description: 'No Git required', scripts: { ignored: 'true' } }))
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  
  expect(result.project.root).toBeUndefined()
  expect(result.project.branch).toBeUndefined()
  expect(result.project.gitHead).toBeUndefined()
  expect(result.project.name).toBe('standalone')
  expect(result.project.description).toBe('No Git required')
  expect(result.project).not.toHaveProperty('scripts')
  expect(result.coverage.gaps).toContain('git metadata unavailable')
  expect(result.documents).toEqual([expect.objectContaining({
    id: 'project:README.md', text: 'Standalone project readme', digest: expect.stringMatching(/^[0-9a-f]{64}$/),
  })])
})

it('filters DSH coordination messages from initial request', async () => {
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [] }
    if (params.sortDirection === 'desc') return { data: [
      { turnId: 'turn-1', item: { id: 'msg-2', type: 'agentMessage', text: 'Answer' } }
    ], nextCursor: null }
    return { data: [
      { turnId: 'turn-1', item: { id: 'auto', type: 'userMessage', content: [{ type: 'text', text: 'DSH Superagent coordination for this existing conversation. Test' }] } },
      { turnId: 'turn-1', item: { id: 'real', type: 'userMessage', content: [{ type: 'text', text: 'Real question' }] } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-2'
  }, signal)
  
  expect(result.initialRequest?.id).toBe('real')
  expect(result.initialRequest?.text).toBe('Real question')
})

it('truncates long documents and messages', async () => {
  const root = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init'], { cwd: root, env: gitEnv() })
  writeFileSync(join(root, 'README.md'), 'x'.repeat(3000))
  
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [] }
    if (params.sortDirection === 'desc') return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'y'.repeat(1500) } }
    ], nextCursor: null }
    return { data: [], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  
  expect(result.documents[0]?.text.length).toBe(2500)
  expect(result.documents[0]?.chars).toBe(3000)
  expect(result.documents[0]?.digest).toMatch(/^[0-9a-f]{64}$/)
  expect(result.messages[0]?.text.length).toBe(1200)
  expect(result.messages[0]?.chars).toBe(1500)
})

it('reports gap when initial request read fails', async () => {
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [] }
    if (params.sortDirection === 'desc') return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'Answer' } }
    ], nextCursor: null }
    throw new Error('RPC error')
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1'
  }, signal)
  
  expect(result.coverage.gaps).toContain('initial request read failed')
  expect(result.initialRequest).toBeUndefined()
})

it('throws when recent messages read fails', async () => {
  const rpc = rpcWith(() => {
    throw new Error('RPC failed')
  })
  
  await expect(readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1'
  }, signal)).rejects.toThrow('RPC failed')
})

it('respects abort signal', async () => {
  const controller = new AbortController()
  controller.abort()
  
  const rpc = rpcWith(() => ({ data: [] }))
  
  await expect(readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1'
  }, controller.signal)).rejects.toThrow('cancelled')
})

it('returns a stable metadata-only worktree state for a clean worktree', async () => {
  const root = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init'], { cwd: root, env: gitEnv() })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, env: gitEnv() })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, env: gitEnv() })
  writeFileSync(join(root, 'file.txt'), 'content')
  execFileSync('git', ['add', '.'], { cwd: root, env: gitEnv() })
  execFileSync('git', ['commit', '-m', 'Initial'], { cwd: root, env: gitEnv() })
  
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  
  expect(result.project.dirty).toBeUndefined()
  expect(result.project.worktreeState).toMatch(/^[0-9a-f]{64}$/)
  expect(result.coverage.gaps).toContain('worktree state is metadata-only')
})

it('reads cwd from thread/list projection', async () => {
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/list') return { data: params.archived === false ? [
      { id: 't1', cwd: '/test/path', name: 'Thread 1', source: 'cli', updatedAt: 1700000000 }
    ] : [], nextCursor: null }
    return { data: [] }
  })
  
  const { listAllCodexThreads } = await import('../src/codex/monitor-read.ts')
  const threads = await listAllCodexThreads(rpc, signal)
  expect(threads[0]?.cwd).toBe('/test/path')
})

it('skips symlinked documents', async () => {
  const root = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init'], { cwd: root, env: gitEnv() })
  const outside = makeRoot()
  writeFileSync(join(outside, 'README.md'), 'outside content')
  const { symlinkSync } = await import('node:fs')
  symlinkSync(join(outside, 'README.md'), join(root, 'README.md'))
  
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  
  expect(result.documents).toEqual([])
})

it('truncates oversized documents', async () => {
  const root = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init'], { cwd: root, env: gitEnv() })
  writeFileSync(join(root, 'README.md'), 'x'.repeat(10000))
  
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  
  expect(result.documents).toHaveLength(1)
  expect(result.documents[0]?.text.length).toBe(2500)
  expect(result.documents[0]?.chars).toBe(10000)
  expect(result.documents[0]?.digest).toMatch(/^[0-9a-f]{64}$/)
})

it('handles missing README and AGENTS gracefully', async () => {
  const root = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init'], { cwd: root, env: gitEnv() })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'only-package' }))
  
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  
  expect(result.project.name).toBe('only-package')
  expect(result.documents).toEqual([])
  expect(result.coverage.gaps).toContain('initial request not found')
})

it('stops initial request pagination when empty pages keep returning new cursors', async () => {
  let pages = 0
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [] }
    if (params.sortDirection === 'desc') return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
    pages++
    return { data: [], nextCursor: `empty-${pages}` }
  })
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1'
  }, signal)
  expect(pages).toBe(20)
  expect(result.initialRequest).toBeUndefined()
  expect(result.coverage.initialRequestFound).toBe(false)
  expect(result.coverage.gaps).toContain('initial request history is incomplete')
})

it('rejects symlinked documents even when target has same size', async () => {
  const root = makeRoot(), outside = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('/usr/bin/git', ['init'], { cwd: root, env: gitEnv() })
  writeFileSync(join(outside, 'secret.md'), 'secret')
  symlinkSync(join(outside, 'secret.md'), join(root, 'README.md'))
  const rpc = rpcWith((method) => method === 'thread/turns/list' ? { data: [] } : { data: [
    { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
  ], nextCursor: null })
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  expect(result.documents).toEqual([])
  expect(JSON.stringify(result)).not.toContain('secret')
})

it('rejects documents when root is replaced by a symlink', async () => {
  const root = makeRoot(), outside = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('/usr/bin/git', ['init'], { cwd: root, env: gitEnv() })
  writeFileSync(join(outside, 'README.md'), 'external')
  const rootPath = root
  rmSync(rootPath, { recursive: true })
  symlinkSync(outside, rootPath)
  const rpc = rpcWith((method) => method === 'thread/turns/list' ? { data: [] } : { data: [
    { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
  ], nextCursor: null })
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: rootPath
  }, signal)
  expect(result.coverage.gaps).toContain('cwd is not a regular directory')
  expect(result.documents).toEqual([])
})

it('uses the trusted git binary instead of a PATH script in the project', async () => {
  const root = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('/usr/bin/git', ['init'], { cwd: root, env: gitEnv() })
  const marker = join(root, 'git-script-ran')
  writeFileSync(join(root, 'git'), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = root
  try {
    const rpc = rpcWith((method) => {
      if (method === 'thread/turns/list') return { data: [] }
      return { data: [
        { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
      ], nextCursor: null }
    })
    const result = await readCodexProjectContext(rpc, {
      threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
    }, signal)
    expect(result.project.root).toMatch(/codex-project-context-/)
    const { statSync } = await import('node:fs')
    expect(() => statSync(marker)).toThrow()
  } finally { process.env.PATH = previousPath }
})

it('rejects a Git worktree outside the canonical cwd', async () => {
  const root = makeRoot()
  const outside = makeRoot()
  const { execFileSync } = await import('node:child_process')
  execFileSync('/usr/bin/git', ['init'], { cwd: root, env: gitEnv() })
  execFileSync('/usr/bin/git', ['config', 'core.worktree', outside], { cwd: root, env: gitEnv() })
  writeFileSync(join(outside, 'README.md'), 'unrelated project secret')
  const rpc = rpcWith((method) => {
    if (method === 'thread/turns/list') return { data: [] }
    return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
  })
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  expect(result.project.root).toBeUndefined()
  expect(result.coverage.gaps).toContain('git root does not contain cwd')
  expect(result.documents).toEqual([])
  expect(JSON.stringify(result)).not.toContain('unrelated project secret')
})

it('uses the same user request filter for initial and recent messages', async () => {
  for (const text of [
    ' DSH Superagent coordination for this existing conversation. Continue ',
    '\n# AGENTS.md instructions\n{}', '<environment_context>{}</environment_context>',
    '<permissions instructions>{}</permissions instructions>', '<apps_instructions>{}</apps_instructions>',
    '<tools>{}</tools>', '<heartbeat>{}</heartbeat>',
  ]) expect(isCodexUserRequest(text)).toBe(false)
  expect(isCodexUserRequest('  Fix the failing test  ')).toBe(true)
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [] }
    if (params.sortDirection === 'desc') return { data: [
      { turnId: 'turn-2', item: { id: 'recent-injected', type: 'userMessage', content: [{ type: 'text', text: '<heartbeat>{}</heartbeat>' }] } },
      { turnId: 'turn-1', item: { id: 'recent-real', type: 'userMessage', content: [{ type: 'text', text: 'Real request' }] } }
    ], nextCursor: null }
    return { data: [
      { turnId: 'turn-1', item: { id: 'initial-injected', type: 'userMessage', content: [{ type: 'text', text: '<environment_context>{}</environment_context>' }] } },
      { turnId: 'turn-1', item: { id: 'recent-real', type: 'userMessage', content: [{ type: 'text', text: 'Real request' }] } }
    ], nextCursor: null }
  })
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'recent-injected'
  }, signal)
  expect(result.initialRequest?.id).toBe('recent-real')
  expect(result.messages.map(message => message.id)).toEqual(['recent-real'])
})

it('rejects a FIFO without blocking and honors cancellation during file reads', async () => {
  const root = makeRoot()
  execFileSync('/usr/bin/git', ['init'], { cwd: root, env: gitEnv() })
  execFileSync('mkfifo', ['README.md'], { cwd: root })
  const rpc = rpcWith((method) => method === 'thread/turns/list' ? { data: [] } : { data: [
    { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
  ], nextCursor: null })
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  expect(result.documents).toEqual([])
  const controller = new AbortController()
  controller.abort()
  await expect(readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, controller.signal)).rejects.toThrow('cancelled')
})

it('changes the document digest when an equally long tail changes', async () => {
  const root = makeRoot()
  execFileSync('/usr/bin/git', ['init'], { cwd: root, env: gitEnv() })
  writeFileSync(join(root, 'README.md'), 'x'.repeat(2500) + 'tail-a')
  const rpc = rpcWith((method) => method === 'thread/turns/list' ? { data: [] } : { data: [
    { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
  ], nextCursor: null })
  const input = { threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root }
  const first = await readCodexProjectContext(rpc, input, signal)
  writeFileSync(join(root, 'README.md'), 'x'.repeat(2500) + 'tail-b')
  const second = await readCodexProjectContext(rpc, input, signal)
  expect(first.documents[0]?.text).toBe(second.documents[0]?.text)
  expect(first.documents[0]?.chars).toBe(second.documents[0]?.chars)
  expect(first.documents[0]?.digest).not.toBe(second.documents[0]?.digest)
})

it('does not execute a configured clean filter while reading project context', async () => {
  const root = makeRoot()
  execFileSync('/usr/bin/git', ['init'], { cwd: root, env: gitEnv() })
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: root, env: gitEnv() })
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: root, env: gitEnv() })
  const marker = join(root, 'filter-ran')
  writeFileSync(join(root, 'filter.sh'), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 })
  execFileSync('/usr/bin/git', ['config', 'filter.fixture.clean', `${join(root, 'filter.sh')}`], { cwd: root, env: gitEnv() })
  execFileSync('/usr/bin/git', ['config', 'filter.fixture.required', 'true'], { cwd: root, env: gitEnv() })
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=fixture\n')
  writeFileSync(join(root, 'tracked.txt'), 'original\n')
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: root, env: gitEnv() })
  execFileSync('/usr/bin/git', ['commit', '-m', 'Initial'], { cwd: root, env: gitEnv() })
  rmSync(marker, { force: true })
  writeFileSync(join(root, 'tracked.txt'), 'changed in the worktree\n')
  const rpc = rpcWith((method) => method === 'thread/turns/list' ? { data: [] } : { data: [
    { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
  ], nextCursor: null })
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1', cwd: root
  }, signal)
  expect(result.project.gitHead).toMatch(/^[0-9a-f]{40}$/)
  expect(result.project.dirty).toBeUndefined()
  expect(result.project.worktreeState).toMatch(/^[0-9a-f]{64}$/)
  expect(result.coverage.gaps).toContain('worktree state is metadata-only')
  expect(() => statSync(marker)).toThrow()
})

it('handles initial request pagination', async () => {
  let pageCount = 0
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [] }
    if (params.sortDirection === 'desc') return { data: [
      { turnId: 'turn-1', item: { id: 'msg-3', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
    // Ascending for initial request
    pageCount++
    if (pageCount === 1) return { data: Array.from({ length: 100 }, (_, i) => ({
      turnId: 'turn-1', item: { id: `auto-${i}`, type: 'userMessage', 
        content: [{ type: 'text', text: 'DSH Superagent coordination for this existing conversation.' }] }
    })), nextCursor: 'page-2' }
    return { data: [
      { turnId: 'turn-1', item: { id: 'real', type: 'userMessage', content: [{ type: 'text', text: 'Real request' }] } }
    ], nextCursor: null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-3'
  }, signal)
  
  expect(result.initialRequest?.id).toBe('real')
  expect(result.initialRequest?.text).toBe('Real request')
})

it('handles initial request at item limit', async () => {
  let itemCount = 0
  const rpc = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [] }
    if (params.sortDirection === 'desc') return { data: [
      { turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'A' } }
    ], nextCursor: null }
    // Ascending - only auto messages
    itemCount += 100
    return { data: Array.from({ length: 100 }, (_, i) => ({
      turnId: 'turn-1', item: { id: `auto-${itemCount + i}`, type: 'userMessage',
        content: [{ type: 'text', text: 'DSH Superagent coordination for this existing conversation.' }] }
    })), nextCursor: itemCount < 500 ? `page-${itemCount}` : null }
  })
  
  const result = await readCodexProjectContext(rpc, {
    threadId: 'thread-a', title: 'Thread', headItemId: 'msg-1'
  }, signal)
  
  expect(result.initialRequest).toBeUndefined()
  expect(result.coverage.gaps).toContain('initial request not found')
})
