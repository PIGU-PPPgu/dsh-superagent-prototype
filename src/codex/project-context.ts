/** Bounded read-only conversation and project context; project text is untrusted data. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { readRecentCodexMessages, type CodexMonitorRpc } from './monitor-read.ts'

const MAX_DOCUMENT_CHARS = 2500
const MAX_DOCUMENT_BYTES = 16 * 1024
const MAX_MESSAGE_CHARS = 1200
const MAX_INITIAL_CHARS = 2000
const MAX_INITIAL_ITEMS = 500
const MAX_INITIAL_PAGES = 20
const PAGE_SIZE = 100
const GIT_TIMEOUT_MS = 5000
const GIT_MAX_OUTPUT = 128 * 1024
const MAX_INDEX_ENTRIES = 4000
const MAX_PATH = 4096
const GIT_BINARY = '/usr/bin/git'
const exec = promisify(execFile)

export interface ProjectContextInput {
  threadId: string
  title: string
  headItemId: string
  cwd?: string
  repository?: string
}

export interface ProjectMessage {
  id: string
  turnId: string
  role: 'user' | 'assistant'
  text: string
  chars?: number
}

export interface ProjectDocument {
  id: 'project:README.md' | 'project:AGENTS.md'
  name: 'README.md' | 'AGENTS.md'
  text: string
  chars?: number
  digest: string
}

export interface CodexProjectContext {
  threadId: string
  title: string
  headItemId: string
  readAt: string
  project: {
    cwd?: string
    root?: string
    repository?: string
    name?: string
    description?: string
    branch?: string
    gitHead?: string
    dirty?: boolean
    worktreeState?: string
  }
  initialRequest?: ProjectMessage
  messages: ProjectMessage[]
  documents: ProjectDocument[]
  coverage: {
    initialRequestFound: boolean
    recentComplete: boolean
    gaps: string[]
  }
}

interface InitialRequestRead { message?: ProjectMessage; complete: boolean }

const ItemPage = z.looseObject({
  data: z.array(z.unknown()).max(PAGE_SIZE),
  nextCursor: z.string().nullish().optional(),
})
const ItemEntry = z.looseObject({
  turnId: z.string(),
  item: z.looseObject({ id: z.string(), type: z.string(), content: z.unknown().optional() }),
})
const IndexEntry = /^\d+ ([0-9a-f]{40,64}) \d\t(.+)$/

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Codex project context read cancelled')
}

function truncate(text: string, limit: number): Pick<ProjectMessage, 'text' | 'chars'> {
  return text.length <= limit ? { text } : { text: text.slice(0, limit), chars: text.length }
}

/** Ignores generated router messages and the host's injected instruction envelopes. */
export function isCodexUserRequest(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('DSH Superagent coordination for this existing conversation.')) return false
  return !/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<apps_instructions>|<tools>|<heartbeat>)/i.test(trimmed)
}

async function readInitialRequest(rpc: CodexMonitorRpc, threadId: string, signal: AbortSignal): Promise<InitialRequestRead> {
  let itemCount = 0
  let pageCount = 0
  let cursor: string | undefined
  const cursors = new Set<string>()
  while (itemCount < MAX_INITIAL_ITEMS && pageCount < MAX_INITIAL_PAGES) {
    checkCancelled(signal)
    pageCount++
    const response = ItemPage.parse(await rpc.request('thread/items/list', {
      threadId, ...(cursor ? { cursor } : {}),
      limit: Math.min(PAGE_SIZE, MAX_INITIAL_ITEMS - itemCount), sortDirection: 'asc',
    }, signal))
    for (const value of response.data) {
      const { turnId, item } = ItemEntry.parse(value)
      itemCount++
      if (item.type !== 'userMessage') continue
      const content = z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).parse(item.content)
      const text = content.flatMap(part => part.type === 'text' ? [z.string().parse(part.text)] : []).join('')
      if (!isCodexUserRequest(text)) continue
      return { message: { id: item.id, turnId, role: 'user', ...truncate(text, MAX_INITIAL_CHARS) }, complete: true }
    }
    if (!response.nextCursor) return { complete: true }
    if (cursors.has(response.nextCursor)) throw new Error('Codex initial request returned a repeated cursor')
    cursors.add(response.nextCursor)
    cursor = response.nextCursor
  }
  return { complete: false }
}

/** Opens without following a final symlink and binds the bytes to the current directory entry. */
async function readProjectFile(root: string, name: string, signal: AbortSignal): Promise<{ text: string; digest: string } | undefined> {
  const path = join(root, name)
  let handle
  try {
    checkCancelled(signal)
    const rootBefore = await lstat(root)
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return undefined
    // A FIFO or other non-regular entry must not block before the descriptor type is checked.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_DOCUMENT_BYTES) return undefined
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino) return undefined
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      checkCancelled(signal)
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (bytesRead === 0) break
      bytes += bytesRead
    }
    if (bytes > MAX_DOCUMENT_BYTES) return undefined
    const [after, current, rootAfter, resolvedRoot] = await Promise.all([
      handle.stat(), lstat(path), lstat(root), realpath(root),
    ])
    if (!after.isFile() || !current.isFile() || current.isSymbolicLink()
      || after.dev !== opened.dev || after.ino !== opened.ino
      || current.dev !== opened.dev || current.ino !== opened.ino) return undefined
    // The root must still be the same canonical directory; a renamed parent or symlink swap invalidates the read.
    if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink()
      || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino
      || resolvedRoot !== root) return undefined
    const bytesRead = buffer.subarray(0, bytes)
    return { text: bytesRead.toString('utf8'), digest: createHash('sha256').update(bytesRead).digest('hex') }
  } catch {
    checkCancelled(signal)
    return undefined
  } finally { await handle?.close().catch(() => undefined) }
}

async function projectFiles(root: string, signal: AbortSignal): Promise<{
  documents: ProjectDocument[]
  name?: string
  description?: string
}> {
  const documents: ProjectDocument[] = []
  for (const name of ['README.md', 'AGENTS.md'] as const) {
    const file = await readProjectFile(root, name, signal)
    if (file) documents.push({ id: `project:${name}`, name, digest: file.digest, ...truncate(file.text, MAX_DOCUMENT_CHARS) })
  }
  let name: string | undefined
  let description: string | undefined
  const manifest = await readProjectFile(root, 'package.json', signal)
  if (manifest !== undefined) {
    try {
      const value = JSON.parse(manifest.text) as { name?: unknown; description?: unknown }
      if (typeof value.name === 'string' && value.name.length <= 200) name = value.name
      if (typeof value.description === 'string' && value.description.length <= 1000) description = value.description
    } catch { /* An invalid manifest contributes no metadata. */ }
  }
  return { documents, ...(name ? { name } : {}), ...(description ? { description } : {}) }
}

/** Hashes index records and tracked-file metadata without reading file contents or invoking Git filters. */
async function readWorktreeState(root: string, git: (args: string[]) => Promise<string | undefined>,
  signal: AbortSignal): Promise<{ worktreeState?: string; gaps: string[] }> {
  const output = await git(['ls-files', '--stage', '--sparse', '--full-name', '-z'])
  if (output === undefined) return { gaps: ['worktree metadata unavailable'] }
  const hash = createHash('sha256')
  const records = output.length ? output.split('\0') : []
  if (records.at(-1) === '') records.pop()
  if (records.length > MAX_INDEX_ENTRIES || output.length >= GIT_MAX_OUTPUT) {
    return { gaps: ['worktree metadata limit exceeded'] }
  }
  for (const record of records) {
    checkCancelled(signal)
    const match = IndexEntry.exec(record)
    if (!match) return { gaps: ['worktree metadata unavailable'] }
    const [_, objectId, path] = match
    if (!objectId || !path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      return { gaps: ['worktree metadata unavailable'] }
    }
    const fullPath = join(root, path)
    // Include the index identity but never emit repository paths or content in the result.
    hash.update(record).update('\0')
    try {
      const info = await lstat(fullPath)
      hash.update(info.isFile() && !info.isSymbolicLink() ? 'file' : 'other').update('\0')
      hash.update(`${info.size}:${Math.trunc(info.mtimeMs)}:${Math.trunc(info.ctimeMs)}`).update('\0')
    } catch {
      checkCancelled(signal)
      hash.update('missing\0')
    }
  }
  return { worktreeState: hash.digest('hex'), gaps: [] }
}

async function readGitInfo(cwd: string | undefined, signal: AbortSignal): Promise<{
  /** Canonical cwd is a safe document root even when Git metadata is unavailable or untrusted. */
  cwd?: string
  root?: string
  branch?: string
  gitHead?: string
  dirty?: boolean
  worktreeState?: string
  gaps: string[]
}> {
  const gaps: string[] = []
  if (!cwd) return { gaps: ['cwd not provided'] }
  if (!isAbsolute(cwd) || cwd.length > MAX_PATH || cwd.includes('\0')) return { gaps: ['cwd is not absolute'] }
  try {
    const info = await lstat(cwd)
    if (!info.isDirectory() || info.isSymbolicLink()) return { gaps: ['cwd is not a regular directory'] }
  } catch {
    checkCancelled(signal)
    return { gaps: ['cwd does not exist'] }
  }
  let canonicalCwd: string
  try { canonicalCwd = await realpath(cwd) }
  catch {
    checkCancelled(signal)
    return { gaps: ['cwd does not exist'] }
  }
  const environment = {
    PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
  }
  const git = async (args: string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await exec(GIT_BINARY, ['-c', 'core.fsmonitor=false', ...args], {
        cwd, env: environment, signal, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT,
        windowsHide: true,
      })
      return stdout.trim()
    } catch {
      checkCancelled(signal)
      return undefined
    }
  }
  const root = await git(['rev-parse', '--show-toplevel'])
  if (!root || root.length > MAX_PATH || !isAbsolute(root)) return { cwd: canonicalCwd, gaps: ['git metadata unavailable'] }
  let canonicalRoot: string
  try { canonicalRoot = await realpath(root) }
  catch {
    checkCancelled(signal)
    return { cwd: canonicalCwd, gaps: ['git metadata unavailable'] }
  }
  if (canonicalCwd !== canonicalRoot && !canonicalCwd.startsWith(canonicalRoot + sep)) {
    return { cwd: canonicalCwd, gaps: ['git root does not contain cwd'] }
  }
  const rootInfo = await lstat(canonicalRoot).catch(() => undefined)
  checkCancelled(signal)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    return { cwd: canonicalCwd, gaps: ['git metadata unavailable'] }
  }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const gitHead = await git(['rev-parse', 'HEAD'])
  if (!branch || branch.length > 200 || !gitHead) {
    return { cwd: canonicalCwd, root: canonicalRoot, branch, gitHead, gaps: ['git metadata unavailable'] }
  }
  const worktree = await readWorktreeState(canonicalRoot, git, signal)
  gaps.push('worktree state is metadata-only', ...worktree.gaps)
  return { cwd: canonicalCwd, root: canonicalRoot, branch, gitHead, worktreeState: worktree.worktreeState, gaps }
}

export async function readCodexProjectContext(rpc: CodexMonitorRpc, input: ProjectContextInput,
  signal: AbortSignal): Promise<CodexProjectContext> {
  checkCancelled(signal)
  // Recent history is the authoritative snapshot anchor. Do not return an apparently ready stale snapshot.
  const recent = await readRecentCodexMessages(rpc, input.threadId, signal)
  if (recent.newestItemId !== input.headItemId) throw new Error('Codex conversation changed; snapshot is stale')
  const messages = recent.messages.flatMap(message =>
    message.role === 'user' && !isCodexUserRequest(message.text) ? [] : [{
      id: message.id, turnId: message.turnId, role: message.role, ...truncate(message.text, MAX_MESSAGE_CHARS),
    }])
  const gaps: string[] = []
  let initial: InitialRequestRead
  try { initial = await readInitialRequest(rpc, input.threadId, signal) }
  catch (error) {
    checkCancelled(signal)
    initial = { complete: false }
    gaps.push('initial request read failed')
  }
  if (!initial.message && initial.complete) gaps.push('initial request not found')
  if (!initial.complete && !gaps.includes('initial request read failed')) gaps.push('initial request history is incomplete')

  const git = await readGitInfo(input.cwd, signal)
  gaps.push(...git.gaps)
  const files = git.root || git.cwd ? await projectFiles(git.root ?? git.cwd!, signal) : { documents: [] }
  return {
    threadId: input.threadId, title: input.title, headItemId: input.headItemId, readAt: new Date().toISOString(),
    project: {
      ...(input.cwd ? { cwd: input.cwd } : {}), ...(git.root ? { root: git.root } : {}),
      ...(input.repository ? { repository: input.repository } : {}),
      ...(files.name ? { name: files.name } : {}), ...(files.description ? { description: files.description } : {}),
      ...(git.branch ? { branch: git.branch } : {}), ...(git.gitHead ? { gitHead: git.gitHead } : {}),
      ...(git.dirty !== undefined ? { dirty: git.dirty } : {}),
      ...(git.worktreeState ? { worktreeState: git.worktreeState } : {}),
    },
    ...(initial.message ? { initialRequest: initial.message } : {}),
    messages, documents: files.documents,
    coverage: { initialRequestFound: !!initial.message, recentComplete: recent.complete, gaps },
  }
}
