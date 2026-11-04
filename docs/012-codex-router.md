# 012 Codex 路由与原生控制桥

本功能建立在 [011 本机 Codex 对话监控](011-codex-monitor.md) 的历史事实之上。CodexMonitor 只读本机已持久化会话；CodexRouter 把变化整理成一份简报交给 DSH 主 Session；CodexControl 保存消息意图和回执；CodexDelivery 在 DSH 进程里执行主 Session 排入的消息。默认关闭会话通信。

## 路由简报

简报优先列需要用户决定的会话、技术异常、需要用户处理的 DSH 工单和子线程历史失败，并纳入会话完成与工单结果。它从已归纳的会话摘要生成，不包含完整对话正文。首次扫描产生基线；之后有新的待办、异常、完成或结果事实时才唤醒 DSH 主 Session。会话排序、同一请求的消息 ID 和摘要措辞变化不会重复触发。未获用户答复的请求保留提醒；后续技术异常不会绕过该请求自动派工。面板的“汇报”打开固定 DSH 主会话；历史摘要标明 Codex 历史快照，工单阶段是 DSH 当前状态。

主 Session 可用 `orchestrator_codex_route` 的 `operation=list` 分页发现全部主会话，`offset` 从返回的 `nextOffset` 继续；每页最多 12 个，工单附带独立的 DSH 状态来源。`operation=history` 按需读取最近 1–12 条用户与助手消息，每条最多 1200 字符。`complete=false` 表示窗口可能省略更早消息，即使当前窗口为空也不能断言没有历史。历史读取不返回命令输出、推理或 Desktop 的实时状态；暂停或停止监控会取消进行中的读取。

## 会话通信

DSH 主 Session 用 `orchestrator_codex_route` 的 `operation=head` 读取目标主会话，`operation=followup` 排一条后续消息，`reorder` 或 `cancel` 只影响尚未领取的消息。`message` 可请求状态或协调已授权工作；宿主明确附加“没有新增人工授权”，要求目标 Session 重新核对当前任务、把审批交给用户。工具要求通信已开启并连接、目标仍是监控中的未归档主会话、最新 item ID 一致、无待用户决定事项且无同会话活动 DSH Ticket。

自动接单仍遵守 011 的原文证据、历史基线和审批限制。新失败或技术阻塞先核对 Desktop 实时状态，运行中、待审批、未知或找不到所有者时暂缓。符合条件的观察成为持久化 Trigger，经 Engine 的 Eval 候选送到 DSH 主 Session；监控器不再直接决定接单。主 Session 决定接单、附加证据、忽略，或协调原会话继续已有工作。原生消息送达不等于工作完成；子线程由其主会话协调。
若同一会话已有未领取的后续意图，创建 Ticket 时一并取消它；意图已经被领取而发送结果未明时，暂缓创建 Ticket，避免两边同时执行。

Codex 候选的授权按精确 Trigger 持久化，主 Session 决策前重新核对当前监控事实。关闭自动接单、出现新用户消息或历史游标过时后不能继续用旧候选接单。工单的结果、失败、待人事项回到 DSH 主 Session；例行进度留在面板，重复结果通过稳定投递 ID 去重。

## DSH 本机适配器

独立启动的 Codex App Server 只作为历史读取连接，不用来控制 Desktop 的轮次。官方接口说明见 [Codex App Server](https://developers.openai.com/codex/app-server)。Desktop 的实时查询和通信由下述版本钉住的私有 IPC 适配器完成。

DSH 每次扫描或路由请求最多执行一条意图，至多检查前八个候选。适配器先读取真实 owner 快照和最新已保存 item；后续消息等待目标空闲，同时允许队列中的其他空闲会话前进。待审批时保留队列，历史游标变化则拒发。DSH 暂停、停止或监控关闭时不开始发送；写入前再次检查暂停状态。发送前在 SQLite 中持久化 `dispatching` 和唯一消息 ID，成功后记录 `sent` 与 turn ID。结果不明时保留 `dispatching`，不自动重发。权限或设置的发送后核验失败会关闭后续通信，并通知 DSH 主 Session。

适配器与 DSH 插件一同启动、停止，通过本机连接探测更新 `bridge.json`，不使用 Codex 定时任务。`queue.json` 仍是仅当前用户可读的队列投影；旧外部脚本只允许 `list`，`claim/sent/failed/heartbeat` 已禁止，历史 receipts 只读兼容。审批仍在 Codex 原界面由用户处理，适配器不批准请求或设置审批策略。

关闭面板的通信开关会取消尚未领取的消息；已经领取或送达的消息不会被撤回。失败或取消的消息只有主路由再次明确排入时才会生成新 intent。

## Desktop IPC 试验

`src/codex/desktop-ipc.ts` 仅适配 Desktop `26.1027.51404` 的私有本机协议，检查 socket 的用户归属和私有权限；版本不匹配时拒绝连接。主 Session 用 `operation=status` 查询真实 owner 状态、活动 turn ID、待处理请求数量及通信开关。连接成功不代表通信开关已开。DSH 主 Session 的历史读取、实时查询已在原生窗口验证；两个未加载旧会话的 owner 查询超时，不能将所有者缺失当成空闲。快照正文和权限内容不进入实时工具返回值。

文本启动接口只接受空闲、无待处理请求、已知内置权限结构且设置未变化的项目会话；省略模型、审批和 sandbox 覆盖，要求继承目标设置。该私有接口没有原子空闲检查，真实文本送达与权限保持仍需隔离测试；代码与模拟测试不能作为通信已经启用的依据。适配器不复用当前聊天的内部工具凭据。

Desktop 的内置完全权限会话可省略 `runtimeWorkspaceRoots`，并在首个继承轮次补齐这个运行目录字段。发送前仍比较完整原始权限 hash；发送后仅对已验证的 `dangerFullAccess` 策略单独排除该字段计算策略 hash，审批、profile、sandbox 和其他字段均参与比较。回执用 `runtimeRootsChanged` 标明元数据变化，不把它表述为原始 hash 相同。其他策略仍要求有效的根目录数组，并完整比较其权限对象。

`operation=interrupt` 要求刚查询到的 `active_turn_id`，使用 Desktop 的 `expectedTurnId` 检查，拒绝中断替换后的新轮次或待人请求。版本固定的 `descendant-cleanup` 模式配合轮次 ID 只停止指定轮次，跳过会自动拒绝子会话审批的全树清理，保持审批请求与长期目标设置；已启用的长期目标可能自动继续。中断后的后续意图仍由主 Session 明确排入，不自动重发。真实中断和送达仍需隔离会话测试。
