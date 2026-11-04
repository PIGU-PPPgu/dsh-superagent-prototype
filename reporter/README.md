# Superagent Reporter

把 superagent 的状态推进飞书，并让你在飞书里直接下指令。它是一个**独立常驻进程**，不改动 DSH 主进程，也不新增任何特权接口：所有读取都走 superagent 已有的 `/orchestrator/api`（面板同款），所有操作都是面板里已经有的那些（停止/重试工单、暂停、确认提醒、取消控制意图、开关监控）。

```
飞书消息 ──► lark-cli 事件流 ──► Reporter ──► /orchestrator/api ──► superagent
superagent 状态 ──► 巡检(45s) ──► 变化指纹 ──► Reporter ──► lark-cli 发消息 ──► 飞书
```

## 它做什么

- **推送**：需要你决定的 Codex 会话、技术异常、新工单结果、健康异常出现变化时，主动发一条播报（同一件事只推一次；措辞变化不重复推）。
- **每日简报**：每天 `dailyAt`（默认 09:00）推一次全局简报。
- **查询**：飞书里发 `状态` / `简报` / `待办` / `工单` / `会话` / `健康`，机器人回一条当前状态。
- **远程操作**：发 `暂停` / `继续` / `停止 <工单ID>` / `重试 <工单ID>` / `已读 <会话ID>` / `取消 <意图ID>` / `监控 开|关` 等。

审批仍然在 Codex 或 DSH 原界面完成，Reporter 不替你批准任何请求；它也不执行任意命令或自由文本，只有一张固定命令表。

## 配置

```bash
mkdir -p ~/.dsh/state/superagent-reporter
cp reporter/config.example.json ~/.dsh/state/superagent-reporter/config.json
$EDITOR ~/.dsh/state/superagent-reporter/config.json
```

| 字段 | 说明 |
| --- | --- |
| `orchestrator.url` | superagent 面板地址，必须是回环地址（`http://127.0.0.1:61104`） |
| `feishu.cli` | `lark-cli` 路径，需要有可用 bot 身份 |
| `feishu.userId` / `feishu.chatId` | 推送目标：私聊用 `ou_` open_id，群用 `oc_` chat id |
| `feishu.operators` | 允许执行操作的 open_id（查询权限自动包含） |
| `feishu.readers` | 只想查询的人的 open_id，可留空 |
| `feishu.pollSeconds` | 巡检间隔，默认 45 秒 |
| `feishu.push.dailyAt` | 每日简报时间 `HH:MM` |
| `feishu.push.quietFrom` / `quietTo` | 免打扰窗口（只压变化推送，不压每日简报和命令回复） |
| `feishu.push.minIntervalSeconds` | 两次变化推送的最小间隔 |

`operators` 为空时进程只推送、不响应命令——新装机器默认是不会被人指挥的。

## 命令行

```bash
node reporter/cli.mjs doctor      # 体检：配置、orchestrator 连接、lark-cli 身份、推送目标
node reporter/cli.mjs once        # 打印一次状态与简报
node reporter/cli.mjs once --send # 同时推送到配置的目标
node reporter/cli.mjs send "文本" # 发一条测试消息
node reporter/cli.mjs events      # 只打印收到的飞书事件（调试）
node reporter/cli.mjs run         # 常驻运行
```

## 飞书侧的准备

1. 把机器人拉进一个群，或直接私聊机器人（私聊推送用 `feishu.userId`）。
2. 开发者后台给应用开 `im:message.p2p_msg:readonly` 权限，并启用事件 `im.message.receive_v1`（用长连接接收事件）。
3. `node reporter/cli.mjs doctor` 全绿后，`node reporter/cli.mjs run`。

## 常驻

```bash
cp reporter/launchd/dev.dsh.superagent-reporter.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/dev.dsh.superagent-reporter.plist
```

plist 里的路径要改成实际仓库位置；日志在 `~/.dsh/state/superagent-reporter/reporter.log`。

## 边界

- 只有 `operators` / `readers` 名单里的人才能得到回复，其他人发消息不会有任何回应。
- 推送只包含摘要和短 ID，不含对话正文、命令输出或凭据。
- 状态文件 `~/.dsh/state/superagent-reporter/state.json` 保存指纹和最近 300 条消息 ID，用于去重；权限 0600。
- Reporter 不做审批、不改策略、不直接改 Codex 会话内容：所有远程操作都走 superagent 自己的接口和守卫。
