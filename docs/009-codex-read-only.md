# 009 观察现有 Codex 线程：只读试验

这是一层 **Codex → dsh-superagent** 的观察适配，不涉及 dot2dot。它让 DSH 的主会话通过 `orchestrator_codex_threads` 查询指定的现有 Codex 开发线程。它不把 Codex 的消息写成 DSH Trigger，也不新建 Ticket、启动 Codex turn、回复或中断线程。

## 当前可运行的边界

适配层包含：

- 显式 `taskId → threadId` 白名单，重复任务或线程 ID 拒绝加载，最多 32 条；
- 可注入的 `CodexReadBackend`，以及只调用 `thread/read`、`thread/turns/list` 的 `CodexAppServerBackend`；
- 文件桥接输入 `CodexFileBackend`，以及 Mac 上可手动运行的、只读的历史快照导出器；
- 状态归一化、两分钟采样过期判断、进度变化去重、单线程读取错误隔离；
- 只在设置两个路径后向 DSH **主会话**注册的只读工具。没有后台轮询或自动消息。

配置文件里的 `taskId` 是本试验的映射键，不是 DSH Ticket ID。`changes` 只表示本进程上次查询以来可见状态或进度变了；重启或编辑白名单后重新建立基线。查询时间本身不产生变化。主会话工具不返回外部线程的名字、自由文本摘要或原始错误；只返回状态、turn 与 item 的结构化字段。

### 状态可信度

Codex [App Server 文档](https://developers.openai.com/codex/app-server)说明，`thread/read` 不恢复线程，返回的 `status` 可以是 `notLoaded`、`idle`、`active` 或 `systemError`；`thread/turns/list` 读取已存储的 turn。**独立启动一个 `codex app-server` 进程能读到历史，不等于它拥有 Codex Desktop 此刻正在执行的 turn。** 文件桥只能接收 `statusSource: "historyOnly"`；即使文件自报 `"sameHost"`，也会失败关闭。工具将历史读取的运行状态显示为 `unknown`。`notLoaded` 和超过两分钟的采样也显示为 `unknown`。可信的同宿主实时连接需要另行实现和在 Mac 上验证。

`waitingForApproval` 只在可信的同宿主 `active` 状态带 `waitingOnApproval` flag 时显示。文件桥及导出器不显示这个实时结论。最新 turn 的状态与 item ID 仅说明历史读取看到了哪一步；它们可能滞后，也不代表代码已完成。

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

把 `capturedAt` 改为写入时的当前 UTC ISO 时间，给两个文件设仅本人可读写的权限，设置环境变量，然后按此仓库的 [部署说明](006-deployment.md)启动 DSH：

```sh
chmod 600 codex-watchlist.json codex-snapshot.json
export DSH_SUPERAGENT_CODEX_WATCHLIST="$PWD/codex-watchlist.json"
export DSH_SUPERAGENT_CODEX_SNAPSHOT="$PWD/codex-snapshot.json"
```

在 DSH 主会话调用 `orchestrator_codex_threads`，参数 `{}`。应看到两个任务、状态均为 `unknown`、首次的 `changes` 为 `new`；第二次调用的 `changes` 为空。改变 `lastItemId` 后再次调用，只应出现对应任务的一条 `changed`；仅改变 `summary` 不应影响输出。把快照里的 `example-thread-b` 删除，应看到它为 `missing`，而不是 `idle`。这一步验证白名单、映射、去重和 DSH 只读工具路径，不验证真实 Codex 连接。

### 在 Mac 本地手动导出真实的历史快照

此路径按[官方 stdio 初始化流程](https://developers.openai.com/codex/app-server)另起一个 `codex app-server`，只请求 `thread/read` 和 `thread/turns/list`。它**不会**接管 Codex Desktop 正在运行的线程，只供验证真实线程 ID、标题与已存储的最新 turn。先安装本机 Codex CLI，并核对本机版本对这两个 RPC 的支持；官方建议用本机 `codex app-server generate-ts` 或 `generate-json-schema` 查看该版本的协议。

在私有 `codex-watchlist.json` 中填一个真实线程 ID 后：

```sh
pnpm build
chmod 600 codex-watchlist.json
node scripts/codex-export-snapshot.mjs "$PWD/codex-watchlist.json" "$PWD/codex-snapshot.json"
```

导出器一次运行、一次写入，使用临时文件和原子改名，输出文件权限仅本人可读写，始终标记 `historyOnly`。如果某线程读取失败，记录为 `unavailable`；若 App Server 未安装、初始化失败或不支持所需 RPC，命令失败或记录不可用，不会改称实时。该程序不请求任何写入 RPC，也不生成凭据。之后再按上方的环境变量启动 DSH 并查询工具。若 DSH 在云端，仍需单独建立经授权的 Mac→云传送；本项目没有自动传送。

### 接真实 Mac 线程的前提与顺序

1. 从 Mac 上受支持的 Codex 线程视图取得 **一个**真实 `threadId`，先加入白名单。仅按标题匹配可能指向错误线程；要核对 ID、标题及最后一个 turn。
2. 运行一次历史导出器，核对 ID、已存储的 turn 与 DSH 工具映射。不要用另起的 App Server 的 `idle` / `notLoaded` 声称桌面任务已停。
3. 若要实时状态，先找到正式支持的同宿主读取接口，确认不会中断或恢复线程，并用一个正在执行的线程和一个已结束的线程对照桌面状态，观察 turn ID、approval flag 和更新时间是否一致。当前文件桥不能通过修改 `sameHost` 字段启用实时状态。
4. 一条验证通过后再逐步扩到 5–8 条。逐条确认白名单外的线程不出现在工具结果中；模拟断连和陈旧快照时应显示 `unavailable` 或 `unknown`，不能继续展示旧的运行状态。

自制采集器也应先写私有临时文件，再在同一文件系统上原子改名为 `codex-snapshot.json`，避免 DSH 读到半个 JSON。输入必须是由当前用户拥有的普通文件，权限不得允许组或其他用户读取；白名单限制 64 KiB，快照限制 1 MiB。不要把包含消息的文件提交进仓库。真实 Mac 桥接的传输、进程所有权和权限范围必须在 Mac 上验证；云端测试无法证明这些条件成立。

## 后续阶段

向既有 Codex 线程发指令属于独立控制阶段。需要先确认同宿主可写接口、明确的人类授权、按线程限制可执行动作以及发送幂等性；这份只读适配没有控制接口或自动介入逻辑。
