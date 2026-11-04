/**
 * Loopback client for the superagent management API (`/orchestrator/api`, see src/app/http.ts).
 * Every operation here is one the panel already exposes; the reporter adds no new privilege.
 */
export class OrchestratorError extends Error {
  constructor(message, status) { super(message); this.status = status }
}

export class Orchestrator {
  constructor({ baseUrl, timeoutMs = 8000, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
  }
  async request(method, path, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetch(`${this.baseUrl}/orchestrator/api${path}`, {
        method,
        // The API answers only loopback requests carrying this marker (sameOrigin in src/app/http.ts).
        headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw new OrchestratorError(error.name === 'AbortError' ? `orchestrator 无响应（${this.timeoutMs}ms 超时）` : `连不上 orchestrator：${error.message}`)
    } finally { clearTimeout(timer) }
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { error: text.slice(0, 200) } }
    if (!response.ok) throw new OrchestratorError(data.error ?? `HTTP ${response.status}`, response.status)
    return data
  }
  get(path) { return this.request('GET', path) }
  post(path, body) { return this.request('POST', path, body) }

  state() { return this.get('/state') }
  overview() { return this.get('/overview') }
  codex() { return this.get('/codex') }
  tickets(state = 'open', limit = 20) { return this.get(`/tickets?state=${state}&limit=${limit}`) }
  decisions(limit = 10) { return this.get(`/decisions?limit=${limit}`) }

  /** One snapshot per poll or command; Codex history is the largest read, so it is shared by the renderers. */
  async snapshot() {
    const [state, overview, codex] = await Promise.all([this.state(), this.overview(), this.codex()])
    return { state, overview, codex, at: new Date() }
  }
  stopTicket(id) { return this.post(`/tickets/${encodeURIComponent(id)}/stop`) }
  retryTicket(id) { return this.post(`/tickets/${encodeURIComponent(id)}/retry`) }
  pause(paused) { return this.post('/executor/pause', { paused }) }
  setMonitor(enabled) { return this.post('/codex/monitor', { enabled }) }
  setAutoHandoff(enabled) { return this.post('/codex/auto-handoff', { enabled }) }
  setControl(enabled) { return this.post('/codex/control', { enabled }) }
  cancelIntent(id) { return this.post(`/codex/control/${encodeURIComponent(id)}/cancel`) }
  ackAttention(threadId, itemId, at) { return this.post(`/codex/attention/${encodeURIComponent(threadId)}/ack`, { itemId, at }) }
}
