/** Loopback-only, operator-facing Codex history dashboard. No Codex control or model API calls. */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { discoverCodexThreads } from './discovery.ts'
import { exportCodexHistorySnapshot } from './export.ts'
import { CodexFileMonitor, readCodexWatchlistFile } from './file-bridge.ts'
import { CodexWatchlistSchema, type CodexObservation } from './model.ts'
import { MAX_CODEX_WATCHLIST_BYTES } from './private-file.ts'
import { CodexStdioReadRpc } from './stdio.ts'
import { LOCAL_CSS, LOCAL_HTML, LOCAL_JS } from './local-ui.ts'

export interface LocalRpc {
  request(method: 'thread/read' | 'thread/turns/list' | 'thread/list', params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  close(): void
}
export interface CodexLocalOptions {
  directory?: string
  /** Port 0 asks the OS for a free port; intended for tests. */
  port?: number
  connect?: () => Promise<LocalRpc>
}
export interface CodexLocalServer {
  readonly url: string
  readonly directory: string
  readonly watchlistPath: string
  readonly snapshotPath: string
  close(): Promise<void>
}

/** A safe, bounded message and HTTP status for local dashboard requests. */
class LocalError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const noFile = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if (noFile(error)) return false; throw error }
}
async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Codex local data directory must be absolute')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Codex local data directory must be owned by this user and private (mode 0700)')
  }
}
async function savePrivate(path: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > MAX_CODEX_WATCHLIST_BYTES) throw new LocalError(400, 'Codex watchlist is too large')
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(body)
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
  } catch {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw new Error('Codex watchlist could not be saved')
  }
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_CODEX_WATCHLIST_BYTES) throw new LocalError(400, 'Codex request is too large')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new LocalError(400, 'Codex request is not JSON') }
}
const EmptyWatchlist = z.object({ version: z.literal(1), tasks: z.tuple([]) }).strict()
function watchlistInput(value: unknown) {
  const empty = EmptyWatchlist.safeParse(value)
  if (empty.success) return empty.data
  const parsed = CodexWatchlistSchema.safeParse(value)
  if (!parsed.success) throw new LocalError(400, 'Invalid task mapping: each task needs a unique task ID and Codex thread ID')
  return parsed.data
}
function headers(res: ServerResponse, type: string): void {
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
}
function send(res: ServerResponse, status: number, value: unknown): void {
  headers(res, 'application/json; charset=utf-8')
  res.writeHead(status)
  res.end(JSON.stringify(value))
}
async function withRpc<T>(connect: () => Promise<LocalRpc>, run: (rpc: LocalRpc) => Promise<T>): Promise<T> {
  let rpc: LocalRpc
  try { rpc = await connect() }
  catch { throw new LocalError(503, 'Codex App Server unavailable. Check that the Codex CLI is installed on this Mac') }
  try { return await run(rpc) } finally { rpc.close() }
}

/** Starts the dashboard on 127.0.0.1. Reads only stored history and writes only its private local mapping/snapshot. */
export async function startCodexLocalServer(options: CodexLocalOptions = {}): Promise<CodexLocalServer> {
  const directory = options.directory ?? join(homedir(), '.dsh', 'state', 'codex-readonly')
  await privateDirectory(directory)
  const watchlistPath = join(directory, 'watchlist.json')
  const snapshotPath = join(directory, 'snapshot.json')
  const monitor = new CodexFileMonitor(watchlistPath, snapshotPath)
  const connect = options.connect ?? (() => CodexStdioReadRpc.connect())
  let mutating = false
  const state = async (): Promise<{ tasks: { taskId: string; threadId: string; label?: string }[]; observation?: CodexObservation;
    watchlistPath: string; snapshotPath: string; snapshotReady: boolean }> => {
    const configured = await exists(watchlistPath)
    const tasks = configured ? (await readCodexWatchlistFile(watchlistPath, new AbortController().signal)).tasks : []
    const snapshotReady = await exists(snapshotPath)
    return { tasks, ...(configured && snapshotReady ? { observation: await monitor.refresh() } : {}),
      watchlistPath, snapshotPath, snapshotReady }
  }
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number } | null)?.port
    const host = req.headers.host
    if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
      send(res, 403, { error: 'Same-origin localhost request required' }); return
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const asset = path === '/' ? [LOCAL_HTML, 'text/html; charset=utf-8'] : path === '/app.js' ? [LOCAL_JS, 'text/javascript; charset=utf-8']
      : path === '/app.css' ? [LOCAL_CSS, 'text/css; charset=utf-8'] : undefined
    if (req.method === 'GET' && asset) {
      headers(res, asset[1]!); res.writeHead(200); res.end(asset[0]); return
    }
    if (req.headers['x-codex-local-request'] !== '1') { send(res, 403, { error: 'Local dashboard request required' }); return }
    try {
      if (req.method === 'GET' && path === '/api/state') { send(res, 200, await state()); return }
      if (req.method === 'GET' && path === '/api/candidates') {
        const candidates = await withRpc(connect, rpc => discoverCodexThreads(rpc, new AbortController().signal))
        send(res, 200, candidates); return
      }
      if (req.method === 'POST' && path === '/api/watchlist') {
        if (mutating) throw new LocalError(409, 'Another Codex local change is still running')
        mutating = true
        try {
          const list = watchlistInput(await readJson(req))
          if (list.tasks.length) await savePrivate(watchlistPath, list)
          else await unlink(watchlistPath).catch(error => { if (!noFile(error)) throw error })
          await unlink(snapshotPath).catch(error => { if (!noFile(error)) throw error })
          send(res, 200, await state())
        } finally { mutating = false }
        return
      }
      if (req.method === 'POST' && path === '/api/export') {
        if (mutating) throw new LocalError(409, 'Another Codex local change is still running')
        if (!await exists(watchlistPath)) throw new LocalError(400, 'Save at least one Codex thread first')
        mutating = true
        try {
          const result = await withRpc(connect, rpc => exportCodexHistorySnapshot(watchlistPath, snapshotPath, rpc))
          send(res, 200, { ...result, state: await state() })
        } finally { mutating = false }
        return
      }
      throw new LocalError(404, 'Unknown local dashboard operation')
    } catch (error) {
      send(res, error instanceof LocalError ? error.status : 500,
        { error: error instanceof LocalError ? error.message : 'Codex local request failed; check the mapping and Codex CLI' })
    }
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 3188, '127.0.0.1', resolve) })
  } catch (error) { server.close(); throw error }
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, directory, watchlistPath, snapshotPath,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
