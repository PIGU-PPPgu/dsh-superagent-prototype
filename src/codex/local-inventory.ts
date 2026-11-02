/** Read-only discovery of local Codex rollout files joined with the Codex state database. */
import { DatabaseSync } from 'node:sqlite'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { MonitoredCodexThread } from './monitor-read.ts'

// Codex names a rollout file `rollout-<time>-<uuid>.jsonl`, optionally zstd compressed as `.jsonl.zst`.
// The UUID in the name is the thread ID.
const ROLLOUT = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i
const ROLLOUT_DIRECTORIES = ['sessions', 'archived_sessions'] as const
const MAX_DEPTH = 8
const MAX_FILES = 200_000
const QUERY_CHUNK = 400
const MAX_NAME = 200

interface RolloutFile {
  id: string
  path: string
  archived: boolean
  mtimeMs: number
}

interface ThreadRow {
  name?: string
  source?: string
  updatedAt?: number
  parentThreadId?: string
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Codex local inventory cancelled')
}

const noFile = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error
  && (error as { code?: string }).code === 'ENOENT'

/** Walks one rollout directory. Symlinked directories and files are never followed. */
async function collectRollouts(directory: string, archived: boolean, depth: number, out: RolloutFile[],
  signal: AbortSignal): Promise<void> {
  if (depth > MAX_DEPTH) throw new Error('Codex rollout directory exceeded the depth limit')
  if (out.length >= MAX_FILES) throw new Error('Codex rollout inventory exceeded the file limit')
  checkCancelled(signal)
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (noFile(error)) return; throw error }
  for (const entry of entries) {
    checkCancelled(signal)
    if (entry.isSymbolicLink()) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await collectRollouts(path, archived, depth + 1, out, signal); continue }
    if (!entry.isFile()) continue
    const match = ROLLOUT.exec(entry.name)
    if (!match) continue
    const info = await lstat(path)
    if (out.length >= MAX_FILES) throw new Error('Codex rollout inventory exceeded the file limit')
    out.push({ id: match[1]!.toLowerCase(), path, archived, mtimeMs: info.mtimeMs })
  }
}

/** Enumerates the rollout files that exist on disk under the given Codex home. */
async function listRolloutFiles(codexHome: string, signal: AbortSignal): Promise<RolloutFile[]> {
  let base: string
  try { base = await realpath(codexHome) }
  catch { throw new Error('Codex home directory is unavailable') }
  const files: RolloutFile[] = []
  for (const name of ROLLOUT_DIRECTORIES) {
    checkCancelled(signal)
    const directory = join(base, name)
    let info
    try { info = await lstat(directory) } catch (error) { if (noFile(error)) continue; throw error }
    // A symlinked root may point outside the Codex home; fail instead of claiming a partial inventory.
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Codex rollout directory is unavailable or unsafe')
    await collectRollouts(directory, name === 'archived_sessions', 0, files, signal)
  }
  // Every candidate must resolve inside the Codex home. The check runs in small batches so a large
  // session tree cannot exhaust the file descriptor limit.
  const contained: RolloutFile[] = []
  for (let index = 0; index < files.length; index += 100) {
    const batch = files.slice(index, index + 100)
    const resolved = await Promise.all(batch.map(async file => {
      try { const real = await realpath(file.path); return real.startsWith(base + '/') ? file : undefined }
      catch { return undefined }
    }))
    for (const file of resolved) if (file) contained.push(file)
  }
  return contained.filter((file): file is RolloutFile => file !== undefined)
}

/** Normalizes a Codex `source` column into the monitored source kind and parent thread. */
function normalizeSource(source: string | undefined): { sourceKind: string, parentThreadId?: string } {
  if (!source) return { sourceKind: 'unknown' }
  if (source === 'cli' || source === 'vscode' || source === 'exec' || source === 'appServer') {
    return { sourceKind: source }
  }
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { return { sourceKind: 'unknown' } }
  if (!parsed || typeof parsed !== 'object') return { sourceKind: 'unknown' }
  const record = parsed as Record<string, unknown>
  const subAgent = record.subAgent ?? record.subagent
  if (typeof subAgent === 'string') {
    if (subAgent === 'review') return { sourceKind: 'subAgentReview' }
    if (subAgent === 'compact') return { sourceKind: 'subAgentCompact' }
    return { sourceKind: 'subAgentOther' }
  }
  if (!subAgent || typeof subAgent !== 'object') return { sourceKind: 'unknown' }
  const spawn = (subAgent as Record<string, unknown>).thread_spawn
  if (!spawn || typeof spawn !== 'object') return { sourceKind: 'subAgentOther' }
  const parent = (spawn as Record<string, unknown>).parent_thread_id
  return { sourceKind: 'subAgentThreadSpawn', ...(typeof parent === 'string' ? { parentThreadId: parent } : {}) }
}

function tableColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('pragma table_info(threads)').all() as { name?: unknown }[]
  return new Set(rows.map(row => typeof row.name === 'string' ? row.name : ''))
}

/** Reads thread metadata for the given IDs. A missing or damaged schema fails loudly. */
function readThreadRows(db: DatabaseSync, ids: string[], hasParent: boolean): Map<string, ThreadRow> {
  const rows = new Map<string, ThreadRow>()
  for (let index = 0; index < ids.length; index += QUERY_CHUNK) {
    const chunk = ids.slice(index, index + QUERY_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const sql = `select id, name, title, source, updated_at${hasParent ? ', attached_thread_parent_id' : ''}
      from threads where id in (${placeholders})`
    for (const row of db.prepare(sql).all(...chunk) as Record<string, unknown>[]) {
      const id = typeof row.id === 'string' ? row.id : undefined
      if (!id) continue
      const name = [row.name, row.title].find(value => typeof value === 'string' && value.trim().length > 0)
      const parent = typeof row.attached_thread_parent_id === 'string' ? row.attached_thread_parent_id : undefined
      rows.set(id, {
        ...(typeof name === 'string' ? { name: name.trim().slice(0, MAX_NAME) } : {}),
        ...(typeof row.source === 'string' ? { source: row.source } : {}),
        ...(typeof row.updated_at === 'number' && Number.isFinite(row.updated_at) && row.updated_at > 0
          ? { updatedAt: row.updated_at } : {}),
        ...(parent ? { parentThreadId: parent } : {}),
      })
    }
  }
  return rows
}

/** Opens the Codex state database read-only and joins rollout files to their metadata. */
function openStateDatabase(path: string, ids: string[]): Map<string, ThreadRow> {
  let db: DatabaseSync
  try { db = new DatabaseSync(path, { readOnly: true }) }
  catch { throw new Error('Codex state database is unavailable or unreadable') }
  try {
    let tables: { name?: unknown }[]
    try { tables = db.prepare("select name from sqlite_master where type = 'table'").all() as { name?: unknown }[] }
    catch { throw new Error('Codex state database is unreadable or damaged') }
    if (!tables.some(table => table.name === 'threads')) {
      throw new Error('Codex state database does not contain the threads table')
    }
    const columns = tableColumns(db)
    for (const required of ['id', 'source', 'updated_at']) {
      if (!columns.has(required)) throw new Error(`Codex state database is missing the threads.${required} column`)
    }
    return readThreadRows(db, ids, columns.has('attached_thread_parent_id'))
  } finally { db.close() }
}

/**
 * Lists the Codex threads that are stored on this machine.
 *
 * Rollout files under `<codexHome>/sessions` and `<codexHome>/archived_sessions` are enumerated without
 * reading their content. Metadata comes from `<codexHome>/state_5.sqlite`, opened read-only. Threads without
 * a database row keep `sourceKind: 'unknown'` and use the file mtime as `updatedAt`.
 */
export async function listLocalCodexInventory(codexHome: string, signal: AbortSignal): Promise<MonitoredCodexThread[]> {
  checkCancelled(signal)
  const files = await listRolloutFiles(codexHome, signal)
  checkCancelled(signal)
  const ids = [...new Set(files.map(file => file.id))]
  // The state database is the only source of names, sources, and update times. Without it the result is
  // not a full inventory, so an unreadable or damaged database is an error instead of a partial list.
  const metadata = openStateDatabase(join(codexHome, 'state_5.sqlite'), ids)

  // The same rollout ID can appear in both directories. It stays one thread and the archive wins.
  const merged = new Map<string, RolloutFile>()
  for (const file of files) {
    const existing = merged.get(file.id)
    if (!existing) { merged.set(file.id, file); continue }
    merged.set(file.id, {
      ...file,
      archived: existing.archived || file.archived,
      mtimeMs: Math.max(existing.mtimeMs, file.mtimeMs),
    })
  }

  return [...merged.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(file => {
      const row = metadata.get(file.id)
      const source = normalizeSource(row?.source)
      // A live rollout can advance before Codex refreshes its metadata index.
      const updatedAt = new Date(Math.max(row?.updatedAt ? row.updatedAt * 1000 : 0, file.mtimeMs)).toISOString()
      const parentThreadId = row?.parentThreadId ?? source.parentThreadId
      return {
        id: file.id,
        ...(row?.name ? { name: row.name } : {}),
        updatedAt,
        archived: file.archived,
        sourceKind: row?.source ? source.sourceKind : 'unknown',
        ...(parentThreadId ? { parentThreadId } : {}),
      }
    })
}
