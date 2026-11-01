/** Self-contained local dashboard assets. Dynamic values are inserted with textContent, never HTML. */
export const LOCAL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex 线程观察</title><link rel="stylesheet" href="/app.css"></head>
<body><main>
  <header><div><p class="eyebrow">本机只读试验</p><h1>Codex 线程观察</h1></div><span class="badge">历史快照 · 非实时</span></header>
  <p class="intro">从这台 Mac 的 Codex 已存储记录中选择线程，建立最多 32 条任务映射。读取只调用 Codex App Server 的只读方法；不会给原线程发消息、启动新 turn 或中断任务。</p>
  <div id="notice" role="status" aria-live="polite"></div>
  <section><div class="section-head"><div><h2>1. 查找已有线程</h2><p>列表只显示本机可读取的记录。请用线程 ID 和 Codex 界面核对目标。</p></div><button id="discover">查找本机线程</button></div><div id="candidates" class="stack"></div></section>
  <section><div class="section-head"><div><h2>2. 白名单</h2><p>只有这里保存的线程会进入快照及 DSH 工具。</p></div><button id="add" class="secondary">手动添加</button></div>
    <div class="table-wrap"><table><thead><tr><th>任务 ID</th><th>Codex 线程 ID</th><th>本地标签</th><th></th></tr></thead><tbody id="tasks"></tbody></table></div>
    <div class="actions"><button id="save">保存白名单</button><span id="count"></span></div>
  </section>
  <section><div class="section-head"><div><h2>3. 读取历史</h2><p>每次点击才启动一个独立的 Codex App Server，读取白名单中的历史并写入私有快照。</p></div><div class="actions"><button id="export">读取一次历史</button><button id="refresh" class="secondary">刷新页面数据</button></div></div>
    <p class="warning">独立进程无法证明 Codex Desktop 当前是否正在运行。这里的状态始终是“未知”；turn 和 item 仅代表已存储的进度。</p>
    <div class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>最新 turn</th><th>最后 item</th><th>采样时间</th></tr></thead><tbody id="observations"></tbody></table></div>
  </section>
  <section><h2>接入 DSH</h2><p>本机历史读取不需要模型 API key。若已安装 DSH，可在 DSH Web 的 Settings → Models → DeepSeek 中配置模型 API。默认数据目录下，导出快照后重启 dsh-superagent 即可让主会话读取；自定义数据目录时，需要在启动环境中设置下面两个变量。它不会自动接管线程。</p><pre id="env"></pre><p>完整步骤见仓库的 <code>docs/009-codex-read-only.md</code>。当前未验证 Mac 上已有运行线程的实时状态或控制接口。</p></section>
</main><script src="/app.js" defer></script></body></html>`

export const LOCAL_CSS = `:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e9edf4;background:#0e1219}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:0 auto;padding:36px 20px 80px}header,.section-head,.actions,.candidate{display:flex;align-items:center;justify-content:space-between;gap:16px}header{align-items:flex-start}h1{font-size:32px;margin:4px 0 14px}h2{font-size:20px;margin:0 0 8px}p{line-height:1.55}header p,.section-head p{margin:0;color:#aeb7c7}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#89b9ff!important}.intro{max-width:800px;color:#c8d1df}.badge{white-space:nowrap;background:#243b54;border:1px solid #4a7094;border-radius:999px;padding:7px 11px;font-size:13px}section{background:#171e28;border:1px solid #2a3544;border-radius:14px;margin-top:22px;padding:22px}button{background:#75adfa;border:1px solid #75adfa;color:#111722;font:inherit;font-weight:650;border-radius:8px;padding:9px 13px;cursor:pointer;white-space:nowrap}button:hover{filter:brightness(1.08)}button:disabled{opacity:.5;cursor:wait}.secondary{background:transparent;color:#cbd8eb;border-color:#52657b}.danger{color:#f0acac;border-color:#775355;background:transparent}.stack{display:grid;gap:8px;margin-top:15px}.candidate{border:1px solid #344154;border-radius:8px;padding:11px 12px;align-items:flex-start}.candidate div{min-width:0}.candidate strong,.candidate small{display:block;overflow-wrap:anywhere}.candidate small{color:#9ca9bc;margin-top:4px}.table-wrap{overflow:auto;margin-top:16px}table{border-collapse:collapse;width:100%;min-width:660px}th,td{text-align:left;border-bottom:1px solid #2d3848;padding:10px 8px;vertical-align:top}th{color:#aeb7c7;font-weight:600;font-size:13px}td{overflow-wrap:anywhere}input{width:100%;min-width:130px;color:#e9edf4;background:#10161f;border:1px solid #435167;border-radius:7px;padding:8px;font:inherit}input:focus,button:focus-visible{outline:2px solid #a8d2ff;outline-offset:2px}.actions{justify-content:flex-start;flex-wrap:wrap;margin-top:14px}#count{color:#9ca9bc}#notice{min-height:22px;margin-top:16px;color:#9fd9bd}#notice.error{color:#ffabab}.warning{background:#3a2c20;border-left:3px solid #db9d57;padding:11px 13px;border-radius:4px;color:#f2d6b7}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0e141c;border:1px solid #344154;padding:14px;border-radius:8px;color:#a5d1ff}code{color:#a5d1ff}@media(max-width:700px){main{padding:22px 12px 60px}header,.section-head{align-items:flex-start;flex-direction:column}section{padding:17px}.badge{white-space:normal}}`

export const LOCAL_JS = `(() => {
  const byId = id => document.getElementById(id);
  const notice = byId('notice');
  let rows = [];
  let state;
  let busy = false;
  const actions = ['discover', 'add', 'save', 'export', 'refresh'];
  function message(text, error = false) { notice.textContent = text; notice.className = error ? 'error' : ''; }
  function setBusy(value) { busy = value; for (const id of actions) byId(id).disabled = value; }
  async function call(method, path, body) {
    const headers = { 'x-codex-local-request': '1' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch('/api/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '读取失败');
    return result;
  }
  function cell(row, value) { const td = document.createElement('td'); td.textContent = value || '—'; row.append(td); return td; }
  function renderTasks() {
    const tbody = byId('tasks'); tbody.replaceChildren();
    for (const [index, task] of rows.entries()) {
      const tr = document.createElement('tr');
      for (const key of ['taskId', 'threadId', 'label']) {
        const td = document.createElement('td'); const input = document.createElement('input');
        input.value = task[key] || ''; input.setAttribute('aria-label', key + ' ' + (index + 1));
        input.addEventListener('input', () => { task[key] = input.value; }); td.append(input); tr.append(td);
      }
      const td = document.createElement('td'); const remove = document.createElement('button');
      remove.className = 'danger'; remove.textContent = '移除'; remove.setAttribute('aria-label', '移除 ' + task.taskId);
      remove.addEventListener('click', () => { rows.splice(index, 1); renderTasks(); }); td.append(remove); tr.append(td); tbody.append(tr);
    }
    byId('count').textContent = rows.length + ' / 32';
  }
  function renderObservations() {
    const tbody = byId('observations'); tbody.replaceChildren();
    const tasks = state?.observation?.tasks || [];
    for (const task of tasks) {
      const tr = document.createElement('tr');
      cell(tr, (task.label || task.taskId) + ' (' + task.threadId + ')');
      cell(tr, task.state === 'unavailable' ? '读取失败' : task.state === 'missing' ? '尚无记录' : '未知（历史）');
      cell(tr, task.latestTurn?.id); cell(tr, task.latestTurn?.lastItemId); cell(tr, task.capturedAt);
      tbody.append(tr);
    }
    if (!tasks.length) { const tr = document.createElement('tr'); const td = cell(tr, '保存白名单后读取历史。'); td.colSpan = 5; tbody.append(tr); }
  }
  function renderEnv() {
    byId('env').textContent = 'export DSH_SUPERAGENT_CODEX_WATCHLIST=' + JSON.stringify(state.watchlistPath) +
      '\\nexport DSH_SUPERAGENT_CODEX_SNAPSHOT=' + JSON.stringify(state.snapshotPath);
  }
  async function reload() {
    state = await call('GET', 'state'); rows = state.tasks.map(task => ({ ...task }));
    renderTasks(); renderObservations(); renderEnv();
  }
  async function run(action, success) {
    if (busy) return; setBusy(true); message('正在处理…');
    try { await action(); message(success); } catch (error) { message(error instanceof Error ? error.message : '操作失败', true); }
    finally { setBusy(false); }
  }
  byId('add').addEventListener('click', () => { if (rows.length < 32) { rows.push({ taskId: '', threadId: '', label: '' }); renderTasks(); } });
  byId('save').addEventListener('click', () => run(async () => {
    state = await call('POST', 'watchlist', { version: 1, tasks: rows.map(task => ({
      taskId: task.taskId.trim(), threadId: task.threadId.trim(), ...(task.label.trim() ? { label: task.label.trim() } : {}),
    })) }); await reload();
  }, '白名单已保存。旧快照已清除，请重新读取历史。'));
  byId('export').addEventListener('click', () => run(async () => { await call('POST', 'export'); await reload(); }, '历史快照已更新；实时状态仍未验证。'));
  byId('refresh').addEventListener('click', () => run(reload, '已刷新。'));
  byId('discover').addEventListener('click', () => run(async () => {
    const candidates = await call('GET', 'candidates'); const list = byId('candidates'); list.replaceChildren();
    for (const candidate of candidates) {
      const item = document.createElement('div'); item.className = 'candidate';
      const info = document.createElement('div'); const title = document.createElement('strong');
      title.textContent = candidate.name || candidate.id; const detail = document.createElement('small');
      detail.textContent = candidate.id + (candidate.cwd ? ' · ' + candidate.cwd : '') +
        (candidate.updatedAt ? ' · ' + candidate.updatedAt : ''); info.append(title, detail);
      const add = document.createElement('button'); add.className = 'secondary'; add.textContent = '加入白名单';
      add.addEventListener('click', () => {
        if (rows.length >= 32 || rows.some(row => row.threadId === candidate.id)) return;
        let number = 1; while (rows.some(row => row.taskId === 'task-' + number)) number++;
        rows.push({ taskId: 'task-' + number, threadId: candidate.id, label: candidate.name || '' }); renderTasks();
      }); item.append(info, add); list.append(item);
    }
    if (!candidates.length) list.textContent = '未找到已存储线程。请确认本机 Codex CLI 可以访问相同的记录，或手动填写线程 ID。';
  }, '本机线程列表已读取。'));
  reload().catch(error => message(error instanceof Error ? error.message : '读取失败', true));
})();`
