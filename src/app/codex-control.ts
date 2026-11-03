/** Durable Codex control intents. A separate, native Codex bridge executes queued intents. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { lockSync } from 'proper-lockfile'
import { CodexIdSchema } from '../codex/model.ts'
import { key } from '../core/index.ts'
import { record } from '../kv.ts'
import type { Store } from './store.ts'

export type CodexControlStatus = 'queued' | 'dispatching' | 'sent' | 'failed' | 'cancelled'
export interface CodexControlIntent {
  id: string
  threadId: string
  basedOnItemId: string
  text: string
  reason: string
  priority: number
  status: CodexControlStatus
  source: 'router' | 'panel'
  createdAt: string
  updatedAt: string
  error?: string
}
interface ControlState { version: 1; enabled: boolean; intents: Record<string, CodexControlIntent> }
export interface CodexControlView {
  enabled: boolean
  bridgeReady: boolean
  bridgeSeenAt?: string
  intents: CodexControlIntent[]
}
const ControlKey = record<ControlState>('codex-control-v1')
const Receipt = z.object({ version: z.literal(1), intentId: z.string().regex(/^[a-f0-9]{32}$/),
  threadId: CodexIdSchema, status: z.enum(['dispatching', 'sent', 'failed']),
  at: z.iso.datetime({ offset: true }), error: z.string().max(300).optional() }).strict()
const Bridge = z.object({ version: z.literal(1), at: z.iso.datetime({ offset: true }),
  sendMessage: z.literal(true) }).strict()
const initial = (): ControlState => ({ version: 1, enabled: false, intents: {} })
const active = (status: CodexControlStatus): boolean => status === 'queued' || status === 'dispatching'

/** Persists bounded follow-up intents and reconciles receipts from a separate native Codex bridge. */
export class CodexControl {
  readonly directory: string
  private readonly receipts: string
  constructor(private readonly deps: { store: Pick<Store, 'get' | 'set' | 'atomic' | 'tickets' | 'triggers'>; stateDir: string;
    now?: () => Date }) {
    this.directory = join(deps.stateDir, 'codex-control')
    this.receipts = join(this.directory, 'receipts')
    for (const path of [this.directory, this.receipts]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || process.platform !== 'win32' && (stat.mode & 0o077
          || typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw new Error('Codex control directory must be private and owned by this user')
      }
    }
    this.sync()
  }
  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString() }
  private state(): ControlState { return this.deps.store.get(ControlKey) ?? initial() }
  private save(state: ControlState): void { this.deps.store.set(ControlKey, state) }
  private ownedThreads(): Set<string> {
    return new Set(this.deps.store.tickets.open().flatMap(ticket => {
      const origin = this.deps.store.triggers.get(ticket.origin.triggerId)
      return origin?.source === 'codex' && typeof origin.meta.threadId === 'string' ? [origin.meta.threadId] : []
    }))
  }
  private locked<T>(run: () => T): T {
    const release = lockSync(this.directory, { stale: 30_000 })
    try { return run() } finally { release() }
  }

  view(): CodexControlView {
    const bridge = this.bridge()
    return { enabled: this.state().enabled, bridgeReady: !!bridge,
      ...(bridge ? { bridgeSeenAt: bridge.at } : {}), intents: Object.values(this.state().intents)
        .sort((a, b) => Number(active(b.status)) - Number(active(a.status)) || b.priority - a.priority
          || b.createdAt.localeCompare(a.createdAt)) }
  }
  setEnabled(enabled: boolean): CodexControlView {
    return this.locked(() => {
      this.syncUnlocked()
      this.deps.store.atomic(() => {
        const state = this.state(), at = this.now()
        const intents = enabled ? state.intents : Object.fromEntries(Object.entries(state.intents).map(([id, intent]) =>
          [id, intent.status === 'queued' ? { ...intent, status: 'cancelled' as const, updatedAt: at } : intent]))
        this.save({ ...state, enabled, intents })
      })
      this.writeQueue()
      return this.view()
    })
  }
  enqueue(input: { threadId: string; basedOnItemId: string; text: string; reason: string; priority?: number;
    source: 'router' | 'panel' }): CodexControlIntent {
    const threadId = CodexIdSchema.parse(input.threadId)
    const basedOnItemId = CodexIdSchema.parse(input.basedOnItemId)
    const text = z.string().trim().min(1).max(1000).parse(input.text)
    const reason = z.string().trim().min(1).max(300).parse(input.reason)
    const priority = z.number().int().min(0).max(3).parse(input.priority ?? 1)
    return this.locked(() => {
      this.syncUnlocked()
      const result = this.deps.store.atomic(() => {
        const state = this.state(), matches = Object.values(state.intents).filter(intent => intent.threadId === threadId
          && intent.basedOnItemId === basedOnItemId && intent.text === text)
        if (this.ownedThreads().has(threadId)) throw new Error('An active DSH Ticket owns this Codex conversation')
        const existing = matches.find(intent => active(intent.status) || intent.status === 'sent')
        if (existing) return existing
        if (Object.values(state.intents).some(intent => intent.threadId === threadId && active(intent.status))) {
          throw new Error('This Codex conversation already has a pending router intent')
        }
        const id = key('codex-control-followup', threadId, basedOnItemId, text, String(matches.length))
        const at = this.now()
        const intent: CodexControlIntent = { id, threadId, basedOnItemId, text, reason,
          priority, status: 'queued', source: input.source, createdAt: at, updatedAt: at }
        this.save({ ...state, intents: { ...state.intents, [id]: intent } })
        return intent
      })
      this.writeQueue()
      return result
    })
  }
  reorder(id: string, priority: number): CodexControlIntent {
    z.number().int().min(0).max(3).parse(priority)
    return this.locked(() => {
      this.syncUnlocked()
      const intent = this.update(id, value => {
        if (value.status !== 'queued') throw new Error('Only queued Codex work can be reordered')
        return { ...value, priority, updatedAt: this.now() }
      })
      this.writeQueue()
      return intent
    })
  }
  cancel(id: string): CodexControlIntent {
    return this.locked(() => {
      this.syncUnlocked()
      const intent = this.update(id, value => {
        if (value.status !== 'queued') throw new Error('Only queued Codex work can be cancelled')
        return { ...value, status: 'cancelled', updatedAt: this.now() }
      })
      this.writeQueue()
      return intent
    })
  }
  private update(id: string, change: (value: CodexControlIntent) => CodexControlIntent): CodexControlIntent {
    return this.deps.store.atomic(() => {
      const state = this.state(), before = state.intents[id]
      if (!before) throw new Error('Unknown Codex router intent')
      const after = change(before)
      this.save({ ...state, intents: { ...state.intents, [id]: after } })
      return after
    })
  }
  /** Reconcile native bridge receipts. A dispatching intent is never resent after an uncertain send. */
  sync(): void { this.locked(() => this.syncUnlocked()) }
  private syncUnlocked(): void {
    for (const name of readdirSync(this.receipts)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue
      const path = join(this.receipts, name)
      if (!lstatSync(path).isFile()) continue
      let receipt: z.infer<typeof Receipt>
      try { receipt = Receipt.parse(JSON.parse(readFileSync(path, 'utf8'))) } catch { continue }
      this.deps.store.atomic(() => {
        const state = this.state(), before = state.intents[receipt.intentId]
        if (!before || before.threadId !== receipt.threadId || !active(before.status)
          || Date.parse(receipt.at) < Date.parse(before.createdAt)) return
        const status = receipt.status
        this.save({ ...state, intents: { ...state.intents,
          [before.id]: { ...before, status, updatedAt: receipt.at,
            ...(receipt.error ? { error: receipt.error } : {}) } } })
      })
    }
    const owned = this.ownedThreads(), current = this.state()
    if (owned.size && Object.values(current.intents).some(intent => owned.has(intent.threadId) && intent.status === 'queued')) {
      const at = this.now()
      this.deps.store.atomic(() => this.save({ ...current, intents: Object.fromEntries(Object.entries(current.intents).map(([id, intent]) =>
        [id, owned.has(intent.threadId) && intent.status === 'queued'
          ? { ...intent, status: 'cancelled' as const, updatedAt: at, error: 'A DSH Ticket owns this conversation' } : intent])) }))
    }
    this.writeQueue()
  }
  private writeQueue(): void {
    const state = this.state()
    const actions = state.enabled ? Object.values(state.intents).filter(intent => intent.status === 'queued')
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt)) : []
    const destination = join(this.directory, 'queue.json')
    const temporary = `${destination}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, generatedAt: this.now(), actions }) + '\n',
      { mode: 0o600, flag: 'wx' })
    renameSync(temporary, destination)
  }
  private bridge(): z.infer<typeof Bridge> | undefined {
    const path = join(this.directory, 'bridge.json')
    if (!existsSync(path) || !lstatSync(path).isFile()) return undefined
    try {
      const value = Bridge.parse(JSON.parse(readFileSync(path, 'utf8')))
      const age = (this.deps.now?.().getTime() ?? Date.now()) - Date.parse(value.at)
      return age >= 0 && age < 10 * 60_000 ? value : undefined
    } catch { return undefined }
  }
}
