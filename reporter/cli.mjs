#!/usr/bin/env node
/** Superagent Reporter CLI: `run` the daemon, `once` a report, `doctor` the setup, `send` a test message. */
import { loadConfig, ConfigError } from './config.mjs'
import { Orchestrator } from './orchestrator.mjs'
import { Feishu } from './feishu.mjs'
import { Reporter, describeEvent } from './daemon.mjs'
import { renderDigest, renderStatus } from './report.mjs'

const USAGE = `Superagent Reporter — 把 superagent 的状态推进飞书，并响应飞书里的命令

用法：node reporter/cli.mjs <命令>

  run               常驻：定时巡检、变化推送、接收并执行命令
  once [--send]     打印一次状态与简报；--send 同时推送到配置的目标
  doctor            检查配置、orchestrator 连接、lark-cli 身份和发送目标
  send <文本>       给配置的目标发一条测试消息
  events            打印收到的飞书消息事件（调试用，不回复）
  help              显示本帮助

配置：~/.dsh/state/superagent-reporter/config.json（可用 DSH_REPORTER_CONFIG 覆盖）
`

const arg = name => process.argv.includes(name)

async function doctor(config) {
  const results = []
  const check = async (name, run) => {
    try { results.push([name, 'ok', await run()]) }
    catch (error) { results.push([name, 'fail', error.message]) }
  }
  await check('orchestrator', async () => {
    const state = await new Orchestrator(config.orchestrator).state()
    return `${config.orchestrator.baseUrl} · master ${state.masterId} · paused=${state.paused}`
  })
  const feishu = new Feishu(config.feishu)
  await check('lark-cli 身份', async () => {
    const auth = await feishu.auth()
    return `${auth.appId} bot=${auth.identities?.bot?.status ?? '?'}`
  })
  await check('机器人所在的群', async () => {
    const chats = await feishu.chats()
    const list = chats.data?.chats ?? []
    return list.length ? list.map(chat => `${chat.chat_id} ${chat.name ?? ''}`).join(' | ') : '机器人还没加入任何群（可先用 userId 私聊推送）'
  })
  results.push(['推送目标', config.feishu.chatId || config.feishu.userId ? 'ok' : 'fail',
    config.feishu.chatId || config.feishu.userId || '未配置 feishu.chatId / feishu.userId'])
  results.push(['命令权限', config.feishu.operators.length ? 'ok' : 'warn',
    config.feishu.operators.length ? `operators=${config.feishu.operators.join(',')} readers=${config.feishu.readers.join(',')}` : '未配置 operators：只推送，不响应命令'])
  for (const [name, status, detail] of results) console.log(`${status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : '❌'} ${name}: ${detail}`)
  return results.every(([, status]) => status !== 'fail')
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  if (command === 'help' || command === '--help' || command === '-h') { console.log(USAGE); return }
  const config = loadConfig()
  if (command === 'doctor') { process.exitCode = await doctor(config) ? 0 : 1; return }
  if (command === 'once') {
    const reporter = new Reporter(config)
    const snapshot = await reporter.orchestrator.snapshot()
    console.log(renderStatus(snapshot), '\n')
    console.log(renderDigest(snapshot))
    if (arg('--send')) { await reporter.push(renderDigest(snapshot), `reporter:once:${Date.now()}`); console.log('\n已推送。') }
    return
  }
  if (command === 'send') {
    if (!rest.length) throw new ConfigError('send 需要一段文本')
    await new Reporter(config).push(rest.join(' '), `reporter:manual:${Date.now()}`)
    console.log('已发送。')
    return
  }
  if (command === 'events') {
    const feishu = new Feishu(config.feishu)
    console.error('等待飞书消息事件，Ctrl-C 退出')
    feishu.consume({ onEvent: event => console.log(describeEvent(event)), onError: error => console.error(error.message) })
    return
  }
  if (command === 'run') {
    const reporter = new Reporter(config)
    const stop = () => { reporter.stop(); process.exit(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await reporter.run()
    return
  }
  console.log(USAGE)
  process.exitCode = 1
}

main().catch(error => { console.error(`❌ ${error.message}`); process.exitCode = 1 })
