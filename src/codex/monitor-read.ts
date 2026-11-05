/** Bounded, read-only Codex thread discovery and message history projections. */
import { z } from 'zod'

export interface MonitoredCodexThread {
  id: string
  cwd?: string
  name?: string
  updatedAt?: string
  archived: boolean
  sourceKind: string
  parentThreadId?: string
  /** Canonical owner/name only when the stored Git origin is a GitHub.com repository. */
  repository?: string
}

export interface CodexMonitorRpc {
  request(method: 'thread/list' | 'thread/turns/list' | 'thread/items/list',
    params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

export interface CodexRecentMessagesOptions {
  /** Return only items newer than this persisted item ID. */
  sinceItemId?: string
}

const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact',
  'subAgentThreadSpawn', 'subAgentOther', 'unknown'] as const
const PAGE_SIZE = 100
const MAX_THREAD_PAGES = 1000
const MAX_ITEMS = 1000
const MAX_MESSAGES = 12

const ListPage = z.looseObject({
  data: z.array(z.unknown()).max(PAGE_SIZE),
  nextCursor: z.string().nullish().optional(),
})
const ListedThread = z.looseObject({
  id: z.string().min(1),
  cwd: z.string().nullish().optional(),
  name: z.string().nullish().optional(),
  updatedAt: z.number().finite().nonnegative().nullish().optional(),
  source: z.unknown(),
  parentThreadId: z.string().nullish().optional(),
})
const TurnPage = z.looseObject({
  data: z.array(z.looseObject({ id: z.string(), status: z.string() })).max(1),
})

/** Latest persisted turn metadata; this is not the Desktop process's live turn state. */
export async function readLatestCodexTurn(rpc: CodexMonitorRpc, threadId: string, signal: AbortSignal):
  Promise<{ id: string; status: string } | undefined> {
  checkCancelled(signal)
  const page = TurnPage.parse(await rpc.request('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary',
  }, signal))
  return page.data[0]
}
const ItemEntry = z.looseObject({
  turnId: z.string(),
  item: z.looseObject({
    id: z.string(),
    type: z.string(),
    text: z.string().optional(),
    content: z.unknown().optional(),
  }),
})

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Codex read cancelled')
}

function sourceKind(source: unknown): string {
  if (typeof source === 'string') return SOURCE_KINDS.includes(source as typeof SOURCE_KINDS[number]) ? source : 'unknown'
  if (!source || typeof source !== 'object') return 'unknown'
  if ('subAgent' in source) {
    const subAgent = source.subAgent
    if (subAgent === 'review') return 'subAgentReview'
    if (subAgent === 'compact') return 'subAgentCompact'
    if (subAgent && typeof subAgent === 'object' && 'thread_spawn' in subAgent) return 'subAgentThreadSpawn'
    return 'subAgentOther'
  }
  return 'unknown'
}

function sourceParent(source: unknown): string | undefined {
  if (!source || typeof source !== 'object' || !('subAgent' in source)) return undefined
  const subAgent = source.subAgent
  if (!subAgent || typeof subAgent !== 'object' || !('thread_spawn' in subAgent)) return undefined
  const spawn = subAgent.thread_spawn
  if (!spawn || typeof spawn !== 'object' || !('parent_thread_id' in spawn)) return undefined
  return typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : undefined
}

function threadProjection(value: unknown, archived: boolean): MonitoredCodexThread {
  const thread = ListedThread.parse(value)
  const parentThreadId = thread.parentThreadId ?? sourceParent(thread.source)
  const updatedAt = thread.updatedAt === null || thread.updatedAt === undefined
    ? undefined : new Date(thread.updatedAt * 1000).toISOString()
  return {
    id: thread.id,
    ...(thread.cwd ? { cwd: thread.cwd } : {}),
    ...(thread.name ? { name: thread.name } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    archived,
    sourceKind: sourceKind(thread.source),
    ...(parentThreadId ? { parentThreadId } : {}),
  }
}

async function listThreadPages(rpc: CodexMonitorRpc, archived: boolean, signal: AbortSignal): Promise<MonitoredCodexThread[]> {
  const threads: MonitoredCodexThread[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    checkCancelled(signal)
    const response = ListPage.parse(await rpc.request('thread/list', {
      ...(cursor ? { cursor } : {}),
      limit: PAGE_SIZE,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: [...SOURCE_KINDS],
      archived,
      useStateDbOnly: true,
    }, signal))
    threads.push(...response.data.map(value => threadProjection(value, archived)))
    if (!response.nextCursor) return threads
    if (cursors.has(response.nextCursor)) throw new Error('Codex thread list returned a repeated cursor')
    cursors.add(response.nextCursor)
    cursor = response.nextCursor
  }
  throw new Error('Codex thread list exceeded the page limit')
}

/** Enumerates both archive states without rollout repair or write requests. */
export async function listAllCodexThreads(rpc: CodexMonitorRpc, signal: AbortSignal): Promise<MonitoredCodexThread[]> {
  const threads = [...await listThreadPages(rpc, false, signal), ...await listThreadPages(rpc, true, signal)]
  const ids = new Set<string>()
  for (const thread of threads) {
    if (ids.has(thread.id)) throw new Error(`Codex thread list returned duplicate thread ${thread.id}`)
    ids.add(thread.id)
  }
  return threads
}

/**
 * Reads newest items first, then returns at most 12 user/agent messages in chronological order.
 * `complete` is true only when the requested anchor or history end was reached below both limits.
 */
export async function readRecentCodexMessages(rpc: CodexMonitorRpc, threadId: string, signal: AbortSignal,
  options: CodexRecentMessagesOptions = {}): Promise<{
    latestTurnId?: string
    latestTurnStatus?: string
    latestAssistantItemId?: string
    latestAssistantTurnId?: string
    newestItemId?: string
    messages: { id: string; turnId: string; role: 'user' | 'assistant'; text: string }[]
    complete: boolean
  }> {
  checkCancelled(signal)
  const turns = await readLatestCodexTurn(rpc, threadId, signal)

  const messages: { id: string; turnId: string; role: 'user' | 'assistant'; text: string }[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let newestItemId: string | undefined
  let itemCount = 0
  let reachedBoundary = false

  while (itemCount < MAX_ITEMS && messages.length < MAX_MESSAGES) {
    checkCancelled(signal)
    const limit = Math.min(PAGE_SIZE, MAX_ITEMS - itemCount)
    const response = ListPage.parse(await rpc.request('thread/items/list', {
      threadId, ...(cursor ? { cursor } : {}), limit, sortDirection: 'desc',
    }, signal))
    for (const value of response.data) {
      const { turnId, item } = ItemEntry.parse(value)
      newestItemId ??= item.id
      itemCount++
      if (item.id === options.sinceItemId) { reachedBoundary = true; break }
      if (item.type === 'userMessage') {
        const content = z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).parse(item.content)
        const text = content.flatMap(part => part.type === 'text'
          ? [z.string().parse(part.text)] : []).join('')
        messages.push({ id: item.id, turnId, role: 'user', text })
      } else if (item.type === 'agentMessage') {
        messages.push({ id: item.id, turnId, role: 'assistant', text: z.string().parse(item.text) })
      }
      if (messages.length === MAX_MESSAGES) break
    }
    const nextCursor = response.nextCursor
    if (!nextCursor) { reachedBoundary ||= options.sinceItemId === undefined; break }
    if (reachedBoundary || messages.length === MAX_MESSAGES || itemCount === MAX_ITEMS) break
    if (cursors.has(nextCursor)) throw new Error('Codex item list returned a repeated cursor')
    cursors.add(nextCursor)
    cursor = nextCursor
  }

  messages.reverse()
  const latestAssistant = [...messages].reverse().find(message => message.role === 'assistant')
  const complete = reachedBoundary && itemCount < MAX_ITEMS && messages.length < MAX_MESSAGES
  return {
    ...(turns ? { latestTurnId: turns.id, latestTurnStatus: turns.status } : {}),
    ...(latestAssistant ? { latestAssistantItemId: latestAssistant.id, latestAssistantTurnId: latestAssistant.turnId } : {}),
    ...(newestItemId ?? options.sinceItemId ? { newestItemId: newestItemId ?? options.sinceItemId } : {}),
    messages,
    complete,
  }
}
