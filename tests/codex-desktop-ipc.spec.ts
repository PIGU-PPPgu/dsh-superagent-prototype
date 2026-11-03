import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CODEX_DESKTOP_IPC_VERSION, CodexDesktopIpc } from '../src/codex/desktop-ipc.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const frame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}
async function fixture(handle: (message: Record<string, unknown>, socket: Socket) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-desktop-ipc-')), path = join(directory, 'ipc.sock')
  chmodSync(directory, 0o700)
  const sockets = new Set<Socket>()
  let connections = 0
  const received: Record<string, unknown>[] = []
  const server: Server = createServer(socket => {
    connections++
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let pending = Buffer.alloc(0)
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
        const length = pending.readUInt32LE(0)
        const value = JSON.parse(pending.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>
        pending = pending.subarray(4 + length); received.push(value); handle(value, socket)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  chmodSync(path, 0o600)
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  return { path, received, connections: () => connections, options: { socketPath: path, readVersion: async () => CODEX_DESKTOP_IPC_VERSION,
    timeoutMs: 1000 } }
}
const clientId = randomUUID(), ownerId = randomUUID()
const knownPermissions = () => ({ activePermissionProfile: null, approvalPolicy: 'on-request', approvalsReviewer: 'user',
  runtimeWorkspaceRoots: ['/test'], sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/test'],
    networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } })
function initialize(message: Record<string, unknown>, socket: Socket): boolean {
  if (message.method !== 'initialize') return false
  socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'success',
    method: 'initialize', handledByClientId: clientId, result: { clientId } }))
  return true
}

it('discovers the Desktop owner without accepting ownership or exposing write operations', async () => {
  const probeId = randomUUID()
  let responded!: () => void
  const negative = new Promise<void>(resolve => { responded = resolve })
  const test = await fixture((message, socket) => {
    if (initialize(message, socket)) return
    if (message.type === 'client-discovery-response') { responded(); return }
    if (message.method === 'thread-owner-discovery') {
      const encoded = frame({ type: 'client-discovery-request', requestId: probeId, request: message })
      socket.write(encoded.subarray(0, 7)); socket.write(encoded.subarray(7))
      socket.write(frame({ type: 'response', requestId: message.requestId, method: message.method,
        resultType: 'success', handledByClientId: ownerId, result: { supportsUntrustedAppInput: true } }))
    }
  })
  const client = await CodexDesktopIpc.connect(test.options)
  try {
    expect(await client.discover(randomUUID())).toEqual({ clientId: ownerId, supportsUntrustedAppInput: true })
    await negative
    expect(test.received.filter(message => message.method).map(message => message.method))
      .toEqual(['initialize', 'thread-owner-discovery'])
    expect(test.received).toContainEqual({ type: 'client-discovery-response', requestId: probeId,
      response: { canHandle: false } })
  } finally { client.close() }
})

it('reports no owner and refuses an unsupported Desktop version', async () => {
  const test = await fixture((message, socket) => {
    if (initialize(message, socket)) return
    socket.write(frame({ type: 'response', requestId: message.requestId, method: message.method,
      resultType: 'error', error: 'no-client-found' }))
  })
  const client = await CodexDesktopIpc.connect(test.options)
  try { expect(await client.discover(randomUUID())).toBeUndefined() } finally { client.close() }
  await expect(CodexDesktopIpc.connect({ ...test.options, readVersion: async () => 'different' }))
    .rejects.toThrow('unsupported-desktop-version')
})

it('rejects a non-private socket and closes on an oversized frame', async () => {
  const test = await fixture((message, socket) => {
    if (initialize(message, socket)) return
    const header = Buffer.alloc(4); header.writeUInt32LE(128 * 1024 * 1024)
    socket.write(header)
  })
  chmodSync(test.path, 0o660)
  await expect(CodexDesktopIpc.connect(test.options)).rejects.toThrow('private-socket-required')
  chmodSync(test.path, 0o600)
  const client = await CodexDesktopIpc.connect(test.options)
  await expect(client.discover(randomUUID())).rejects.toThrow('invalid-frame')
})

it('closes the pending read when its caller cancels', async () => {
  let started!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  const test = await fixture((message, socket) => { if (!initialize(message, socket)) started() })
  const client = await CodexDesktopIpc.connect(test.options), controller = new AbortController()
  const reading = client.discover(randomUUID(), controller.signal)
  const rejected = expect(reading).rejects.toThrow('cancelled')
  await pending; controller.abort(); await rejected
})

it('cancels or times out version reads before creating a socket connection', async () => {
  const test = await fixture(initialize)
  const controller = new AbortController()
  let release!: (version: string) => void
  const version = new Promise<string>(resolve => { release = resolve })
  const connecting = CodexDesktopIpc.connect({ ...test.options, signal: controller.signal, readVersion: () => version })
  const rejected = expect(connecting).rejects.toThrow('cancelled')
  controller.abort(new Error('private abort reason'))
  await rejected
  release(CODEX_DESKTOP_IPC_VERSION)
  await expect(CodexDesktopIpc.connect({ ...test.options, timeoutMs: 20,
    readVersion: () => new Promise<string>(() => {}) })).rejects.toThrow('connect-timeout')
  expect(test.connections()).toBe(0)
})

it('returns fixed errors without raw command, path or response data', async () => {
  const test = await fixture((message, socket) => socket.write(frame({ type: 'response', requestId: message.requestId,
    method: message.method, resultType: 'success', handledByClientId: clientId, result: { private: 'private response' } })))
  await expect(CodexDesktopIpc.connect({ ...test.options,
    readVersion: async () => { throw new Error('private command text') } })).rejects.toThrow('desktop-version-unavailable')
  await expect(CodexDesktopIpc.connect({ ...test.options, socketPath: test.path + '-private-path' }))
    .rejects.toThrow('connection-unavailable')
  await expect(CodexDesktopIpc.connect(test.options)).rejects.toThrow('invalid-initialize')
})

it('distinguishes connection timeout from caller cancellation while initializing', async () => {
  let entered: (() => void) | undefined
  const test = await fixture(() => { entered?.() })
  await expect(CodexDesktopIpc.connect({ ...test.options, timeoutMs: 20 }))
    .rejects.toThrow(/^Codex Desktop IPC: connect-timeout$/)
  const initializing = new Promise<void>(resolve => { entered = resolve })
  const controller = new AbortController()
  const connecting = CodexDesktopIpc.connect({ ...test.options, signal: controller.signal })
  const rejected = expect(connecting).rejects.toThrow(/^Codex Desktop IPC: cancelled$/)
  await initializing; controller.abort(new Error('private cancellation reason')); await rejected
})

it('reads one matching owner snapshot and releases its subscription', async () => {
  const threadId = randomUUID(), turnId = randomUUID()
  let unfollowed!: () => void
  const released = new Promise<void>(resolve => { unfollowed = resolve })
  const test = await fixture((message, socket) => {
    if (initialize(message, socket)) return
    if (message.method === 'thread-owner-discovery') {
      socket.write(frame({ type: 'response', requestId: message.requestId, method: message.method,
        resultType: 'success', handledByClientId: ownerId, result: { supportsUntrustedAppInput: true } }))
    } else if (message.method === 'thread-stream-following-changed') {
      if (!(message.params as { following: boolean }).following) { unfollowed(); return }
      socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: ownerId,
        targetClientIds: [clientId], version: 11, params: { hostId: 'local', conversationId: threadId,
          change: { type: 'snapshot', revision: 4, conversationState: { id: threadId, cwd: '/test',
            workspaceKind: 'project', turns: [], turnHistory: { kind: 'paginated', history: { entitiesByKey: {
              [turnId]: { turnId, status: 'inProgress', items: ['private history'] } } } },
            requests: [{ method: 'approval', params: 'private request' }], threadRuntimeStatus: { type: 'active' },
            currentPermissions: knownPermissions(), latestThreadSettings: { model: 'private model' } } } } }))
    }
  })
  const client = await CodexDesktopIpc.connect(test.options)
  try {
    const state = await client.readState(threadId)
    expect(state).toMatchObject({ threadId, revision: 4, status: 'active', activeTurnId: turnId,
      pendingRequests: 1, cwd: '/test', workspaceKind: 'project' })
    expect(JSON.stringify(state)).not.toMatch(/private history|private request|private permissions|private model/)
    await released
  } finally { client.close() }
})

it('rejects a snapshot from a different owner', async () => {
  const threadId = randomUUID()
  const test = await fixture((message, socket) => {
    if (initialize(message, socket)) return
    if (message.method === 'thread-owner-discovery') socket.write(frame({ type: 'response',
      requestId: message.requestId, method: message.method, resultType: 'success', handledByClientId: ownerId, result: {} }))
    else socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: randomUUID(),
      targetClientIds: [clientId], version: 11, params: { hostId: 'local', conversationId: threadId,
        change: { type: 'snapshot', revision: 0, conversationState: { id: threadId, turns: [], requests: [] } } } }))
  })
  const client = await CodexDesktopIpc.connect(test.options)
  await expect(client.readState(threadId)).rejects.toThrow('invalid-snapshot')
})

it('rejects deeply nested snapshot settings with a fixed error instead of throwing from the socket callback', async () => {
  for (const field of ['currentPermissions', 'latestThreadSettings']) {
    const threadId = randomUUID()
    const test = await fixture((message, socket) => {
      if (initialize(message, socket)) return
      if (message.method === 'thread-owner-discovery') socket.write(frame({ type: 'response',
        requestId: message.requestId, method: message.method, resultType: 'success', handledByClientId: ownerId, result: {} }))
      else if (message.method === 'thread-stream-following-changed' && (message.params as { following: boolean }).following) {
        const value = JSON.stringify({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: ownerId,
          targetClientIds: [clientId], version: 11, params: { hostId: 'local', conversationId: threadId,
            change: { type: 'snapshot', revision: 0, conversationState: { id: threadId, turns: [], requests: [],
              [field]: '__deep__' } } } }).replace('"__deep__"', '{"a":'.repeat(15_000) + '0' + '}'.repeat(15_000))
        const body = Buffer.from(value), header = Buffer.alloc(4); header.writeUInt32LE(body.length)
        socket.write(Buffer.concat([header, body]))
      }
    })
    const client = await CodexDesktopIpc.connect(test.options)
    await expect(client.readState(threadId)).rejects.toThrow(/^Codex Desktop IPC: invalid-snapshot$/)
    await expect(client.discover(threadId)).rejects.toThrow('not-connected')
  }
})

it('starts text with inherited settings only and refuses a newly active thread', async () => {
  const threadId = randomUUID(), turnId = randomUUID(), messageId = randomUUID()
  let active = false, pending = false
  const test = await fixture((message, socket) => {
    if (initialize(message, socket)) return
    if (message.method === 'thread-owner-discovery') socket.write(frame({ type: 'response',
      requestId: message.requestId, method: message.method, resultType: 'success', handledByClientId: ownerId, result: {} }))
    else if (message.method === 'thread-stream-following-changed' && (message.params as { following: boolean }).following) {
      socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: ownerId,
        targetClientIds: [clientId], version: 11, params: { hostId: 'local', conversationId: threadId,
          change: { type: 'snapshot', revision: 1, conversationState: { id: threadId, cwd: '/test', workspaceKind: 'project',
            turns: active ? [{ turnId, status: 'inProgress' }] : [], requests: pending ? [{}] : [],
            threadRuntimeStatus: { type: active ? 'active' : 'idle' }, currentPermissions: knownPermissions(),
            latestThreadSettings: { model: 'existing-model' } } } } }))
    } else if (message.method === 'thread-follower-start-turn') {
      active = true
      socket.write(frame({ type: 'response', requestId: message.requestId, method: message.method,
        resultType: 'success', handledByClientId: ownerId, result: { result: { turn: { id: turnId } } } }))
    }
  })
  const client = await CodexDesktopIpc.connect(test.options)
  try {
    const before = (await client.readState(threadId))!
    expect(await client.startText(before, 'Reply with TEST OK only', messageId)).toEqual({
      clientUserMessageId: messageId, turnId, settingsPreserved: true })
    const sent = test.received.filter(message => message.method === 'thread-follower-start-turn')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ targetClientId: ownerId, version: 2,
      params: { conversationId: threadId, turnStart: { request: { threadId,
        clientUserMessageId: messageId, input: [{ type: 'text', text: 'Reply with TEST OK only', text_elements: [] }] },
      context: { inheritThreadSettings: true } } } })
    expect(Object.keys(((sent[0]!.params as { turnStart: { request: object } }).turnStart.request)))
      .toEqual(['threadId', 'input', 'clientUserMessageId'])
    await expect(client.startText(before, 'Another message', randomUUID())).rejects.toThrow('thread-state-changed')
    active = false; pending = true
    await expect(client.startText(before, 'Another message', randomUUID())).rejects.toThrow('thread-state-changed')
    expect(test.received.filter(message => message.method === 'thread-follower-start-turn')).toHaveLength(1)
  } finally { client.close() }
})

it('does not send when turn metadata or permissions are malformed', async () => {
  for (const malformed of ['turn', 'permissions', 'policy', 'profile']) {
    const threadId = randomUUID()
    const test = await fixture((message, socket) => {
      if (initialize(message, socket)) return
      if (message.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: message.requestId,
        method: message.method, resultType: 'success', handledByClientId: ownerId, result: {} }))
      else if (message.method === 'thread-stream-following-changed' && (message.params as { following: boolean }).following) {
        socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: ownerId,
          targetClientIds: [clientId], version: 11, params: { hostId: 'local', conversationId: threadId,
            change: { type: 'snapshot', revision: 0, conversationState: { id: threadId, cwd: '/test', workspaceKind: 'project',
              turns: malformed === 'turn' ? [{ turnId: 'invalid', status: 'inProgress' }] : [], requests: [],
              threadRuntimeStatus: { type: 'idle' }, currentPermissions: malformed === 'permissions' ? false
                : malformed === 'policy' ? { ...knownPermissions(), approvalPolicy: false }
                  : malformed === 'profile' ? { ...knownPermissions(), activePermissionProfile: { id: 'custom', extends: null } }
                    : knownPermissions(),
              latestThreadSettings: {} } } } }))
      }
    })
    const client = await CodexDesktopIpc.connect(test.options)
    try {
      const expected = (await client.readState(threadId))!
      await expect(client.startText(expected, 'Test only', randomUUID())).rejects.toThrow('thread-state-changed')
      expect(test.received.filter(message => message.method === 'thread-follower-start-turn')).toEqual([])
    } finally { client.close() }
  }
})

it('reports cancellation or closure before a write as definitely not sent', async () => {
  const test = await fixture(initialize)
  for (const action of ['cancel', 'close', 'hold']) {
    const client = await CodexDesktopIpc.connect(test.options), controller = new AbortController()
    const expected = { threadId: randomUUID(), clientId: ownerId, supportsUntrustedAppInput: true,
      revision: 0, status: 'idle' as const, pendingRequests: 0, workspaceKind: 'project', permissionsKnown: true,
      permissionsHash: 'permissions', settingsHash: 'settings' }
    vi.spyOn(client, 'readState').mockImplementation(async () => {
      if (action === 'cancel') controller.abort()
      else if (action === 'close') client.close()
      return expected
    })
    await expect(client.startText(expected, 'Test only', randomUUID(), controller.signal, () => action !== 'hold'))
      .rejects.toThrow(action === 'cancel' ? 'cancelled' : action === 'close' ? 'not-connected' : 'delivery-held')
    client.close()
  }
  expect(test.received.filter(message => message.method === 'thread-follower-start-turn')).toEqual([])
})
