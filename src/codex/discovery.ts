/** Local-only discovery of stored Codex thread IDs for the operator's allowlist editor. */
import { z } from 'zod'
import { CodexIdSchema } from './model.ts'

const Candidate = z.looseObject({
  id: CodexIdSchema,
  name: z.string().max(200).nullish().optional(),
  cwd: z.string().max(500).nullish().optional(),
  updatedAt: z.number().finite().nonnegative().nullish().optional(),
})
const ListResponse = z.looseObject({ data: z.array(z.unknown()).max(50), nextCursor: z.string().nullish().optional() })
export type CodexCandidate = { id: string; name?: string; cwd?: string; updatedAt?: string }
export interface CodexDiscoveryRpc {
  request(method: 'thread/list', params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

/** Read one bounded page. Names and paths stay in the loopback GUI; they never enter a DSH tool response. */
export async function discoverCodexThreads(rpc: CodexDiscoveryRpc, signal: AbortSignal): Promise<CodexCandidate[]> {
  const response = ListResponse.parse(await rpc.request('thread/list', {
    limit: 50, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
  }, signal))
  const seen = new Set<string>()
  return response.data.flatMap(value => {
    const parsed = Candidate.safeParse(value)
    if (!parsed.success || seen.has(parsed.data.id)) return []
    seen.add(parsed.data.id)
    const { id, name, cwd, updatedAt } = parsed.data
    const date = updatedAt === null || updatedAt === undefined ? undefined : new Date(updatedAt * 1000)
    return [{ id, ...(name ? { name } : {}), ...(cwd ? { cwd } : {}),
      ...(date && Number.isFinite(date.valueOf()) ? { updatedAt: date.toISOString() } : {}) }]
  })
}
