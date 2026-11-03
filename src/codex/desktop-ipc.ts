/** Version-pinned connection to Codex Desktop's private local owner router. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

export const CODEX_DESKTOP_IPC_VERSION = '26.1027.51404'
const MAX_FRAME = 64 * 1024 * 1024
const ERRORS = new Set(['no-client-found', 'client-not-found', 'client-disconnected', 'server-closed',
  'request-timeout', 'request-version-mismatch', 'no-handler-for-request', 'error-handling-request'])
const uuid = z.uuid()
const PROFILES = new Set([':read-only', ':workspace', ':danger-full-access'])
const Permissions = z.looseObject({
  activePermissionProfile: z.object({ id: z.string(), extends: z.string().nullable() }).nullable(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']),
  approvalsReviewer: z.enum(['user', 'auto_review', 'guardian_subagent']),
  runtimeWorkspaceRoots: z.array(z.string()),
  sandboxPolicy: z.discriminatedUnion('type', [
    z.looseObject({ type: z.literal('dangerFullAccess') }),
    z.looseObject({ type: z.literal('readOnly'), networkAccess: z.boolean() }),
    z.looseObject({ type: z.literal('externalSandbox'), networkAccess: z.enum(['restricted', 'enabled']) }),
    z.looseObject({ type: z.literal('workspaceWrite'), writableRoots: z.array(z.string()), networkAccess: z.boolean(),
      excludeTmpdirEnvVar: z.boolean(), excludeSlashTmp: z.boolean() }),
  ]),
})
const run = promisify(execFile)
type Response = { type: 'response'; requestId: string; method: string; resultType: 'success' | 'error';
  handledByClientId?: string; result?: unknown; error?: string }
type Pending = { method: string; resolve(value: Response): void; reject(error: Error): void; cleanup(): void }
export interface CodexDesktopOwner { clientId: string; supportsUntrustedAppInput: boolean }
export interface CodexDesktopState extends CodexDesktopOwner {
  threadId: string; revision: number; status: 'idle' | 'active' | 'notLoaded' | 'systemError' | 'unknown'
  activeTurnId?: string; pendingRequests: number; cwd?: string; workspaceKind?: string
  permissionsKnown: boolean; permissionsHash: string; settingsHash: string
}
export interface CodexDesktopDelivery { clientUserMessageId: string; turnId: string; settingsPreserved?: boolean }
type StateRead = { owner: CodexDesktopOwner; resolve(value: CodexDesktopState): void; reject(error: Error): void; cleanup(): void }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
/** Safe protocol failure codes without Desktop response payloads. */
export class CodexDesktopIpcError extends Error {
  constructor(readonly code: string) { super(`Codex Desktop IPC: ${code}`) }
}

async function desktopVersion(appPath: string, signal: AbortSignal): Promise<string> {
  const result = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
    join(appPath, 'Contents', 'Info.plist')], { timeout: 3000, maxBuffer: 1024, signal })
  return result.stdout.trim()
}

function abortable<T>(work: Promise<T>, signal: AbortSignal, cancelled: () => CodexDesktopIpcError): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      () => { signal.removeEventListener('abort', abort); reject(new CodexDesktopIpcError('desktop-version-unavailable')) })
    if (signal.aborted) abort()
  })
}

/** Restricted Desktop client; it never claims ownership or handles another client's follower operations. */
export class CodexDesktopIpc {
  private readonly pending = new Map<string, Pending>()
  private readonly stateReads = new Map<string, StateRead>()
  private buffer = Buffer.alloc(0)
  private clientId = 'initializing-client'
  private closed = false
  private constructor(private readonly socket: Socket, private readonly timeoutMs: number) {
    socket.on('data', chunk => this.receive(chunk))
    socket.on('error', () => this.fail('connection-failed'))
    socket.on('close', () => this.fail('connection-closed'))
  }

  static async connect(options: { socketPath?: string; appPath?: string; timeoutMs?: number; signal?: AbortSignal;
    readVersion?: () => Promise<string> } = {}): Promise<CodexDesktopIpc> {
    const timeout = options.timeoutMs ?? 5000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10_000) throw new CodexDesktopIpcError('invalid-timeout')
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])])
    const cancelled = () => new CodexDesktopIpcError(options.signal?.aborted ? 'cancelled' : 'connect-timeout')
    let client: CodexDesktopIpc | undefined
    try {
      if (signal.aborted) throw cancelled()
      const version = await abortable(Promise.resolve().then(() => options.readVersion?.()
        ?? desktopVersion(options.appPath ?? '/Applications/ChatGPT.app', signal)), signal, cancelled)
      if (signal.aborted) throw cancelled()
      if (version !== CODEX_DESKTOP_IPC_VERSION) throw new CodexDesktopIpcError('unsupported-desktop-version')
      const path = options.socketPath ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'ipc', 'ipc.sock')
      if (!isAbsolute(path) || typeof process.getuid !== 'function') throw new CodexDesktopIpcError('local-socket-required')
      for (const [target, isSocket] of [[dirname(path), false], [path, true]] as const) {
        const stat = lstatSync(target)
        if (stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077
          || (isSocket ? !stat.isSocket() : !stat.isDirectory())) throw new CodexDesktopIpcError('private-socket-required')
      }
      if (signal.aborted) throw cancelled()
      const socket = createConnection({ path })
      client = new CodexDesktopIpc(socket, timeout)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new CodexDesktopIpcError('connect-timeout')), timeout)
        const abort = () => finish(cancelled())
        const error = () => finish(new CodexDesktopIpcError('connection-failed'))
        const connected = () => finish()
        const finish = (failure?: Error) => {
          clearTimeout(timer); signal.removeEventListener('abort', abort)
          socket.off('connect', connected); socket.off('error', error)
          failure ? reject(failure) : resolve()
        }
        socket.once('connect', connected); socket.once('error', error)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      const response = await client.call('initialize', 0, { clientType: 'dsh-superagent' }, signal)
      const initialized = z.object({ clientId: uuid }).safeParse(response.result)
      if (!initialized.success || response.handledByClientId !== initialized.data.clientId) throw new CodexDesktopIpcError('invalid-initialize')
      client.clientId = initialized.data.clientId
      return client
    } catch (error) {
      client?.close()
      if (signal.aborted) throw cancelled()
      throw error instanceof CodexDesktopIpcError ? error : new CodexDesktopIpcError('connection-unavailable')
    }
  }

  async discover(threadId: string, signal?: AbortSignal): Promise<CodexDesktopOwner | undefined> {
    if (!uuid.safeParse(threadId).success) throw new CodexDesktopIpcError('invalid-thread-id')
    if (this.clientId === 'initializing-client') throw new CodexDesktopIpcError('not-initialized')
    let response: Response
    try { response = await this.call('thread-owner-discovery', 1, { hostId: 'local', conversationId: threadId }, signal) }
    catch (error) { if (error instanceof CodexDesktopIpcError && error.code === 'no-client-found') return undefined; throw error }
    const clientId = uuid.safeParse(response.handledByClientId)
    const result = z.object({ supportsUntrustedAppInput: z.boolean().optional() }).safeParse(response.result)
    if (!clientId.success || !result.success) { this.close(); throw new CodexDesktopIpcError('invalid-response') }
    return { clientId: clientId.data, supportsUntrustedAppInput: result.data.supportsUntrustedAppInput === true }
  }

  /** Read one owner snapshot, then immediately release the private stream subscription. */
  async readState(threadId: string, signal?: AbortSignal): Promise<CodexDesktopState | undefined> {
    const owner = await this.discover(threadId, signal)
    if (!owner) return undefined
    if (this.stateReads.has(threadId)) throw new CodexDesktopIpcError('state-read-pending')
    return await new Promise<CodexDesktopState>((resolve, reject) => {
      const abort = () => finish(new CodexDesktopIpcError('cancelled'))
      const timer = setTimeout(() => finish(new CodexDesktopIpcError('snapshot-timeout')), this.timeoutMs)
      const cleanup = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.stateReads.delete(threadId)
        this.follow(threadId, false)
      }
      const finish = (error: Error) => { cleanup(); reject(error) }
      this.stateReads.set(threadId, { owner, resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted || this.closed) { abort(); return }
      this.follow(threadId, true)
    })
  }

  /** Experimental text-only start; callers must retain an uncertain result rather than retrying it. */
  async startText(expected: CodexDesktopState, text: string, clientUserMessageId: string,
    signal?: AbortSignal, canSend?: () => boolean): Promise<CodexDesktopDelivery> {
    if (!uuid.safeParse(clientUserMessageId).success || !text.trim() || text.length > 1000) {
      throw new CodexDesktopIpcError('invalid-message')
    }
    const current = await this.readState(expected.threadId, signal)
    if (!current || current.clientId !== expected.clientId || current.status !== 'idle' || current.pendingRequests
      || !current.permissionsKnown || current.workspaceKind !== 'project'
      || current.permissionsHash !== expected.permissionsHash || current.settingsHash !== expected.settingsHash) {
      throw new CodexDesktopIpcError('thread-state-changed')
    }
    if (canSend && !canSend()) throw new CodexDesktopIpcError('delivery-held')
    if (signal?.aborted) throw new CodexDesktopIpcError('cancelled')
    if (this.closed) throw new CodexDesktopIpcError('not-connected')
    let response: Response
    try {
      response = await this.call('thread-follower-start-turn', 2, { conversationId: current.threadId,
        turnStart: { request: { threadId: current.threadId, input: [{ type: 'text', text, text_elements: [] }],
          clientUserMessageId }, context: { inheritThreadSettings: true } } }, signal, current.clientId)
    } catch { throw new CodexDesktopIpcError('delivery-uncertain') }
    const result = z.looseObject({ result: z.looseObject({ turn: z.looseObject({ id: uuid }) }) }).safeParse(response.result)
    if (response.handledByClientId !== current.clientId || !result.success) {
      throw new CodexDesktopIpcError('delivery-uncertain')
    }
    let settingsPreserved: boolean | undefined
    try {
      const after = await this.readState(current.threadId, signal)
      if (after) settingsPreserved = after.permissionsHash === current.permissionsHash && after.settingsHash === current.settingsHash
    } catch { /* Delivery already succeeded; a failed post-check must never cause a resend. */ }
    return { clientUserMessageId, turnId: result.data.result.turn.id,
      ...(settingsPreserved === undefined ? {} : { settingsPreserved }) }
  }

  close(): void { this.fail('connection-closed') }

  private call(method: 'initialize' | 'thread-owner-discovery' | 'thread-follower-start-turn', version: number, params: unknown,
    signal?: AbortSignal, targetClientId?: string): Promise<Response> {
    if (this.closed || signal?.aborted) return Promise.reject(new CodexDesktopIpcError('not-connected'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('request-timeout'), this.timeoutMs)
      const abort = () => this.fail('cancelled')
      this.pending.set(requestId, { method, resolve, reject, cleanup: () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
      } })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      this.send({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params,
        timeoutMs: this.timeoutMs, ...(targetClientId ? { targetClientId } : {}) })
    })
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (!length || length > MAX_FRAME) { this.fail('invalid-frame'); return }
      if (this.buffer.length < 4 + length) return
      const bytes = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      let message: Record<string, unknown>
      try { message = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString('utf8'))) }
      catch { this.fail('invalid-frame'); return }
      if (message.type === 'broadcast') {
        try { this.snapshot(message) } catch { this.fail('invalid-snapshot') }
        continue
      }
      if (message.type === 'client-discovery-response') continue
      if (message.type === 'client-discovery-request') {
        const id = uuid.safeParse(message.requestId)
        if (!id.success) { this.fail('invalid-discovery'); return }
        this.send({ type: 'client-discovery-response', requestId: id.data, response: { canHandle: false } })
        continue
      }
      if (message.type !== 'response' || typeof message.requestId !== 'string') { this.fail('unsupported-message'); return }
      const pending = this.pending.get(message.requestId)
      if (!pending || message.method !== pending.method) { this.fail('unexpected-response'); return }
      this.pending.delete(message.requestId); pending.cleanup()
      if (message.resultType === 'error' && typeof message.error === 'string') {
        pending.reject(new CodexDesktopIpcError(ERRORS.has(message.error) ? message.error : 'owner-error')); continue
      }
      if (message.resultType !== 'success') {
        pending.reject(new CodexDesktopIpcError('invalid-response')); this.fail('invalid-response'); return
      }
      pending.resolve(message as unknown as Response)
    }
  }

  private send(value: unknown): void {
    if (this.closed) return
    const body = Buffer.from(JSON.stringify(value))
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length)
    try { this.socket.write(Buffer.concat([header, body])) } catch { this.fail('connection-failed') }
  }
  private follow(threadId: string, following: boolean): void {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId,
      version: 1, params: { conversationId: threadId, hostId: 'local', following } })
  }
  private snapshot(message: Record<string, unknown>): void {
    if (message.method !== 'thread-stream-state-changed') return
    const params = z.looseObject({ conversationId: uuid }).safeParse(message.params)
    if (!params.success) return
    const reading = this.stateReads.get(params.data.conversationId)
    if (!reading) return
    const parsed = z.looseObject({ version: z.literal(11), sourceClientId: uuid, targetClientIds: z.array(uuid),
      params: z.looseObject({ conversationId: uuid, hostId: z.literal('local'), change: z.looseObject({
        type: z.literal('snapshot'), revision: z.number().int().nonnegative(),
        conversationState: z.looseObject({ id: uuid, cwd: z.string().optional(), workspaceKind: z.string().optional(),
          turns: z.array(z.unknown()), requests: z.array(z.unknown()), currentPermissions: z.unknown().optional(),
          latestThreadSettings: z.unknown().optional(), threadRuntimeStatus: z.unknown().optional(),
          turnHistory: z.unknown().optional() }),
      }) }) }).safeParse(message)
    if (!parsed.success || parsed.data.sourceClientId !== reading.owner.clientId
      || !parsed.data.targetClientIds.includes(this.clientId)
      || parsed.data.params.change.conversationState.id !== params.data.conversationId) {
      this.fail('invalid-snapshot'); return
    }
    const { revision, conversationState: state } = parsed.data.params.change
    let invalidTurn = false
    const history = state.turnHistory === undefined ? undefined : z.looseObject({ history: z.looseObject({
      entitiesByKey: z.record(z.string(), z.unknown()) }) }).safeParse(state.turnHistory)
    if (history && !history.success) invalidTurn = true
    const values = [...state.turns, ...(history?.success ? Object.values(history.data.history.entitiesByKey) : [])]
    const turns = [...new Set(values.flatMap(value => {
      const turn = z.looseObject({ turnId: uuid,
        status: z.enum(['pending', 'inProgress', 'completed', 'interrupted', 'failed']) }).safeParse(value)
      if (!turn.success) invalidTurn = true
      return turn.success && turn.data.status === 'inProgress' ? [turn.data.turnId] : []
    }))]
    const runtime = z.looseObject({ type: z.enum(['idle', 'active', 'notLoaded', 'systemError']),
      activeFlags: z.array(z.string()).optional() }).safeParse(state.threadRuntimeStatus)
    const status = invalidTurn || turns.length > 1 ? 'unknown' : turns.length ? 'active' : runtime.success ? runtime.data.type : 'unknown'
    const flags = runtime.success ? runtime.data.activeFlags ?? [] : []
    const permissions = Permissions.safeParse(state.currentPermissions)
    const profile = permissions.success ? permissions.data.activePermissionProfile : undefined
    const result: CodexDesktopState = { ...reading.owner, threadId: state.id, revision, status,
      ...(turns.length === 1 ? { activeTurnId: turns[0]! } : {}),
      pendingRequests: state.requests.length + Number(flags.some(flag => /approval|userinput/i.test(flag))),
      ...(state.cwd ? { cwd: state.cwd } : {}), ...(state.workspaceKind ? { workspaceKind: state.workspaceKind } : {}),
      permissionsKnown: permissions.success && (profile === null || !!profile && PROFILES.has(profile.id)
        && (profile.extends === null || PROFILES.has(profile.extends))),
      permissionsHash: fingerprint(state.currentPermissions), settingsHash: fingerprint(state.latestThreadSettings) }
    reading.cleanup(); reading.resolve(result)
  }
  private fail(code: string): void {
    if (this.closed) return
    this.closed = true; this.socket.destroy(); this.buffer = Buffer.alloc(0)
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new CodexDesktopIpcError(code)) }
    this.pending.clear()
    for (const reading of [...this.stateReads.values()]) { reading.cleanup(); reading.reject(new CodexDesktopIpcError(code)) }
  }
}
