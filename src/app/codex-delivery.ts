/** In-process execution of DSH-authored Codex follow-ups through the Desktop owner. */
import { CodexDesktopIpc, CodexDesktopIpcError } from '../codex/desktop-ipc.ts'
import type { CodexControl, CodexControlIntent } from './codex-control.ts'
import type { CodexMonitor } from './codex-monitor.ts'

type Client = Pick<CodexDesktopIpc, 'readState' | 'startText' | 'close'>
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
    const client = await (this.host.connect?.(this.signal) ?? CodexDesktopIpc.connect({ signal: this.signal }))
    try {
      this.signal.throwIfAborted()
      this.host.control.setBridgeAvailable(true); this.problem = undefined
      const view = this.host.control.view()
      if (!view.enabled || this.host.paused()) return
      const intent = view.intents.find(item => item.status === 'queued')
      if (!intent) return
      const head = this.host.monitor.routeHead(intent.threadId)
      if (!head?.present || head.archived || !head.ready || head.needsYou || head.lastItemId !== intent.basedOnItemId) {
        this.failQueued(intent, head?.needsYou ? 'person-required' : 'stale-history-head'); return
      }
      const state = await client.readState(intent.threadId, this.signal)
      if (!state || state.status === 'active' || state.pendingRequests) return
      if (state.status !== 'idle' || !state.permissionsKnown || state.workspaceKind !== 'project') {
        this.failQueued(intent, 'unsupported-desktop-state'); return
      }
      const history = await this.host.monitor.readHistory(intent.threadId, 1, this.signal)
      if (history.headItemId !== intent.basedOnItemId) { this.failQueued(intent, 'stale-history-head'); return }
      if (!this.host.control.view().enabled || this.signal.aborted || this.host.paused()) return
      const claimed = this.host.control.claim(intent.id)
      try {
        const result = await client.startText(state, claimed.text, claimed.deliveryId!, this.signal,
          () => !this.signal.aborted && !this.host.paused() && this.host.control.view().enabled)
        this.host.control.finish(claimed.id, 'sent', { turnId: result.turnId })
        if (result.settingsPreserved !== true) this.host.control.setEnabled(false)
        this.notice(claimed, 'sent', { turnId: result.turnId, settingsVerified: result.settingsPreserved === true,
          ...(result.settingsPreserved === true ? {} : { controlDisabled: true }) })
      } catch (error) {
        const code = error instanceof CodexDesktopIpcError ? error.code : 'delivery-uncertain'
        if (code === 'delivery-held') {
          this.host.control.releaseUnsent(claimed.id)
        } else if (['thread-state-changed', 'cancelled', 'not-connected', 'invalid-message'].includes(code)) {
          this.host.control.finish(claimed.id, 'failed', { error: code })
          if (!this.signal.aborted) this.notice(claimed, 'failed', { error: code })
        } else {
          this.notice(claimed, 'uncertain', { error: 'delivery-uncertain', userAction: 'Verify the target conversation before routing again' })
        }
      }
    } finally { client.close() }
  }
}
