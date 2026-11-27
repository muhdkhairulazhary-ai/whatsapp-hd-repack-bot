const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat();
const unavailable = 'Unavailable';
const count = n => n == null ? unavailable : number.format(n);
const time = ms => ms == null ? unavailable : new Date(ms).toLocaleString();
const bytes = n => n == null ? unavailable : `${(n / 1024 ** 2).toFixed(1)} MiB`;
const duration = ms => ms == null ? unavailable : ms < 60000 ? `${Math.round(ms / 1000)}s` :
  `${Math.floor(ms / 60000)}m ${Math.round(ms / 1000) % 60}s`;
const label = (labels, key) => Object.hasOwn(labels, key) ? labels[key] : unavailable;
const method = key => label({ copy: 'Smart Copy', encode: 'HD Conversion' }, key);
const stage = key => label({ queued: 'Queued', downloading: 'Downloading', copy: 'Smart Copy',
  processing: 'Encoding', validating: 'Validating output', sending: 'Sending', image: 'Processing image' }, key);

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    return { status: response.status, data: await response.json() };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

if ($('login')) {
  $('login').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    const input = $('token');
    const body = JSON.stringify({ token: input.value });
    input.value = '';
    button.disabled = true;
    $('login-error').textContent = '';
    try {
      const { status } = await request('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      });
      if (status === 200) location.replace('/dashboard');
      else $('login-error').textContent = status === 429 ? 'Too many attempts. Try again in a minute.' : 'Sign-in failed. Check your access token.';
    } catch { $('login-error').textContent = 'Connection unavailable. Try again when online.'; }
    finally { button.disabled = false; }
  });
}

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function panel(title) {
  const el = node('section', undefined, 'panel');
  if (title) el.append(node('h2', title));
  return el;
}
function metrics(entries) {
  const grid = node('div', undefined, 'grid');
  for (const [name, value] of entries) {
    const el = node('div', undefined, 'panel metric');
    el.append(node('p', name), node('strong', value));
    grid.append(el);
  }
  return grid;
}
function svg(tag, attributes) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  return el;
}
function activity(days) {
  const card = panel('Processing activity · 7 UTC days');
  const chart = svg('svg', { class: 'chart', viewBox: '0 0 350 120', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const labels = node('div', undefined, 'chart-labels');
  const max = Math.max(1, ...days.map(day => day.total || 0));
  days.forEach((day, i) => {
    const total = day.total || 0;
    const success = day.success || 0;
    const scale = 112 / max;
    const x = i * 50 + 13;
    const bar = (h, y, color) => svg('rect', { x, y, width: 24, height: h, rx: 3, class: color });
    chart.append(bar(112, 4, 'track'), bar(total * scale, 116 - total * scale, 'secondary'),
      bar(success * scale, 116 - success * scale, 'bar'));
    const text = node('span', day.date.slice(5));
    text.title = `${day.date}: ${success} successful, ${day.failed || 0} failed`;
    text.setAttribute('aria-label', text.title);
    labels.append(text);
  });
  card.append(chart, labels);
  return card;
}
function breakdown(name, left, a, right, b) {
  const el = node('div', undefined, 'breakdown');
  const ratio = svg('svg', { class: 'ratio', viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  ratio.append(svg('rect', { width: 100, height: 8, rx: 1, fill: a + b ? '#626570' : '#27292f' }),
    svg('rect', { width: a + b ? 100 * a / (a + b) : 0, height: 8, rx: 1, fill: '#ff5363' }));
  const legend = node('div', undefined, 'legend');
  legend.append(node('span', `${left} · ${count(a)}`), node('span', `${right} · ${count(b)}`));
  el.append(node('strong', name), ratio, legend);
  return el;
}
function overview(data) {
  const o = data.overview;
  const items = [
    ['Videos delivered', count(o?.videos)], ['Processing jobs', count(o?.total)],
    ['Failed jobs', count(o?.failed)], ['Success rate', o?.total ? `${(100 * o.success / o.total).toFixed(1)}%` : '—'],
    ['Observed users · retained', count(o?.uniqueUsers)], ['Active users today · UTC', count(o?.activeToday)],
    ['Average active job time', duration(o?.averageMs)],
    ['Processing / queued', `${data.queue.activeJobs} / ${data.queue.queuedJobs}`]
  ];
  if (!o?.startedAt) return [metrics(items), node('p', o ? 'No jobs recorded yet. Statistics begin after the first completed job.' : 'Historical telemetry is unavailable.', 'panel')];
  const charts = node('div', undefined, 'chart-grid');
  const outcomes = panel('Outcomes · 30 UTC dates');
  outcomes.append(breakdown('Job results', 'Success', o.success, 'Failed', o.failed),
    breakdown('Delivered video methods', 'Smart Copy', o.copy, 'HD Conversion', o.encode));
  charts.append(activity(o.days), outcomes);
  return [metrics(items), charts, node('p', `Data collection started ${time(o.startedAt)}. Totals cover the latest 30 UTC dates.`, 'muted')];
}
function list(items, row, empty) {
  if (!items?.length) return node('p', empty, 'empty');
  const el = node('ul', undefined, 'records');
  for (const item of items) el.append(row(item));
  return el;
}
function formatVideo(job) {
  const geometry = job.width && job.height ? `${job.width} × ${job.height}` : '';
  const fps = job.fps ? `${Math.round(job.fps * 100) / 100} FPS` : '';
  return [geometry, fps].filter(Boolean).join(' · ') || unavailable;
}
function liveJob(job) {
  const el = node('li');
  const head = node('div', undefined, 'job-top');
  head.append(node('strong', `#${job.id.slice(0, 8)}`), node('span', stage(job.stage), 'badge'));
  const summary = [job.kind, bytes(job.inputBytes), formatVideo(job), job.method !== 'unknown' ? method(job.method) : null,
    `${duration(job.durationMs)} elapsed`, job.attempt > 1 ? `Retry · attempt ${job.attempt}` : null];
  el.append(head, node('p', summary.filter(Boolean).join(' · '), 'muted'));
  if (job.percent != null) {
    const progress = node('progress', undefined, 'progress');
    progress.max = 100;
    progress.value = job.percent;
    progress.setAttribute('aria-label', 'Encoding progress');
    el.append(progress, node('p', `${job.percent}% encoded · ${job.etaSeconds == null ? 'Estimating remaining time…' :
      `~${duration(job.etaSeconds * 1000)} encoding remaining`}`, 'muted'));
  }
  return el;
}
function historyJob(job) {
  const el = node('li', undefined, 'record');
  const identity = node('div');
  identity.append(node('strong', `#${job.id.slice(0, 8)}`), node('p', `${job.kind} · ${method(job.method)}`, 'muted'));
  const media = node('div');
  media.append(node('span', `${bytes(job.inputBytes)} → ${bytes(job.outputBytes)}`), node('p', formatVideo(job), 'muted'));
  const timing = node('div');
  timing.append(node('span', duration(job.durationMs)), node('p', time(job.finishedAt), 'muted'));
  const status = node('div');
  status.append(node('span', job.result === 'success' ? 'Delivered' : 'Failed', `badge ${job.result === 'success' ? 'good' : 'bad'}`));
  if (job.error) status.append(node('p', job.error.replaceAll('_', ' '), 'muted'));
  el.append(identity, media, timing, status);
  return el;
}
let view = 'overview';
let page = 1;
let filter = 'all';
function pages(info) {
  const nav = node('div', undefined, 'pagination');
  if (!info) return nav;
  const total = Math.max(1, Math.ceil(info.total / info.pageSize));
  for (const [text, delta] of [['Previous', -1], ['Next', 1]]) {
    if (delta === 1) nav.append(node('span', `Page ${info.page} of ${total}`, 'muted'));
    const button = node('button', text);
    button.disabled = delta < 0 ? info.page <= 1 : info.page >= total;
    button.addEventListener('click', () => { page = info.page + delta; refresh(); });
    nav.append(button);
  }
  return nav;
}
function jobs(data) {
  const live = panel('Live processing');
  live.append(list(data.active, liveJob, 'No active or queued jobs.'));
  const card = panel();
  card.classList.add('section-gap');
  const head = node('div', undefined, 'section-head');
  const select = node('select');
  select.setAttribute('aria-label', 'Filter job history');
  for (const [value, text] of [['all', 'All jobs'], ['success', 'Successful'], ['failed', 'Failed'], ['copy', 'Smart Copy'], ['encode', 'HD Conversion']]) {
    const option = node('option', text);
    option.value = value;
    select.append(option);
  }
  select.value = filter;
  select.addEventListener('change', () => { filter = select.value; page = 1; select.blur(); refresh(); });
  head.append(node('h2', 'Recent jobs'), select);
  card.append(head, list(data.history?.items, historyJob, data.overview ? 'No jobs match this view.' : 'History unavailable.'), pages(data.history));
  return [live, card];
}
function users(data) {
  const o = data.overview;
  const card = panel('Observed users');
  card.append(node('p', 'Anonymous IDs. Job counts cover retained job records.', 'muted'),
    list(data.users?.items, item => {
      const row = node('li', undefined, 'job-top');
      row.append(node('strong', `#${item.id.slice(0, 12)}`), node('span', `${count(item.jobs)} jobs`),
        node('p', `Last active ${time(item.lastActive)}`, 'muted'));
      return row;
    }, o ? 'No users recorded yet.' : 'User analytics unavailable.'), pages(data.users));
  return [metrics([['Unique users · retained', count(o?.uniqueUsers)], ['Active today · UTC', count(o?.activeToday)],
    ['Active in last 7 days', count(o?.activeWeek)]]), card];
}
function system(data) {
  const s = data.system;
  return [metrics([
    ['HTTP server', 'Healthy'],
    ['Connection detail', s.whatsappReason?.replaceAll('_', ' ') ?? unavailable],
    ['Outbound delivery', label({ available: 'Available', unknown: 'Unconfirmed', checking: 'Checking',
      restricted: 'Restricted', rejected: 'Suspended after rejection', cooldown: 'Waiting for recheck' }, s.outbound)], ['WhatsApp', s.whatsapp === 'connected' ? 'Connected' : 'Disconnected'],
    ['Analytics Redis', label({ available: 'Available', unavailable: 'Unavailable' }, s.redis)],
    ['FFmpeg stage', data.active.some(j => ['copy', 'processing'].includes(j.stage)) ? 'Running' : 'Idle'],
    ['Node.js RSS', bytes(s.rssBytes)], ['Container memory', bytes(s.containerBytes)],
    ['Container limit', bytes(s.containerLimitBytes)], ['Memory headroom', bytes(s.memoryHeadroomBytes)],
    ['Container OOM kills', count(s.oomKills)], ['Node.js CPU share', s.cpuPercent == null ? unavailable : `${s.cpuPercent}%`],
    ['Process uptime', duration(s.uptimeSeconds * 1000)], ['Queue depth', count(data.queue.queuedJobs)], ['Workers', count(data.queue.workers)],
    ['Queue capacity', count(data.queue.queueCapacity)], ['Last media failure', data.queue.lastFailure ?
      data.queue.lastFailure.reason.replaceAll('_', ' ') : unavailable],
    ['Telemetry write drops · process', count(data.dropped)], ['Application build', s.version?.slice(0, 12) ?? unavailable],
    ['Last WhatsApp connection', time(s.lastWhatsAppAt)], ['Last video delivery', time(s.lastDeliveryAt)]
  ]), node('p', 'Container memory includes child processes where measured. CPU share reflects the Node.js process only.', 'muted')];
}

const views = { overview, jobs, users, system };
const subtitles = { overview: 'Video delivery, activity, and service health.', jobs: 'Live progress and recent processing results.',
  users: 'Privacy-preserving activity across observed users.', system: 'Connection state and resource usage.' };
let pending;
let timer;
let csrf;
let failures = 0;
let refreshRequested = false;
let lastData;
const warning = text => { $('warning').textContent = text; $('warning').hidden = !text; };

function render(data) {
  const shell = $('view');
  const focused = document.activeElement;
  // Avoid dismissing the native filter or moving focus during automatic refresh.
  if (focused?.tagName === 'SELECT' && shell.contains(focused)) return;
  shell.replaceChildren(...views[view](data));
  const connected = data.system.whatsapp === 'connected';
  $('connection').textContent = connected ? 'WhatsApp connected' : 'WhatsApp disconnected';
  $('connection').className = `badge ${connected ? 'good' : 'warn'}`;
  $('updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
  const stale = data.collectedAt && data.updatedAt - data.collectedAt > 30_000;
  warning(data.redis !== 'available' || stale ? (data.collectedAt ?
    `Historical data may be stale. Last collected ${time(data.collectedAt)}.` : 'Historical data is unavailable.') : '');
}
function refresh() {
  clearTimeout(timer);
  if (document.hidden || !navigator.onLine) return;
  if (pending) { refreshRequested = true; pending.abort(); return; }
  void poll();
}
async function poll() {
  const controller = new AbortController();
  pending = controller;
  const query = new URLSearchParams({ view, page, filter });
  try {
    const { status, data } = await request(`/api/admin/state?${query}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (status === 401) { location.replace('/dashboard'); return; }
    if (status !== 200) throw new Error();
    csrf = data.csrf;
    lastData = data;
    failures = 0;
    render(data);
  } catch {
    if (!controller.signal.aborted) {
      failures++;
      warning(lastData ? `Connection lost. Showing data from ${time(lastData.updatedAt)}.` : 'Unable to load the dashboard. Retrying…');
    }
  } finally {
    pending = null;
    if (!document.hidden && navigator.onLine) {
      const delay = refreshRequested ? 0 : Math.min(96_000, 12_000 * 2 ** failures);
      timer = setTimeout(poll, delay);
    }
    refreshRequested = false;
  }
}
if ($('view')) {
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      if (view === button.dataset.view) return;
      view = button.dataset.view;
      page = 1;
      filter = 'all';
      for (const item of document.querySelectorAll('[data-view]')) item.removeAttribute('aria-current');
      button.setAttribute('aria-current', 'page');
      $('heading').textContent = button.textContent.trim();
      $('subtitle').textContent = subtitles[view];
      if (lastData && (view === 'overview' || view === 'system')) render(lastData);
      else $('view').replaceChildren(node('p', 'Loading…', 'panel'));
      refresh();
    });
  }
  $('logout').addEventListener('click', async () => {
    try {
      const { status } = await request('/api/admin/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf || '' } });
      if (status === 200 || status === 401) location.replace('/dashboard');
      else warning('Sign-out failed. Try again after the dashboard connects.');
    } catch { warning('Sign-out failed. Check your connection.'); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); pending?.abort(); }
    else refresh();
  });
  addEventListener('offline', () => {
    clearTimeout(timer);
    pending?.abort();
    warning(lastData ? `Offline. Showing data from ${time(lastData.updatedAt)}.` : 'Offline. Waiting for a connection.');
  });
  addEventListener('online', refresh);
  refresh();
}
