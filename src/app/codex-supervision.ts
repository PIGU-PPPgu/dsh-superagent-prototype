/** Durable review of every managed Codex response, independent of the summary classifier. */
import type { CodexControl, CodexControlIntent, CodexManagedResponse } from './codex-control.ts'
import type { CodexMonitor } from './codex-monitor.ts'
import { isCodexUserRequest } from '../codex/project-context.ts'

interface SupervisionHost {
  control: Pick<CodexControl, 'view' | 'observeManagedTurn' | 'observeManagedResponse' | 'notifyManagedReview' | 'decideManagedReview'>
  monitor: Pick<CodexMonitor, 'supervisionSnapshot'>
  paused(): boolean
  relay(id: string, text: string): void
  now?: () => Date
}
const open = (intent: CodexControlIntent): boolean => intent.status === 'sent' && !!intent.supervision
  && ['awaitingReply', 'needsReview', 'waiting'].includes(intent.supervision.phase)
const terminal = new Set(['completed', 'failed', 'interrupted'])

/** Tracks managed replies until DSH continues, completes, waits or stops the goal. */
export class CodexSupervision {
  constructor(private readonly host: SupervisionHost) {}

  refresh(): void {
    if (this.host.paused() || !this.host.control.view().enabled) return
    for (const intent of this.host.control.view().intents.filter(open)) {
      if (!intent.turnId || !intent.delegation) continue
      const snapshot = this.host.monitor.supervisionSnapshot(intent.threadId)
      if (!snapshot?.head.present || snapshot.head.threadId !== intent.threadId || snapshot.head.archived || !snapshot.head.ready) continue
      if (snapshot.head.pausedByUser || snapshot.head.needsYou) continue
      const sameTurn = snapshot.latestTurnId === intent.turnId
      const seen = sameTurn || snapshot.messages.some(message => message.turnId === intent.turnId)
      if (seen && !intent.supervision?.observedTurn) this.host.control.observeManagedTurn(intent.id)
      const changedHead = !!snapshot.head.lastItemId && snapshot.head.lastItemId !== intent.basedOnItemId
      const newUser = snapshot.messages.some(message => message.role === 'user' && message.turnId === snapshot.latestTurnId
        && message.turnId !== intent.turnId && isCodexUserRequest(message.text))
      if (!sameTurn && changedHead && (seen || intent.supervision?.observedTurn) && newUser) {
        this.host.control.decideManagedReview(intent.id, undefined, 'stop', '原会话出现新的用户指令，停止旧目标的自动续接')
        continue
      }
      if (changedHead && terminal.has(snapshot.latestTurnStatus ?? '') && snapshot.latestTurnId
        && sameTurn) {
        const assistant = [...snapshot.messages].reverse().find(message => message.role === 'assistant' && message.turnId === snapshot.latestTurnId)
        if (assistant || snapshot.latestTurnStatus !== 'completed') {
          const response: CodexManagedResponse = { itemId: assistant?.id ?? snapshot.latestTurnId,
            turnId: snapshot.latestTurnId, headItemId: snapshot.head.lastItemId!,
            text: assistant?.text.slice(0, 1200) ?? `Stored turn ended as ${snapshot.latestTurnStatus} without a visible assistant reply.`,
            status: snapshot.latestTurnStatus!, kind: 'reply',
            observedAt: (this.host.now?.() ?? new Date()).toISOString() }
          this.host.control.observeManagedResponse(intent.id, response)
        }
      }
      if (snapshot.head.pausedByUser || snapshot.head.needsYou) continue
      this.host.control.notifyManagedReview(intent.id, value => {
        const review = value.supervision!, response = review.response!
        this.host.relay(`codex-review:${value.id}:${response.itemId}:${review.notifications}`,
          JSON.stringify({ kind: 'codex_managed_reply', intentId: value.id, threadId: value.threadId,
            sentTurnId: value.turnId, goal: value.delegation!.goal, doneWhen: value.delegation!.doneWhen,
            lastAction: value.delegation!.action, response, heldByUser: !!snapshot.head.pausedByUser,
            needsHuman: snapshot.head.needsYou,
            instruction: 'Review this response against the overall goal and doneWhen. A completed turn is not a completed project. If unmet, read fresh context/status and followup with intent_id and response_item_id; preserve goal/done_when. Otherwise review complete, wait or stop with a concrete reason. Never blindly send continue, approve, lift a hold or repeat an uncertain delivery.' }))
      }, () => {
        const head = this.host.monitor.supervisionSnapshot(intent.threadId)?.head
        return !this.host.paused() && !!head?.present && head.threadId === intent.threadId && head.ready && !head.archived
          && !head.pausedByUser && !head.needsYou
      })
    }
  }

  continuation(threadId: string, intentId: string, responseItemId: string, headItemId: string): CodexControlIntent {
    let value = this.host.control.view().intents.find(intent => intent.id === intentId)
    const response = value?.supervision?.response
    const snapshot = this.host.monitor.supervisionSnapshot(threadId)
    if (value && response?.itemId === responseItemId && response.headItemId !== headItemId
      && snapshot?.head.lastItemId === headItemId && snapshot.latestTurnId === response.turnId
      && terminal.has(snapshot.latestTurnStatus ?? '')
      && [...snapshot.messages].reverse().find(message => message.role === 'assistant' && message.turnId === response.turnId)?.id === responseItemId) {
      this.host.control.observeManagedResponse(intentId, { ...response, headItemId })
      value = this.host.control.view().intents.find(intent => intent.id === intentId)
    }
    const currentResponse = value?.supervision?.response
    if (!value || value.threadId !== threadId || !open(value) || !currentResponse || currentResponse.itemId !== responseItemId
      || currentResponse.headItemId !== headItemId || snapshot?.head.threadId !== threadId || snapshot.head.lastItemId !== headItemId) {
      throw new Error('Managed response is stale or already handled; read the current head and reply')
    }
    return value
  }

  review(intentId: string, responseItemId: string | undefined, decision: 'complete' | 'wait' | 'stop', reason: string, retryAfter?: number): CodexControlIntent {
    const value = this.host.control.view().intents.find(intent => intent.id === intentId)
    if (!value || !open(value)) throw new Error('Managed step was already handled')
    const response = value.supervision!.response
    if (response && decision !== 'stop') this.continuation(value.threadId, intentId, responseItemId ?? '',
      this.host.monitor.supervisionSnapshot(value.threadId)?.head.lastItemId ?? response.headItemId)
    return this.host.control.decideManagedReview(intentId, responseItemId, decision, reason, retryAfter)
  }
}
