/** Reporter daemon: polls the orchestrator, pushes changes, and answers Feishu commands. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator.mjs'
import { Feishu } from './feishu.mjs'
import { fingerprint, renderDigest, renderPush } from './report.mjs'
import { executeCommand, normalize, parseCommand } from './commands.mjs'

const SEEN_LIMIT = 300

/** Loads/saves the small JSON state atomically; a corrupt file is ignored rather than crashing the loop. */
export class ReporterState {
  constructor(file) { this.file = file; this.value = this.read() }
  read() {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      return { fingerprint: data.fingerprint ?? '', lastPushAt: data.lastPushAt ?? 0, daily: data.daily ?? '', seen: data.seen ?? {} }
    } catch { return { fingerprint: '', lastPushAt: 0, daily: '', seen: {} } }
  }
  save() {
    mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(this.value), { mode: 0o600 })
    renameSync(temp, this.file)
  }
  /** Bounded message-ID dedupe; IDs expire from the map in insertion order. */
  seen(id) {
    if (!id) return false
    if (this.value.seen[id]) return true
    this.value.seen[id] = Date.now()
    const keys = Object.keys(this.value.seen)
    for (const key of keys.slice(0, Math.max(0, keys.length - SEEN_LIMIT))) delete this.value.seen[key]
    this.save()
    return false
  }
}

export const inQuietHours = (date, from, to, zone = 'Asia/Shanghai') => {
  if (!from || !to || from === to) return false
  const [hour, minute] = new Date(date).toLocaleTimeString('zh-CN', { timeZone: zone, hour12: false }).split(':').map(Number)
  const now = hour * 60 + minute
  const [startH, startM] = from.split(':').map(Number)
  const [endH, endM] = to.split(':').map(Number)
  const start = startH * 60 + startM
  const end = endH * 60 + endM
  return start < end ? now >= start && now < end : now >= start || now < end
}

/** Change pushes need a new fingerprint, an enabled switch, an existing baseline, and a gap since the last push. */
export function shouldPush({ onChange, fingerprint: next, baseline, lastPushAt, minIntervalSeconds, now, quiet }) {
  // Without a baseline there is nothing to compare against yet; the first scan only sets the baseline.
  if (!onChange || !next || !baseline || next === baseline || quiet) return false
  if (baseline && now - lastPushAt < minIntervalSeconds * 1000) return false
  return true
}
export class Reporter {
  constructor(config, { orchestrator, feishu, state, log, now } = {}) {
    this.config = config
    this.orchestrator = orchestrator ?? new Orchestrator({ baseUrl: config.orchestrator.baseUrl, timeoutMs: config.orchestrator.timeoutMs })
    this.feishu = feishu ?? new Feishu({ cli: config.feishu.cli, timeoutMs: config.feishu.timeoutMs })
    this.state = state ?? new ReporterState(join(config.stateDir, 'state.json'))
    this.log = log ?? (message => console.error(`${new Date().toISOString()} ${message}`))
    this.now = now ?? (() => new Date())
    this.snapshot = undefined
    this.stopConsumer = undefined
    this.timer = undefined
    this.stopped = false
  }

  target() {
    const { chatId, userId } = this.config.feishu
    return chatId ? { chatId } : userId ? { userId } : undefined
  }

  async push(markdown, idempotencyKey) {
    const target = this.target()
    if (!target) throw new Error('未配置 feishu.chatId 或 feishu.userId，无法推送')
    await this.feishu.send({ ...target, markdown, idempotencyKey })
  }

  /** One poll: refresh the snapshot, push a changed report, and send the daily digest when its time has passed. */
  async poll() {
    const snapshot = await this.orchestrator.snapshot()
    this.snapshot = snapshot
    const next = fingerprint(snapshot)
    const now = this.now()
    const push = this.config.feishu.push
    if (shouldPush({
      onChange: push.onChange, fingerprint: next, baseline: this.state.value.fingerprint,
      lastPushAt: this.state.value.lastPushAt, minIntervalSeconds: push.minIntervalSeconds,
      now: now.getTime(), quiet: inQuietHours(now, push.quietFrom, push.quietTo),
    })) {
      await this.push(renderPush(snapshot), `reporter:${next}`)
      this.state.value.fingerprint = next
      this.state.value.lastPushAt = now.getTime()
      this.state.save()
      this.log(`pushed change ${next}`)
    }
    const day = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    const [hour, minute] = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).split(':').map(Number)
    if (push.dailyAt && this.state.value.daily !== day) {
      const [targetH, targetM] = push.dailyAt.split(':').map(Number)
      if (hour * 60 + minute >= targetH * 60 + targetM) {
        await this.push(renderDigest(snapshot), `reporter:daily:${day}`)
        this.state.value.daily = day
        this.state.save()
        this.log(`pushed daily digest ${day}`)
      }
    }
    return snapshot
  }

  /** Whether this event is a command the reporter should answer; unauthorized senders get no response at all. */
  accepts(event) {
    if (!event || event.type && event.type !== 'im.message.receive_v1') return false
    if (!event.message_id || !event.sender_id) return false
    if (this.config.feishu.chatId && event.chat_type !== 'p2p' && event.chat_id !== this.config.feishu.chatId) return false
    return this.config.feishu.readers.includes(event.sender_id)
  }

  async handleEvent(event) {
    if (!this.accepts(event)) return undefined
    const id = event.event_id ?? event.message_id
    if (this.state.seen(id)) return undefined
    const parsed = parseCommand(event.content)
    if (!parsed) {
      const answer = event.chat_type === 'p2p' ? '我只响应命令。发「帮助」查看可用命令。' : undefined
      if (answer) await this.feishu.send({ chatId: event.chat_id, markdown: answer, idempotencyKey: `reporter:hint:${event.message_id}` })
      return answer
    }
    const canOperate = this.config.feishu.operators.includes(event.sender_id)
    let markdown
    try { markdown = await executeCommand(parsed, { orchestrator: this.orchestrator, canOperate }) }
    catch (error) { markdown = `操作失败：${String(error.message ?? error).slice(0, 300)}` }
    if (!markdown) return undefined
    await this.feishu.send({ chatId: event.chat_id, markdown, idempotencyKey: `reporter:reply:${event.message_id}` })
    this.log(`answered ${parsed.command} for ${event.sender_id}`)
    return markdown
  }

  startConsumer() {
    if (!this.config.feishu.readers.length) { this.log('no readers configured: running push-only'); return }
    const restart = () => {
      if (this.stopped) return
      this.log('event stream ended; restarting in 10s')
      setTimeout(() => { if (!this.stopped) this.startConsumer() }, 10_000).unref?.()
    }
    this.stopConsumer = this.feishu.consume({
      onEvent: event => { this.handleEvent(event).catch(error => this.log(`command failed: ${error.message}`)) },
      onError: error => this.log(`event stream: ${error.message}`),
      onExit: (code, detail) => { this.log(`event stream exited (${code}) ${detail.slice(-300)}`); restart() },
    })
    this.log('listening for Feishu commands')
  }

  async run() {
    // The first poll only sets the baseline when there is no saved one, so a restart does not re-push old news.
    if (!this.state.value.fingerprint) {
      const snapshot = await this.orchestrator.snapshot()
      this.snapshot = snapshot
      this.state.value.fingerprint = fingerprint(snapshot)
      this.state.save()
      this.log(`baseline ${this.state.value.fingerprint}`)
    }
    this.startConsumer()
    const tick = async () => {
      try { await this.poll() }
      catch (error) { this.log(`poll failed: ${error.message}`) }
    }
    await tick()
    this.timer = setInterval(tick, this.config.feishu.pollSeconds * 1000)
    this.log(`polling every ${this.config.feishu.pollSeconds}s`)
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.stopConsumer?.()
  }
}

/** Text used by the CLI's `events` debug command; keeps raw events out of the chat. */
export const describeEvent = event => `${event.type ?? '?'} ${event.chat_type ?? '?'} ${event.sender_id ?? '?'}: ${normalize(event.content).slice(0, 120)}`
