import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startCodexLocalServer, type CodexLocalServer, type LocalRpc } from '../src/codex/local.ts'
import { LOCAL_JS } from '../src/codex/local-ui.ts'

let server: CodexLocalServer | undefined
let directory: string | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function mockRpc() {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const connect = vi.fn(async (): Promise<LocalRpc> => ({
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/list') return { data: [
        { id: 'thread-a', name: 'Mac task', cwd: '/private/project', preview: 'private prompt', updatedAt: 1793523600 },
        { id: 'thread-a', name: 'duplicate' }, { id: 'other-thread', name: '<script>text</script>' },
      ], nextCursor: null }
      if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'active' },
        name: 'Private thread name' } }
      if (method === 'thread/turns/list') return { data: [{ id: `turn-${params.threadId}`, status: 'inProgress',
        items: [{ id: 'item-1', type: 'agentMessage', text: 'private message' }] }] }
      throw new Error('Unexpected method')
    }, close: vi.fn(),
  }))
  return { calls, connect }
}
async function start(connect: () => Promise<LocalRpc>) {
  directory = mkdtempSync(join(tmpdir(), 'codex-local-'))
  server = await startCodexLocalServer({ directory, port: 0, connect })
  return server
}
async function api(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${server!.url}/api/${path}`, { method,
    headers: { 'x-codex-local-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, value: await response.json() as Record<string, any> }
}

it('provides a loopback GUI, discovers stored IDs, and exports only allowlisted history', async () => {
  expect(() => new Function(LOCAL_JS)).not.toThrow()
  expect(LOCAL_JS).toContain('textContent')
  expect(LOCAL_JS).not.toContain('innerHTML')
  const rpc = mockRpc()
  await start(rpc.connect)
  const page = await fetch(server!.url)
  expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
  expect(await page.text()).toContain('Codex 线程观察')
  expect(statSync(directory!).mode & 0o077).toBe(0)

  const candidates = await api('candidates')
  expect(candidates.status).toBe(200)
  expect(candidates.value).toEqual([
    { id: 'thread-a', name: 'Mac task', cwd: '/private/project', updatedAt: '2026-11-01T09:00:00.000Z' },
    { id: 'other-thread', name: '<script>text</script>' },
  ])
  expect(JSON.stringify(candidates.value)).not.toContain('private prompt')
  expect(rpc.calls[0]).toMatchObject({ method: 'thread/list', params: { limit: 50 } })

  const list = { version: 1, tasks: [{ taskId: 'mac', threadId: 'thread-a', label: 'Mac task' }] }
  expect((await api('watchlist', 'POST', list)).status).toBe(200)
  expect(statSync(server!.watchlistPath).mode & 0o077).toBe(0)
  expect((await api('state')).value).toMatchObject({ tasks: list.tasks, snapshotReady: false })

  const exported = await api('export', 'POST')
  expect(exported.status).toBe(200)
  expect(exported.value).toMatchObject({ threads: 1, unavailable: 0,
    state: { observation: { tasks: [{ taskId: 'mac', threadId: 'thread-a', state: 'unknown', statusSource: 'historyOnly' }] } } })
  expect(rpc.calls.map(call => call.method)).toEqual(['thread/list', 'thread/read', 'thread/turns/list'])
  const raw = readFileSync(server!.snapshotPath, 'utf8')
  expect(statSync(server!.snapshotPath).mode & 0o077).toBe(0)
  expect(raw).toContain('thread-a')
  expect(raw).not.toMatch(/private message|Private thread name|other-thread/)

  expect((await api('watchlist', 'POST', { version: 1, tasks: [] })).status).toBe(200)
  expect(existsSync(server!.watchlistPath)).toBe(false)
  expect(existsSync(server!.snapshotPath)).toBe(false)
})

it('rejects cross-site requests and invalid mappings without changing private files', async () => {
  const rpc = mockRpc()
  await start(rpc.connect)
  const denied = await fetch(`${server!.url}/api/state`, { headers: { Origin: 'https://other.example', 'x-codex-local-request': '1' } })
  expect(denied.status).toBe(403)
  const missingHeader = await fetch(`${server!.url}/api/state`)
  expect(missingHeader.status).toBe(403)
  expect((await api('export', 'POST')).status).toBe(400)
  const invalid = await api('watchlist', 'POST', { version: 1, tasks: [
    { taskId: 'a', threadId: 'thread-a' }, { taskId: 'b', threadId: 'thread-a' },
  ] })
  expect(invalid.status).toBe(400)
  expect(existsSync(server!.watchlistPath)).toBe(false)
  expect(rpc.connect).not.toHaveBeenCalled()
})
