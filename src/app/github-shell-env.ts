/** Give DSH's built-in shell tools the GitHub binding of their calling worker Session. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ticketOfSession } from '../executor/dsh.ts'
import type { Store } from './store.ts'

export const GITHUB_BINDING_ENV = 'DSH_SUPERAGENT_GITHUB_BINDING'
interface ShellEnvService {
  register(contributor: { name: string; variables: Record<string, { description: string }>;
    resolve(execution: ToolExecution): Readonly<Partial<Record<string, string>>> }): () => void
}

/** The DSH shell-env service resolves this value for every bash/pwsh call, including worker subagents. */
export function registerGithubShellEnv(ctx: Context, store: Pick<Store, 'tickets' | 'triggers'>, masterId: string): void {
  ctx.inject(['shellEnv'], child => {
    const shellEnv = (child as Context & { shellEnv: ShellEnvService }).shellEnv
    child.effect(() => shellEnv.register({ name: 'dsh-superagent-github-binding',
      variables: { [GITHUB_BINDING_ENV]: { description: 'GitHub repository and account binding of this Superagent Session' } },
      resolve(execution) {
        const agent = execution.agent
        if (!agent) return {}
        if (agent.id === masterId) return { [GITHUB_BINDING_ENV]: 'default' }
        let parent: string | undefined = agent.id
        for (let depth = 0; parent && !ticketOfSession(parent) && depth < 8; depth++) {
          parent = ctx.agents.get(parent as typeof agent.id)?.session.header.parentSession
        }
        const ticketId = parent && ticketOfSession(parent)
        if (!ticketId) return {}
        const ticket = store.tickets.get(ticketId)
        if (!ticket) return { [GITHUB_BINDING_ENV]: 'unavailable' }
        const origin = store.triggers.get(ticket.origin.triggerId)
        return { [GITHUB_BINDING_ENV]: origin?.source === 'github' && typeof origin.meta.bindingId === 'string'
          ? origin.meta.bindingId : 'default' }
      },
    }))
  })
}
