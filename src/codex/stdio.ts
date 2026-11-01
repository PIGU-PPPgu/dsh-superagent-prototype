/** Mac-local, read-only JSON-RPC transport to a separately started Codex App Server. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { CodexReadRpc } from './app-server.ts'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
const READ_METHODS = new Set(['thread/read', 'thread/turns/list'])

/** Starts a separate App Server, so its runtime status is never authoritative for Codex Desktop turns. */
export class CodexStdioReadRpc implements CodexReadRpc {
  private readonly lines: Interface
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  private ready = false

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs: number) {
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', line => {
      let message: unknown
      try { message = JSON.parse(line) as unknown }
      catch { this.failAll('Codex App Server returned invalid JSON'); return }
      if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      pending.cleanup()
      if ('error' in message && message.error != null) pending.reject(new Error('Codex App Server rejected a read request'))
      else if ('result' in message) pending.resolve(message.result)
      else pending.reject(new Error('Codex App Server returned an invalid response'))
    })
    child.on('error', () => this.failAll('Codex App Server connection failed'))
    child.on('exit', () => this.failAll('Codex App Server exited'))
    child.stdin.on('error', () => this.failAll('Codex App Server input closed'))
    child.stderr.resume() // Never forward potentially sensitive process diagnostics to DSH.
  }

  static async connect(options: { command?: string; args?: string[]; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CodexStdioReadRpc> {
    if (options.signal?.aborted) throw new Error('Codex read cancelled')
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Codex RPC timeout must be 1-60000 ms')
    const child = spawn(options.command ?? 'codex', options.args ?? ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    const rpc = new CodexStdioReadRpc(child, timeoutMs)
    try {
      await rpc.call('initialize', { clientInfo: { name: 'dsh_superagent_read', title: 'DSH read-only Codex bridge', version: '0.1.0' } }, options.signal)
      rpc.send({ method: 'initialized', params: {} })
      rpc.ready = true
      return rpc
    } catch {
      rpc.close()
      throw new Error('Codex App Server read connection unavailable')
    }
  }

  request(method: 'thread/read' | 'thread/turns/list', params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!this.ready || !READ_METHODS.has(method)) return Promise.reject(new Error('Codex read-only RPC rejected the method'))
    return this.call(method, params, signal)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll('Codex App Server read connection closed')
    this.lines.close()
    this.child.stdin.end()
    this.child.kill('SIGTERM')
  }

  private call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Codex App Server read connection unavailable'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id); pending.cleanup(); reject(new Error('Codex App Server read timed out'))
      }, this.timeoutMs)
      const abort = () => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id); pending.cleanup(); reject(new Error('Codex App Server read cancelled'))
      }
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      try { this.send({ id, method, params }) }
      catch { this.pending.delete(id); cleanup(); reject(new Error('Codex App Server read connection unavailable')) }
    })
  }

  private send(message: unknown): void {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex App Server read connection unavailable')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private failAll(message: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(new Error(message))
    }
  }
}
