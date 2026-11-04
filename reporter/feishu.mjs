/** Feishu transport through lark-cli: bot messages out, `im.message.receive_v1` events in. */
import { execFile, spawn } from 'node:child_process'

export class FeishuError extends Error {}

const run = (cli, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cli, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new FeishuError(`${args.slice(0, 3).join(' ')}: ${String(stderr || error.message).trim().slice(0, 400)}`))
    const text = stdout.trim()
    if (!text) return resolve({})
    try { resolve(JSON.parse(text)) }
    catch { reject(new FeishuError(`lark-cli 返回的不是 JSON：${text.slice(0, 200)}`)) }
  })
})

export class Feishu {
  constructor({ cli = 'lark-cli', timeoutMs = 30000 } = {}) {
    this.cli = cli
    this.timeoutMs = timeoutMs
  }
  /** Posts Markdown to a chat or a direct message; the idempotency key keeps a retried push from doubling. */
  async send({ chatId, userId, markdown, text, idempotencyKey }) {
    if (!chatId && !userId) throw new FeishuError('缺少发送目标 chatId 或 userId')
    const args = ['im', '+messages-send', '--as', 'bot',
      ...(chatId ? ['--chat-id', chatId] : ['--user-id', userId]),
      ...(markdown !== undefined ? ['--markdown', markdown] : ['--text', text ?? '']),
      ...(idempotencyKey ? ['--idempotency-key', idempotencyKey] : [])]
    const result = await run(this.cli, args, this.timeoutMs)
    if (result.ok === false) throw new FeishuError(result.error?.message ?? result.message ?? '飞书发送失败')
    return result
  }
  /** Lists chats the bot has joined, for `doctor` and setup. */
  chats() { return run(this.cli, ['im', '+chat-list', '--as', 'bot', '--page-size', '50'], this.timeoutMs) }
  auth() { return run(this.cli, ['auth', 'status'], this.timeoutMs) }

  /**
   * Streams flattened receive events (chat_id, chat_type, message_id, event_id, sender_id, content, message_type).
   * Returns a stop function; a crash is reported through `onError` so the daemon can restart the consumer.
   */
  consume({ onEvent, onError, onExit }) {
    // stdin stays open: lark-cli treats stdin EOF as "stop consuming", so a closed pipe would end the stream at once.
    const child = spawn(this.cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--quiet'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stopped = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try { onEvent(JSON.parse(line)) }
        catch (error) { onError?.(new FeishuError(`事件解析失败：${error.message}`)) }
      }
    })
    let errors = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000) })
    child.on('error', error => onError?.(new FeishuError(`事件流启动失败：${error.message}`)))
    child.on('close', code => { if (!stopped) onExit?.(code, errors.trim()) })
    return () => { stopped = true; child.stdin?.end(); child.kill('SIGTERM') }
  }
}
