/** In-process execution of DSH-authored Codex follow-ups through the Desktop owner. */
import { CodexDesktopIpc, CodexDesktopIpcError, type CodexDesktopState } from '../codex/desktop-ipc.ts'
import { isCodexVerification, type CodexControl, type CodexControlIntent } from './codex-control.ts'
import type { CodexMonitor } from './codex-monitor.ts'

type Client = Pick<CodexDesktopIpc, 'readState' | 'startText' | 'interruptTurn' | 'close'>
interface DeliveryHost {
  control: Pick<CodexControl, 'view' | 'setBridgeAvailable' | 'claim' | 'finish' | 'releaseUnsent' | 'setEnabled'>
  monitor: Pick<CodexMonitor, 'routeHead' | 'readHistory'>
  signal: AbortSignal
  paused(): boolean
  relay(id: string, text: string): void
  connect?(signal: AbortSignal): Promise<Client>
}

/** One bounded delivery per DSH scan or router request; no external agent or scheduled chat is involved. */
export class CodexDelivery {
  private readonly controller = new AbortController()
  private readonly signal: AbortSignal
  private running?: Promise<void>
  private problem?: string
  private readonly checked = new Set<string>()
  constructor(private readonly host: DeliveryHost) {
    this.signal = AbortSignal.any([host.signal, this.controller.signal])
  }
  request(): Promise<void> {
    if (this.signal.aborted || this.host.paused()) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.run().catch(error => {
      this.host.control.setBridgeAvailable(false)
      if (this.signal.aborted) return
      const code = error instanceof CodexDesktopIpcError ? error.code : 'adapter-unavailable'
      if (this.host.control.view().enabled && this.problem !== code) {
        this.problem = code
        this.host.relay(`codex-adapter:${code}`, JSON.stringify({ kind: 'codex_delivery', status: 'unavailable', error: code }))
      }
    }).finally(() => { this.running = undefined })
    return this.running
  }
  async stop(): Promise<void> { this.controller.abort(); await this.running }

  private notice(intent: CodexControlIntent, status: string, detail: Record<string, unknown> = {}): void {
    this.host.relay(`codex-delivery:${intent.id}:${status}`, JSON.stringify({ kind: 'codex_delivery',
      threadId: intent.threadId, intentId: intent.id, status, ...detail }))
  }
  private failQueued(intent: CodexControlIntent, error: string): void {
    if (!this.host.control.view().enabled || this.host.paused()) return
    const claimed = this.host.control.claim(intent.id)
    this.host.control.finish(claimed.id, 'failed', { error })
    this.notice(claimed, 'failed', { error })
  }
  private async run(): Promise<void> {
    const connect = () => this.host.connect?.(this.signal) ?? CodexDesktopIpc.connect({ signal: this.signal })
    let client = await connect()
    try {
      this.signal.throwIfAborted()
      this.host.control.setBridgeAvailable(true); this.problem = undefined
      const view = this.host.control.view()
      if (!view.enabled || this.host.paused()) return
      const queued = view.intents.filter(item => item.status === 'queued')
      const pending = new Set(queued.map(item => item.id))
      for (const id of this.checked) if (!pending.has(id)) this.checked.delete(id)
      if (queued.every(item => this.checked.has(item.id))) this.checked.clear()
      // Cycle through held conversations so an unavailable owner cannot block later work.
      for (const intent of queued.filter(item => !this.checked.has(item.id)).slice(0, 8)) {
        this.checked.add(intent.id)
        const verification = isCodexVerification(intent)
        if (intent.operation === 'verify' && !verification) { this.failQueued(intent, 'invalid-verification'); return }
        const head = this.host.monitor.routeHead(intent.threadId)
        if (verification && (!intent.verificationRequestId || head?.verificationRequestId !== intent.verificationRequestId)) {
          this.failQueued(intent, 'verification-request-changed'); return
        }
        if (!head?.present || head.archived || !head.ready || head.pausedByUser
          || head.needsYou && !verification || head.lastItemId !== intent.basedOnItemId) {
          this.failQueued(intent, head?.needsYou ? 'person-required' : 'stale-history-head'); return
        }
        let state: CodexDesktopState | undefined
        try { state = await client.readState(intent.threadId, this.signal) }
        catch (error) {
          if (!(error instanceof CodexDesktopIpcError)
            || !['request-timeout', 'snapshot-timeout', 'no-client-found', 'client-disconnected'].includes(error.code)
            || this.signal.aborted) throw error
          client.close(); client = await connect(); continue
        }
        if (!state || state.pendingRequests) continue
        const interrupt = intent.operation === 'interrupt'
        if (!interrupt && state.status === 'active') continue
        if (interrupt && (state.status !== 'active' || state.activeTurnId !== intent.expectedTurnId)) {
          this.failQueued(intent, 'stale-active-turn'); return
        }
        if ((!interrupt && state.status !== 'idle') || !state.permissionsKnown || state.workspaceKind !== 'project') {
          this.failQueued(intent, 'unsupported-desktop-state'); return
        }
        const history = await this.host.monitor.readHistory(intent.threadId, 1, this.signal)
        if (history.headItemId !== intent.basedOnItemId) { this.failQueued(intent, 'stale-history-head'); return }
        if (!this.host.control.view().enabled || this.signal.aborted || this.host.paused()) return
        const claimed = this.host.control.claim(intent.id)
        try {
          const canSend = () => {
            const current = this.host.monitor.routeHead(intent.threadId)
            return !this.signal.aborted && !this.host.paused() && this.host.control.view().enabled
              && !!current?.present && !current.archived && current.ready && !current.pausedByUser
              && (!verification || current.verificationRequestId === intent.verificationRequestId)
              && (!current.needsYou || verification) && current.lastItemId === intent.basedOnItemId
          }
          const result = interrupt ? await client.interruptTurn(state, this.signal, canSend)
            : await client.startText(state, claimed.text, claimed.deliveryId!, this.signal, canSend)
          this.host.control.finish(claimed.id, 'sent', { turnId: result.turnId })
          if (result.settingsPreserved !== true) this.host.control.setEnabled(false)
          this.notice(claimed, interrupt ? 'interrupted' : 'sent', { turnId: result.turnId, settingsVerified: result.settingsPreserved === true,
            ...('runtimeRootsChanged' in result && result.runtimeRootsChanged ? { runtimeRootsChanged: true } : {}),
            ...(result.settingsPreserved === true ? {} : { controlDisabled: true }) })
        } catch (error) {
          const code = error instanceof CodexDesktopIpcError ? error.code : 'delivery-uncertain'
          if (code === 'delivery-held') {
            this.host.control.releaseUnsent(claimed.id)
          } else if (['thread-state-changed', 'cancelled', 'not-connected', 'invalid-message', 'invalid-turn-id'].includes(code)) {
            this.host.control.finish(claimed.id, 'failed', { error: code })
            if (!this.signal.aborted) this.notice(claimed, 'failed', { error: code })
          } else {
            this.notice(claimed, 'uncertain', { error: 'delivery-uncertain', userAction: 'Verify the target conversation before routing again' })
          }
        }
        return
      }
    } finally { client.close() }
  }
}
