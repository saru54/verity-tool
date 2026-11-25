const $ = selector => document.querySelector(selector);
const form = $('#task-form');
const field = name => form.elements.namedItem(name);
let token, currentUser, selectedId, selectedJob, cursor = 0, selectionVersion = 0, busy = false, connected = false;
let materialReadyRefreshFor, materialRefreshFor;
let lastActivity = '';
const displayedResults = new Set();
const pendingActions = new Set();
let pollTimer, polling = false, pollRequested = false, queueActive = false, queueLoaded = false;
let connecting, defaultProxyProvider = 'nodemaven';
try { selectedId = sessionStorage.getItem('one-selected-job'); } catch { /* storage is optional */ }
const states = { queued: '排队中', running: '运行中', cancelling: '正在停止', completed: '已结束', cancelled: '已停止', failed: '执行失败' };

function resultLabel(record) {
  if (record.code === 'CANCELLED' || record.status === 'cancelled') return '任务已停止';
  if (record.code === 'API_RATE_LIMITED') return '请求过于频繁，请稍后再试';
  if (record.code === 'VERIFICATION_NOT_FOUND') return record.message ?? '验证链接无效或已过期';
  if (['PROXY_START_FAILED', 'PROXY_UNAVAILABLE', 'INVALID_PROXY', 'INVALID_SYSTEM_PROXY'].includes(record.code)) return '代理连接失败，请检查代理';
  const stage = record.documentStage ?? record.stage;
  const querying = ['starting', 'preflight', 'query_status'].includes(stage);
  if (['API_NETWORK_ERROR', 'API_TIMEOUT', 'STATUS_REQUEST_FAILED', 'STATUS_REQUEST_TIMEOUT'].includes(record.code)) {
    return querying ? '状态查询失败，请检查网络或代理'
      : stage === 'upload_bytes' ? '文件上传失败，请检查网络或代理' : '网络请求失败，请检查网络或代理';
  }
  if (['API_HTTP_ERROR', 'STATUS_HTTP_ERROR', 'API_RESPONSE_INVALID', 'STATUS_RESPONSE_INVALID'].includes(record.code)) {
    return querying ? '状态查询失败，请稍后重试' : '接口请求失败，请稍后重试';
  }
  if (record.status === 'failed') {
    if (record.currentStep === 'error' || record.errorIds?.length
      || ['VERIFICATION_UNAVAILABLE', 'HTTP_CLIENT_ERROR', 'SERVER_VALIDATION_ERROR'].includes(record.code)) {
      const reason = record.errorIds?.[0];
      const reasonText = {
        fraudRulesReject: '被 SheerID 风控规则拒绝（fraudRulesReject）',
        docReviewLimitExceeded: '材料审核次数已达上限',
        ssoCancelLimitExceeded: '学校登录取消次数已达上限',
        verificationLimitExceeded: '该验证尝试次数已达上限',
      }[reason];
      return reasonText ?? '验证失败';
    }
    return '任务执行失败';
  }
  return ({ verified: '验证成功', rejected: '验证失败', filled: '资料已填写', manual: '等待手动填写',
    pending: '等待审核', submission_unknown: '等待确认提交结果' })[record.status] ?? '任务已结束';
}

// Display milestones, not keystrokes. The API cursor still consumes every event.
function activity(record) {
  if (['run_finished', 'web_finished'].includes(record.event)) {
    const label = resultLabel(record);
    return { text: label, resultKey: label };
  }
  // IP quality (proxy detection and switching) — emit a milestone for each
  // attempt, result, and final outcome so the operator can watch the rotation.
  if (record.stage === 'ip_quality' || record.event.startsWith('ip_quality_')) {
    if (record.event === 'stage_started') return { text: '检测代理 IP 质量' };
    if (record.event === 'ip_quality_skipped') return { text: '跳过代理质量检测' };
    if (record.event === 'ip_quality_attempt') {
      const cc = (record.country ?? '').toUpperCase();
      const num = record.label === 'initial' ? 1 : (parseInt(record.label?.split('-')[1] ?? '0', 10) || 0) + 1;
      const providerTag = record.provider === 'nodemaven' ? 'NodeMaven · '
        : record.provider === 'dataimpulse' ? 'DataImpulse · ' : '';
      return { text: `正在检测代理 IP（${providerTag}第 ${num} 次，${cc}）` };
    }
    if (record.event === 'ip_quality_result') {
      const score = record.score ?? '?';
      const grade = record.grade ?? '';
      const verdict = record.passed ? '通过' : '不达标';
      const flags = [
        record.proxyFlags !== undefined ? `代理${record.proxyFlags}/6` : '',
        record.abuseFlags !== undefined ? `滥用${record.abuseFlags}/6` : '',
        record.ipType ? record.ipType : '',
      ].filter(Boolean).join('，');
      return { text: `代理 IP ${verdict}（分数 ${score}${grade ? '，等级 ' + grade : ''}${flags ? '，' + flags : ''}）` };
    }
    if (record.event === 'ip_quality_passed')
      return { text: `代理 IP 质量通过（分数 ${record.score}，等级 ${record.grade}）` };
    if (record.event === 'ip_quality_error')
      return { text: '代理检测出错，尝试更换 IP…' };
    if (record.event === 'ip_quality_done')
      return { text: `代理确认（IP ${record.ip}，分数 ${record.score}，等级 ${record.grade}）` };
    return null;
  }
  if (record.event === 'stage_started') {
    if (record.stage === 'upload_bytes' && record.fileIndex && record.fileCount) {
      return { text: `正在上传第 ${record.fileIndex}/${record.fileCount} 份文件（${record.fileName ?? ''}）` };
    }
    if (record.stage === 'browser_doc_upload' && Array.isArray(record.files) && record.files.length) {
      return { text: `第 ${record.uploadAttempt ?? 1} 轮：正在页面内上传 ${record.files.join('、')}` };
    }
    const text = { launch: '准备中', fill: '填写资料中', submit: '提交资料中',
      document: '等待上传文件', document_direct: '基础信息已填写，直接上传材料',
      query_status: '检查验证状态', ip_quality: '检测代理 IP 质量',
      read_document: '等待上传文件', cancel_sso: '等待上传文件', browser_doc_upload: '页面内上传文件',
      initiate_upload: '等待上传文件', upload_bytes: '等待上传文件' }[record.stage];
    return text ? { text } : null;
  }
  if (record.event === 'stage_completed' && record.stage === 'upload_bytes') {
    if (record.fileIndex && record.fileCount) {
      return { text: `第 ${record.fileIndex}/${record.fileCount} 份文件已上传（${record.fileName ?? ''}）` };
    }
    return { text: '文件已上传' };
  }
  if (record.event === 'stage_completed' && record.stage === 'browser_doc_upload') {
    return { text: Array.isArray(record.files) && record.files.length ? `已在页面内提交 ${record.files.join('、')}` : '文件已上传' };
  }
  if (record.event === 'document_refetch') {
    if (Array.isArray(record.rejectionReasons) && record.rejectionReasons.length) {
      return { text: `材料被退回（${record.rejectionReasons.join(', ')}），准备第 ${record.uploadAttempt ?? 2} 轮重传` };
    }
    return { text: record.uploadAttempt > 1 ? `准备第 ${record.uploadAttempt} 轮重新上传` : '等待上传文件' };
  }
  if (['waiting_for_review', 'verification_status'].includes(record.event)) {
    if (record.code === 'AWAITING_WRITE_CONFIRMATION') return { text: '等待确认提交结果' };
    if (record.currentStep === 'emailLoop') return { text: '等待完成邮件验证' };
    if (record.currentStep === 'pending' || record.event === 'waiting_for_review') return { text: '等待审核' };
    return null;
  }
  if (record.event === 'browser_doc_files_attached') {
    return {
      text: Array.isArray(record.fileNames) && record.fileNames.length
        ? `已在页面挂载 ${record.fileNames.join('、')}，准备提交`
        : '已在页面挂载证明文件',
    };
  }
  const text = {
    web_queued: '已加入队列', web_started: '检查当前状态', web_cancelling: '正在停止任务', web_resumed: '任务已恢复',
    submission_uncertain: '等待确认提交结果',
    status_query_retry: '状态查询暂时失败，正在重试',
    material_ready: '验证材料已生成', material_generated: '验证材料已生成',
    material_prepared: '验证材料已准备',
    pending_final: '材料已提交，等待审核',
    form_language_switch_started: '正在切换表单语言',
    form_language_switched: '表单已切换为英语',
    form_language_switch_retry: '正在重试切换表单语言',
    submit_step_advanced: '页面已进入下一步',
    browser_sso_cancelled: '已跳过学校登录，准备上传材料',
  }[record.event];
  return text ? { text } : null;
}

function setConn(state, text) { const el = $('#connection'); el.dataset.state = state; el.textContent = text; }
function error(message = '') { $('#form-error').textContent = message; $('#form-error').hidden = !message; if (message) notice(); }
function notice(message = '') { const el = $('#form-notice'); if (el) { el.textContent = message; el.hidden = !message; } }

function updateControls() {
  $('#start').textContent = busy ? '正在加入…' : '加入队列';
  $('#form-fields').disabled = busy;
  $('#start').disabled = busy || !connected;
  $('#cancel').hidden = Boolean(selectedJob?.finishedAt) || selectedJob?.state === 'cancelled';
  $('#cancel').disabled = !connected || !selectedJob || Boolean(selectedJob.finishedAt) || selectedJob.state === 'cancelling' || pendingActions.has(selectedId);
  $('#resume').hidden = selectedJob?.state !== 'cancelled';
  $('#resume').disabled = !connected || !selectedJob?.finishedAt || pendingActions.has(selectedId);
  $('#delete').hidden = !selectedJob?.finishedAt || !['completed', 'failed', 'cancelled'].includes(selectedJob.state);
  $('#delete').disabled = !connected || pendingActions.has(selectedId);
  // Resubmit: show for any finished task (completed/failed/cancelled).
  $('#resubmit').hidden = !selectedJob?.finishedAt || !['completed', 'failed', 'cancelled'].includes(selectedJob.state);
  $('#resubmit').disabled = !connected || busy || pendingActions.has(selectedId);
  // Download log: show for any selected task with events.
  $('#download-log').hidden = !selectedJob;
  $('#download-log').disabled = !connected || !selectedJob;
  const who = $('#login-user');
  if (who) { who.textContent = currentUser ?? ''; who.hidden = !currentUser; }
  const logout = $('#logout');
  if (logout) logout.hidden = !currentUser;
}

// Redirect to login page when not authenticated.
function redirectToLogin() { window.location.href = '/login'; }

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Local-Token': token ?? '', ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/login')) redirectToLogin();
    throw Object.assign(new Error(data.error?.message ?? `请求失败 (${response.status})`), { status: response.status });
  }
  return data;
}
function isNewJobRun(job) {
  return Boolean(selectedJob && selectedJob.id === job.id && (
    (job.queuedAt && selectedJob.queuedAt && job.queuedAt !== selectedJob.queuedAt)
    || (selectedJob.finishedAt && !job.finishedAt)
    || job.lastSequence < cursor
  ));
}

function resetLogView() {
  selectionVersion++;
  cursor = 0;
  lastActivity = '';
  displayedResults.clear();
  $('#logs').replaceChildren();
  $('#log-count').textContent = '0 条';
}

function render(job, records = []) {
  if (isNewJobRun(job)) resetLogView();
  selectedJob = job;
  $('#selected-job').textContent = job.id;
  $('#job-state').textContent = states[job.state];
  $('#job-state').dataset.state = job.state;
  for (const record of records) {
    if (record.sequence <= cursor) continue;
    cursor = Math.max(cursor, record.sequence);
    if (record.event === 'web_resumed') { lastActivity = ''; displayedResults.clear(); }
    const entry = activity(record);
    if (!entry || entry.text === lastActivity || (entry.resultKey && displayedResults.has(entry.resultKey))) continue;
    lastActivity = entry.text;
    if (entry.resultKey) displayedResults.add(entry.resultKey);
    $('#logs .empty')?.remove();
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(record.time).toLocaleTimeString();
    item.append(time, entry.text);
    $('#logs').append(item);
    if ($('#logs').children.length > 200) $('#logs').firstElementChild.remove();
  }
  $('#log-count').textContent = `${$('#logs').querySelectorAll('li:not(.empty)').length} 条`;
  if (records.length) $('#logs').scrollTop = $('#logs').scrollHeight;
  renderJobMaterial(job);
  const runKey = `${job.id}:${job.queuedAt ?? ''}`;
  if (job.material && materialReadyRefreshFor !== runKey) { materialReadyRefreshFor = runKey; void loadMaterials(); }
  if (job.finishedAt && materialRefreshFor !== runKey) { materialRefreshFor = runKey; void loadMaterials(); }
  updateControls();
}
function selectJob(job, { reset = false } = {}) {
  if (selectedId !== job.id || reset || isNewJobRun(job)) {
    resetLogView();
  }
  selectedId = job.id;
  try { sessionStorage.setItem('one-selected-job', selectedId); } catch { /* optional */ }
  render(job);
}

function clearSelection() {
  selectionVersion++;
  selectedId = selectedJob = undefined;
  cursor = 0;
  lastActivity = '';
  displayedResults.clear();
  try { sessionStorage.removeItem('one-selected-job'); } catch { /* optional */ }
  $('#selected-job').textContent = '';
  $('#job-state').textContent = '待开始';
  delete $('#job-state').dataset.state;
  $('#log-count').textContent = '0 条';
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = '任务开始后，进度将在这里更新。';
  $('#logs').replaceChildren(empty);
  updateControls();
}

function renderQueue(queue) {
  $('#queue-summary').textContent = `运行 ${queue.running} / ${queue.concurrency} · 等待 ${queue.queued}`;
  $('#jobs').replaceChildren();
  for (const job of queue.jobs) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.jobId = job.id;
    button.setAttribute('aria-pressed', String(job.id === selectedId));
    const id = document.createElement('span');
    id.textContent = job.id;
    const state = document.createElement('span');
    state.textContent = states[job.state] + (job.state === 'queued' ? ` · 第 ${job.queuePosition} 位` : '');
    button.append(id, state);
    button.addEventListener('click', () => { selectJob(job); renderQueue(queue); requestPoll(); });
    item.append(button);
    $('#jobs').append(item);
  }
}

function requestPoll() {
  clearTimeout(pollTimer);
  if (polling) { pollRequested = true; return; }
  void poll();
}
async function poll() {
  if (polling || !connected) return;
  polling = true;
  pollRequested = false;
  try {
    const requestedVersion = selectionVersion;
    const queue = await api('/api/jobs');
    if (selectionVersion !== requestedVersion) return;
    queueLoaded = true;
    queueActive = queue.jobs.some(job => !job.finishedAt);
    if (!selectedId || !queue.jobs.some(job => job.id === selectedId)) {
      const next = queue.jobs.find(job => !job.finishedAt) ?? queue.jobs.at(-1);
      if (next) selectJob(next);
      else if (selectedId) clearSelection();
    }
    renderQueue(queue);
    const id = selectedId;
    const version = selectionVersion;
    const job = queue.jobs.find(job => job.id === id);
    if (job) {
      if (!job.finishedAt || job.lastSequence > cursor) {
        const data = await api(`/api/jobs/${id}?after=${cursor}`);
        if (selectedId === id && selectionVersion === version) render(data.job, data.events);
      } else render(job);
    }
  } catch (reason) {
    if (reason.status === 401) { redirectToLogin(); return; }
    const message = `进度连接中断：${reason.message}。${queueActive || !queueLoaded ? '正在重新连接。' : '请刷新页面重试。'}`;
    error(message);
  } finally {
    polling = false;
    if (connected && (pollRequested || queueActive || !queueLoaded)) {
      pollTimer = setTimeout(poll, pollRequested ? 0 : 1000);
    }
  }
}

function applyDefaultProxyProvider() {
  const select = field('proxyProvider');
  if (select) select.value = defaultProxyProvider;
}

// Dynamic proxy provider credentials (NodeMaven + DataImpulse).
async function loadProxySettings() {
  try {
    const settings = await api('/api/settings/proxy');
    const nm = settings.nodemaven;
    if (nm) {
      $('#nm-host').value = nm.host ?? 'gate.nodemaven.com';
      $('#nm-port').value = nm.port ?? 8080;
      $('#nm-username').value = nm.username ?? '';
      $('#nm-password').value = nm.password ?? '';
      $('#nm-filter').value = nm.filter ?? 'medium';
      $('#nm-ipv4').checked = nm.ipv4Only !== false;
      $('#nm-status').textContent = nm.username ? '已配置' : '';
      $('#nm-badge').textContent = nm.username ? '· 已配置' : '· 未配置';
    } else {
      $('#nm-badge').textContent = '· 未配置';
    }
    const di = settings.dataimpulse;
    if (di) {
      $('#di-host').value = di.host ?? 'gw.dataimpulse.com';
      $('#di-port').value = di.port ?? 10000;
      $('#di-username').value = di.username ?? '';
      $('#di-password').value = di.password ?? '';
      $('#di-status').textContent = di.username ? '已配置' : '';
      $('#di-badge').textContent = di.username ? '· 已配置' : '· 未配置';
    } else {
      $('#di-badge').textContent = '· 未配置';
    }
    defaultProxyProvider = !nm?.username && !di?.username && settings.hasStaticProxy
      ? 'direct'
      : (settings.proxyProvider ?? 'nodemaven');
    applyDefaultProxyProvider();
  } catch { /* not yet connected */ }
}

async function saveNodeMaven() {
  const body = {
    host: $('#nm-host').value.trim() || 'gate.nodemaven.com',
    port: parseInt($('#nm-port').value, 10) || 8080,
    username: $('#nm-username').value.trim(),
    password: $('#nm-password').value,
    filter: $('#nm-filter').value || 'medium',
    ipv4Only: $('#nm-ipv4').checked,
  };
  try {
    await api('/api/settings/proxy', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token },
      body: JSON.stringify({ nodemaven: body }),
    });
    $('#nm-status').textContent = '已保存';
    $('#nm-badge').textContent = body.username ? '· 已配置' : '· 未配置';
    if (defaultProxyProvider === 'direct') defaultProxyProvider = 'nodemaven';
    error();
  } catch (reason) { error(`NodeMaven 配置保存失败：${reason.message}`); }
}

async function saveDataImpulse() {
  const body = {
    host: $('#di-host').value.trim() || 'gw.dataimpulse.com',
    port: parseInt($('#di-port').value, 10) || 10000,
    username: $('#di-username').value.trim(),
    password: $('#di-password').value,
  };
  try {
    await api('/api/settings/proxy', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token },
      body: JSON.stringify({ dataimpulse: body }),
    });
    $('#di-status').textContent = '已保存';
    $('#di-badge').textContent = body.username ? '· 已配置' : '· 未配置';
    if (defaultProxyProvider === 'direct') defaultProxyProvider = 'nodemaven';
    error();
  } catch (reason) { error(`DataImpulse 配置保存失败：${reason.message}`); }
}
$('#nm-save')?.addEventListener('click', () => { void saveNodeMaven(); });
$('#di-save')?.addEventListener('click', () => { void saveDataImpulse(); });

form.addEventListener('change', updateControls);
field('countryCode')?.addEventListener('change', () => { void loadUniversities(); });
form.addEventListener('reset', () => { error(); notice(); setTimeout(() => { applyDefaultProxyProvider(); updateControls(); }, 0); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  error();
  notice();
  const value = name => field(name).value.trim();
  const input = { url: value('url') };
  const profileVal = value('profile');
  if (profileVal) input.profile = profileVal;
  const providerVal = value('proxyProvider');
  if (providerVal) input.proxyProvider = providerVal;
  for (const name of ['firstName', 'lastName', 'birthDate', 'universityId']) {
    if (value(name)) input[name] = value(name);
  }
  const countryVal = value('countryCode');
  if (countryVal) input.countryCode = countryVal;
  if (field('fillOnly').checked) input.fillOnly = true;
  if (field('keepOpenOnFailure').checked) input.keepOpenOnFailure = true;
  busy = true;
  updateControls();
  try {
    const { job, deduplicated } = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    selectJob(job, { reset: !deduplicated });
    if (deduplicated) {
      notice(`任务 ${job.id} 正在${job.state === 'queued' ? '排队' : '运行'}中，已为你定位到当前任务`);
    } else if (job.state === 'queued') {
      notice(`已加入队列（当前排第 ${job.queuePosition} 位），等待前面任务结束后自动执行`);
    } else {
      notice('任务已加入队列并开始执行');
    }
  } catch (reason) { error(reason.message); }
  finally { busy = false; updateControls(); requestPoll(); }
});
async function taskAction(action) {
  const id = selectedId;
  if (!id || pendingActions.has(id)) return;
  pendingActions.add(id);
  selectionVersion++;
  error();
  updateControls();
  try {
    if (action === 'delete') {
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
      selectionVersion++;
      if (selectedId === id) clearSelection();
    } else {
      const { job } = await api(`/api/jobs/${id}/${action}`, { method: 'POST' });
      if (selectedId === id) { selectionVersion++; render(job); }
    }
  } catch (reason) { error(reason.message); }
  finally { pendingActions.delete(id); updateControls(); requestPoll(); }
}
const MATERIAL_LABELS = {
  'immatrikulationsbescheinigung.pdf': '在读证明',
  'studierendenausweis.pdf': '学生证',
  'semesterbescheinigung.pdf': '学期注册证明',
  'enrollment-certificate.pdf': '在读证明 (PDF)',
  'term-verification.pdf': '学期证明 (PDF)',
};

function materialFileLinks(material) {
  const list = document.createElement('ul');
  list.className = 'material-files';
  for (const file of material.files ?? []) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `/api/materials/${material.verificationId}/files/${encodeURIComponent(file.name)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = MATERIAL_LABELS[file.name] ?? file.name;
    item.append(link);
    list.append(item);
  }
  return list;
}

function renderJobMaterial(job) {
  const host = $('#job-material');
  const material = job?.material;
  if (!material) {
    if (job && !job.finishedAt) {
      host.hidden = false;
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = job.state === 'queued'
        ? '排队中，轮到本任务后将先筛选代理并生成对应材料…'
        : '正在筛选代理并生成验证材料…';
      host.replaceChildren(hint);
    } else {
      host.hidden = true;
      host.replaceChildren();
    }
    return;
  }
  host.hidden = false;
  host.replaceChildren();
  const line = (label, value) => {
    const row = document.createElement('p');
    const strong = document.createElement('span');
    strong.textContent = label;
    row.append(strong, document.createTextNode(value ?? '—'));
    return row;
  };
  host.append(
    line('任务 ID', job.id),
    ...(material.sheeridVerificationId && material.sheeridVerificationId !== job.id
      ? [line('SheerID ID', material.sheeridVerificationId)]
      : []),
    line('学校', material.university?.name),
    line('姓名', material.identity?.fullName),
    line('出生日期', material.identity?.birthDate),
    line('学号', material.identity?.studentNumber),
    line('材料来源', material.source === 'archived' ? '沿用同 ID 原存档' : '本次自动生成'),
    materialFileLinks(material),
  );
}

const ARCHIVE_STATUS_LABELS = {
  verified: { text: '已通过', tone: 'completed' },
  pending: { text: '审核中', tone: 'running' },
  failed: { text: '失败', tone: 'failed' },
  rejected: { text: '已拒绝', tone: 'failed' },
  validation_failed: { text: '校验失败', tone: 'failed' },
  cancelled: { text: '已停止', tone: 'cancelled' },
  filled: { text: '已填写', tone: 'completed' },
  manual: { text: '手动处理', tone: 'queued' },
};

const PROFILE_LABELS = { 'google-one': 'Google One', spotify: 'Spotify' };
const PROXY_LABELS = { nodemaven: 'NodeMaven', dataimpulse: 'DataImpulse', direct: '直连 / 固定代理', configured: '固定代理' };

function archiveMetaRow(label, value, { mono = false, href = null } = {}) {
  const row = document.createElement('div');
  row.className = 'material-info-row';
  const keyEl = document.createElement('span');
  keyEl.className = 'material-info-key';
  keyEl.textContent = label;
  let valEl;
  if (href) {
    valEl = document.createElement('a');
    valEl.href = href;
    valEl.target = '_blank';
    valEl.rel = 'noopener';
    valEl.className = 'material-url-link';
  } else {
    valEl = document.createElement('span');
    valEl.className = mono ? 'material-info-val mono' : 'material-info-val';
  }
  valEl.textContent = value || '—';
  row.append(keyEl, valEl);
  return row;
}

function renderMaterials(payload) {
  const list = $('#materials');
  list.replaceChildren();
  const materials = payload?.materials ?? [];
  $('#materials-summary').textContent = materials.length
    ? `共 ${materials.length} 条任务归档，最近更新 ${new Date(materials[0].updatedAt).toLocaleString()}`
    : '还没有任务归档。提交任务后将按任务 ID 自动记录。';
  for (const material of materials) {
    const item = document.createElement('li');
    item.className = 'material-card';
    const taskId = material.taskId ?? material.verificationId;
    const task = material.task ?? null;
    const submittedUrl = material.url ?? task?.url ?? '';

    const head = document.createElement('div');
    head.className = 'material-card-head';
    const idGroup = document.createElement('div');
    idGroup.className = 'material-id-group';
    const idLabel = document.createElement('span');
    idLabel.className = 'material-id-label';
    idLabel.textContent = '任务 ID';
    const idValue = document.createElement('code');
    idValue.className = 'material-id-value';
    idValue.textContent = taskId;
    idGroup.append(idLabel, idValue);
    if (material.sheeridVerificationId && material.sheeridVerificationId !== taskId) {
      const sheerId = document.createElement('span');
      sheerId.className = 'material-sub-id';
      sheerId.textContent = `SheerID: ${material.sheeridVerificationId}`;
      idGroup.append(sheerId);
    }

    const statusMeta = ARCHIVE_STATUS_LABELS[material.lastStatus] ?? { text: material.lastStatus ?? '已生成', tone: 'queued' };
    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge material-status';
    statusBadge.dataset.state = statusMeta.tone;
    statusBadge.textContent = statusMeta.text;
    head.append(idGroup, statusBadge);

    const timeLine = document.createElement('div');
    timeLine.className = 'material-time hint';
    const submittedTime = task?.submittedAt ? new Date(task.submittedAt).toLocaleString() : new Date(material.createdAt).toLocaleString();
    timeLine.textContent = `提交于 ${submittedTime}` + (material.updatedAt ? ` · 更新 ${new Date(material.updatedAt).toLocaleString()}` : '');

    const info = document.createElement('div');
    info.className = 'material-info-list';
    const profileLabel = task?.profile ? (PROFILE_LABELS[task.profile] ?? task.profile) : null;
    const proxyLabel = task?.proxyProvider ? (PROXY_LABELS[task.proxyProvider] ?? task.proxyProvider) : null;
    const countryLabel = material.university?.countryCode ?? task?.countryCode ?? null;
    const modeTags = [
      profileLabel,
      proxyLabel,
      countryLabel ? `国家 ${countryLabel}` : null,
      task?.fillOnly ? '仅填写' : null,
      task?.keepOpenOnFailure ? '保持窗口' : null,
    ].filter(Boolean).join(' · ');

    const manualName = task?.firstName && task?.lastName;
    const displayName = material.identity?.fullName
      ? `${material.identity.fullName}${manualName ? '（手动填写）' : '（自动生成）'}`
      : '—';
    const schoolText = [material.university?.name, material.identity?.program].filter(Boolean).join(' · ');
    const identityDetail = [
      material.identity?.studentNumber ? `学号 ${material.identity.studentNumber}` : null,
      material.identity?.birthDate ? `出生 ${material.identity.birthDate}` : null,
    ].filter(Boolean).join(' · ');

    info.append(
      archiveMetaRow('提交链接', submittedUrl || '—', { href: /^https?:\/\//i.test(submittedUrl) ? submittedUrl : null }),
      archiveMetaRow('任务配置', modeTags || '默认配置'),
      archiveMetaRow('提交姓名', displayName),
      archiveMetaRow('学校专业', schoolText || '—'),
      archiveMetaRow('学号生日', identityDetail || '—', { mono: true }),
      archiveMetaRow('学校邮箱', material.identity?.email ?? '—', { mono: true }),
    );

    const actions = document.createElement('div');
    actions.className = 'material-actions';
    actions.append(materialFileLinks(material));
    item.append(head, timeLine, info, actions);
    list.append(item);
  }
}

let materialsLoaded = false;
async function loadMaterials() {
  if (!connected) return;
  try {
    renderMaterials(await api('/api/materials'));
    materialsLoaded = true;
  } catch (reason) {
    if (reason.status === 401) { redirectToLogin(); return; }
    if (!materialsLoaded) $('#materials-summary').textContent = `材料存档读取失败：${reason.message}`;
  }
}

async function loadUniversities() {
  try {
    const country = field('countryCode').value || 'US';
    const { universities } = await api(`/api/universities?country=${encodeURIComponent(country)}`);
    const select = field('universityId');
    const previous = select.value;
    select.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动分配（按所选国家，推荐）';
    select.append(auto);
    for (const entry of universities) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = `${entry.name} · ${entry.city}`;
      select.append(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  } catch { /* optional: the server falls back to automatic assignment */ }
}

$('#materials-reload').addEventListener('click', () => { void loadMaterials(); });
$('#cancel').addEventListener('click', () => taskAction('cancel'));
$('#resume').addEventListener('click', () => taskAction('resume'));
$('#delete').addEventListener('click', () => taskAction('delete'));
$('#resubmit').addEventListener('click', async () => {
  if (!selectedJob?.url || busy) return;
  busy = true;
  updateControls();
  try {
    error();
    const body = { url: selectedJob.url };
    if (selectedJob.profile) body.profile = selectedJob.profile;
    if (selectedJob.proxyProvider) body.proxyProvider = selectedJob.proxyProvider;
    const { job } = await api('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    selectJob(job, { reset: true });
  } catch (reason) { error(reason.message); }
  finally { busy = false; updateControls(); requestPoll(); }
});
$('#download-log').addEventListener('click', async () => {
  if (!selectedId) return;
  try {
    const response = await fetch(`/api/jobs/${selectedId}/events`, { headers: { 'X-Local-Token': token ?? '' } });
    if (!response.ok) throw new Error('下载失败');
    const blob = await response.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${selectedId}.events.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (reason) { error(`日志下载失败：${reason.message}`); }
});

function connect() {
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const session = await api('/api/session');
      token = session.token;
      currentUser = session.username;
      await loadProxySettings();
      connected = true;
      setConn('ok', '服务已连接');
      error();
      updateControls();
      requestPoll();
      void loadMaterials();
      void loadUniversities();
      return true;
    } catch (reason) {
      if (reason.status === 401) { redirectToLogin(); return false; }
      setConn('error', '服务未连接');
      error(reason.message);
      return false;
    } finally { connecting = undefined; }
  })();
  return connecting;
}

$('#logout')?.addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* an expired session is already logged out */ }
  redirectToLogin();
});

updateControls();
void connect();
