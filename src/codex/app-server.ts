/** Read-only projection of Codex App Server RPCs. Transport is supplied by a Mac-side bridge. */
import { z } from 'zod'
import type { CodexReadBackend, CodexReadBatch, CodexThreadSnapshot } from './model.ts'

export interface CodexReadRpc {
  request(method: 'thread/read' | 'thread/turns/list', params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

const ThreadResponse = z.looseObject({ thread: z.looseObject({
  id: z.string(), name: z.string().nullish().optional(), updatedAt: z.number().nullish().optional(),
  status: z.looseObject({ type: z.string(), activeFlags: z.array(z.string()).nullish().optional() }).nullish().optional(),
}) })
const TurnsResponse = z.looseObject({ data: z.array(z.looseObject({
  id: z.string(), status: z.string(), items: z.array(z.unknown()).optional(),
})) })

function itemOf(value: unknown): { id?: string; type?: string; text?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  return { ...(typeof item.id === 'string' ? { id: item.id } : {}),
    ...(typeof item.type === 'string' ? { type: item.type } : {}),
    ...(typeof item.text === 'string' ? { text: item.text } : {}) }
}

/**
 * Calls only thread/read and thread/turns/list for explicitly supplied IDs. `statusSource` must be `sameHost` only when
 * this RPC transport is attached to the Codex process that owns the target live turns.
 */
export class CodexAppServerBackend implements CodexReadBackend {
  constructor(private readonly rpc: CodexReadRpc, private readonly statusSource: 'sameHost' | 'historyOnly' = 'historyOnly',
    private readonly now: () => Date = () => new Date()) {}

  async readThreads(threadIds: readonly string[], signal: AbortSignal): Promise<CodexReadBatch> {
    const results = await Promise.all(threadIds.map(async (id): Promise<{ id: string; snapshot: CodexThreadSnapshot } | { id: string; error: string }> => {
      try { return { id, snapshot: await this.readOne(id, signal) } }
      catch (error) { return { id, error: String(error).slice(0, 300) } }
    }))
    const threads: CodexThreadSnapshot[] = []
    const failures: { id: string; error: string }[] = []
    for (const result of results) {
      if ('error' in result) failures.push({ id: result.id, error: result.error })
      else threads.push(result.snapshot)
    }
    return { threads, failures }
  }

  private async readOne(id: string, signal: AbortSignal): Promise<CodexThreadSnapshot> {
    const read = ThreadResponse.parse(await this.rpc.request('thread/read', { threadId: id, includeTurns: false }, signal)).thread
    if (read.id !== id) throw new Error(`Codex returned a different thread ID for ${id}`)
    const response = TurnsResponse.parse(await this.rpc.request('thread/turns/list',
      { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'summary' }, signal))
    const turn = response.data[0]
    const items = (turn?.items ?? []).flatMap(value => { const item = itemOf(value); return item ? [item] : [] })
    const last = items.at(-1)
    const assistant = items.findLast(item => item.type === 'agentMessage' && item.text)
    const statusType = read.status?.type
    const status = statusType === 'active' || statusType === 'idle' || statusType === 'notLoaded' || statusType === 'systemError'
      ? statusType : 'notLoaded'
    const turnStatus = turn?.status
    const updatedAt = read.updatedAt === null || read.updatedAt === undefined ? undefined : new Date(read.updatedAt * 1000).toISOString()
    return {
      id, capturedAt: this.now().toISOString(), statusSource: this.statusSource,
      status: { type: status, ...(read.status?.activeFlags ? { activeFlags: read.status.activeFlags } : {}) },
      ...(read.name ? { name: read.name.slice(0, 200) } : {}), ...(updatedAt ? { updatedAt } : {}),
      ...(turn ? { latestTurn: { id: turn.id,
        status: turnStatus === 'inProgress' || turnStatus === 'completed' || turnStatus === 'failed' || turnStatus === 'interrupted'
          ? turnStatus : 'unknown',
        ...(last?.id ? { lastItemId: last.id.slice(0, 200) } : {}),
        ...(last?.type ? { lastItemType: last.type.slice(0, 100) } : {}),
        ...(assistant?.text ? { summary: assistant.text.slice(0, 500) } : {}),
      } } : {}),
    }
  }
}
