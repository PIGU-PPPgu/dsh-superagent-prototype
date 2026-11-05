/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexFileMonitor } from '../codex/file-bridge.ts'
import { CodexDesktopIpc } from '../codex/desktop-ipc.ts'
import { CodexMonitor, type CodexAutoHandoffResult, type CodexFailureCandidate } from './codex-monitor.ts'
import { CodexRouter } from './codex-router.ts'
import { CodexControl } from './codex-control.ts'
import { CodexDelivery } from './codex-delivery.ts'
import { CodexSupervision } from './codex-supervision.ts'
import { registerGithubShellEnv } from './github-shell-env.ts'
import { lockSync } from 'proper-lockfile'
import { Engine, key, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { githubBindingOf } from '../sources/github-binding.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, workerSessionId } from '../executor/dsh.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  private readonly codexPanel?: CodexFileMonitor
  private readonly codexMonitor: CodexMonitor
  readonly codexRouter: CodexRouter
  readonly codexControl: CodexControl
  private readonly codexDelivery: CodexDelivery
  private readonly codexSupervision: CodexSupervision
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      this.codexControl = new CodexControl({ store, stateDir: machine.stateDir })
      this.codexMonitor = new CodexMonitor({ store, context: ctx,
        autoHandoff: (candidate, signal) => this.intakeCodexFailure(candidate, signal),
        onScan: () => { try { this.codexControl.sync(); this.codexSupervision.refresh(); this.codexRouter.refresh(); void this.codexDelivery.request().catch(report) }
          catch (error) { ctx.logger.warn('dsh-superagent Codex Router refresh failed: %s', String(error)) } } })
      this.codexRouter = new CodexRouter({ store, monitor: this.codexMonitor,
        relay: (id, text) => this.sessions.relay(id, text) })
      this.codexSupervision = new CodexSupervision({ control: this.codexControl, monitor: this.codexMonitor,
        paused: () => this.paused() || !this.codexMonitor.view(0, 1).enabled,
        relay: (id, text) => this.sessions.relay(id, text) })
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      registerGithubShellEnv(ctx, store, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const defaultCodexDir = join(homedir(), '.dsh', 'state', 'codex-readonly')
      const configuredWatchlist = process.env.DSH_SUPERAGENT_CODEX_WATCHLIST
      const configuredSnapshot = process.env.DSH_SUPERAGENT_CODEX_SNAPSHOT
      const defaultsPresent = !configuredWatchlist && !configuredSnapshot
        && existsSync(join(defaultCodexDir, 'watchlist.json')) && existsSync(join(defaultCodexDir, 'snapshot.json'))
      const codexWatchlist = configuredWatchlist ?? (defaultsPresent ? join(defaultCodexDir, 'watchlist.json') : undefined)
      const codexSnapshot = configuredSnapshot ?? (defaultsPresent ? join(defaultCodexDir, 'snapshot.json') : undefined)
      const codex = codexWatchlist && codexSnapshot ? new CodexFileMonitor(codexWatchlist, codexSnapshot) : undefined
      this.codexPanel = codexWatchlist && codexSnapshot ? new CodexFileMonitor(codexWatchlist, codexSnapshot) : undefined
      if (!!codexWatchlist !== !!codexSnapshot) ctx.logger.warn('dsh-superagent Codex read-only adapter needs both DSH_SUPERAGENT_CODEX_WATCHLIST and DSH_SUPERAGENT_CODEX_SNAPSHOT')
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      this.codexDelivery = new CodexDelivery({ control: this.codexControl, monitor: this.codexMonitor, signal: this.lifetime,
        paused: () => this.paused() || this.closing() || !this.codexMonitor.view(0, 1).enabled,
        relay: (id, text) => sessions.relay(id, text) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources, trigger => {
        const grant = store.get(KV.codex.intake(trigger.id))
        const head = typeof trigger.meta.threadId === 'string' ? this.codexMonitor.routeHead(trigger.meta.threadId) : undefined
        return trigger.meta.codexAutoIntake === true && !!grant
          && grant.threadId === trigger.meta.threadId && grant.itemId === trigger.meta.itemId
          && trigger.id === key('codex-handoff', grant.threadId, grant.itemId)
          && grant.generation === this.codexMonitor.handoffGeneration()
          && !!head?.present && !head.archived && head.ready && !head.needsYou
          && head.assessmentItemId === grant.itemId && (head.stage === 'failed' || head.stage === 'blocked')
      })
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const codexEvent = event.type === 'ticket.ended'
            ? store.triggers.get(store.tickets.get(event.data.ticketId)?.origin.triggerId ?? '')?.source === 'codex'
            : event.type === 'trigger.requeued'
              ? store.triggers.get(event.data.triggerId)?.source === 'codex'
              : event.type === 'thread.unsubscribed' && event.data.threadKey.startsWith('codex:')
          const notice = this.quiet || codexEvent ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          const codexFollowup = (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
            && store.triggers.get(event.data.triggerId)?.source === 'codex'
          if (followup && !codexFollowup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            const origin = store.triggers.get(ended.origin.triggerId)
            const bindingId = origin?.source === 'github' && typeof origin.meta.bindingId === 'string'
              ? origin.meta.bindingId : undefined
            const repository = bindingId ? setup.deployment.githubBindings?.[bindingId]?.repository : setup.deployment.repository
            if (origin?.source !== 'codex' && repository) {
              for (const message of pullEndNotices(ended, request, repository)) outbox.send(message)
            }
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        codexMonitor: this.codexMonitor, codexControl: this.codexControl, codexSupervision: this.codexSupervision,
        codexDesktopStatus: (threadId, caller) => this.codexDesktopStatus(threadId, caller),
        requestCodexDelivery: () => { void this.codexDelivery.request() },
        ...(codex ? { codex } : {}),
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, githubBindings: resolved.githubBindings,
      ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    const binding = trigger ? githubBindingOf(trigger) : undefined
    if (trigger?.source === 'codex' && !binding?.available) return ticketEnvironment({ deployment: {
      ...deployment, repository: '', github: { cli: '', login: '', noreply: '' }, githubBindings: {} },
      sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
    const selected = binding?.id ? deployment.githubBindings?.[binding.id] : undefined
    if (binding?.id && !selected) throw new Error(`GitHub binding ${binding.id} is unavailable for this ticket`)
    return ticketEnvironment({ deployment: selected ? { ...deployment, ...selected } : deployment,
      sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  private async codexDesktopStatus(threadId: string, caller: AbortSignal) {
    const head = this.codexMonitor.routeHead(threadId)
    if (!this.codexMonitor.view(0, 1).enabled || !head?.present) throw new Error('Codex main conversation is not monitored')
    const signal = AbortSignal.any([caller, this.lifetime])
    const client = await CodexDesktopIpc.connect({ signal })
    try {
      const state = await client.readState(threadId, signal)
      const control = this.codexControl.view()
      return { source: 'Codex Desktop owner', readAt: now(), available: !!state,
        messaging: { enabled: control.enabled, connected: control.bridgeReady },
        ...(state ? { status: state.status, pendingRequests: state.pendingRequests,
          ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}) } : {}) }
    } finally { client.close() }
  }
  /** Persist an authorized candidate; the main Session, not the monitor, decides what happens next. */
  private async intakeCodexFailure(candidate: CodexFailureCandidate, signal: AbortSignal): Promise<CodexAutoHandoffResult> {
    signal.throwIfAborted()
    if (this.closing() || this.paused()) return { waiting: true }
    const desktop = await this.codexDesktopStatus(candidate.threadId, signal)
    if (!desktop.available || desktop.status !== 'idle' || desktop.pendingRequests !== 0) return { waiting: true }
    const generation = this.codexMonitor.handoffGeneration()
    if (!generation) return { waiting: true }
    const { store } = this
    const deployment = this.setup.deployment
    const matchingBinding = Object.entries(deployment.githubBindings ?? {}).find(([, binding]) =>
      candidate.repository && sameName(binding.repository, candidate.repository))
    const githubBinding = candidate.repository && sameName(deployment.repository, candidate.repository)
      ? 'default' : matchingBinding?.[0] ?? 'unavailable'
    const workspaceMode = githubBinding === 'unavailable' ? 'analysis' : 'execute'
    const trigger: Trigger = {
      id: key('codex-handoff', candidate.threadId, candidate.itemId), source: 'codex',
      threads: [{ source: 'codex', id: key('codex-intake', candidate.threadId, candidate.itemId) }],
      actor: { source: 'codex', id: 'local-codex-monitor' }, human: false, addressed: 'direct',
      at: now(),
      text: JSON.stringify({ kind: candidate.stage === 'blocked' ? 'Codex historical technical blocker' : 'Codex historical failure',
        threadId: candidate.threadId, ...(candidate.turnId ? { turnId: candidate.turnId } : {}),
        title: candidate.title.slice(0, 200), summary: candidate.summary.slice(0, 300),
        evidence: candidate.evidence.slice(0, 200),
        messages: candidate.messages.slice(-6).map(message => ({ role: message.role, text: message.text.slice(0, 1_500) })) }),
      meta: { threadId: candidate.threadId, itemId: candidate.itemId, codexAutoIntake: true,
        ...(candidate.stage ? { stage: candidate.stage } : {}),
        ...(candidate.turnId ? { turnId: candidate.turnId } : {}),
        ...(candidate.repository ? { repository: candidate.repository } : {}), githubBinding, workspaceMode },
    }
    this.store.atomic(() => {
      store.set(KV.codex.intake(trigger.id), { threadId: candidate.threadId, itemId: candidate.itemId, generation })
      const received = this.passes.receive(trigger)
      if (received === 'filtered') throw new Error('Codex handoff was filtered by source scope')
    })
    return { triggerId: trigger.id }
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.codexMonitor.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      ...(this.codexPanel ? { codex: this.codexPanel } : {}),
      codexMonitor: this.codexMonitor,
      codexRouter: this.codexRouter,
      codexControl: this.codexControl,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      await this.codexMonitor.stop()
      await this.codexDelivery.stop()
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
