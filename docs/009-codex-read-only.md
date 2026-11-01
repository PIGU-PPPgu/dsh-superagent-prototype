# 009 观察现有 Codex 线程：只读试验

这是一层 **Codex → dsh-superagent** 的观察适配，不涉及 dot2dot。它让 DSH 的主会话通过 `orchestrator_codex_threads` 查询指定的现有 Codex 开发线程。它不把 Codex 的消息写成 DSH Trigger，也不新建 Ticket、启动 Codex turn、回复或中断线程。

## 当前可运行的边界

适配层包含：

- 显式 `taskId → threadId` 白名单，重复任务或线程 ID 拒绝加载，最多 32 条；
- 可注入的 `CodexReadBackend`，以及只调用 `thread/read`、`thread/turns/list` 的 `CodexAppServerBackend`；
- 文件桥接输入 `CodexFileBackend`，供 Mac 上的采集进程以原子替换写入；
- 状态归一化、两分钟采样过期判断、进度变化去重、单线程读取错误隔离；
- 只在设置两个路径后向 DSH **主会话**注册的只读工具。没有后台轮询或自动消息。

配置文件里的 `taskId` 是本试验的映射键，不是 DSH Ticket ID。`changes` 只表示本进程上次查询以来可见状态或进度变了；重启或编辑白名单后重新建立基线。查询时间本身不产生变化。

### 状态可信度

Codex [App Server 文档](https://developers.openai.com/codex/app-server)说明，`thread/read` 不恢复线程，返回的 `status` 可以是 `notLoaded`、`idle`、`active` 或 `systemError`；`thread/turns/list` 读取已存储的 turn。**独立启动一个 `codex app-server` 进程能读到历史，不等于它拥有 Codex Desktop 此刻正在执行的 turn。** 因此采集器只有在确认连接的是拥有目标 live turn 的同一宿主实例时，才能写 `statusSource: "sameHost"`。其他情况写 `"historyOnly"`，工具会把运行状态显示为 `unknown`，即使历史读取返回 `idle`。`notLoaded` 和超过两分钟的采样也显示为 `unknown`。

`waitingForApproval` 只在可信的同宿主 `active` 状态带 `waitingOnApproval` flag 时显示。`latestTurn.summary` 只取已观察到的最新 assistant 消息的前 500 字符，属于不可信数据；它可能滞后，也不代表代码已完成。

## 在 Mac 上用模拟数据验证

先在这份仓库运行 `pnpm install --frozen-lockfile` 和 `pnpm check`。创建两个仅供本地使用的 JSON 文件，路径可以换成你自己的目录。**示例线程 ID 不是你的真实线程。**

`codex-watchlist.json`：

```json
{
  "version": 1,
  "tasks": [
    { "taskId": "frontend", "threadId": "example-thread-a", "label": "前端" },
    { "taskId": "api", "threadId": "example-thread-b", "label": "接口" }
  ]
}
```

`codex-snapshot.json`：

```json
{
  "version": 1,
  "capturedAt": "2026-11-01T09:00:00.000Z",
  "statusSource": "historyOnly",
  "threads": [
    {
      "id": "example-thread-a",
      "status": { "type": "active" },
      "latestTurn": { "id": "example-turn-a", "status": "inProgress", "lastItemId": "example-item-a", "summary": "正在运行测试" }
    },
    { "id": "example-thread-b", "status": { "type": "idle" } }
  ]
}
```

把 `capturedAt` 改为写入时的当前 UTC ISO 时间，设置两个环境变量，然后按此仓库的 [部署说明](006-deployment.md)启动 DSH：

```sh
export DSH_SUPERAGENT_CODEX_WATCHLIST="$PWD/codex-watchlist.json"
export DSH_SUPERAGENT_CODEX_SNAPSHOT="$PWD/codex-snapshot.json"
```

在 DSH 主会话调用 `orchestrator_codex_threads`，参数 `{}`。应看到两个任务、状态均为 `unknown`、首次的 `changes` 为 `new`；第二次调用的 `changes` 为空。改变 `lastItemId` 和 `summary` 后再次调用，只应出现对应任务的一条 `changed`。把快照里的 `example-thread-b` 删除，应看到它为 `missing`，而不是 `idle`。这一步验证白名单、映射、去重和 DSH 只读工具路径，不验证真实 Codex 连接。

### 接真实 Mac 线程的前提与顺序

1. 从 Mac 上受支持的 Codex 线程视图取得 **一个**真实 `threadId`，先加入白名单。仅按标题匹配可能指向错误线程；要核对 ID、标题及最后一个 turn。
2. 给 Mac 上的采集器实现 `CodexReadRpc` 传输，或输出上述文件格式。`CodexAppServerBackend` 已限定为两个读取 RPC；采集器负责连接、初始化、定时采样和原子写文件。若 DSH 运行在云端，还须有经明确授权的 Mac→云数据传送方式；这个仓库当前没有这种连接，也没有替用户创建凭据或开放端口。
3. 若只能另起一个 `codex app-server`，先用 `historyOnly` 验证历史内容与映射；**不要**用它的 `idle` / `notLoaded` 声称桌面任务已停。只有找到可访问且经验证的同宿主实时接口，再设 `sameHost`。用一个正在执行的线程和一个已结束的线程对照桌面状态，观察 turn ID、approval flag 和更新时间是否一致。
4. 一条验证通过后再逐步扩到 5–8 条。逐条确认白名单外的线程不出现在工具结果中；模拟断连和陈旧快照时应显示 `unavailable` 或 `unknown`，不能继续展示旧的运行状态。

文件采集器应先写临时文件，再在同一文件系统上原子改名为 `codex-snapshot.json`，避免 DSH 读到半个 JSON。不要把包含消息的文件提交进仓库。真实 Mac 桥接的传输、进程所有权和权限范围必须在 Mac 上验证；云端测试无法证明这些条件成立。

## 后续阶段

向既有 Codex 线程发指令属于独立控制阶段。需要先确认同宿主可写接口、明确的人类授权、按线程限制可执行动作以及发送幂等性；这份只读适配没有控制接口或自动介入逻辑。
