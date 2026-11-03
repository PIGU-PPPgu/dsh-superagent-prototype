import { expect, it, vi } from 'vitest'
import { listAllCodexThreads, readRecentCodexMessages, type CodexMonitorRpc } from '../src/codex/monitor-read.ts'

const signal = new AbortController().signal
const allSources = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact',
  'subAgentThreadSpawn', 'subAgentOther', 'unknown']

function rpcWith(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const rpc: CodexMonitorRpc = { request: async (method, params) => {
    calls.push({ method, params })
    return handler(method, params)
  } }
  return { rpc, calls }
}

it('enumerates active and archived pages with every source and preserves subagent parents', async () => {
  const { rpc, calls } = rpcWith((_method, params) => {
    if (params.archived === true) return { data: [{ id: 'archived', source: 'vscode', name: null, updatedAt: null }], nextCursor: null }
    if (!params.cursor) return { data: [
      { id: 'parent', source: 'appServer', name: 'Main', updatedAt: 1793523600 },
      { id: 'review', source: { subAgent: 'review' }, parentThreadId: 'parent' },
    ], nextCursor: 'active-page-2' }
    return { data: [
      { id: 'spawned', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } } },
      { id: 'compact', source: { subAgent: 'compact' } },
      { id: 'custom', source: { custom: 'other-client' } },
    ], nextCursor: null }
  })
  await expect(listAllCodexThreads(rpc, signal)).resolves.toEqual([
    { id: 'parent', name: 'Main', updatedAt: '2026-11-01T09:00:00.000Z', archived: false, sourceKind: 'appServer' },
    { id: 'review', archived: false, sourceKind: 'subAgentReview', parentThreadId: 'parent' },
    { id: 'spawned', archived: false, sourceKind: 'subAgentThreadSpawn', parentThreadId: 'parent' },
    { id: 'compact', archived: false, sourceKind: 'subAgentCompact' },
    { id: 'custom', archived: false, sourceKind: 'unknown' },
    { id: 'archived', archived: true, sourceKind: 'vscode' },
  ])
  expect(calls).toHaveLength(3)
  for (const call of calls) {
    expect(call.method).toBe('thread/list')
    expect(call.params).toMatchObject({ limit: 100, sortKey: 'updated_at', sortDirection: 'desc',
      sourceKinds: allSources, useStateDbOnly: true })
  }
  expect(calls[1]!.params).toMatchObject({ cursor: 'active-page-2', archived: false })
  expect(calls[2]!.params).toMatchObject({ archived: true })
  expect(calls[2]!.params).not.toHaveProperty('cursor')
})

it('rejects repeated thread cursors instead of looping or dropping history', async () => {
  const { rpc } = rpcWith(() => ({ data: [], nextCursor: 'same-cursor' }))
  await expect(listAllCodexThreads(rpc, signal)).rejects.toThrow('repeated cursor')
})

it('rejects a thread listing that exceeds the page bound', async () => {
  let page = 0
  const { rpc } = rpcWith(() => ({ data: [], nextCursor: `cursor-${++page}` }))
  await expect(listAllCodexThreads(rpc, signal)).rejects.toThrow('page limit')
  expect(page).toBe(1000)
})

it('reads backwards to sinceItemId and returns only chronological user/agent text', async () => {
  const { rpc, calls } = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-new', status: 'completed', items: [
      { id: 'raw', type: 'commandExecution', aggregatedOutput: 'must not leak' },
    ] }] }
    if (!params.cursor) return { data: [
      { turnId: 'turn-new', item: { id: 'command-new', type: 'commandExecution', aggregatedOutput: 'secret output' } },
      { turnId: 'turn-new', item: { id: 'answer-2', type: 'agentMessage', text: 'Second answer' } },
      { turnId: 'turn-new', item: { id: 'reasoning-new', type: 'reasoning', content: ['private reasoning'] } },
      { turnId: 'turn-new', item: { id: 'question-2', type: 'userMessage', content: [
        { type: 'text', text: 'Second ' }, { type: 'image', url: 'private-url' }, { type: 'text', text: 'question' },
      ] } },
    ], nextCursor: 'older-items' }
    return { data: [
      { turnId: 'turn-old', item: { id: 'answer-1', type: 'agentMessage', text: 'First answer' } },
      { turnId: 'turn-old', item: { id: 'question-1', type: 'userMessage', content: [{ type: 'text', text: 'First question' }] } },
      { turnId: 'turn-old', item: { id: 'cursor-item', type: 'agentMessage', text: 'Already delivered' } },
      { turnId: 'turn-old', item: { id: 'too-old', type: 'userMessage', content: [{ type: 'text', text: 'Must not return' }] } },
    ], nextCursor: null }
  })
  const result = await readRecentCodexMessages(rpc, 'thread-a', signal, { sinceItemId: 'cursor-item' })
  expect(result).toEqual({
    latestTurnId: 'turn-new', latestTurnStatus: 'completed', newestItemId: 'command-new',
    latestAssistantItemId: 'answer-2', latestAssistantTurnId: 'turn-new', complete: true,
    messages: [
      { id: 'question-1', turnId: 'turn-old', role: 'user', text: 'First question' },
      { id: 'answer-1', turnId: 'turn-old', role: 'assistant', text: 'First answer' },
      { id: 'question-2', turnId: 'turn-new', role: 'user', text: 'Second question' },
      { id: 'answer-2', turnId: 'turn-new', role: 'assistant', text: 'Second answer' },
    ],
  })
  expect(JSON.stringify(result)).not.toMatch(/secret output|private reasoning|private-url|Already delivered|Must not return/)
  expect(calls.map(call => call.method)).toEqual(['thread/turns/list', 'thread/items/list', 'thread/items/list'])
  expect(calls[0]!.params).toEqual({ threadId: 'thread-a', limit: 1, sortDirection: 'desc', itemsView: 'summary' })
  expect(calls[1]!.params).toEqual({ threadId: 'thread-a', limit: 100, sortDirection: 'desc' })
  expect(calls[2]!.params).toEqual({ threadId: 'thread-a', cursor: 'older-items', limit: 100, sortDirection: 'desc' })
})

it('caps a baseline at the newest 12 messages and reports it incomplete', async () => {
  const items = Array.from({ length: 13 }, (_, index) => ({
    turnId: 'turn-a', item: { id: `message-${13 - index}`, type: 'agentMessage', text: `Message ${13 - index}` },
  }))
  const { rpc, calls } = rpcWith(method => method === 'thread/turns/list' ? { data: [] } : { data: items, nextCursor: null })
  const result = await readRecentCodexMessages(rpc, 'thread-a', signal)
  expect(result.complete).toBe(false)
  expect(result.newestItemId).toBe('message-13')
  expect(result.messages).toHaveLength(12)
  expect(result.messages.map(message => message.id)).toEqual(Array.from({ length: 12 }, (_, index) => `message-${index + 2}`))
  expect(result).not.toHaveProperty('latestTurnId')
  expect(calls).toHaveLength(2)
})

it('marks a short baseline complete only after reaching history end', async () => {
  const { rpc } = rpcWith(method => method === 'thread/turns/list' ? { data: [] } : { data: [
    { turnId: 'turn-a', item: { id: 'answer', type: 'agentMessage', text: 'Answer' } },
    { turnId: 'turn-a', item: { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] } },
  ], nextCursor: null })
  await expect(readRecentCodexMessages(rpc, 'thread-a', signal)).resolves.toMatchObject({ complete: true,
    newestItemId: 'answer', messages: [{ id: 'question' }, { id: 'answer' }] })
})

it('reports a missing incremental anchor instead of treating old history as a complete delta', async () => {
  const { rpc } = rpcWith(method => method === 'thread/turns/list' ? { data: [] } : { data: [
    { turnId: 'turn-a', item: { id: 'answer', type: 'agentMessage', text: 'Answer' } },
  ], nextCursor: null })
  await expect(readRecentCodexMessages(rpc, 'thread-a', signal, { sinceItemId: 'missing' }))
    .resolves.toMatchObject({ complete: false, newestItemId: 'answer' })
})

it('reports incomplete when the anchor is the 1000th item', async () => {
  let page = 0
  const { rpc, calls } = rpcWith((method, params) => {
    if (method === 'thread/turns/list') return { data: [] }
    const current = page++
    return { data: Array.from({ length: 100 }, (_, index) => ({ turnId: 'turn-a', item: {
      id: current === 0 && index === 0 ? 'newest' : current === 9 && index === 99 ? 'anchor' : `item-${current}-${index}`,
      type: 'reasoning', content: ['hidden'],
    } })), nextCursor: current === 9 ? null : `page-${current + 1}` }
  })
  const result = await readRecentCodexMessages(rpc, 'thread-a', signal, { sinceItemId: 'anchor' })
  expect(result).toEqual({ newestItemId: 'newest', messages: [], complete: false })
  expect(calls.filter(call => call.method === 'thread/items/list')).toHaveLength(10)
  expect(calls.at(-1)!.params).toMatchObject({ limit: 100, cursor: 'page-9' })
})

it('rejects repeated item cursors and honors an already aborted signal', async () => {
  const request = vi.fn(async (method: string) => method === 'thread/turns/list' ? { data: [] }
    : { data: [], nextCursor: 'repeat' })
  const rpc: CodexMonitorRpc = { request: request as CodexMonitorRpc['request'] }
  await expect(readRecentCodexMessages(rpc, 'thread-a', signal)).rejects.toThrow('repeated cursor')
  const controller = new AbortController()
  controller.abort()
  await expect(readRecentCodexMessages(rpc, 'thread-a', controller.signal)).rejects.toThrow('cancelled')
  expect(request).toHaveBeenCalledTimes(3)
})
