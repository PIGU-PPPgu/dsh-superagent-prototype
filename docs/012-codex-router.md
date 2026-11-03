# 012 Codex 路由与原生控制桥

本功能建立在 [011 本机 Codex 对话监控](011-codex-monitor.md) 的历史事实之上。CodexMonitor 只读本机已持久化会话；CodexRouter 把变化整理成一份简报交给 DSH 主 Session；CodexControl 保存消息意图和回执；CodexDelivery 在 DSH 进程里执行主 Session 排入的消息。默认关闭会话通信。

## 路由简报

简报优先列需要用户决定的会话、技术异常、需要用户处理的 DSH 工单和子线程历史失败。它从已归纳的会话摘要生成，不包含完整对话正文。首次扫描产生一份基线简报；之后只有人工待办、技术异常、DSH 工单待人阶段、子线程失败等事实变化，才向 DSH 主 Session 再发一份。会话排序、同一请求的消息 ID 和摘要措辞变化不会重复触发。未获用户答复的请求保留提醒；同一会话后续出现技术异常时仍更新异常状态，但不会绕过该请求自动派工。面板标明 Codex 历史快照和 DSH 当前工单状态。

主 Session 可用 `orchestrator_codex_route` 的 `operation=history` 按需读取监控中的主会话最近 1–12 条用户与助手消息；每条正文最多 1200 字符。`complete=false` 表示窗口可能省略更早消息，即使当前窗口为空也不能断言没有历史。该工具只读取已保存的历史，不返回命令输出、推理或 Desktop 的实时运行状态；暂停或停止监控会取消进行中的读取。

## 会话通信

DSH 主 Session 用 `orchestrator_codex_route` 的 `operation=head` 读取目标主会话，`operation=followup` 排一条后续消息，`reorder` 或 `cancel` 只影响尚未领取的消息。`message` 可请求状态或协调已授权工作；宿主明确附加“没有新增人工授权”，要求目标 Session 重新核对当前任务、把审批交给用户。工具要求通信已开启并连接、目标仍是监控中的未归档主会话、最新 item ID 一致、无待用户决定事项且无同会话活动 DSH Ticket。

自动接单仍遵守 011 的原文证据、历史基线和审批限制。符合条件的新失败或技术阻塞进入独立 DSH Ticket；原生桥心跳不参与自动接单或工单所有权判定。主 Session 显式排入的后续消息只是一条待发送意图，送达也不等于 DSH 已接单或完成工作。子线程不独立接收控制消息，由主会话处理。
若同一会话已有未领取的后续意图，创建 Ticket 时一并取消它；意图已经被领取而发送结果未明时，暂缓创建 Ticket，避免两边同时执行。

目前 Codex 自动接单仍由监控器直接调用 DSH Engine 创建 Ticket，没有经过普通 Source 的 Trigger/Eval 和主 Session 决策链。要让 DSH 主 Session 真正承担这部分路由，应将 Codex 历史观察接为 Source，再由 Policy 和 Eval 决定是否创建 Ticket；现有自动接单不能当作这项改造已经完成的证据。

## DSH 本机适配器

独立启动的 Codex App Server 只作为历史读取连接，不用来控制 Desktop 的轮次。官方接口说明见 [Codex App Server](https://developers.openai.com/codex/app-server)。Desktop 的实时查询和通信由下述版本钉住的私有 IPC 适配器完成。

DSH 每次历史扫描后最多尝试投递一条主 Session 意图。适配器先读取真实 owner 快照和最新已保存 item；活动中或待审批的会话留在队列，历史游标变化则拒发。DSH 暂停、停止或监控关闭时不开始发送；写入前再次检查暂停状态。发送前在 SQLite 中持久化 `dispatching` 和唯一消息 ID，成功后记录 `sent` 与 turn ID。结果不明时保留 `dispatching`，不自动重发。权限或设置的发送后核验失败会关闭后续通信，并通知 DSH 主 Session。

适配器与 DSH 插件一同启动、停止，通过本机连接探测更新 `bridge.json`，不使用 Codex 定时任务。`queue.json` 仍是仅当前用户可读的队列投影；旧外部脚本只允许 `list`，`claim/sent/failed/heartbeat` 已禁止，历史 receipts 只读兼容。运行中的线程等空闲后再派发；审批仍在 Codex 原界面由用户处理，适配器不批准请求或设置审批策略。

关闭面板的通信开关会取消尚未领取的消息；已经领取或送达的消息不会被撤回。失败或取消的消息只有主路由再次明确排入时才会生成新 intent。

## Desktop IPC 试验

`src/codex/desktop-ipc.ts` 仅适配 Desktop `26.1027.51404` 的私有本机协议，检查 socket 的用户归属和私有权限；版本不匹配时拒绝连接。主 Session 用 `operation=status` 查询选定主会话的真实 owner 状态、活动 turn ID 和待处理请求数量。所有者发现和一次性实时快照读取已在本机验证，快照正文和权限内容不进入工具返回值。

文本启动接口只接受空闲、无待处理请求、已知内置权限结构且设置未变化的项目会话；省略模型、审批和 sandbox 覆盖，要求继承目标设置。该私有接口没有原子空闲检查，真实文本送达与权限保持仍需隔离测试；代码与模拟测试不能作为通信已经启用的依据。适配器不复用当前聊天的内部工具凭据。
