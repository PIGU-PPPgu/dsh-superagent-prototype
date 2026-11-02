/** A GitHub Source context confined to one configured repository and CLI identity. */
import type { Thread, ThreadRef, Ticket } from '../core/index.ts'
import { record, type Family, type Key } from '../kv.ts'
import type { SourceContext } from './host.ts'

export interface GithubContext extends SourceContext { readonly bindingId?: string }

export function githubBindingContext(ctx: SourceContext, bindingId?: string): GithubContext {
  const binding = bindingId ? ctx.deployment.githubBindings?.[bindingId] : undefined
  if (bindingId && !binding) throw new Error(`GitHub binding ${bindingId} is unavailable`)
  const statePrefix = bindingId ? `github-binding:${bindingId}:` : ''
  const threadPrefix = bindingId ? `github:${bindingId}:` : 'github:'
  const refPrefix = bindingId ? `${bindingId}:` : ''
  const primaryRef = (id: string): boolean => /^\d+$/.test(id) || id.startsWith('ci:')
  const belongsRef = (id: string): boolean => bindingId ? id.startsWith(refPrefix) : primaryRef(id)
  const actualRef = (ref: ThreadRef): ThreadRef => ref.source === 'github' && bindingId
    ? { ...ref, id: `${refPrefix}${ref.id}` } : ref
  const localRef = (ref: ThreadRef): ThreadRef => ref.source === 'github' && bindingId
    ? { ...ref, id: ref.id.slice(refPrefix.length) } : ref
  const actualKey = (key: string): string => bindingId && key.startsWith('github:')
    ? `${threadPrefix}${key.slice('github:'.length)}` : key
  const localKey = (key: string): string => bindingId && key.startsWith(threadPrefix)
    ? `github:${key.slice(threadPrefix.length)}` : key
  const localThread = (thread: Thread): Thread => ({ ...thread, key: localKey(thread.key), ref: localRef(thread.ref) })
  const belongsTicket = (ticket: Ticket): boolean => {
    const origin = ctx.triggers.get(ticket.origin.triggerId)
    if (origin?.source === 'github') return origin.meta.bindingId === bindingId
    return !bindingId || (ticket.follows ?? []).some(follow => follow.thread.startsWith(threadPrefix))
  }
  const localTicket = (ticket: Ticket): Ticket => ({ ...ticket,
    follows: (ticket.follows ?? []).filter(follow => !follow.thread.startsWith('github:')
      || belongsRef(follow.thread.slice('github:'.length))).map(follow => ({ ...follow,
      thread: follow.thread.startsWith('github:') ? localKey(follow.thread) : follow.thread })) })
  const scoped = <V>(key: Key<V>): Key<V> => statePrefix ? record<V>(statePrefix + key) : key
  return {
    bindingId,
    get deployment() { return binding ? { ...ctx.deployment, ...binding } : ctx.deployment },
    commands: bindingId ? ctx.commands.forBinding(bindingId) : ctx.commands,
    ready: ctx.ready, configured: () => ctx.configured(),
    get problem() { return ctx.problem }, config: id => ctx.config(id), receive: trigger => ctx.receive(trigger),
    atomic: work => ctx.atomic(work),
    state: {
      get: key => ctx.state.get(scoped(key)),
      set: (key, value) => ctx.state.set(scoped(key), value),
      keys: family => {
        if (!statePrefix) return ctx.state.keys(family)
        const mapped = Object.assign((() => undefined) as unknown as Family<never, never>,
          { prefix: statePrefix + family.prefix })
        return ctx.state.keys(mapped).map(key => record(String(key).slice(statePrefix.length)))
      },
    },
    threads: {
      get: key => { const thread = ctx.threads.get(actualKey(key)); return thread && localThread(thread) },
      subscribed: source => ctx.threads.subscribed(source).filter(thread => source !== 'github'
        || belongsRef(thread.ref.id)).map(localThread),
      describe: (key, description) => ctx.threads.describe(actualKey(key), description),
      patch: (key, meta) => ctx.threads.patch(actualKey(key), meta),
    },
    tickets: {
      get: id => { const ticket = ctx.tickets.get(id); return ticket && belongsTicket(ticket) ? localTicket(ticket) : undefined },
      open: () => ctx.tickets.open().filter(belongsTicket).map(localTicket),
      bindThread: (id, ref, own) => ctx.tickets.bindThread(id, actualRef(ref), own),
      threadClosed: (ref, outcome, at) => ctx.tickets.threadClosed(actualRef(ref), outcome, at),
    },
    triggers: { get: id => ctx.triggers.get(id), latest: thread => ctx.triggers.latest(actualKey(thread)) },
    notify: message => ctx.notify(message), report: (entry, health) => ctx.report(entry, health),
  }
}
