# 010 云端 Codex CLI 与本机 GUI 实测

2026-11-01 10:35–10:40 UTC，在隔离的 Linux 云端测试目录 `/tmp/dsh-codex-cloud-20261101-poXtz0` 执行。版本：`codex-cli 0.163.0`、Node.js `24.19.0`、pnpm `11.25.0`、Chromium `154.0.8037.57`。这是自建的 **Codex CLI** 测试线程，不是用户 Mac 上现有的 Codex Desktop 线程。测试未使用真实仓库内容；本项目未请求或保存 API key，测试未执行登录，也未放宽沙箱或更改网络权限。

## 测试命令与结果

先为测试准备私有 `CODEX_HOME`，在只读沙箱中发起无工具、无敏感内容的对话：

```sh
mkdir -m 700 /tmp/dsh-codex-cloud-20261101-poXtz0/codex-home
CODEX_HOME=/tmp/dsh-codex-cloud-20261101-poXtz0/codex-home \
  codex exec --skip-git-repo-check -C /tmp/dsh-codex-cloud-20261101-poXtz0 \
  --sandbox read-only --ignore-user-config --json \
  'Reply with exactly CLOUD_CODEX_READONLY_TEST_20261101. Do not use tools or read files.'
```

未指定私有 `CODEX_HOME` 的首次尝试在初始化时因只读文件系统失败。使用隔离目录后，CLI 发出 `thread.started` 和 `turn.started`；线程 ID 为 `01a196ad-dd5c-7051-b1db-56d491b72924`。模型请求随后被云端代理拒绝：`wss://api.openai.com/v1/responses` 的 HTTP CONNECT 返回 **403**。测试进程已终止，因此 **没有模型生成的完成答复**，最新 turn 记录为 `interrupted`。没有尝试绕过代理或提供凭据。

构建当前分支后，启动 GUI：

```sh
CODEX_HOME=/tmp/dsh-codex-cloud-20261101-poXtz0/codex-home \
CODEX_READONLY_DIR=/tmp/dsh-codex-cloud-20261101-poXtz0/dashboard \
CODEX_READONLY_PORT=3190 node scripts/codex-local.mjs
```

通过 Chromium 实际打开 `http://127.0.0.1:3190/`，点击“查找本机线程” → “加入白名单” → “保存白名单” → “读取一次历史”。初版发现列表为空，因为 `thread/list` 的来源过滤漏了 `exec`；补上后，页面找到了上述真实线程。浏览器完成白名单和导出流程，HTTP 导出返回 `threads: 1, unavailable: 0`，观察结果为 `state: unknown, statusSource: historyOnly`，带有已存储的 turn 与 item ID。白名单和快照文件权限均为 `0600`。页面截图：[Codex 云端 GUI 测试](assets/codex-cloud-validation.png)。

“刷新页面数据”只重读已有快照：测试前后 `capturedAt` 均为 `2026-11-01T10:39:00.328Z`。再次点击“读取一次历史”才将其更新为 `2026-11-01T10:39:33.901Z`。当前实现**不自动轮询 Codex**，也不能从另起的 App Server 判断现有线程的实时运行状态。由于模型请求被代理拒绝，本次无法验证一个正常运行中的 turn 是否能出现逐步更新。

构建、类型检查和 13 项 Codex 针对性测试通过。完整项目测试的已知飞书竞态失败仍在独立范围；本次没有混入其修复。DSH CLI 未安装在此云端，因而没有启动 DSH 面板或验证 DSH 主会话的真实模型调用。Mac Desktop 的历史可见性、实时状态与控制能力仍须在 Mac 上单独验证；见[只读试用说明](009-codex-read-only.md)。
