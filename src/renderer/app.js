'use strict';

/* ------------------------------------------------------------------ *
 *  FRP 控制台 · 渲染层
 *  纯 JS，无框架；所有能力经 preload 暴露的 window.FRP 走 IPC。
 * ------------------------------------------------------------------ */

(function () {
  const FRP = window.FRP;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const S = {
  ready: false,
  state: null,
  app: null,
  logs: [],
  view: 'overview',
  listeners: null,
  listenersBusy: false,
  proxyQuery: '',
  logLevel: '',
  follow: true,
  modalOpen: false,
  proxyEdit: null,
  update: null,
  lastKeys: {},
  viewScroll: {},
  busy: new Set(),
  server: {
    loaded: false,
    busy: false,
    connected: false,
    host: '',
    port: 22,
    username: '',
    saved: {},
    savedCredential: false,
    profiles: [],
    activeServerId: '',
    clientServerId: '',
    tunnel: null,
    // 请求序号：异步返回时序号已变，说明用户在等待期间切了档案，结果直接丢弃。
    seq: 0,
    switching: false,
    autoConnecting: false,
    sessionServerId: '',
    client: null,
    info: null,
    configPath: '',
    config: '',
    summary: null,
    configError: '',
    mode: 'wizard',
    template: 'custom',
    wizard: null,
    wizardDirty: false,
    previewText: '',
    previewError: '',
    previewTimer: null,
    logs: '',
    logsSource: '',
    logsError: '',
    logExpanded: false,
    logErrorsOnly: false,
    selftest: null,
    installBusy: false,
    installProgress: null,
    error: '',
  },
};

/* ----------------------------- 图标 ------------------------------ */

const ICON_PATHS = {
  gauge: '<path d="M4 19a8 8 0 1 1 16 0"/><path d="M12 15l3.5-4.5"/><circle cx="12" cy="15" r="1.4"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M7.6 16.4a4 4 0 0 1 0-5.5l2-2a4 4 0 0 1 5.5 5.5"/><path d="M16.4 7.6a4 4 0 0 1 0 5.5l-2 2a4 4 0 0 1-5.5-5.5"/>',
  box: '<path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5z"/><path d="m3.5 8.5 8.5 4.5 8.5-4.5M12 13v7"/>',
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h3.5"/>',
  power: '<path d="M12 3.8v7.4"/><path d="M7.6 6.6a7.6 7.6 0 1 0 8.8 0"/>',
  server: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><circle cx="7.5" cy="7.2" r="1"/><circle cx="7.5" cy="16.7" r="1"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.6a7.6 7.6 0 0 0 .1-3.2l2-1.5-2-3.4-2.4 1a7.6 7.6 0 0 0-2.7-1.6L14 2.4h-4l-.4 2.5A7.6 7.6 0 0 0 6.9 6.5l-2.4-1-2 3.4 2 1.5a7.6 7.6 0 0 0-.1 3.2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 0 0 2.7 1.6l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.7-1.6l2.4 1 2-3.4-2-1.5z"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>',
  reload: '<path d="M4 12a8 8 0 0 1 13.6-5.7"/><path d="M20 12a8 8 0 0 1-13.6 5.7"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15a2 2 0 0 1-1-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 1"/>',
  external: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M17 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h5"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6.5 7l.8 12h9.4l.8-12M10 10.5v5M14 10.5v5"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2.2 2.2 0 0 0-3-3L5 17z"/><path d="m13.5 5.5 3 3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 6.5"/>',
  alert: '<path d="M12 3.5 21 19H3z"/><path d="M12 9.5v4M12 16.2v.3"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 19h16"/>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17"/>',
  server: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M7.5 7h.1M7.5 17h.1"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z"/><path d="m8.8 12 2.2 2.2 4.2-4.5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  activity: '<path d="M3 12h4l2.5-6 4 12 3-8 2 4h2.5"/>',
  eye: '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeoff: '<path d="M4 4l16 16"/><path d="M9.5 9.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-1.2M6.6 6.8C4.6 8.3 3 12 3 12s3.5 6 9 6a10 10 0 0 0 4.2-.9M10.7 6.2A9 9 0 0 1 12 6c5.5 0 9 6 9 6a14 14 0 0 1-1.8 2.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
};

function icon(name, cls = '') {
  const path = ICON_PATHS[name] || '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ''} aria-hidden="true">${path}</svg>`;
}

/* ----------------------------- 工具 ------------------------------ */

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function modeLabel(mode) {
  return {
    service: 'Windows 服务托管',
    managed: '应用托管进程',
    starting: '正在启动',
    external: '外部 frpc 进程',
    stopped: '未运行',
  }[mode] || mode || '未知';
}

const TYPE_LABEL = { tcp: 'TCP', udp: 'UDP', http: 'HTTP', https: 'HTTPS', stcp: 'STCP', sudp: 'SUDP', xtcp: 'XTCP', tcpmux: 'TCPMUX' };

function healthTip(h) {
  if (!h || !h.layers) return '';
  const label = (name, layer) => {
    if (!layer) return `${name}：—`;
    if (layer.skipped) return `${name}：不适用`;
    return `${name}：${layer.ok ? '通' : '不通'}`;
  };
  const parts = [
    label('本地服务', h.layers.local),
    label('隧道', h.layers.tunnel),
    label('公网', h.layers.public),
  ];
  return parts.join(' · ');
}

/* ---------------------------- 提示条 ----------------------------- */

function toast(kind, title, message = '') {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind || 'info'}`;
  el.innerHTML = `
    <span class="t-icon">${icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : kind === 'warn' ? 'shield' : 'activity')}</span>
    <div class="t-text">
      <strong class="t-title">${esc(title)}</strong>
      ${message ? `<span class="t-msg">${esc(message)}</span>` : ''}
    </div>
    <button class="t-close" type="button" aria-label="关闭">×</button>`;
  const remove = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.t-close').addEventListener('click', remove);
  root.appendChild(el);
  setTimeout(remove, kind === 'error' ? 7200 : 4200);
}

function toastResult(res, successTitle) {
  if (!res) return;
  if (!res.ok) {
    toast('error', '操作失败', res.error || '未知错误');
  } else if (successTitle) {
    toast('success', successTitle, '');
  }
}

/* ---------------------------- 状态判定 ---------------------------- */

function runtimeInfo() {
  const state = S.state || {};
  const r = state.runtime || {};
  const service = state.service || {};
  const runMode = (state.settings || {}).runMode || 'auto';
  // connected 只代表本机管理 API 有响应，不代表已登录 frps。
  const online = !!r.connected && !r.loginFailed;
  const running = !!r.connected;
  const starting = r.mode === 'starting' || !!r.pending;
  const external = r.mode === 'external';
  // 只有在“本来该由系统服务提供隧道”的模式下，服务停了才值得单独提示。
  // 托管模式下服务停着是常态，再报“系统服务未运行”只会把人引偏。
  const wantsService = runMode === 'auto' || runMode === 'service';
  const serviceDown = wantsService && service.installed && !online && (service.state === 'stopped' || service.state === 'paused' || service.state === 'stop-pending');
  let tone = 'warn';
  let label = '未连接';
  let title = '隧道未运行';
  let desc = '';
  if (online && !starting) {
    tone = 'online';
    label = '隧道在线';
    title = '隧道已连接';
    desc = modeLabel(r.mode);
  } else if (starting) {
    tone = 'warn';
    label = '连接中…';
    title = '正在连接服务器';
    desc = r.pending ? 'frpc 正在登录 frps，代理尚未注册' : '等待管理 API 就绪';
  } else if (external) {
    tone = 'warn';
    label = '外部进程';
    title = '检测到外部 frpc 进程';
    desc = '隧道可能由其他方式启动';
  } else if (r.loginFailed || r.connectFailed) {
    // frpc 起来了但没登录上 frps，或连不上后直接退出——都不能显示成“已连接”。
    // 这个分支必须排在“服务已停止”前面：装了服务但没连上时，只报“服务未运行”会把人引去启服务，
    // 而真正的原因（端口没开 / Token 不对 / 被代理拦）就藏在下面的日志里。
    const why = { refused: '端口未监听', unreachable: '网络不可达', auth: 'Token 校验失败', proxy: '被代理/网关拦截', unconfirmed: '服务器未确认代理' }[r.connectKind] || '连接失败';
    tone = 'error';
    label = '未连上服务器';
    title = 'frpc 连不上 frps';
    // 概览页标题下方本来就会打印 serverAddr:serverPort，这里只说原因，免得地址重复两遍。
    desc = why;
  } else if (serviceDown) {
    tone = 'error';
    label = '服务已停止';
    title = '系统服务未运行';
    desc = 'frpc 服务已停止';
  } else {
    tone = 'error';
    label = '未连接';
    title = '隧道未运行';
    // 这里没有任何进程在跑，apiError（“管理 API 未启动”）对用户毫无信息量，只留操作提示。
    desc = '点击“启动隧道”建立连接';
  }
  return { tone, label, title, desc, online, running, starting, external, r, service };
}

/* ---------------------------- 页面骨架 ---------------------------- */

const NAV_ITEMS = [
  { id: 'overview', label: '概览', icon: 'gauge', sub: '运行状态与快捷入口' },
  { id: 'proxies', label: '代理映射', icon: 'link', sub: '穿透规则与公网地址' },
  { id: 'discovery', label: '服务发现', icon: 'box', sub: '本机端口扫描' },
  { id: 'server', label: '服务器', icon: 'server', sub: 'frps 远程管理' },
  { id: 'logs', label: '实时日志', icon: 'terminal', sub: 'frpc 运行日志' },
  { id: 'settings', label: '设置', icon: 'gear', sub: '连接、路径与运行模式' },
];

function buildNav() {
  const nav = $('#nav');
  nav.innerHTML = NAV_ITEMS.map(
    (item) => `
      <button class="nav-item${S.view === item.id ? ' active' : ''}" type="button" data-act="nav" data-view="${item.id}" title="${esc(item.sub)}">
        <span class="nav-icon">${icon(item.icon)}</span>
        <span class="grow">${esc(item.label)}</span>
        ${item.id === 'proxies' ? '<span class="nav-badge" id="nav-proxy-count">0</span>' : ''}
      </button>`,
  ).join('');
  updateNavBadge();
}

function updateNavBadge() {
  const badge = $('#nav-proxy-count');
  if (!badge) return;
  const counts = S.state && S.state.counts;
  badge.textContent = counts ? String(counts.total) : '0';
}

function updateChrome() {
  const info = runtimeInfo();
  const pill = $('#tb-status');
  if (pill) {
    pill.className = `status-pill ${info.tone}`;
    pill.querySelector('.label').textContent = info.label;
    pill.title = info.desc ? `${info.title} · ${info.desc}` : info.title;
  }
  const mini = $('#mini-status');
  if (mini) {
    mini.className = `mini-status ${info.tone === 'online' ? 'online' : info.tone === 'error' ? 'error' : 'warn'}`;
    mini.querySelector('.mini-title').textContent = info.title;
    mini.querySelector('.mini-sub').textContent = info.online ? `${S.state.app && S.state.app.uptimeLabel || ''} · ${modeLabel(info.r.mode)}` : info.desc;
  }
  const ver = $('#side-version');
  if (ver) ver.textContent = S.state && S.state.app ? `v${S.state.app.version}` : 'FRP 控制台';
  const frpc = $('#side-frpc');
  if (frpc) frpc.textContent = S.state && S.state.app && S.state.app.frpcVersion ? `frpc ${S.state.app.frpcVersion}` : 'frpc ·';
  const crumb = $('#tb-crumb');
  if (crumb) crumb.textContent = (NAV_ITEMS.find((n) => n.id === S.view) || NAV_ITEMS[0]).label;
  updateNavBadge();
}

function setView(view, { force = false } = {}) {
  const changed = !S.view || S.view !== view;
  if (changed) {
    S.viewScroll[S.view] = $('#view') ? $('#view').scrollTop : 0;
    S.view = view;
    $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    updateChrome();
  }
  renderCurrent({ force: true });
  const main = $('#view');
  if (main) {
    main.scrollTop = S.viewScroll[view] || 0;
    if (changed) {
      // 只在切换页面时播放一次入场动画，播完就摘掉类，避免后续重渲染重放
      main.classList.remove('enter');
      void main.offsetWidth;
      main.classList.add('enter');
      setTimeout(() => main.classList.remove('enter'), 400);
    }
  }
}

function renderCurrent({ force = false } = {}) {
  if (!S.ready) return;
  if (S.view === 'overview') renderOverview(force);
  else if (S.view === 'proxies') renderProxies(force);
  else if (S.view === 'discovery') renderDiscovery(force);
  else if (S.view === 'logs') renderLogs(force);
  else if (S.view === 'server') renderServer(force);
  else if (S.view === 'settings') renderSettings(force);
  if (S.view === 'server' && !S.server.loaded) loadServerState({ autoConnect: true }).catch(() => {});
}

/* ----------------------------- 概览 ------------------------------ */

// 注意：不要把“最后一条日志 id”算进这个键。
// frpc 会周期性写日志，算进去会导致概览页每隔几十秒整页重渲染，入场动画重放，表现为界面闪一下。
// 迷你日志由 refreshMiniLog() 单独就地更新。
function overviewKey() {
  const s = S.state || {};
  const r = s.runtime || {};
  const svc = s.service || {};
  return JSON.stringify({
    m: r.mode, c: r.connected, p: r.pid, since: r.since, api: r.apiError,
    // 连接失败原因（已去掉时间戳，同一错误重试时字符串不变，不会引起频繁重渲染）
    ce: r.connectKind || '', cx: r.connectError ? 1 : 0, lf: r.loginFailed ? 1 : 0, pd: r.pending ? 1 : 0,
    svc: svc.state, svcType: svc.startType,
    counts: s.counts, cfgErr: s.configError,
    val: s.validation && s.validation.errors ? s.validation.errors.length : 0,
    proxies: (s.proxies || []).map((p) => [p.name, p.status, p.publicAddress, p.health && p.health.ok, p.health && p.health.reason, p.statusError]),
  });
}

/* 概览页“最近日志”卡片的最小刷新：只换日志区，不重建整页 */
function miniLogHtml() {
  const recent = S.logs.slice(-9).reverse();
  return recent.length
    ? recent.map((l) => logLineHtml(l)).join('')
    : '<div class="log-empty"><span>暂无日志</span></div>';
}

function refreshMiniLog() {
  const body = document.querySelector('.mini-log .log-body');
  if (!body) return;
  body.innerHTML = miniLogHtml();
}

// 把“三层检查失败”落到具体层级，别只丢一句模糊结论。
function layerFailText(counts) {
  if (counts.unhealthyLocal) return `${counts.unhealthyLocal} 个本地服务不通`;
  if (counts.unhealthyTunnel) return `${counts.unhealthyTunnel} 个隧道未建立`;
  if (counts.unhealthyPublic) return `${counts.unhealthyPublic} 个公网不可达`;
  return '存在隧道或公网检查失败';
}

function renderOverview(force = false) {
  const key = overviewKey();
  if (!force && S.lastKeys.overview === key) return;
  S.lastKeys.overview = key;
  const state = S.state || {};
  const info = runtimeInfo();
  const counts = state.counts || { total: 0, online: 0, unhealthy: 0, unhealthyLocal: 0 };
  const proxies = state.proxies || [];
  const app = state.app || {};
  const settings = state.settings || {};
  const config = state.config || {};
  const dashboard = state.dashboardUrl || '';
  const validation = state.validation || {};
  // 第一次打开时只差“服务器地址”没填，这是正常状态而不是配置出错：
  // 用中性提示引导去设置，别拿红色报错吓人。
  const validationErrors = validation.errors || [];
  const onlyMissingServer = !config.serverAddr
    && validationErrors.length === 1
    && validationErrors[0].field === 'serverAddr';

  const addresses = proxies
    .filter((p) => p.publicAddress)
    .slice(0, 7)
    .map((p) => {
      const failed = p.health && !p.health.ok;
      const online = p.status === 'running' && p.health && p.health.ok;
      const dotColor = online ? 'var(--green)' : failed ? 'var(--red)' : 'var(--amber)';
      const dotTip = online ? '三层连通' : failed ? (p.health.reason || '链路异常') : '正在检测连通性';
      return `
        <div class="addr-row">
          <span class="ar-dot" title="${esc(dotTip)}" style="background:${dotColor}"></span>
          <div class="ar-main">
            <span class="ar-name">${esc(p.name)}</span>
            <span class="ar-addr" title="${esc(p.publicAddress)}">${esc(p.publicAddress)}</span>
          </div>
          <div class="ar-actions">
            <button class="icon-btn" type="button" data-act="copy" data-text="${esc(p.publicAddress)}" title="复制地址">${icon('copy')}</button>
            ${(p.type === 'http' || p.type === 'https')
              ? `<button class="icon-btn" type="button" data-act="open" data-url="${esc(p.publicAddress)}" title="在浏览器中打开">${icon('external')}</button>`
              : `<button class="icon-btn" type="button" data-act="probe.remote" data-host="${esc(config.serverAddr || '')}" data-port="${esc(p.remotePort || '')}" data-name="${esc(p.name)}" title="测试公网端口">${icon('activity')}</button>`}
          </div>
        </div>`;
    })
    .join('');

  const logLines = miniLogHtml();

  const issues = [];
  if (state.configError) issues.push(`<div class="note error">${icon('alert')}<div>${esc(state.configError)}</div></div>`);
  if (onlyMissingServer) {
    issues.push(`<div class="note">${icon('alert')}<div><strong>还没有连上服务器</strong><br>到「服务器」页新建一个档案，填 IP 和 SSH 密码，连上后一键初始化 frps——地址与 Token 会自动写进本机配置，不用手填。<br><span style="opacity:.75">服务器就绪后，去「代理映射」加一条穿透规则，回来这里看三层是否全绿。</span></div></div>`);
  } else if (validationErrors.length) {
    issues.push(`<div class="note error">${icon('alert')}<div><strong>配置存在 ${validationErrors.length} 处错误</strong><br>${esc(validationErrors[0].message)}</div></div>`);
  }
  const runtime = state.runtime || {};
  // 两种情况都算“没连上”：frpc 没起来 / 起来了但没登录上 frps / 日志里明确记着连不上。
  const offline = !!(runtime.loginFailed || runtime.connectFailed);
  // 隧道根本没连上时，代理“三层不通”只是结果。这时说清楚连不上谁、为什么，
  // 别让人去查本地服务（本地可能完全正常）。
  if (offline) {
    const target = config.serverAddr ? `${config.serverAddr}:${config.serverPort || 7000}` : '服务器';
    const why = {
      refused: `服务器上的 frps 没在 ${config.serverPort || 7000} 端口监听：服务没启动、端口改过，或被防火墙拒绝。`,
      unreachable: '连不到服务器端口：网络 / 安全组把它丢了，也可能本机的代理、VPN 在拦截。',
      auth: 'frps 在线，但 Token 校验没过：档案里的 Token 与服务端 auth.token 不一致。',
      proxy: '本机到服务器的链路走了 HTTP 代理，请求被网关挡回 502/503。到「设置 → 运行模式与行为」打开“不继承系统代理”，或让代理放行该端口。',
      unconfirmed: 'frpc 进程起来了，但配置里的代理一个都没在服务器上注册成功，说明还没登录上 frps（端口不对、Token 不符或被网络挡了）。',
      unknown: '具体原因见概览下方的 frpc 日志。',
    }[runtime.connectKind] || '具体原因见概览下方的 frpc 日志。';
    issues.push(`<div class="note error">${icon('alert')}<div><strong>隧道没连上 ${esc(target)}</strong><br>${esc(why)}${runtime.connectError ? `<br><span class="mono" style="font-size:11px;opacity:.75">${esc(runtime.connectError)}</span>` : ''}<br><span style="opacity:.75">本地服务（如 localhost:8080）通不通都不影响这一步——先把隧道连上，公网才会有转发。</span></div></div>`);
  } else if (counts.unhealthy > 0) {
    const parts = [];
    if (counts.unhealthyLocal) parts.push(`本地服务不通 ${counts.unhealthyLocal} 个`);
    if (counts.unhealthyTunnel) parts.push(`隧道未建立 ${counts.unhealthyTunnel} 个`);
    if (counts.unhealthyPublic) parts.push(`公网不可达 ${counts.unhealthyPublic} 个`);
    const detail = parts.length ? `（${parts.join('、')}）` : '';
    issues.push(`<div class="note warn">${icon('alert')}<div>有 ${counts.unhealthy} 个代理未通过三层连通性检查${detail}，公网访问会失败。</div></div>`);
  }

  $('#view').innerHTML = `
    <div class="view">
      <section class="card hero">
        <div class="hero-main">
          <div class="hero-status">
            <div class="hero-orb ${info.online ? 'online' : info.tone === 'error' ? 'error' : 'warn'}">${icon(info.online ? 'shield' : info.starting ? 'clock' : 'alert')}</div>
            <div class="hero-titles">
              <h2>${esc(info.title)}</h2>
              <p>${esc(config.serverAddr ? `${config.serverAddr}:${config.serverPort}` : '尚未配置服务器')} · ${esc(info.desc)}</p>
            </div>
          </div>
          <div class="hero-actions">
            ${info.running
              ? `<button class="btn" type="button" data-act="tunnel.restart" title="重启 frpc（连不上服务器时先试这个）">${icon('restart')}<span>重启</span></button>
                 <button class="btn danger" type="button" data-act="tunnel.stop">${icon('stop')}<span>停止隧道</span></button>`
              : `<button class="btn primary" type="button" data-act="tunnel.start">${icon('play')}<span>启动隧道</span></button>`}
            <button class="btn" type="button" data-act="tunnel.reload" title="从磁盘重新载入代理配置，不断开连接">${icon('reload')}<span>热重载</span></button>
            ${dashboard ? `<button class="btn ghost" type="button" data-act="open" data-url="${esc(dashboard)}" title="打开 frps 面板">${icon('globe')}<span>服务器面板</span></button>` : ''}
          </div>
          <div class="hero-details">
            <div class="hero-cell"><span>运行模式</span><strong>${esc(modeLabel(info.r.mode))}</strong></div>
            <div class="hero-cell"><span>服务器端口</span><strong>${esc(config.serverPort || '—')}</strong></div>
            <div class="hero-cell"><span>进程 PID</span><strong>${esc(info.r.pid || '—')}</strong></div>
          </div>
        </div>
        <div class="hero-side">
          <div class="hero-side-title">公网地址</div>
          <div class="addr-list">
            ${addresses || '<div class="muted" style="font-size:11.5px;padding:10px 2px">还没有可用的公网映射</div>'}
          </div>
        </div>
      </section>

      <section class="metrics" style="margin-top:16px">
        <div class="card metric">
          <div class="metric-top"><span class="metric-label">代理总数</span><span class="metric-icon">${icon('link')}</span></div>
          <div class="metric-value">${esc(counts.total)}</div>
          <div class="metric-foot"><span>已配置的穿透规则</span></div>
        </div>
        <div class="card metric">
          <div class="metric-top"><span class="metric-label">在线代理</span><span class="metric-icon">${icon('activity')}</span></div>
          <div class="metric-value">${esc(counts.online)}<small> / ${esc(counts.total)}</small></div>
          <div class="metric-foot"><span class="${!config.serverAddr ? '' : (counts.online === counts.total && counts.total ? 'up' : 'down')}">${!config.serverAddr ? '配置服务器后自动检测' : counts.total ? (counts.online === counts.total ? '全部在线' : `${counts.total - counts.online} 条未通过连通性检查`) : '暂无代理'}</span></div>
        </div>
        <div class="card metric">
          <div class="metric-top"><span class="metric-label">连通性异常</span><span class="metric-icon">${icon('cpu')}</span></div>
          <div class="metric-value">${config.serverAddr ? esc(counts.unhealthy || 0) : '—'}</div>
          <div class="metric-foot"><span class="${!config.serverAddr ? '' : counts.unhealthy ? 'down' : 'up'}">${!config.serverAddr ? '尚未开始检测' : counts.unhealthy ? layerFailText(counts) : '全部代理三层全通（本地 → 隧道 → 公网）'}</span></div>
        </div>
        <div class="card metric">
          <div class="metric-top"><span class="metric-label">运行时长</span><span class="metric-icon">${icon('clock')}</span></div>
          <div class="metric-value">${esc(app.uptimeLabel || '—')}</div>
          <div class="metric-foot"><span>${esc(app.frpcVersion ? `frpc ${app.frpcVersion}` : 'frpc 0.61')}</span></div>
        </div>
      </section>

      <div class="grid-2">
        <section class="card mini-log">
          <div class="card-head">
            <div class="card-title">${icon('terminal', 'ct-icon')}<span>最近日志</span></div>
            <button class="btn ghost small" type="button" data-act="nav" data-view="logs">全部日志 ${icon('up')}</button>
          </div>
          <div class="log-body" style="padding:6px 16px 14px">${logLines}</div>
        </section>

        <div class="stack">
          <section class="card">
          <div class="card-head">
            <div class="card-title">${icon('server', 'ct-icon')}<span>连接信息</span></div>
            <button class="btn ghost small" type="button" data-act="nav" data-view="server">服务器页</button>
          </div>
            <div class="card-pad" style="padding-top:0">
              <div class="detail-list">
                ${detailRow('服务器', config.serverAddr ? `${config.serverAddr}:${config.serverPort}` : '未配置')}
                ${detailRow('认证方式', `${config.auth && config.auth.method || 'token'}${config.auth && config.auth.token ? ' · 已设置' : ' · 未设置'}`, config.auth && config.auth.token ? 'ok' : 'bad')}
                ${detailRow('管理 API', info.r.adminPort ? `127.0.0.1:${info.r.adminPort}` : '未启用', info.r.connected ? 'ok' : 'bad')}
                ${detailRow('系统服务', info.service.installed ? `${info.service.name} · ${serviceStateText(info.service.state)}` : '未安装')}
                ${detailRow('管理员权限', app.elevated ? '已提升' : '普通权限', app.elevated ? 'ok' : '')}
                ${detailRow('配置文件', state.paths && state.paths.configPath ? state.paths.configPath : '未设置', state.paths && state.paths.configExists ? 'ok' : 'bad', true)}
              </div>
            </div>
          </section>
          ${issues.join('')}
        </div>
      </div>
    </div>`;

  bindConfigReveal();
}

function detailRow(label, value, tone = '', mono = false) {
  return `<div class="detail-row"><span class="dr-label">${esc(label)}</span><span class="dr-value${mono ? ' mono-text' : ''} ${tone ? `dr-${tone}` : ''}" title="${esc(value)}">${esc(value)}</span></div>`;
}

function serviceStateText(state) {
  return { running: '运行中', stopped: '已停止', paused: '已暂停', 'start-pending': '启动中', 'stop-pending': '停止中', missing: '未安装', unknown: '未知' }[state] || state || '未知';
}

function bindConfigReveal() {
  $$('[data-reveal]').forEach((el) => {
    el.addEventListener('click', () => FRP.revealPath(el.dataset.reveal).catch(() => {}));
  });
}

/* ---------------------------- 代理映射 ---------------------------- */

function proxiesKey() {
  const s = S.state || {};
  return JSON.stringify({
    q: S.proxyQuery,
    cfgErr: s.configError,
    list: (s.proxies || []).map((p) => [p.name, p.type, p.status, p.statusError, p.publicAddress, p.localPort, p.health && p.health.ok, p.health && p.health.ms, p.health && p.health.reason]),
  });
}

function renderProxies(force = false) {
  const key = proxiesKey();
  const q = S.proxyQuery;
  const searchEl = $('#proxy-search');
  if (!force && document.activeElement === searchEl && searchEl) return;
  if (!force && S.lastKeys.proxies === key) return;
  S.lastKeys.proxies = key;
  const state = S.state || {};
  const all = state.proxies || [];
  const list = all.filter((p) => {
    if (!q) return true;
    const text = `${p.name} ${p.type} ${p.localPort} ${p.publicAddress}`.toLowerCase();
    return text.includes(q.toLowerCase());
  });

  const rows = list.map(proxyRowHtml).join('');
  const empty = !all.length;

  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>代理映射</h1>
          <p>把本机服务发布到公网。${all.length ? `共 ${all.length} 条，${all.filter((p) => p.status === 'running').length} 条在线。` : '还没有代理，先新增一条吧。'}</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" data-act="tunnel.reload">${icon('reload')}<span>热重载</span></button>
          <button class="btn primary" type="button" data-act="proxy.add">${icon('plus')}<span>新增代理</span></button>
        </div>
      </div>

      ${state.configError ? `<div class="note error" style="margin-bottom:14px">${icon('alert')}<div>${esc(state.configError)}</div></div>` : ''}

      <section class="card table-card">
        <div class="toolbar">
          <div class="search">
            ${icon('search')}
            <input id="proxy-search" type="text" placeholder="搜索名称、本地端口或公网地址…" value="${esc(q)}" autocomplete="off" />
          </div>
          <span class="muted" style="font-size:11px">${esc(list.length)} 条结果</span>
        </div>
        ${empty
          ? `<div class="empty" style="padding:44px 20px">
              <div class="empty-illustration">${icon('link')}</div>
              <strong>还没有代理映射</strong>
              <p>点击右上角“新增代理”，把本机运行的 Web 服务、远程桌面或其他端口发布到公网。</p>
              <button class="btn primary" type="button" data-act="proxy.add">${icon('plus')}<span>新增代理</span></button>
            </div>`
          : `<table class="proxy-table">
              <thead><tr>
                <th>名称 / 类型</th><th>本地服务</th><th>公网地址</th><th>状态</th><th style="text-align:right">操作</th>
              </tr></thead>
              <tbody>${rows || `<tr><td colspan="5"><div class="empty" style="padding:26px"><p>没有匹配「${esc(q)}」的代理</p></div></td></tr>`}</tbody>
            </table>`}
      </section>
    </div>`;

  const input = $('#proxy-search');
  if (input) {
    input.addEventListener('input', () => {
      S.proxyQuery = input.value;
      S.lastKeys.proxies = '';
      const pos = input.selectionStart;
      renderProxies(true);
      const next = $('#proxy-search');
      if (next) { next.focus(); next.setSelectionRange(pos, pos); }
    });
  }
}

function proxyRowHtml(p) {
  const failed = p.health && !p.health.ok;
  const tip = healthTip(p.health);
  const status = p.status === 'running'
    ? (failed
      ? `<span class="badge red" title="${esc(tip)}"><span class="bdot"></span>${esc(p.health.reason || '链路异常')}</span>`
      : '<span class="badge green"><span class="bdot"></span>在线</span>')
    : p.status === 'pending'
      ? '<span class="badge amber"><span class="bdot"></span>同步中</span>'
      : '<span class="badge muted"><span class="bdot"></span>未同步</span>';
  const health = p.health
    ? (p.health.ok
      ? `<span class="health-hint" title="${esc(tip)}">${icon('check')}三层连通 · ${esc(p.health.ms)}ms</span>`
      : `<span class="health-hint bad" title="${esc(tip)}">${icon('alert')}${esc(p.health.reason || p.health.error || '链路异常')}</span>`)
    : '';
  const publicCell = p.publicAddress
    ? `<div class="pub-cell">
        <code title="${esc(p.publicAddress)}">${esc(p.publicAddress)}</code>
        <div class="muted" style="font-size:10px">${esc(p.runtimeRemote || '')}${p.runtimeRemote && p.runtimeLocal ? ' · ' : ''}${esc(p.runtimeLocal || '')}</div>
      </div>`
    : '<span class="muted" style="font-size:11.5px">未分配</span>';
  return `
    <tr>
      <td>
        <div class="name-cell">
          <strong>${esc(p.name)}</strong>
          <small><span class="badge ${esc(p.type)}" style="font-size:9.5px;padding:1px 6px">${esc(TYPE_LABEL[p.type] || p.type)}</span></small>
        </div>
      </td>
      <td>
        <div class="mono">${esc(p.localIP || '127.0.0.1')}:${esc(p.localPort)}</div>
        ${health}
        ${p.statusError ? `<div class="health-hint bad">${icon('alert')}${esc(p.statusError)}</div>` : ''}
      </td>
      <td>${publicCell}</td>
      <td>${status}</td>
      <td>
        <div class="trow-actions">
          <button class="icon-btn" type="button" data-act="proxy.test-local" data-name="${esc(p.name)}" data-port="${esc(p.localPort)}" title="测试本机端口">${icon('activity')}</button>
          ${p.publicAddress ? `<button class="icon-btn" type="button" data-act="copy" data-text="${esc(p.publicAddress)}" title="复制公网地址">${icon('copy')}</button>` : ''}
          ${(p.type === 'http' || p.type === 'https') && p.publicAddress
            ? `<button class="icon-btn" type="button" data-act="open" data-url="${esc(p.publicAddress)}" title="打开公网地址">${icon('external')}</button>` : ''}
          <button class="icon-btn" type="button" data-act="proxy.edit" data-name="${esc(p.name)}" title="编辑">${icon('edit')}</button>
          <button class="icon-btn danger" type="button" data-act="proxy.delete" data-name="${esc(p.name)}" title="删除">${icon('trash')}</button>
        </div>
      </td>
    </tr>`;
}

/* ---------------------------- 服务发现 ---------------------------- */

function renderDiscovery(force = false) {
  if (!force && S.lastKeys.discovery === 'rendered') return;
  S.lastKeys.discovery = 'rendered';
  const listeners = S.listeners || [];

  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>服务发现</h1>
          <p>扫描本机 TCP 监听端口，把正在运行的服务一键发布成公网代理。</p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" data-act="listeners.scan" ${S.listenersBusy ? 'disabled' : ''}>${S.listenersBusy ? '<span class="spinner-sm"></span>' : icon('reload')}<span>扫描本机端口</span></button>
        </div>
      </div>

      <section class="card table-card">
        <div class="toolbar">
          <div class="card-title">${icon('server', 'ct-icon')}<span>本机监听端口</span></div>
          <span class="muted" style="font-size:11px">${listeners.length ? `${listeners.length} 个 TCP 监听` : '尚未扫描'}</span>
        </div>
        ${S.listenersBusy && !listeners.length
          ? `<div class="empty" style="padding:34px 20px"><span class="spinner-sm"></span><p style="margin-top:10px">正在扫描本机端口…</p></div>`
          : listeners.length
            ? `<table class="listener-table">
                <thead><tr><th>端口</th><th>监听地址</th><th>进程</th><th>PID</th><th style="text-align:right">发布</th></tr></thead>
                <tbody>${listeners.slice(0, 200).map(listenerRow).join('')}</tbody>
              </table>`
            : `<div class="empty" style="padding:30px 20px"><p>还没有扫描结果，点击右上角“扫描本机端口”。</p></div>`}
      </section>

      <div class="note" style="margin-top:14px">
        ${icon('info')}
        <div>扫描结果来自 netstat，本机运行的服务及其监听端口都会出现在这里。找到要穿透的端口后点“添加代理”。进程名显示“未知”时，可按 PID 在任务管理器里对照。${S.listenersError ? `<br><span style="opacity:.7">进程名读取失败：${esc(S.listenersError)}</span>` : ''}</div>
      </div>
    </div>`;

  if (!S.listeners && !S.listenersBusy) {
    // 首次进入自动扫描，不阻塞渲染
    scanListeners({ silent: true });
  }
}

function listenerRow(l) {
  return `<tr>
    <td class="port-cell">${esc(l.port)}</td>
    <td class="addr-cell" title="${esc(l.hosts ? l.hosts.join(', ') : '')}">${esc(l.hosts ? l.hosts[0] : '')}${l.hosts && l.hosts.length > 1 ? ` +${l.hosts.length - 1}` : ''}</td>
    <td class="proc-cell" title="${esc(l.process || '当前进程环境无法读取进程名')}">${esc(l.process || '未知')}</td>
    <td class="addr-cell">${esc(l.pid)}</td>
    <td style="text-align:right"><button class="btn small" type="button" data-act="listener.publish" data-port="${esc(l.port)}" data-process="${esc(l.process)}">添加代理</button></td>
  </tr>`;
}

/* ----------------------------- 日志 ------------------------------ */

function logLineHtml(l) {
  const level = String(l.level || 'info').toLowerCase();
  const lv = { error: 'ERR', warn: 'WRN', info: 'INF', debug: 'DBG', trace: 'TRC' }[level] || level.toUpperCase().slice(0, 3);
  return `<div class="log-line ${esc(level)}">
    <span class="lt">${esc(l.time || fmtTime(l.ts))}</span>
    <span class="lv">${esc(lv)}</span>
    <span class="ltx">${esc(l.text)}</span>
  </div>`;
}

function filteredLogs() {
  if (!S.logLevel) return S.logs;
  return S.logs.filter((l) => String(l.level || '').toLowerCase() === S.logLevel);
}

function renderLogs(force = false) {
  if (!force && S.lastKeys.logs === 'rendered') return;
  S.lastKeys.logs = 'rendered';
  const lines = filteredLogs();
  const pathText = (S.state && S.state.paths && S.state.paths.logPath) || '';
  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>实时日志</h1>
          <p>frpc 会持续写入日志文件，控制台实时跟随。共缓存 ${S.logs.length} 条。</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" data-act="logs.export" ${S.logs.length ? '' : 'disabled'}>${icon('download')}<span>导出</span></button>
          <button class="btn" type="button" data-act="logs.clear">${icon('trash')}<span>清空显示</span></button>
          <button class="btn" type="button" data-act="logs.refresh">${icon('reload')}<span>刷新</span></button>
        </div>
      </div>

      <section class="card log-panel">
        <div class="log-head">
          <div class="log-dots"><i></i><i></i><i></i></div>
          <span class="lh-title" title="${esc(pathText)}">${esc(pathText || 'frpc.log')}</span>
          <div class="lh-right">
            <button class="btn ghost small" type="button" data-act="logs.file" title="在资源管理器中打开日志文件">${icon('folder')}</button>
            <span>${S.logs.length ? `最后一条：${esc(S.logs[S.logs.length - 1].time || fmtTime(S.logs[S.logs.length - 1].ts))}` : '暂无日志'}</span>
          </div>
        </div>
        <div class="log-body" id="log-body">${lines.length ? lines.map(logLineHtml).join('') : '<div class="log-empty"><span>暂无日志</span></div>'}</div>
      </section>

      <div class="log-toolbar" style="margin-top:14px">
        <div class="seg" id="log-levels">
          ${['', 'info', 'warn', 'error', 'debug'].map((lv) => `<button type="button" data-act="logs.level" data-level="${lv}" class="${S.logLevel === lv ? 'active' : ''}">${lv ? lv.toUpperCase() : '全部'}</button>`).join('')}
        </div>
        <button class="btn small ${S.follow ? 'primary' : ''}" type="button" data-act="logs.follow">${icon('up')}<span>${S.follow ? '自动滚动' : '自动滚动已关闭'}</span></button>
        <span class="muted" style="font-size:11px">显示 ${lines.length} 条</span>
      </div>
    </div>`;
  const body = $('#log-body');
  if (body && S.follow) body.scrollTop = body.scrollHeight;
}

function appendLogs(lines) {
  if (!lines || !lines.length) return;
  S.logs.push(...lines);
  const max = Math.min(2000, Math.max(100, Number((S.state && S.state.settings && S.state.settings.logBuffer) || 600)));
  if (S.logs.length > max) S.logs.splice(0, S.logs.length - max);
  const body = $('#log-body');
  if (!body || S.view !== 'logs') {
    // 概览页的“最近日志”就地更新，避免为了几行日志重建整页
    if (S.view === 'overview') refreshMiniLog();
    return;
  }
  const filtered = lines.filter((l) => !S.logLevel || String(l.level || '').toLowerCase() === S.logLevel);
  if (!filtered.length) return;
  const placeholder = body.querySelector('.log-empty');
  if (placeholder) placeholder.remove();
  const frag = document.createElement('div');
  frag.innerHTML = filtered.map(logLineHtml).join('');
  const wasBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  while (frag.firstChild) body.appendChild(frag.firstChild);
  while (body.children.length > max) body.removeChild(body.firstChild);
  if (S.follow || wasBottom) body.scrollTop = body.scrollHeight;
  const countEl = $('.lh-right span');
  if (countEl) {
    const last = S.logs[S.logs.length - 1];
    countEl.textContent = last ? `最后一条：${last.time || fmtTime(last.ts)}` : '暂无日志';
  }
}

/* ---------------------------- 服务器 ---------------------------- */

const SERVER_FIELD_DEFAULTS = {
  bindAddr: '0.0.0.0',
  bindPort: 7000,
  authEnabled: true,
  token: '',
  webEnabled: true,
  webAddr: '0.0.0.0',
  webPort: 4096,
  webUser: 'admin',
  webPassword: '',
  vhostHTTPEnabled: false,
  vhostHTTPPort: 80,
  vhostHTTPSEnabled: false,
  vhostHTTPSPort: 443,
  allowPortsText: '',
};

function wizardDefaults() {
  return { ...SERVER_FIELD_DEFAULTS };
}

function wizardFromSummary(summary) {
  const s = summary || {};
  return {
    bindAddr: s.bindAddr || '0.0.0.0',
    bindPort: Number(s.bindPort) || 7000,
    authEnabled: s.authEnabled !== false,
    token: s.token || '',
    webEnabled: s.webEnabled !== false,
    webAddr: s.webAddr || '0.0.0.0',
    webPort: Number(s.webPort) || 4096,
    webUser: s.webUser || 'admin',
    webPassword: s.webPassword || '',
    vhostHTTPEnabled: !!s.vhostHTTPPort,
    vhostHTTPPort: Number(s.vhostHTTPPort) || 80,
    vhostHTTPSEnabled: !!s.vhostHTTPSPort,
    vhostHTTPSPort: Number(s.vhostHTTPSPort) || 443,
    allowPortsText: s.allowPortsText || '',
  };
}

function randomToken(length = 18) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

/* 服务器状态的请求序号：每次发起请求自增，回包时序号不是最新的就丢弃，
 * 避免“点了 A 又马上点 B，A 的结果后到把 B 覆盖掉”。 */
function serverSeq() {
  S.server.seq = (S.server.seq || 0) + 1;
  return S.server.seq;
}

function serverSeqStale(seq) {
  return seq !== S.server.seq;
}

function applyServerState(data, seq) {
  if (!data) return false;
  if (seq !== undefined && serverSeqStale(seq)) return false;
  S.server.loaded = true;
  S.server.connected = !!data.connected;
  S.server.host = data.host || S.server.host || '';
  S.server.port = data.port || S.server.port || 22;
  S.server.username = data.username || S.server.username || '';
  S.server.info = data.info || null;
  S.server.configPath = data.configPath || '';
  S.server.config = data.config || '';
  S.server.summary = data.summary || null;
  S.server.configError = data.configError || '';
  S.server.saved = data.saved || {};
  S.server.savedCredential = !!data.savedCredential;
  S.server.profiles = Array.isArray(data.profiles) ? data.profiles : [];
  S.server.activeServerId = data.activeServerId || '';
  S.server.clientServerId = data.clientServerId || '';
  S.server.tunnel = data.tunnel || null;
  S.server.sessionServerId = data.sessionServerId || data.serverId || '';
  S.server.client = data.client || null;
  if (data.summary && !S.server.wizardDirty) {
    S.server.wizard = wizardFromSummary(data.summary);
    S.server.previewText = '';
  } else if (!data.summary && !S.server.wizard && !S.server.wizardDirty) {
    /* 服务器上还没有 frps.toml：向导直接沿用档案里那把已经自动生成的 Token。
     * 这样「一键初始化」写进服务端的 token 和本机 frpc.toml 的 token 一开始就是
     * 同一个值，用户完全不需要关心它。 */
    const activeProfile = (S.server.profiles || []).find((p) => p.id === S.server.activeServerId);
    S.server.wizard = {
      ...wizardDefaults(),
      token: (activeProfile && activeProfile.token) || randomToken(20),
      webPassword: randomToken(14),
    };
    S.server.previewText = '';
  }
  return true;
}

async function loadServerState({ autoConnect = false } = {}) {
  const seq = serverSeq();
  const res = await FRP.serverState();
  if (serverSeqStale(seq)) return;
  if (res && res.ok) {
    applyServerState(res.data, seq);
    renderServer(true);
    // 只在“第一次打开服务器页”时自动连；绑定变化之类的刷新不打扰已断开的会话。
    if (autoConnect) autoConnectActiveProfile().catch(() => {});
  } else if (res && !res.ok) toastResult(res);
}

async function loadServerConfig(quiet = false) {
  if (!S.server.connected) return;
  const seq = serverSeq();
  const res = await FRP.serverReadConfig();
  if (serverSeqStale(seq)) return;
  if (res && res.ok) {
    applyServerState(res.data.state || {}, seq);
    if (!quiet) toast('success', '配置已重新读取', res.data.path || '');
    renderServer(true);
  } else if (res && !res.ok) {
    if (res.stale) return; // 已切档，静默丢弃
    if (!quiet) toastResult(res);
    else toast('warn', '读取配置失败', res.error || '');
  }
}

async function loadServerLogs() {
  if (!S.server.connected) return;
  const serverId = S.server.sessionServerId;
  const res = await FRP.serverLogs(250);
  // 回包时已切到别的服务器：日志不能串台。
  if (serverId !== S.server.sessionServerId || !S.server.connected) return;
  if (res && res.ok) {
    S.server.logs = res.data.content || '';
    S.server.logsSource = res.data.source || '';
    S.server.logsError = '';
  } else if (res && !res.ok) {
    if (res.stale) return;
    S.server.logs = '';
    S.server.logsError = res.error || '读取日志失败';
  }
  renderServerLogs();
}

function serverStatusLabel(info) {
  if (!info) return { key: 'stopped', text: '未连接', tone: 'muted' };
  const key = info.status === 'running' ? 'running' : info.status === 'abnormal' ? 'abnormal' : 'stopped';
  return {
    key,
    text: { running: '运行中', abnormal: '异常', stopped: '已停止' }[key],
    tone: { running: 'green', abnormal: 'amber', stopped: 'red' }[key],
  };
}

function serverStatusSource(info) {
  if (!info) return '';
  if (info.statusSource === 'port') return info.statusHint || '端口在监听';
  if (info.statusSource === 'docker') return `Docker 容器 ${info.docker ? info.docker.name : ''}`;
  if (info.statusSource === 'process') return `进程 ${info.pids && info.pids.length ? `PID ${info.pids.join(', ')}` : ''}`;
  if (info.statusSource === 'systemd') return `systemd · ${info.serviceName}`;
  if (info.status === 'stopped') {
    if (info.hasUnit) return `systemd · ${info.serviceName} 未运行`;
    if (info.docker && info.docker.name) return `Docker · ${info.docker.name} 未运行`;
    return '未发现运行中的 frps';
  }
  return '';
}

function metricCard(label, value, sub = '', cls = '') {
  return `<div class="srv-metric ${cls}"><span>${esc(label)}</span><strong>${esc(value)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}

function selftestStepMarkup(steps, key, index, title, hint) {
  const step = (steps && steps[key]) || { state: 'idle' };
  const state = step.state || 'idle';
  const iconText = { idle: '○', running: '…', ok: '✓', fail: '✕', skipped: '—' }[state] || '○';
  const detail = state === 'ok' ? step.detail : state === 'fail'
    ? (step.detail ? (step.reason && step.reason !== step.detail ? `${step.reason} · ${step.detail}` : step.detail) : (step.reason || '检测失败'))
    : state === 'skipped' ? '上一层已失败，已短路' : hint;
  const meta = step.ms ? `${step.ms} ms` : '';
  return `
    <div class="st-step ${esc(state)}">
      <span class="st-index">${index}</span>
      <div class="st-body">
        <div class="st-line"><strong>${esc(title)}</strong><span class="st-mark">${iconText}</span></div>
        <p>${esc(detail || '')}${meta ? ` · ${esc(meta)}` : ''}</p>
      </div>
    </div>`;
}

function selftestMarkup() {
  const st = S.server.selftest || {};
  const steps = st.steps || {};
  const conclusion = st.conclusion || '';
  const tone = conclusion === SELFTEST_OK ? 'green' : conclusion ? 'red' : 'muted';
  return `
    <div class="card-head">
      <div class="ch-icon">${icon('activity')}</div>
      <div class="grow"><h3>服务器就绪检查</h3><p>只判断这台服务器是否准备好接收客户端：SSH → frps 运行 → bindPort 监听 → Token 一致。任一层失败立即短路。</p></div>
      <div class="page-actions">
        ${conclusion ? `<span class="badge ${tone}"><span class="bdot"></span>${esc(conclusion)}</span>` : ''}
        <button class="btn primary" type="button" data-act="server.selftest" ${st.busy ? 'disabled' : ''}>${icon('activity')}<span>${st.busy ? '检查中…' : '检查服务器'}</span></button>
      </div>
    </div>
    <div class="st-steps">
      ${selftestStepMarkup(steps, 'ssh', '①', 'SSH 通道', '用一条最小命令确认还能在服务器上执行操作')}
      ${selftestStepMarkup(steps, 'service', '②', 'frps 运行状态', '进程 / systemd / Docker 任一种在跑，并顺带确认开机自启')}
      ${selftestStepMarkup(steps, 'bindPort', '③', 'bindPort 监听', '服务器本机 ss / netstat 里能否看到 frps 的 bindPort')}
      ${selftestStepMarkup(steps, 'token', '④', 'Token 一致', '服务端 auth.token 与本机档案里的 Token 是否完全相同')}
    </div>
    <p class="st-foot">服务器就绪 ≠ 隧道可用。真正的「本地 → 隧道 → 公网」三层连通性在概览与代理映射页检查。</p>`;
}

function wizardField(label, name, value, opts = '') {
  return `<div class="field"><label>${esc(label)}</label><input class="input" name="${esc(name)}" value="${esc(value)}" ${opts}></div>`;
}

function wizardToggle(label, name, checked) {
  return `<label class="check-line"><input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;
}

function wizardPane() {
  const w = S.server.wizard || wizardDefaults();
  return `
    <div id="wizard-pane" class="wizard-pane ${S.server.mode === 'advanced' ? 'hidden' : ''}">
      <div class="wz-templates">
        <span class="wz-label">模板</span>
        ${[
          ['basic', '基础穿透'],
          ['auth', '带鉴权'],
          ['panel', '带鉴权 + Web 面板'],
          ['https', 'HTTPS 域名'],
          ['custom', '自定义'],
        ].map(([key, label]) => `<button class="wz-chip ${S.server.template === key ? 'active' : ''}" type="button" data-act="server.template" data-template="${key}">${label}</button>`).join('')}
      </div>
      <div class="wizard-layout">
        <form id="wizard-form" class="wizard-form" autocomplete="off" onsubmit="return false">
          <input type="hidden" name="webAddr" value="${esc(w.webAddr || '0.0.0.0')}">
          <div class="wz-group">
            <div class="wz-group-title">基础</div>
            <div class="wz-grid">
              ${wizardField('bindPort（客户端连接端口）', 'bindPort', w.bindPort, 'type="number" min="1" max="65535"')}
              <div class="field"><label>绑定地址</label><input class="input" name="bindAddr" value="${esc(w.bindAddr || '0.0.0.0')}" spellcheck="false"></div>
            </div>
          </div>

          <div class="wz-group">
            <div class="wz-group-title">鉴权 ${wizardToggle('启用 token 鉴权', 'authEnabled', w.authEnabled)}</div>
            <div class="wz-grid wz-auth">
              <div class="field">
                <label>auth.token</label>
                <div class="input-group">
                  <input class="input" name="token" value="${esc(w.token)}" spellcheck="false" placeholder="客户端必须填写相同 token">
                  <button class="icon-btn" type="button" data-act="server.gen.token" title="随机生成">${icon('reload')}</button>
                </div>
              </div>
            </div>
          </div>

          <div class="wz-group">
            <div class="wz-group-title">Dashboard ${wizardToggle('启用 Web 面板', 'webEnabled', w.webEnabled)}</div>
            <div class="wz-grid wz-web">
              ${wizardField('面板端口', 'webPort', w.webPort, 'type="number" min="1" max="65535"')}
              ${wizardField('面板用户名', 'webUser', w.webUser, 'spellcheck="false"')}
              <div class="field span-2">
                <label>面板密码</label>
                <div class="input-group">
                  <input class="input" id="wz-webpass" name="webPassword" type="password" value="${esc(w.webPassword)}" placeholder="面板登录密码">
                  <button class="icon-btn" type="button" data-act="server.gen.password" title="随机生成">${icon('reload')}</button>
                  <button class="icon-btn" type="button" data-act="server.eye.web" title="显示 / 隐藏">${icon('eye')}</button>
                </div>
              </div>
            </div>
          </div>

          <div class="wz-group">
            <div class="wz-group-title">域名穿透（可选）</div>
            <div class="wz-toggles">
              ${wizardToggle('HTTP（vhostHTTPPort）', 'vhostHTTPEnabled', w.vhostHTTPEnabled)}
              ${wizardToggle('HTTPS（vhostHTTPSPort）', 'vhostHTTPSEnabled', w.vhostHTTPSEnabled)}
            </div>
            <div class="wz-grid">
              <div class="wz-vhost-http">${wizardField('HTTP 端口', 'vhostHTTPPort', w.vhostHTTPPort, 'type="number" min="1" max="65535"')}</div>
              <div class="wz-vhost-https">${wizardField('HTTPS 端口', 'vhostHTTPSPort', w.vhostHTTPSPort, 'type="number" min="1" max="65535"')}</div>
            </div>
          </div>

          <div class="wz-group">
            <div class="wz-group-title">允许客户端映射的端口（可选）</div>
            <div class="field">
              <input class="input" name="allowPortsText" value="${esc(w.allowPortsText)}" placeholder="例如 2000-3000,3001；留空表示不限制">
              <span class="field-hint">限制客户端能申请的 remotePort，降低被滥用的风险。</span>
            </div>
          </div>
        </form>

        <div class="wizard-preview-box">
          <div class="wpb-head">
            <strong>frps.toml 预览</strong>
            <button class="btn ghost small" type="button" data-act="server.copy.preview">${icon('copy')}<span>复制</span></button>
          </div>
          <pre class="wizard-preview" id="wizard-preview">${esc(S.server.previewText || '正在生成预览…')}</pre>
          <div class="wpb-foot" id="wizard-preview-msg">${esc(S.server.previewError || '')}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn" type="button" data-act="server.save">${icon('check')}<span>仅保存</span></button>
        <button class="btn primary" type="button" data-act="server.save.restart">${icon('restart')}<span>保存并重启</span></button>
        <span class="field-hint">写入前会在服务器生成 .bak 备份，并优先用 frps verify 校验语法。</span>
      </div>
    </div>`;
}

function advancedPane() {
  return `
    <div id="advanced-pane" class="advanced-pane ${S.server.mode === 'advanced' ? '' : 'hidden'}">
      <div class="adv-head">
        <span class="field-hint">直接编辑完整 TOML，保留模板之外的字段；保存前同样会校验语法并备份。</span>
        <div class="page-actions">
          <button class="btn ghost" type="button" data-act="server.advanced.reload">${icon('download')}<span>重新读取</span></button>
          <button class="btn" type="button" data-act="server.save">${icon('check')}<span>仅保存</span></button>
          <button class="btn primary" type="button" data-act="server.save.restart">${icon('restart')}<span>保存并重启</span></button>
        </div>
      </div>
      <textarea class="textarea server-config" id="server-config" spellcheck="false" placeholder="frps 配置内容">${esc(S.server.config)}</textarea>
    </div>`;
}

function serverProxyRows() {
  const proxies = (S.state && S.state.proxies) || [];
  if (!proxies.length) {
    return `<tr><td colspan="5"><div class="empty small"><h3>还没有映射</h3><p>去「代理映射」新增一条，把本机服务发布到 frps。</p></div></td></tr>`;
  }
  return proxies.map((p) => {
    const health = p.health;
    const ok = p.status === 'running' && health && health.ok;
    const failed = health && !health.ok;
    const tone = ok ? 'green' : failed ? 'red' : 'amber';
    const text = ok ? '三层连通' : failed ? (health.reason || '链路异常') : '待检测';
    const target = p.publicAddress || (p.remotePort ? `${(S.state.config && S.state.config.serverAddr) || ''}:${p.remotePort}` : '-');
    return `
      <tr>
        <td><div class="name-cell"><strong>${esc(p.name)}</strong><small>${esc((p.type || '').toUpperCase())}</small></div></td>
        <td class="mono">127.0.0.1:${esc(p.localPort || '-')}</td>
        <td class="mono">${esc(target)}</td>
        <td><span class="badge ${tone}" title="${esc(healthTip(health))}"><span class="bdot"></span>${esc(text)}</span></td>
        <td style="text-align:right">
          <button class="icon-btn" type="button" data-act="copy" data-text="${esc(p.publicAddress || '')}" title="复制公网地址">${icon('copy')}</button>
        </td>
      </tr>`;
  }).join('');
}

function parseServerLogs(text) {
  const items = [];
  const stats = { start: '', logins: 0, errors: 0 };
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  for (const raw of lines) {
    let time = '';
    let level = 'info';
    let body = raw;
    const match = /^(\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*(?:\[([IWED])\])?\s*(.*)$/.exec(raw);
    if (match) {
      time = match[1].replace(/,/g, '.');
      level = { I: 'info', W: 'warn', E: 'error', D: 'debug' }[match[2]] || 'info';
      body = match[3] || '';
    }
    if (level === 'info' && /error|failed|panic|fatal|denied/i.test(body)) level = 'error';
    if (level === 'info' && /warn|deprecated/i.test(body)) level = 'warn';
    if (/start frps|frps started|start service|service start/i.test(body) && !stats.start) stats.start = time || '已启动';
    if (/client login|login to server/i.test(body)) stats.logins += 1;
    if (level === 'error') stats.errors += 1;
    items.push({ time, level, body });
  }
  return { items, stats };
}

function renderServerLogs() {
  const box = $('#server-logs');
  if (!box) return;
  if (!S.server.logs) {
    box.innerHTML = `<div class="empty small"><h3>暂无日志</h3><p>${esc(S.server.logsError || '启动 frps 或刷新日志后这里会显示结构化内容。')}</p></div>`;
    return;
  }
  const parsed = parseServerLogs(S.server.logs);
  const filtered = S.server.logErrorsOnly ? parsed.items.filter((item) => item.level === 'error') : parsed.items;
  const shown = S.server.logExpanded ? filtered : filtered.slice(-10);
  box.innerHTML = `
    <div class="log-chips">
      <span>${icon('clock')}启动：${esc(parsed.stats.start || '未识别')}</span>
      <span>${icon('link')}客户端连接：${parsed.stats.logins}</span>
      <span class="${parsed.stats.errors ? 'bad' : ''}">${icon('alert')}错误：${parsed.stats.errors}</span>
    </div>
    <div class="log-rows">
      ${shown.length ? shown.map((item) => `
        <div class="log-row ${esc(item.level)}">
          <span class="lr-time">${esc(item.time || '—')}</span>
          <span class="lr-level">${esc({ info: 'INFO', warn: 'WARN', error: 'ERR', debug: 'DBG' }[item.level])}</span>
          <span class="lr-body">${esc(item.body)}</span>
        </div>`).join('') : '<div class="muted" style="padding:12px">没有匹配的日志</div>'}
    </div>
    <div class="log-actions">
      <span class="field-hint">共 ${filtered.length} 行${S.server.logErrorsOnly ? '（仅错误）' : ''}，默认显示最近 10 行</span>
      <button class="btn ghost small" type="button" data-act="server.logs.errors">${icon('alert')}<span>${S.server.logErrorsOnly ? '显示全部' : '只看错误'}</span></button>
      <button class="btn ghost small" type="button" data-act="server.logs.expand">${icon('download')}<span>${S.server.logExpanded ? '收起' : '展开全部'}</span></button>
    </div>`;
}

function renderServer(force = false) {
  if (!S.server.loaded) {
    $('#view').innerHTML = `<div class="view"><section class="card"><div class="empty"><span class="spinner"></span><h3>正在读取服务器连接状态</h3><p>请稍候…</p></div></section></div>`;
    return;
  }

  const s = S.server;
  if (!s.connected) {
    $('#view').innerHTML = connectedFormMarkup();
    return;
  }

  const info = s.info || {};
  const summary = s.summary || {};
  const status = serverStatusLabel(info);
  const source = serverStatusSource(info);
  const osText = [info.os, info.kernel ? `内核 ${info.kernel}` : '', info.hostname ? `主机 ${info.hostname}` : ''].filter(Boolean).join(' · ') || '未知系统';
  const canStart = status.key !== 'running';
  const canStop = status.key !== 'stopped' || info.processAlive || info.dockerRunning;
  const needsBootstrap = !info.dockerRunning && ((!info.frpsInstalled && info.version === 'unknown') || !s.configPath || info.configExists === false);
  /* 「正在运行」和「重启后还能自己起来」是两回事，状态卡上分开说。 */
  const boot = (() => {
    const key = info.boot || 'unknown';
    if (key === 'enabled') return { key, label: '已启用', sub: info.bootText || '重启服务器后会自动启动', cls: '' };
    if (key === 'ephemeral') return { key, label: '临时进程', sub: info.bootText || '重启后不会自动运行', cls: 'warn' };
    if (key === 'disabled') return { key, label: '未启用', sub: info.bootText || '重启后不会自动运行', cls: 'warn' };
    return { key, label: '未知', sub: info.bootText || '无法判断', cls: 'muted' };
  })();

  $('#view').innerHTML = `
    <div class="view server-view">
      <div class="page-head">
        <div class="page-title">
          <h1>服务器</h1>
          <p>${esc(s.username)}@${esc(s.host)}:${esc(s.port)} · SSH 已连接 · ${esc(osText)}</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" data-act="server.refresh">${icon('reload')}<span>刷新</span></button>
          <button class="btn ghost" type="button" data-act="server.disconnect">${icon('x')}<span>断开</span></button>
        </div>
      </div>

      ${profileBarMarkup()}

      <section class="card server-status-card ${status.key}">
        <div class="ss-light ${status.key}"></div>
        <div class="ss-main">
          <div class="ss-top">
            <h2>${status.text}</h2>
            <span class="badge ${status.tone}"><span class="bdot"></span>${esc(source || '状态来源未知')}</span>
            ${info.version && info.version !== 'unknown' ? `<span class="ss-version">frps ${esc(info.version)}</span>` : `<span class="ss-version muted" title="未在 PATH、进程目录或 Docker 中找到 frps 可执行文件">版本未识别</span>`}
          </div>
          <p class="ss-sub">${esc(osText)} · 运行时长 ${esc(info.uptime || '—')}</p>
          <div class="ss-actions">
            <button class="btn ${canStart ? 'primary' : ''}" type="button" data-act="server.control" data-op="start" ${canStart ? '' : 'disabled'}>${icon('play')}<span>启动</span></button>
            <button class="btn" type="button" data-act="server.control" data-op="stop" ${canStop ? '' : 'disabled'}>${icon('stop')}<span>停止</span></button>
            <button class="btn" type="button" data-act="server.control" data-op="restart" ${canStop ? '' : 'disabled'}>${icon('restart')}<span>重启</span></button>
            <button class="btn ghost" type="button" data-act="server.scroll.logs">${icon('terminal')}<span>实时日志</span></button>
            ${summary.webPort ? `<button class="btn ghost" type="button" data-act="server.open.dashboard">${icon('external')}<span>打开面板 :${summary.webPort}</span></button>` : ''}
            <button class="btn ghost" type="button" data-act="server.guide">${icon('shield')}<span>排错指南</span></button>
          </div>
        </div>
      </section>

      ${needsBootstrap ? bootstrapCardMarkup(info, s) : ''}

      ${boot.key === 'disabled' || boot.key === 'ephemeral'
        ? `<div class="note warn">${icon('alert')}<div><strong>服务器重启后 frps 不会自己起来</strong><br>${esc(info.bootText || '')}。${info.hasUnit ? `执行 <code>sudo systemctl enable --now ${esc(info.serviceName || 'frps')}</code> 可以修好。` : '建议改为 systemd 服务或用 docker --restart=always 托管。'}</div></div>`
        : ''}

      <section class="srv-metrics">
        ${metricCard('frps 版本', info.version || 'unknown', info.versionSource || '', info.version === 'unknown' ? 'warn' : '')}
        ${metricCard('bindPort', summary.bindPort || '—', summary.bindAddr || '', '')}
        ${metricCard('Dashboard', summary.webPort ? `:${summary.webPort}` : '未启用', summary.webPort ? (summary.webUser || 'admin') : 'webServer 未配置', !summary.webPort ? 'muted' : '')}
        ${metricCard('鉴权 Token', summary.authEnabled ? '已设置' : '未启用', summary.authEnabled ? '客户端需一致' : '不校验 token', !summary.authEnabled ? 'warn' : '')}
        ${metricCard('开机自启', boot.label, boot.sub, boot.cls)}
      </section>

      <section class="card selftest-card" id="selftest-panel">${selftestMarkup()}</section>

      <section class="card config-card">
        <div class="card-head">
          <div class="ch-icon">${icon('edit')}</div>
          <div class="grow"><h3>frps 配置</h3><p>${esc(s.configPath || '未找到配置文件')}${s.configError ? ` · ${esc(s.configError)}` : ''}</p></div>
          <button class="icon-btn" type="button" data-act="server.copy.path" title="复制配置路径">${icon('copy')}</button>
          <div class="mode-tabs">
            <button class="mode-tab ${s.mode === 'wizard' ? 'active' : ''}" type="button" data-act="server.mode" data-mode="wizard">快速配置</button>
            <button class="mode-tab ${s.mode === 'advanced' ? 'active' : ''}" type="button" data-act="server.mode" data-mode="advanced">高级编辑</button>
          </div>        </div>
        ${s.configPath ? '' : `<div class="note warn">${icon('alert')}<div>尚未找到 frps 配置文件。按向导生成后点击「一键初始化并启动」，控制台会创建 <code>/etc/frp/frps.toml</code>、安装 frps 并注册系统服务。</div></div>`}
        ${wizardPane()}
        ${advancedPane()}
      </section>

      <section class="card">
        <div class="card-head">
          <div class="ch-icon">${icon('link')}</div>
          <div class="grow"><h3>当前映射</h3><p>本机 frpc 已配置的穿透规则，链路状态来自三层检查。</p></div>
          <div class="page-actions">
            <button class="btn ghost" type="button" data-act="goto.proxies">${icon('external')}<span>去代理映射</span></button>
          </div>
        </div>
        <div class="table-wrap" id="server-proxies"><table class="table"><thead><tr><th>代理</th><th>本地</th><th>公网</th><th>链路</th><th></th></tr></thead><tbody>${serverProxyRows()}</tbody></table></div>
      </section>

      <section class="card log-card" id="server-log-card">
        <div class="card-head">
          <div class="ch-icon">${icon('terminal')}</div>
          <div class="grow"><h3>frps 日志</h3><p>${esc(s.logsSource || 'journalctl / docker logs / frps.log')} · 结构化展示最近 250 行</p></div>
          <div class="page-actions">
            <button class="btn ghost" type="button" data-act="server.logs.refresh">${icon('reload')}<span>刷新日志</span></button>
          </div>
        </div>
        <div id="server-logs"></div>
      </section>
    </div>`;

  renderServerLogs();
  toggleWizardGroups();
  if (s.mode === 'wizard' && !s.previewText) schedulePreview(true);
  if (s.connected && !s.logs && !s.logsLoading) {
    s.logsLoading = true;
    loadServerLogs().catch(() => {}).finally(() => { s.logsLoading = false; });
  }
}

function bootstrapCardMarkup(info, s) {
  const p = s.installProgress || null;
  const percent = Math.max(0, Math.min(100, Number(p && p.percent) || 0));
  const reasons = [];
  if (!info.frpsInstalled && info.version === 'unknown') reasons.push('未检测到 frps 可执行文件');
  if (!s.configPath || info.configExists === false) reasons.push(`配置文件${s.configPath ? ` ${s.configPath} 不存在` : '未找到'}`);
  return `
    <section class="card bootstrap-card" id="bootstrap-card">
      <div class="bc-icon">${icon('download')}</div>
      <div class="bc-main">
        <div class="bc-head">
          <h3>从零初始化 frps</h3>
          <span class="badge amber"><span class="bdot"></span>需要初始化</span>
        </div>
        <p class="bc-sub">${esc(reasons.join(' · ') || '服务器尚未完成 frps 初始化')}。控制台会按下方向导配置完成全部步骤，不需要登录服务器手动安装。</p>
        <ul class="bc-steps">
          <li>上传内置 frps 0.61.0（按服务器架构自动选择 amd64 / arm64）</li>
          <li>写入配置并执行 <code>frps verify</code> 校验，原文件自动备份</li>
          <li>注册 <code>frps.service</code>、设置开机自启并启动</li>
          <li>检查进程、版本与监听端口，完成后自动刷新状态</li>
        </ul>
        ${p ? `<div class="bc-progress"><div class="bc-bar"><span style="width:${percent}%"></span></div><p>${esc(p.text || '')} · ${percent}%</p></div>` : ''}
        <label class="check-line bc-sync"><input type="checkbox" id="bootstrap-sync" checked> 同时把本机 frpc 的服务器地址与 Token 改为本次配置，并重启隧道</label>
        <div class="bc-actions">
          <button class="btn primary" type="button" data-act="server.bootstrap" ${s.installBusy ? 'disabled' : ''}>${icon('download')}<span>${s.installBusy ? '正在初始化…' : '一键初始化并启动'}</span></button>
          <span class="field-hint">需要 root 或免密 sudo；上传约 18 MB，首次可能需要几十秒。</span>
        </div>
      </div>
    </section>`;
}

function activeServerProfile() {
  const s = S.server;
  return (s.profiles || []).find((p) => p.id === s.activeServerId) || (s.profiles || [])[0] || null;
}

/* 当前查看的档案 vs 本机 frpc 实际配置，逐项列出差异。
 * 只给一句“未应用”会让人分不清是地址、端口还是 Token 的问题。 */
function tunnelDiff(active, tunnel) {
  if (!active || !tunnel) return [];
  const rows = [];
  const sameHost = String(tunnel.addr || '').toLowerCase() === String(active.host || '').toLowerCase();
  if (!sameHost) {
    rows.push({ key: 'host', label: '服务器地址', want: active.host || '—', got: tunnel.addr || '（本机未配置）' });
  }
  const port = Number(tunnel.port) || 0;
  if (port !== Number(active.clientPort)) {
    rows.push({ key: 'port', label: 'frps 端口', want: String(active.clientPort || '—'), got: port ? String(port) : '（本机未配置）' });
  }
  if (tunnel.profileId === active.id && !tunnel.tokenMatch) {
    rows.push({ key: 'token', label: 'Token', want: active.hasToken ? '档案已保存' : '档案未设置', got: tunnel.tokenSet ? '与本机配置不同' : '本机未设置' });
  } else if (tunnel.profileId !== active.id && active.hasToken !== tunnel.tokenSet) {
    rows.push({ key: 'token', label: 'Token', want: active.hasToken ? '档案已保存' : '档案未设置', got: tunnel.tokenSet ? '本机有' : '本机没有' });
  }
  return rows;
}

function profileBarMarkup(options = {}) {
  const showDiff = options.showDiff !== false;
  const s = S.server;
  const profiles = s.profiles || [];
  const active = activeServerProfile();
  const tunnel = s.tunnel || null;
  const rows = tunnelDiff(active, tunnel);
  const boundToActive = !!(active && tunnel && tunnel.profileId === active.id);
  const synced = boundToActive && !rows.length;
  const profileOptions = profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === s.activeServerId ? 'selected' : ''}>${esc(p.name || p.host)}${p.host ? ` · ${esc(p.host)}` : ''}${p.id === s.clientServerId ? '（本机隧道）' : ''}</option>`).join('');

  /* 还没连上这台服务器时，讲“本机隧道指向别处”只会让人以为出错了。
   * 这时候该说的是下一步动作：连上去。 */
  const badge = !active
    ? ''
    : !showDiff
      ? `<span class="badge muted"><span class="bdot"></span>尚未连接，连接后会自动对齐本机隧道</span>`
      : synced
        ? `<span class="badge green"><span class="bdot"></span>本机隧道正指向此档案</span>`
        : boundToActive
          ? `<span class="badge amber"><span class="bdot"></span>档案已修改，本机隧道还是旧配置</span>`
          : tunnel && tunnel.unarchived
            ? `<span class="badge amber"><span class="bdot"></span>本机隧道尚未归档到任何档案</span>`
            : `<span class="badge amber"><span class="bdot"></span>本机隧道指向${tunnel && tunnel.profileName ? `「${esc(tunnel.profileName)}」` : '其他服务器'}</span>`;

  const clientLine = tunnel && tunnel.addr
    ? `本机 frpc 当前连接 <code>${esc(tunnel.addr)}:${esc(tunnel.port || '—')}</code>`
    : '本机 frpc 还没有配置服务器地址';

  return `
    <section class="card profile-card${active && showDiff && !synced ? ' attention' : ''}">
      <div class="profile-row">
        <div class="profile-heading">
          <div class="ch-icon">${icon('server')}</div>
          <div>
            <h3>服务器档案</h3>
            <p>所有服务器共用同一个本机客户端。切换档案只改变当前查看的目标，不会动隧道；需要改隧道时再显式切换。</p>
          </div>
        </div>
        <div class="profile-controls">
          <select class="input profile-select" id="server-profile-select" ${profiles.length ? '' : 'disabled'} ${s.switching ? 'disabled' : ''}>
            ${profileOptions || '<option value="">还没有档案</option>'}
          </select>
          <button class="btn" type="button" data-act="server.profile.new">${icon('plus')}<span>新建</span></button>
          <button class="btn ghost" type="button" data-act="server.profile.edit" ${active ? '' : 'disabled'}>${icon('edit')}<span>编辑</span></button>
          <button class="btn ghost danger-text" type="button" data-act="server.profile.delete" ${active ? '' : 'disabled'}>${icon('trash')}<span>删除</span></button>
        </div>
      </div>
      <div class="profile-meta">
        ${active ? `
          ${badge}
          <span class="profile-fact">SSH ${esc(active.username)}@${esc(active.host)}:${esc(active.port)}</span>
          <span class="profile-fact">frps 端口 ${esc(active.clientPort)}</span>
          <span class="profile-fact">Token ${active.hasToken ? '已生成' : '未设置'}</span>
          ${active.hasPassword ? `<span class="profile-fact">${icon('shield')} 密码已保存</span>` : `<span class="profile-fact muted">${icon('shield')} 密码未保存</span>`}
        ` : `<span class="profile-fact">先新建一个服务器档案，填入 IP 和 SSH 密码即可。</span>`}
      </div>
      ${active && showDiff && !synced ? `
        <div class="profile-diff">
          <div class="pd-head">
            <div class="pd-title">${icon('alert')}<span>${boundToActive ? '这个档案改过，但本机隧道仍在用旧参数' : (tunnel && tunnel.unarchived ? '本机隧道还没有归属到任何档案' : '当前查看的档案不是本机隧道目标')}</span></div>
            <div class="pd-actions">
              <button class="btn ghost small" type="button" data-act="server.apply.keep">${icon('eye')}<span>仅查看</span></button>
              <button class="btn ${active.hasToken ? 'primary' : ''} small" type="button" data-act="server.apply" ${active.hasToken ? '' : 'disabled'}>${icon('link')}<span>切换隧道并重启</span></button>
            </div>
          </div>
          ${rows.length ? `<div class="pd-rows">
            <div class="pd-row pd-head-row"><span>项目</span><span>当前档案</span><span>本机 frpc</span></div>
            ${rows.map((r) => `<div class="pd-row"><span>${esc(r.label)}</span><span class="mono">${esc(r.want)}</span><span class="mono bad">${esc(r.got)}</span></div>`).join('')}
          </div>` : ''}
          <p class="pd-note">${rows.length ? '' : '参数与本机 frpc 完全一致，只是绑定关系没有指向这个档案。'}${clientLine}。切换会改写 frpc.toml 并重启 frpc，所有代理会短暂重连（约 3–10 秒）。${active.hasToken ? '' : ' 此档案还没有 Token，请先编辑档案填写。'}</p>
        </div>` : ''}
    </section>`;
}

/* 地址对不上时的决策弹窗：更新这个档案，还是另存为新档案。
 * 这一步必须显式选择，否则“换了 IP”会静默改写原档案，导致密码与地址错配。 */
function askProfileMismatch(mismatch, onDecide) {
  const p = (mismatch && mismatch.profile) || {};
  const input = (mismatch && mismatch.input) || {};
  openModal(`
    <div class="modal" style="width:560px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--amber)">${icon('alert')}</div>
        <div class="grow"><h3>地址与档案不一致</h3><p>你输入的连接信息与档案「${esc(p.name || p.host || '')}」不同。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="pd-rows" style="margin:0">
          <div class="pd-row pd-head-row"><span>项目</span><span>档案里</span><span>你输入的</span></div>
          <div class="pd-row"><span>地址</span><span class="mono">${esc(p.host || '—')}</span><span class="mono">${esc(input.host || '—')}</span></div>
          <div class="pd-row"><span>SSH 端口</span><span class="mono">${esc(p.port || 22)}</span><span class="mono">${esc(input.port || 22)}</span></div>
          <div class="pd-row"><span>用户名</span><span class="mono">${esc(p.username || 'root')}</span><span class="mono">${esc(input.username || 'root')}</span></div>
        </div>
        <div class="note" style="margin-top:12px">${icon('shield')}<div>更新档案会清空该档案里保存的旧密码（旧密码属于旧主机），需要重新输入一次。另存为新档案则保留原档案不动。</div></div>
      </div>
      <div class="modal-foot">
        <span class="mf-left"></span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
        <button class="btn" type="button" id="mismatch-new">${icon('plus')}<span>另存为新档案</span></button>
        <button class="btn primary" type="button" id="mismatch-adopt">${icon('check')}<span>更新该档案并连接</span></button>
      </div>
    </div>`);
  const adopt = $('#mismatch-adopt');
  const create = $('#mismatch-new');
  if (adopt) adopt.addEventListener('click', () => { closeModal(); onDecide(true); });
  if (create) create.addEventListener('click', () => { closeModal(); onDecide(false); });
}

function openServerProfileModal(mode = 'new') {
  const s = S.server;
  const p = mode === 'edit' ? activeServerProfile() : null;
  const tunnel = s.tunnel || {};
  const profile = p || {
    name: '', host: '', port: 22, username: 'root', clientPort: 7000,
    token: '', configPath: '', dashboardUrl: '', hasPassword: false,
  };
  const canFillFromClient = mode === 'new' && !!tunnel.addr;
  /* Token 不再由用户填写：新建时由主进程生成一个随机值，作为「服务端配置向导」
   * 的默认 token —— 保存 frps.toml 和写本机 frpc.toml 用的是同一个值，
   * 两边天然一致。只有想接管已有 frps（它的 token 已经定死）时才需要动它。 */
  const tokenLine = mode === 'edit'
    ? (profile.hasToken
      ? `<span class="field-hint">已生成（${esc(String(profile.token || '').slice(0, 4))}…，${String(profile.token || '').length} 位）· 与服务端 auth.token 一致</span>`
      : '<span class="field-hint">未设置 · 保存后会自动生成</span>')
    : '<span class="field-hint">保存后自动生成随机值，无需填写</span>';
  openModal(`
    <div class="modal" style="width:680px">
      <div class="modal-head">
        <div class="mh-icon">${icon('server')}</div>
        <div class="grow">
          <h3>${mode === 'edit' ? '编辑服务器档案' : '新建服务器档案'}</h3>
          <p>只需要服务器地址和 SSH 密码；frps 端口与 Token 控制台会自己处理。</p>
        </div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <form id="server-profile-form" class="modal-body" autocomplete="off" data-id="${esc(profile.id || '')}">
        ${canFillFromClient ? `<div class="pd-fill"><span>本机 frpc 正在连接 <code>${esc(tunnel.addr)}:${esc(tunnel.port || '—')}</code></span><button class="btn ghost small" type="button" id="profile-fill-client">${icon('download')}<span>用本机配置填入</span></button></div>` : ''}
        <div class="form-grid">
          <div class="field span-2">
            <label>服务器 IP / 域名 <span class="req">*</span></label>
            <input class="input" name="host" value="${esc(profile.host || '')}" placeholder="例如 frps.example.com" spellcheck="false">
          </div>
          <div class="field">
            <label>SSH 端口</label>
            <input class="input" name="port" type="number" min="1" max="65535" value="${esc(profile.port || 22)}">
          </div>
          <div class="field">
            <label>SSH 用户名</label>
            <input class="input" name="username" value="${esc(profile.username || 'root')}" spellcheck="false">
          </div>
          <div class="field span-2">
            <label>SSH 密码 ${profile.hasPassword ? '<span class="field-hint">已保存，留空保持不变</span>' : '<span class="field-hint">可留空，连接时再输入</span>'}</label>
            <div class="input-group">
              <input class="input" name="password" type="password" placeholder="${profile.hasPassword ? '使用已保存的密码' : 'SSH 登录密码'}" autocomplete="new-password">
              <button class="icon-btn" type="button" data-act="server.eye" title="显示 / 隐藏密码">${icon('eye')}</button>
            </div>
            ${profile.hasPassword ? `<span class="field-hint"><a href="#" id="profile-forget-password">清除已保存的密码</a></span>` : ''}
          </div>
          <div class="field span-2">
            <label>档案名称</label>
            <input class="input" name="name" value="${esc(profile.name || '')}" placeholder="留空就用服务器地址，例如 香港 frps">
          </div>
        </div>
        <details class="adv-block" ${mode === 'edit' ? '' : ''}>
          <summary>高级选项（一般不用改）</summary>
          <div class="form-grid">
            <div class="field">
              <label>frps 端口 bindPort</label>
              <input class="input" name="clientPort" type="number" min="1" max="65535" value="${esc(profile.clientPort || 7000)}">
              <div class="field-hint">本机 frpc 连服务端用的端口，默认 7000</div>
            </div>
            <div class="field">
              <label>frps Token</label>
              <input class="input" name="clientToken" value="" placeholder="${mode === 'edit' ? '留空保持不变' : '留空自动生成'}" spellcheck="false">
              ${tokenLine}
            </div>
            <div class="field">
              <label>远程配置路径</label>
              <input class="input" name="configPath" value="${esc(profile.configPath || '')}" placeholder="/etc/frp/frps.toml" spellcheck="false">
            </div>
            <div class="field">
              <label>面板地址（可选）</label>
              <input class="input" name="dashboardUrl" value="${esc(profile.dashboardUrl || '')}" placeholder="http://IP:4096" spellcheck="false">
            </div>
          </div>
        </details>
        <div class="note">${icon('shield')}<div>每个档案独立保存 SSH 密码（Windows DPAPI 加密）。保存后会自动连上去读取状态；服务器还没装 frps 时可以直接一键初始化。</div></div>
      </form>
      <div class="modal-foot">
        <span class="mf-left"></span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
        <button class="btn primary" type="button" data-act="server.profile.modal.save">${icon('check')}<span>保存并连接</span></button>
      </div>
    </div>`);

  const fill = $('#profile-fill-client');
  if (fill) {
    fill.addEventListener('click', () => {
      const form = $('#server-profile-form');
      if (!form) return;
      const setValue = (name, value) => {
        const input = form.querySelector(`[name="${name}"]`);
        if (input) input.value = value === undefined || value === null ? '' : String(value);
      };
      setValue('name', tunnel.profileName || tunnel.addr || '');
      setValue('host', tunnel.addr || '');
      setValue('clientPort', tunnel.port || 7000);
      const hint = fill.parentElement;
      if (hint) hint.innerHTML = '<span class="field-hint">已填入本机 frpc 正在用的地址与端口；Token 保存时自动生成。</span>';
    });
  }

  const forget = $('#profile-forget-password');
  if (forget) {
    forget.addEventListener('click', async (e) => {
      e.preventDefault();
      const res = await FRP.serverProfileClearPassword(profile.id);
      if (!res || !res.ok) return toastResult(res);
      closeModal();
      applyServerState(res.data);
      renderServer(true);
      toast('success', '已清除该档案保存的密码', profile.name || profile.host || '');
    });
  }

  setTimeout(() => {
    const first = $('#server-profile-form [name="host"]');
    if (first) first.focus();
  }, 30);
}

async function saveServerProfileModal(btn) {
  const form = $('#server-profile-form');
  if (!form) return;
  const value = (name) => {
    const input = form.querySelector(`[name="${name}"]`);
    return input ? String(input.value || '').trim() : '';
  };
  const host = value('host');
  if (!host) return toast('error', '请输入服务器 IP 或域名');
  const password = form.querySelector('[name="password"]').value;
  const payload = {
    id: form.dataset.id || '',
    name: value('name'),
    host,
    port: Number(value('port')) || 22,
    username: value('username') || 'root',
    password,
    clientPort: Number(value('clientPort')) || 7000,
    clientToken: value('clientToken'),
    configPath: value('configPath'),
    dashboardUrl: value('dashboardUrl'),
  };
  if (payload.id && !payload.clientToken) delete payload.clientToken;
  await withBusy(btn, async () => {
    const seq = serverSeq();
    const res = await FRP.serverProfileSave(payload);
    if (serverSeqStale(seq)) return;
    if (!res || !res.ok) return toastResult(res);
    closeModal();
    S.server.wizard = null;
    S.server.wizardDirty = false;
    S.server.previewText = '';
    S.server.logs = '';
    applyServerState(res.data, seq);
    renderServer(true);
    const name = payload.name || host;
    if (res.data && res.data.hostChanged) {
      toast('warn', '档案地址已变更', '旧主机保存的密码已清除，下次连接需要重新输入');
      return;
    }
    /* 新建档案 = 现在要配置这台服务器。带上刚填的密码直接连，
     * 页面会立刻变成这台服务器的状态/向导，而不是继续显示上一台。 */
    if (res.data && res.data.created && res.data.savedCredential) {
      toast('success', '档案已创建', `正在连接 ${name}…`);
      await autoConnectActiveProfile();
      return;
    }
    if (res.data && res.data.created) {
      toast('success', '档案已创建，接着填 SSH 密码', `${name} · 连接后即可初始化 frps`);
      return;
    }
    toast('success', '服务器档案已保存', name);
  });
}

/* 档案里已经存了密码，就没必要每次再点一次「连接并读取状态」：
 * 选中档案、或第一次打开服务器页时，直接用保存的密码连上去。 */
async function autoConnectActiveProfile() {
  const active = activeServerProfile();
  if (!active) return;
  if (S.server.connected && S.server.sessionServerId === active.id) return;
  if (!S.server.savedCredential) return;      // 没存密码就老实走表单
  if (S.server.autoConnecting) return;
  S.server.autoConnecting = true;
  renderServer(true);
  const seq = serverSeq();
  try {
    const res = await FRP.serverConnect({
      host: active.host,
      port: Number(active.port) || 22,
      username: active.username || 'root',
      password: '',
      remember: true,
      serverId: active.id,
    });
    if (serverSeqStale(seq)) return;
    if (!res || !res.ok) {
      // 保存的密码失效（服务器改过密码）时退回表单，让用户补一次。
      if (res && res.needsPassword) toast('info', '需要手动输入密码', `「${active.name}」保存的密码已不可用`);
      else toastResult(res);
      return;
    }
    S.server.wizard = null;
    S.server.wizardDirty = false;
    S.server.mode = 'wizard';
    S.server.previewText = '';
    S.server.logs = '';
    S.server.logsError = '';
    applyServerState(res.data, seq);
  } catch (e) {
    toast('error', '自动连接失败', String((e && e.message) || e));
  } finally {
    S.server.autoConnecting = false;
    renderServer(true);
    if (S.server.connected) loadServerLogs().catch(() => {});
  }
}

async function selectServerProfile(id) {
  if (!id) return;
  if (S.server.switching) return;
  S.server.switching = true;
  const seq = serverSeq();
  try {
    const res = await FRP.serverSelect(id);
    if (serverSeqStale(seq)) return;
    if (!res || !res.ok) {
      toastResult(res);
      renderServer(true);
      return;
    }
    S.server.wizard = null;
    S.server.wizardDirty = false;
    S.server.previewText = '';
    S.server.logs = '';
    S.server.logsError = '';
    applyServerState(res.data, seq);
    renderServer(true);
    if (res.data && res.data.disconnected) {
      toast('info', '已切换到其他档案', `与「${res.data.disconnected}」的 SSH 连接已断开`);
    }
    // 档案里有保存的密码就直接连，不用再点一次「连接并读取状态」。
    autoConnectActiveProfile().catch(() => {});
  } finally {
    S.server.switching = false;
  }
}

/* 切换档案要改写 frpc.toml + 重启 frpc，实测 3–10 秒。这段时间如果只有一个按钮转圈，
 * 用户会以为程序卡死。主进程按「写入 → 重启 → 完成」推事件，这里据此画进度。 */
const SWITCH_STEPS = [
  { key: 'write', label: '写入本机 frpc.toml', percent: 24 },
  { key: 'restart', label: '重启 frpc 隧道', percent: 68 },
  { key: 'done', label: '等待新隧道上线', percent: 94 },
];

function switchStepMark(state) {
  if (state === 'ok') return icon('check');
  if (state === 'fail') return icon('alert');
  if (state === 'run') return '<span class="spinner-sm"></span>';
  return '<span class="sc-dot"></span>';
}

function switchStepsMarkup(current, failed) {
  return SWITCH_STEPS.map((step, i) => {
    const state = i < current ? 'ok' : i === current ? (failed ? 'fail' : 'run') : 'idle';
    return `<div class="sc-step ${state}">${switchStepMark(state)}<span>${step.label}</span></div>`;
  }).join('');
}

function showSwitchProgress(name) {
  const existing = $('#switch-overlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'switch-overlay';
  el.className = 'switch-overlay';
  el.innerHTML = `
    <div class="switch-card">
      <div class="sc-head">
        <span class="spinner"></span>
        <div class="grow"><h4>正在切换隧道</h4><p>${esc(name || '')}</p></div>
      </div>
      <div class="sc-bar"><span style="width:8%"></span></div>
      <div class="sc-steps">${switchStepsMarkup(0, false)}</div>
      <p class="sc-foot">重启 frpc 期间所有代理会短暂中断，通常 3–10 秒。</p>
    </div>`;
  document.body.appendChild(el);
}

function setSwitchProgress(step, ok) {
  const el = $('#switch-overlay');
  if (!el) return;
  const index = SWITCH_STEPS.findIndex((item) => item.key === step);
  if (index < 0) return;
  el.dataset.step = step;
  const bar = el.querySelector('.sc-bar span');
  if (bar) bar.style.width = `${SWITCH_STEPS[index].percent}%`;
  const steps = el.querySelector('.sc-steps');
  if (steps) steps.innerHTML = switchStepsMarkup(index, ok === false);
}

function failSwitchProgress() {
  const el = $('#switch-overlay');
  if (!el) return;
  el.classList.add('failed');
  const title = el.querySelector('.sc-head h4');
  if (title) title.textContent = '隧道切换失败';
  const spinner = el.querySelector('.sc-head .spinner');
  if (spinner) spinner.remove();
  const foot = el.querySelector('.sc-foot');
  if (foot) foot.textContent = '配置已写入，但 frpc 没能在预期时间内起来，请查看日志或手动重启隧道。';
}

function markSwitchSlow() {
  const el = $('#switch-overlay');
  if (!el) return;
  const foot = el.querySelector('.sc-foot');
  if (foot) foot.textContent = 'frpc 还没起来，继续等待…（以服务方式运行时重启会稍慢）';
}

function hideSwitchProgress() {
  const el = $('#switch-overlay');
  if (!el) return;
  // 成功时让 100% 的条停一下再收，避免“闪一下就没了”。
  const wait = el.dataset.step === 'done'
    ? (el.classList.contains('failed') ? 2600 : 620)
    : 200;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), wait);
}

async function applyServerProfile(btn, { force = false } = {}) {
  const active = activeServerProfile();
  if (!active) return;
  showSwitchProgress(active.name);
  const slowTimer = setTimeout(markSwitchSlow, 8000);
  let unreachable = null;
  try {
    await withBusy(btn, async () => {
      const seq = serverSeq();
      const res = await FRP.serverApply(active.id, force);
      if (serverSeqStale(seq)) return;
      // 主进程先探了目标端口：连不上就不动配置，交给用户决定要不要硬切。
      if (res && !res.ok && res.unreachable) {
        unreachable = res.unreachable;
        return;
      }
      if (!res || !res.ok) return toastResult(res);
      applyServerState(res.data.state || {}, seq);
      if (res.data.appState) S.state = res.data.appState;
      S.lastKeys.overview = '';
      S.lastKeys.proxies = '';
      renderServer(true);
      if (res.data.message) toast('warn', '隧道已切换', res.data.message);
      else toast('success', '本机隧道已切换', `${active.name} · ${active.host}:${active.clientPort}`);
    });
  } finally {
    clearTimeout(slowTimer);
    hideSwitchProgress();
  }
  if (unreachable) confirmSwitchUnreachable(active, unreachable);
}

/* 目标服务器的 frps 连不上时，切换会把正在工作的隧道一起搞断。
 * 这一步不替用户做决定，只把后果说清楚。 */
function confirmSwitchUnreachable(active, info) {
  openModal(`
    <div class="modal" style="width:520px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--red)">${icon('alert')}</div>
        <div class="grow">
          <h3>目标服务器连不上</h3>
          <p>${esc(info.name || active.name)} · ${esc(info.host)}:${esc(info.port)}</p>
        </div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="note error">${icon('alert')}<div>${esc(info.hint || '连不上目标端口')}。<br>没有改动任何配置。</div></div>
        <div class="note warn">${icon('alert')}<div>如果仍然切换：本机 frpc.toml 会立刻改指向 <code>${esc(info.host)}:${esc(info.port)}</code> 并重启 frpc，<strong>现在能用的隧道会一起中断</strong>，直到那台服务器上的 frps 起来。</div></div>
        <div class="note">${icon('shield')}<div>建议先到「服务器」页连接这台机器，确认 frps 已启动（<code>systemctl status frps</code> 或 <code>docker ps</code>），或检查安全组是否放行 ${esc(info.port)} 端口。</div></div>
      </div>
      <div class="modal-foot">
        <span class="mf-left"></span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
        <button class="btn danger" type="button" id="switch-anyway">${icon('alert')}<span>仍然切换</span></button>
      </div>
    </div>`);
  const anyway = $('#switch-anyway');
  if (anyway) {
    anyway.addEventListener('click', () => {
      closeModal();
      applyServerProfile(null, { force: true });
    });
  }
}

/* 切换隧道是本页影响面最大的动作：会改写 frpc.toml 并重启 frpc，
 * 所有代理掉线重连，所以必须二次确认并把差异摆出来。 */
function confirmApplyProfile() {
  const active = activeServerProfile();
  if (!active) return;
  if (!active.hasToken) return toast('error', '该档案还没有 Token', '请先编辑档案填写，或连接服务器完成初始化');
  const tunnel = S.server.tunnel || {};
  const rows = tunnelDiff(active, tunnel);
  openModal(`
    <div class="modal" style="width:540px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--amber)">${icon('link')}</div>
        <div class="grow"><h3>切换本机隧道</h3><p>把 frpc.toml 改为指向「${esc(active.name)}」，然后重启 frpc。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="pd-rows" style="margin:0">
          <div class="pd-row pd-head-row"><span>项目</span><span>当前</span><span>切换后</span></div>
          <div class="pd-row"><span>服务器地址</span><span class="mono">${esc(tunnel.addr || '未配置')}</span><span class="mono good">${esc(active.host)}</span></div>
          <div class="pd-row"><span>frps 端口</span><span class="mono">${esc(tunnel.port || '—')}</span><span class="mono good">${esc(active.clientPort)}</span></div>
          <div class="pd-row"><span>Token</span><span class="mono">${tunnel.tokenSet ? '已配置' : '未配置'}</span><span class="mono good">档案 Token</span></div>
        </div>
        <div class="note warn" style="margin-top:12px">${icon('alert')}<div>重启期间所有代理会短暂中断（约 3–10 秒）；若隧道以 Windows 服务方式运行，可能需要 UAC 授权。${rows.length ? ' 当前档案与本机配置存在差异，切换后这些差异会被覆盖。' : ''}</div></div>
      </div>
      <div class="modal-foot">
        <span class="mf-left"></span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
        <button class="btn primary" type="button" id="apply-profile-confirm">${icon('restart')}<span>切换并重启</span></button>
      </div>
    </div>`);
  const confirm = $('#apply-profile-confirm');
  if (confirm) {
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      closeModal();
      await applyServerProfile(confirm);
    });
  }
}

function keepViewingOnly() {
  const active = activeServerProfile();
  toast('info', '未改动本机隧道', active ? `当前只是查看「${active.name}」，frpc.toml 保持不变` : '');
}

function confirmDeleteServerProfile() {
  const active = activeServerProfile();
  if (!active) return;
  const bound = active.id === S.server.clientServerId;
  openModal(`
    <div class="modal" style="width:480px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--red)">${icon('trash')}</div>
        <div class="grow"><h3>删除服务器档案</h3><p>只删除本机保存的 SSH / Token 信息，不会卸载服务器上的 frps。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="note warn">${icon('alert')}<div>确定删除档案 <strong>${esc(active.name)}</strong>（${esc(active.host)}）吗？该档案保存的密码会一并清除。</div></div>
        ${bound ? `<label class="check-line" style="margin-top:12px"><input type="checkbox" id="profile-del-force"> 这是本机隧道当前目标，同时解除绑定（不会修改 frpc.toml，隧道仍连原地址）</label>` : ''}
      </div>
      <div class="modal-foot">
        <span class="mf-left"></span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
        <button class="btn danger" type="button" id="profile-del-confirm">${icon('trash')}<span>删除</span></button>
      </div>
    </div>`);
  const confirm = $('#profile-del-confirm');
  if (confirm) {
    confirm.addEventListener('click', async () => {
      const forceBox = $('#profile-del-force');
      const force = !!(forceBox && forceBox.checked);
      if (bound && !force) {
        toast('warn', '需要先解除绑定', '勾选“同时解除绑定”后重试');
        return;
      }
      confirm.disabled = true;
      const seq = serverSeq();
      const res = await FRP.serverProfileDelete(active.id, force);
      if (serverSeqStale(seq)) return;
      if (res && res.ok) {
        closeModal();
        S.server.wizard = null;
        S.server.wizardDirty = false;
        applyServerState(res.data, seq);
        renderServer(true);
        toast('success', '档案已删除', active.name);
      } else {
        confirm.disabled = false;
        toastResult(res);
      }
    });
  }
}

function connectedFormMarkup() {
  const s = S.server;
  const saved = s.saved || {};
  const state = S.state || {};
  const active = (s.profiles || []).find((p) => p.id === s.activeServerId) || null;
  const defaultHost = (active && active.host) || saved.host || (state.config && state.config.serverAddr) || '';
  const defaultUser = (active && active.username) || saved.username || 'root';
  const defaultPort = (active && active.port) || saved.port || 22;
  return `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>服务器</h1>
          <p>通过 SSH 登录自己的服务器，把 frps 装好、配置好、跑起来。</p>
        </div>
      </div>
      ${profileBarMarkup({ showDiff: false })}
      <section class="card">
        <div class="card-head">
          <div class="ch-icon">${icon('server')}</div>
          <div class="grow"><h3>连接 frps 服务器</h3><p>需要服务器开放 SSH（默认 22）和登录密码。全链路连通性在概览与代理映射页检查。</p></div>
        </div>
        <form id="server-form" class="server-form" autocomplete="off" onsubmit="return false">
          <div class="field span-2">
            <label>服务器 IP / 域名 <span class="req">*</span></label>
            <input class="input" name="host" value="${esc(defaultHost)}" placeholder="例如 frps.example.com" spellcheck="false">
          </div>
          <div class="field">
            <label>SSH 端口</label>
            <input class="input" name="port" type="number" min="1" max="65535" value="${esc(defaultPort)}">
          </div>
          <div class="field">
            <label>用户名 <span class="req">*</span></label>
            <input class="input" name="username" value="${esc(defaultUser)}" placeholder="root" spellcheck="false">
          </div>
          <div class="field span-2">
            <label>密码 ${s.savedCredential ? '<span class="field-hint">已保存，留空可直接连接</span>' : '<span class="req">*</span>'}</label>
            <div class="input-group">
              <input class="input" id="server-password" name="password" type="password" placeholder="${s.savedCredential ? '使用已保存的密码' : 'SSH 登录密码'}" autocomplete="new-password">
              <button class="icon-btn" type="button" data-act="server.eye" title="显示 / 隐藏密码">${icon('eye')}</button>
            </div>
          </div>
          <div class="field span-2">
            <label class="check-line"><input type="checkbox" name="remember" ${s.savedCredential ? 'checked' : ''}> 记住密码（使用 Windows DPAPI 加密保存在本机）</label>
          </div>
        </form>
        <div class="card-actions">
          ${s.autoConnecting
            ? `<button class="btn primary" type="button" disabled><span class="spinner-sm"></span><span>正在自动连接…</span></button>
               <span class="field-hint">使用档案里保存的密码，无需再次输入。</span>`
            : `<button class="btn primary" type="button" data-act="server.connect">${icon('link')}<span>连接并读取状态</span></button>
               <span class="field-hint">${s.savedCredential ? '已保存密码：切换档案会自动连接并读取状态。' : '密码不会写入 frpc 配置或日志。'}</span>`}
        </div>
      </section>
      <div class="note">${icon('shield')}<div>连接后按顺序走：检查 frps 是否在跑 → 需要时一键从零初始化 → 保存配置并重启 → 做一次「服务器就绪检查」。都绿了再去代理映射添加隧道。</div></div>
    </div>`;
}

async function connectServer(btn, options = undefined) {
  const form = $('#server-form');
  if (!form) return;
  const host = form.querySelector('[name="host"]').value.trim();
  const port = Number(form.querySelector('[name="port"]').value);
  const username = form.querySelector('[name="username"]').value.trim();
  const password = form.querySelector('[name="password"]').value;
  const remember = form.querySelector('[name="remember"]').checked;
  if (!host) return toast('error', '请输入服务器 IP 或域名');
  if (!username) return toast('error', '请输入 SSH 用户名');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return toast('error', 'SSH 端口无效');
  if (!password && !S.server.savedCredential) return toast('error', '请输入密码');

  const payload = { host, port, username, password, remember, serverId: S.server.activeServerId };
  if (options && options.adoptProfile !== undefined) payload.adoptProfile = options.adoptProfile;

  await withBusy(btn, async () => {
    const seq = serverSeq();
    const res = await FRP.serverConnect(payload);
    if (serverSeqStale(seq)) return;
    if (!res || !res.ok) {
      // 地址与所选档案不一致：先让用户决定是更新档案还是另存新档，再重连。
      if (res && res.needsDecision === 'host-mismatch') {
        askProfileMismatch(res, (adopt) => {
          connectServer(null, { adoptProfile: adopt }).catch((error) => toast('error', '连接失败', String((error && error.message) || error)));
        });
        return;
      }
      if (res && res.needsPassword) {
        const input = $('#server-password');
        if (input) {
          input.value = '';
          input.focus();
          input.placeholder = '档案地址已变更，请重新输入密码';
        }
      }
      toastResult(res);
      return;
    }
    S.server.wizard = null;
    S.server.wizardDirty = false;
    S.server.mode = 'wizard';
    S.server.template = 'custom';
    S.server.previewText = '';
    S.server.logs = '';
    applyServerState(res.data, seq);
    renderServer(true);
    if (res.data && res.data.adoptProfile) {
      toast('success', '已连接并更新档案地址', `${username}@${host}:${port}`);
    } else {
      toast('success', '已连接服务器', `${username}@${host}:${port}`);
    }
    await loadServerLogs();
  });
}

function readWizardForm() {
  const form = $('#wizard-form');
  if (!form) return null;
  const fields = {};
  const value = (name) => {
    const input = form.querySelector(`[name="${name}"]`);
    return input ? input.value : '';
  };
  const checked = (name) => {
    const input = form.querySelector(`[name="${name}"]`);
    return !!(input && input.checked);
  };
  fields.bindAddr = value('bindAddr').trim() || '0.0.0.0';
  fields.bindPort = Number(value('bindPort'));
  fields.authEnabled = checked('authEnabled');
  fields.token = value('token').trim();
  fields.webEnabled = checked('webEnabled');
  fields.webAddr = value('webAddr').trim() || '0.0.0.0';
  fields.webPort = Number(value('webPort'));
  fields.webUser = value('webUser').trim();
  fields.webPassword = value('webPassword');
  fields.vhostHTTPEnabled = checked('vhostHTTPEnabled');
  fields.vhostHTTPPort = Number(value('vhostHTTPPort'));
  fields.vhostHTTPSEnabled = checked('vhostHTTPSEnabled');
  fields.vhostHTTPSPort = Number(value('vhostHTTPSPort'));
  fields.allowPortsText = value('allowPortsText').trim();
  return fields;
}

function toggleWizardGroups() {
  const form = $('#wizard-form');
  if (!form) return;
  const toggle = (name, selector) => {
    const input = form.querySelector(`[name="${name}"]`);
    const box = form.querySelector(selector);
    if (input && box) box.classList.toggle('off', !input.checked);
  };
  toggle('authEnabled', '.wz-auth');
  toggle('webEnabled', '.wz-web');
  toggle('vhostHTTPEnabled', '.wz-vhost-http');
  toggle('vhostHTTPSEnabled', '.wz-vhost-https');
}

function schedulePreview(immediate = false) {
  clearTimeout(S.server.previewTimer);
  const run = async () => {
    const fields = readWizardForm();
    if (!fields) return;
    S.server.wizard = fields;
    const res = await FRP.serverPreview(fields);
    const box = $('#wizard-preview');
    const msg = $('#wizard-preview-msg');
    if (!box) return;
    if (res && res.ok) {
      S.server.previewText = res.data.text || '';
      S.server.previewError = '';
      box.textContent = S.server.previewText;
      if (msg) {
        msg.textContent = (res.data.warnings || []).join('；');
        msg.classList.toggle('warn', !!(res.data.warnings || []).length);
      }
    } else {
      S.server.previewText = `// 无法生成：${res ? res.error : '未知错误'}`;
      S.server.previewError = res ? res.error : '';
      box.textContent = S.server.previewText;
      if (msg) {
        msg.textContent = S.server.previewError;
        msg.classList.add('bad');
      }
    }
  };
  if (immediate) run();
  else S.server.previewTimer = setTimeout(run, 300);
}

function setWizardValues(fields) {
  const form = $('#wizard-form');
  if (!form) return;
  for (const [name, value] of Object.entries(fields)) {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value;
  }
  toggleWizardGroups();
}

function applyServerTemplate(template) {
  const form = $('#wizard-form');
  if (!form) return;
  const fields = readWizardForm();
  if (!fields) return;
  if (template === 'basic') {
    fields.authEnabled = false;
    fields.webEnabled = false;
    fields.vhostHTTPEnabled = false;
    fields.vhostHTTPSEnabled = false;
  } else if (template === 'auth') {
    fields.authEnabled = true;
    if (!fields.token) fields.token = randomToken(20);
    fields.webEnabled = false;
    fields.vhostHTTPEnabled = false;
    fields.vhostHTTPSEnabled = false;
  } else if (template === 'panel') {
    fields.authEnabled = true;
    if (!fields.token) fields.token = randomToken(20);
    fields.webEnabled = true;
    fields.webPort = 4096;
    fields.webUser = fields.webUser || 'admin';
    if (!fields.webPassword) fields.webPassword = randomToken(12);
    fields.vhostHTTPEnabled = false;
    fields.vhostHTTPSEnabled = false;
  } else if (template === 'https') {
    fields.authEnabled = true;
    if (!fields.token) fields.token = randomToken(20);
    fields.webEnabled = true;
    fields.webPort = fields.webPort || 4096;
    fields.webUser = fields.webUser || 'admin';
    if (!fields.webPassword) fields.webPassword = randomToken(12);
    fields.vhostHTTPEnabled = true;
    fields.vhostHTTPPort = 80;
    fields.vhostHTTPSEnabled = true;
    fields.vhostHTTPSPort = 443;
  }
  setWizardValues(fields);
  S.server.template = template;
  S.server.wizardDirty = true;
  document.querySelectorAll('.wz-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.template === template));
  schedulePreview();
}

function setServerMode(mode) {
  S.server.mode = mode === 'advanced' ? 'advanced' : 'wizard';
  const wizard = $('#wizard-pane');
  const advanced = $('#advanced-pane');
  if (wizard) wizard.classList.toggle('hidden', S.server.mode !== 'wizard');
  if (advanced) advanced.classList.toggle('hidden', S.server.mode !== 'advanced');
  document.querySelectorAll('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === S.server.mode));
  if (S.server.mode === 'advanced') {
    const area = $('#server-config');
    if (area && S.server.config && !area.value) area.value = S.server.config;
  }
}

async function saveServerConfig(restart, btn) {
  if (!S.server.configPath) return runServerBootstrap(btn);
  let content = '';
  if (S.server.mode === 'advanced') {
    const area = $('#server-config');
    if (!area) return;
    content = area.value;
    if (!content.trim()) return toast('error', '配置内容为空');
  } else {
    const fields = readWizardForm();
    if (!fields) return;
    const preview = await FRP.serverPreview(fields);
    if (!preview || !preview.ok) return toastResult(preview);
    content = preview.data.text;
  }
  await withBusy(btn, async () => {
    const seq = serverSeq();
    const res = await FRP.serverSaveConfig(content, restart);
    if (serverSeqStale(seq)) return;
    if (!res || !res.ok) return toastResult(res);
    applyServerState(res.data && res.data.state, seq);
    S.server.wizardDirty = false;
    const backup = res.data && res.data.backup ? `备份：${res.data.backup}` : '';
    if (restart) {
      const after = res.data && res.data.restarted && res.data.restarted.after;
      toast('success', '配置已保存并重启 frps', `${backup}${after && after.statusText ? ` · ${after.statusText}` : ''}`);
    } else {
      toast('success', '配置已保存', backup);
    }
    renderServer(true);
    await loadServerLogs();
  });
}

async function runServerBootstrap(btn) {
  if (S.server.installBusy) return;
  const fields = readWizardForm();
  if (!fields) return toast('error', '请先填写配置向导');
  S.server.installBusy = true;
  S.server.installProgress = { percent: 0, text: '正在检查服务器环境…' };
  const syncLocal = $('#bootstrap-sync') ? $('#bootstrap-sync').checked : true;
  renderServer(true);
  const seq = serverSeq();
  const res = await FRP.serverBootstrap(fields, { syncLocal }).catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }));
  S.server.installBusy = false;
  if (serverSeqStale(seq) || (res && res.stale)) {
    S.server.installProgress = null;
    toast('warn', '初始化结果未回写', '期间切换了服务器档案，请回到原档案确认状态');
    renderServer(true);
    return;
  }
  if (!res || !res.ok) {
    S.server.installProgress = { percent: Number(S.server.installProgress && S.server.installProgress.percent) || 0, text: (res && res.error) || '初始化失败' };
    renderServer(true);
    toastResult(res);
    return;
  }
  applyServerState(res.data && res.data.state);
  S.server.wizardDirty = false;
  S.server.installProgress = { percent: 100, text: '初始化完成，frps 已运行' };
  const via = res.data && res.data.via === 'systemd' ? '已注册 systemd 服务' : '已以后台进程方式启动';
  const bootWarning = (res.data && res.data.bootWarning) || '';
  const sync = res.data && res.data.localSync;
  if (sync && !sync.ok) {
    toast('warn', 'frps 已初始化，但本机隧道同步失败', sync.error || '请在概览页手动重启隧道');
  } else if (bootWarning) {
    // 服务起来了，但「重启后还会不会起来」没设上：这比装成功更值得说一句。
    toast('warn', 'frps 已启动，但开机自启没设上', bootWarning);
  } else if (sync && sync.ok) {
    toast('success', 'frps 已初始化，本机隧道已同步并重启', `${via} · ${(res.data && res.data.configPath) || ''}`);
  } else {
    toast('success', 'frps 已初始化并启动', `${via} · ${(res.data && res.data.configPath) || ''}`);
  }
  if (res.data && res.data.appState) S.state = res.data.appState;
  renderServer(true);
  await loadServerLogs();
}

function updateBootstrapProgress(payload) {
  if (!payload || !S.server.installBusy) return;
  S.server.installProgress = payload;
  const bar = document.querySelector('#bootstrap-card .bc-bar span');
  const text = document.querySelector('#bootstrap-card .bc-progress p');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(payload.percent) || 0))}%`;
  if (text) text.textContent = `${payload.text || ''} · ${payload.percent || 0}%`;
}

async function controlServer(btn, action) {
  const label = { start: '启动', stop: '停止', restart: '重启' }[action] || action;
  await withBusy(btn, async () => {
    const seq = serverSeq();
    const res = await FRP.serverControl(action);
    if (serverSeqStale(seq)) return;
    if (!res || !res.ok) return toastResult(res);
    applyServerState(res.data && res.data.state, seq);
    toast('success', `frps 已${label}`, res.data && res.data.after ? (res.data.after.statusText || '') : '');
    renderServer(true);
    if (action !== 'stop') await loadServerLogs();
  });
}

function renderSelfTest() {
  const panel = $('#selftest-panel');
  if (panel) panel.innerHTML = selftestMarkup();
}

const SELFTEST_LAYERS = ['ssh', 'service', 'bindPort', 'token'];
const SELFTEST_OK = '服务器就绪';

async function runServerSelfTest() {
  const st = S.server.selftest || {};
  if (st.busy) return;
  S.server.selftest = {
    busy: true,
    conclusion: '',
    steps: Object.fromEntries(SELFTEST_LAYERS.map((key) => [key, { state: 'idle' }])),
  };
  renderSelfTest();
  let failure = '';
  for (const layer of SELFTEST_LAYERS) {
    S.server.selftest.steps[layer] = { state: 'running' };
    renderSelfTest();
    const res = await FRP.serverSelfTest(layer);
    const data = res && res.ok ? res.data : { ok: false, reason: res ? res.error : '检查失败' };
    S.server.selftest.steps[layer] = {
      state: data.ok ? 'ok' : 'fail',
      detail: data.detail || '',
      reason: data.reason || data.detail || '',
      ms: data.ms || 0,
    };
    if (!data.ok) {
      failure = data.reason || data.detail || '检查失败';
      const later = SELFTEST_LAYERS.slice(SELFTEST_LAYERS.indexOf(layer) + 1);
      for (const key of later) S.server.selftest.steps[key] = { state: 'skipped' };
      break;
    }
    renderSelfTest();
  }
  S.server.selftest.busy = false;
  S.server.selftest.conclusion = failure || SELFTEST_OK;
  renderSelfTest();
  if (failure) {
    toast('error', '服务器还没准备好', failure);
    return;
  }
  toast('success', '服务器已就绪', '接下来去「代理映射」添加隧道，三层全绿即可访问');
}

async function disconnectServer() {
  const seq = serverSeq();
  const res = await FRP.serverDisconnect();
  if (serverSeqStale(seq)) return;
  if (res && res.ok) {
    applyServerState(res.data, seq);
    S.server.wizard = null;
    S.server.logs = '';
    renderServer(true);
    toast('info', '已断开服务器连接');
  } else toastResult(res);
}

function openTroubleshoot() {
  openModal(`
    <div class="modal" style="width:680px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--amber)">${icon('shield')}</div>
        <div class="grow"><h3>frps 排错指南</h3><p>针对状态误判、版本 unknown、连接超时与 token 不匹配。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="guide-block">
          <h4>1. 显示“已停止”，但 7000 / 4096 端口在监听</h4>
          <p>frps 可能由 Docker、supervisor 或手工 nohup 启动，systemd 里没有同名服务。控制台会同时检查进程、Docker 容器、systemd 和监听端口；如果仍误判，按下面命令确认：</p>
          <pre>ps -ef | grep '[f]rps'
docker ps | grep -i frp
ss -lntp | grep -E ':(7000|4096)'</pre>
        </div>
        <div class="guide-block">
          <h4>2. frps 版本显示 unknown</h4>
          <p>说明 <code>frps</code> 不在 PATH，也没有从进程或 Docker 镜像里识别到。可以执行：</p>
          <pre>command -v frps
/usr/local/bin/frps -v
docker exec &lt;容器名&gt; frps -v</pre>
          <p>识别到版本后，启动/重启会优先使用同一路径。</p>
        </div>
        <div class="guide-block">
          <h4>3. 本地 → 远程 7000 不通 / connect timeout</h4>
          <p>检查云厂商安全组与系统防火墙是否放行 bindPort；确认 frps 的 <code>bindAddr</code> 不是 127.0.0.1；frpc 的 <code>serverAddr</code> 必须指向公网 IP。</p>
        </div>
        <div class="guide-block">
          <h4>4. 日志出现 token 不匹配 / login failed</h4>
          <p>frps 与所有 frpc 的 <code>auth.token</code> 必须完全一致。改完 frps 配置后需要重启 frps，并同步每个客户端。</p>
        </div>
        <div class="guide-block">
          <h4>5. 修改配置后服务起不来</h4>
          <p>保存时已自动备份为 <code>frps.toml.bak-时间戳</code>。可在服务器上执行 <code>frps verify -c /etc/frp/frps.toml</code>，或从备份恢复后重启。</p>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn primary" type="button" data-act="modal.close">知道了</button>
      </div>
    </div>`);
}


/* ----------------------------- 设置 ------------------------------ */

function renderSettings(force = false) {
  if (!force && S.lastKeys.settings === 'rendered') return;
  S.lastKeys.settings = 'rendered';
  const state = S.state || {};
  const config = state.config || {};
  const settings = state.settings || {};
  const paths = state.paths || {};
  const app = state.app || {};
  const service = state.service || {};
  const log = config.log || {};
  const admin = config.webServer || null;

  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>设置</h1>
          <p>本机程序行为、可执行文件路径、系统集成与版本更新。服务器地址、端口与 Token 全部在「服务器」页管理。</p>
        </div>
      </div>

      <div class="settings-grid">
        <section class="card section">
          <div class="section-head">
            <div class="section-title"><strong>可执行文件与路径</strong><span>frpc.exe 与 frpc.toml 的位置。</span></div>
            <button class="btn" type="button" data-act="settings.reveal">${icon('folder')}<span>打开配置目录</span></button>
          </div>
          <div class="stack" style="gap:12px">
            ${pathRow('frpc.exe', paths.frpcPath, paths.frpcExists, 'frpc')}
            ${pathRow('frpc.toml', paths.configPath, paths.configExists, 'config')}
            <div class="path-row">
              <div class="path-display grow">
                <span class="p-label">frps 面板地址（可选）</span>
                <span class="p-value mono">${esc(settings.frpsDashboardUrl || (config.serverAddr ? `${config.serverAddr}:7500` : '配置服务器后可用'))}</span>
              </div>
            </div>
            <div class="path-row">
              <div class="path-display grow">
                <span class="p-label">日志文件</span>
                <span class="p-value mono">${esc(paths.logPath || '')}</span>
                <span class="tag ${paths.logExists ? 'ok' : 'bad'}">${paths.logExists ? '存在' : '不存在'}</span>
              </div>
              <button class="btn small" type="button" data-act="reveal.log">${icon('folder')}</button>
            </div>
          </div>
        </section>

        <section class="card section">
          <div class="section-head">
            <div class="section-title"><strong>托盘与退出</strong><span>控制台是常驻托盘的应用：关窗口只是收起来，退出要显式点。</span></div>
            <div class="section-actions">
              <button class="btn small" type="button" data-act="app.tray.hide">${icon('box')}<span>收进托盘</span></button>
              <button class="btn small danger" type="button" data-act="app.quit">${icon('power')}<span>完全退出</span></button>
            </div>
          </div>
          <div class="stack" style="gap:10px">
            <div class="path-row">
              <div class="path-display grow">
                <span class="p-label">托盘图标</span>
                <span class="p-value mono">${S.app && S.app.tray ? '已创建，右键可退出' : S.app && S.app.trayCreated ? '已创建，但系统没显示图标' : '未创建'}</span>
                <span class="tag ${S.app && S.app.tray ? 'ok' : 'bad'}">${S.app && S.app.tray ? '可用' : '不可用'}</span>
              </div>
            </div>
            <div class="field-hint">
              关闭窗口（X）${settings.closeToTray !== false ? '会收进托盘，隧道继续跑' : '会直接退出程序'}；
              「完全退出」会先停掉控制台自己拉起的 frpc，再结束进程。
              系统服务模式的隧道不受影响——那是单独的常驻服务。
            </div>
            ${S.app && S.app.tray ? '' : `<div class="note warn">${icon('alert')}<div>${S.app && S.app.trayCreated
              ? '托盘对象已创建，但系统没有给它分配屏幕位置（可能只被折叠进「^ 显示隐藏的图标」，先点 ^ 看看）。<br>如果 ^ 里也没有，多半是<strong>程序所在目录被安全软件/管控策略保护</strong>，系统拒绝为该目录下的程序注册托盘图标——把程序安装或移动到默认目录（C 盘的「应用程序」目录）再打开即可。此时关闭窗口会<strong>直接退出程序</strong>，不会藏起来。'
              : '托盘图标没能创建（assets 下的 tray-*.png 缺失或被拦截）。此时关闭窗口会<strong>直接退出程序</strong>，不会藏起来，避免窗口消失后叫不回来。'}</div></div>`}
          </div>
        </section>

        <section class="card section">
          <div class="section-head">
            <div class="section-title"><strong>系统集成</strong><span>生成带 --no-sandbox 的桌面与开始菜单快捷方式。</span></div>
            <button class="btn" type="button" data-act="app.shortcut">${icon('box')}<span>创建快捷方式</span></button>
          </div>
          <div class="note">${icon('shield')}<div>本机直接双击 exe 会因 Chromium 沙箱初始化失败而没有窗口（退出码 3），必须由命令行带 <code>--no-sandbox</code>。这里生成的快捷方式已经带上该参数，完成后从桌面或开始菜单双击即可，不用再经过 <code>.cmd</code>。</div></div>
        </section>

        <section class="card section">
          <div class="section-head">
            <div class="section-title"><strong>运行模式与行为</strong><span>决定控制台如何启动 frpc 以及界面行为。</span></div>
            <button class="btn primary" type="button" data-act="settings.save.behavior">${icon('check')}<span>保存行为设置</span></button>
          </div>
          <form id="form-behavior" class="form-grid" autocomplete="off" onsubmit="return false">
            <div class="field">
              <label>运行模式</label>
              <select class="select" name="runMode">
                <option value="auto" ${settings.runMode === 'auto' ? 'selected' : ''}>自动（优先使用 Windows 服务）</option>
                <option value="service" ${settings.runMode === 'service' ? 'selected' : ''}>Windows 服务</option>
                <option value="managed" ${settings.runMode === 'managed' ? 'selected' : ''}>应用托管进程</option>
              </select>
              <div class="field-hint">${settings.runMode === 'managed'
                ? '托管模式下隧道是控制台的子进程：控制台退出即断开，不建议用于无人值守。'
                : '服务模式可开机自启；托管模式由控制台直接拉起 frpc.exe。'}</div>
            </div>
            <div class="field">
              <label>状态刷新间隔（毫秒）</label>
              <input class="input" name="pollIntervalMs" type="number" min="1000" max="30000" step="500" value="${esc(settings.pollIntervalMs || 3000)}" />
            </div>
            <div class="field">
              <label>frpc 日志级别</label>
              <select class="select" name="logLevel">
                ${['trace', 'debug', 'info', 'warn', 'error'].map((lv) => `<option value="${lv}" ${log.level === lv ? 'selected' : ''}>${lv}</option>`).join('')}
              </select>
              <div class="field-hint">写入 frpc.toml，保存时会自动备份原配置</div>
            </div>
            <div class="field">
              <div class="switch-row" style="justify-content:space-between">
                <div class="sr-text"><strong>loginFailExit</strong><span>登录失败后直接退出，不再反复重试</span></div>
                <button class="switch ${config.loginFailExit !== false ? 'on' : ''}" type="button" data-act="toggle" data-field="loginFailExit" aria-pressed="${config.loginFailExit !== false}"></button>
              </div>
              <div class="field-hint">写进 frpc.toml；两者都在「保存行为设置」时一起生效</div>
            </div>
            <div class="field span-2">
              <div class="stack" style="gap:0">
                ${switchRow('自动热重载', '检测到配置文件被外部修改后自动调用管理 API 重载', 'autoReload', settings.autoReload !== false)}
                ${switchRow('关闭窗口时最小化到托盘', '退出请使用托盘菜单中的“退出”', 'closeToTray', settings.closeToTray !== false)}
                ${switchRow('启动时自动启动隧道', '控制台启动后立即建立 frpc 连接', 'launchTunnelOnStart', !!settings.launchTunnelOnStart)}
                ${switchRow('开机自动启动', '登录 Windows 后自动运行控制台（写当前用户的启动项，不需要管理员权限）', 'launchAtLogin', !!settings.launchAtLogin)}
                ${app.launchAtLoginBlocked ? `<div class="note warn" style="margin:2px 0 10px">${icon('alert')}<div>启动项已被系统「任务管理器 → 启动」禁用，重启后不会运行。要恢复请到那里把「FRP 控制台」设为「已启用」；或者换个办法：把快捷方式放进 <code>shell:startup</code>。</div></div>` : ''}
                ${settings.launchAtLogin && settings.runMode === 'managed' ? `<div class="note warn" style="margin:2px 0 10px">${icon('alert')}<div>当前是「应用托管进程」模式：开机只会自动打开控制台，隧道要等控制台把 frpc 拉起来才算通；控制台一退隧道就断。要“开机即通”，请改用 Windows 服务模式。</div></div>` : ''}
                ${switchRow('以最小化状态启动', '仅显示托盘图标', 'startMinimized', !!settings.startMinimized)}
                ${switchRow('停止/重启服务前确认', '需要管理员权限时弹出 UAC 提示', 'confirmStopService', settings.confirmStopService !== false)}
                ${switchRow('不继承系统代理', '启动 frpc 时摘掉 HTTP_PROXY 等变量。系统开着代理时，frp 会把 TCP 握手交给代理，常见是被网关挡回 502（对系统服务模式无效）', 'stripProxyEnv', settings.stripProxyEnv !== false)}
              </div>
            </div>
          </form>
        </section>

        <section class="card section">
          <div class="section-head">
            <div class="section-title"><strong>客户端管理 API</strong><span>用于状态查询与配置热重载，仅监听本机。</span></div>
            <button class="btn primary" type="button" data-act="admin.enable">${icon('shield')}<span>${admin ? '校验 / 修复' : '启用管理 API'}</span></button>
          </div>
          ${admin
            ? `<div class="note">${icon('shield')}<div>已启用：<span class="mono">${esc(admin.addr || '127.0.0.1')}:${esc(admin.port)}</span> · 用户 <span class="mono">${esc(admin.user || '-')}</span><br>该管理接口会写回 frpc.toml，启用/修改后需要一次服务重启。</div></div>`
            : `<div class="note warn">${icon('alert')}<div>未检测到 <span class="mono">webServer</span> 配置。启用后控制台可以读取代理在线状态并热重载配置。</div></div>`}
          <div class="field-hint" style="margin-top:10px">当前连接：${state.runtime && state.runtime.connected ? '管理 API 可用' : `不可用${state.runtime && state.runtime.apiError ? `（${esc(state.runtime.apiError)}）` : ''}`}</div>
        </section>

        <section class="card section">
          <div class="section-head">
            <div class="section-title"><strong>Windows 服务</strong><span>frpc 以系统服务方式运行，开机自启。</span></div>
            <div class="page-actions">
              <button class="btn small" type="button" data-act="service.control" data-op="start" ${!service.installed || service.state === 'running' ? 'disabled' : ''}>${icon('play')}<span>启动</span></button>
              <button class="btn small" type="button" data-act="service.control" data-op="stop" ${service.state !== 'running' ? 'disabled' : ''}>${icon('stop')}<span>停止</span></button>
              <button class="btn small" type="button" data-act="service.control" data-op="restart" ${!service.installed ? 'disabled' : ''}>${icon('restart')}<span>重启</span></button>
            </div>
          </div>
          <div class="service-box">
            <div class="sb-state">
              <span class="sb-name">${esc(service.name || settings.serviceName || 'frpc')}</span>
              <span class="sb-desc">${esc(service.installed ? `${serviceStateText(service.state)}${service.pid ? ` · PID ${service.pid}` : ''}` : '未检测到该服务')}</span>
            </div>
            <select class="select" data-act="service.autostart" ${!service.installed ? 'disabled' : ''} style="max-width:150px">
              <option value="auto" ${service.startType === 'auto' ? 'selected' : ''}>开机自启</option>
              <option value="demand" ${service.startType === 'demand' ? 'selected' : ''}>手动启动</option>
              <option value="disabled" ${service.startType === 'disabled' ? 'selected' : ''}>禁用</option>
            </select>
          </div>
          <div class="field-hint" style="margin-top:10px">${esc(service.binaryPath || '')}</div>
          ${app.elevated ? '' : `<div class="note warn" style="margin-top:10px">${icon('alert')}<div>当前不是管理员权限。启动/停止服务会触发 UAC 提权确认。</div></div>`}
        </section>

        <section class="card section">
          <div class="section-head">
            <div class="section-title"><strong>关于</strong><span>版本与运行环境。</span></div>
          </div>
          <div class="detail-list">
            ${detailRow('控制台版本', app.version || '1.0.0')}
            ${detailRow('frpc 版本', app.frpcVersion || '未检测到')}
            ${detailRow('运行平台', `${app.platform || ''} ${app.arch || ''}`)}
            ${detailRow('管理员权限', app.elevated ? '已提升' : '普通权限', app.elevated ? 'ok' : '')}
            ${detailRow('数据目录', app.dataDir || '')}
          </div>
          <div class="update-box" id="update-box"></div>
        </section>
      </div>
    </div>`;

  renderUpdateBox();  if (!S.update) refreshUpdateState();
}

function pathRow(label, value, exists, kind) {
  return `<div class="path-row">
    <div class="path-display grow">
      <span class="p-label">${esc(label)}</span>
      <span class="p-value mono" title="${esc(value || '')}">${esc(value || '未设置')}</span>
      <span class="tag ${exists ? 'ok' : 'bad'}">${exists ? '可用' : '缺失'}</span>
    </div>
    <button class="btn small" type="button" data-act="settings.pick" data-kind="${esc(kind)}">选择</button>
  </div>`;
}

function switchRow(label, desc, field, on) {
  return `<div class="switch-row">
    <div class="sr-text"><strong>${esc(label)}</strong><span>${esc(desc)}</span></div>
    <button class="switch ${on ? 'on' : ''}" type="button" data-act="toggle" data-field="${esc(field)}" aria-pressed="${on}"></button>
  </div>`;
}

function isOn(field) {
  const btn = document.querySelector(`.switch[data-field="${field}"]`);
  return !!(btn && btn.classList.contains('on'));
}

/* ---------------------------- 自动更新 ---------------------------- */

/* 状态都由主进程给（src/main/update.js）：idle / checking / available /
 * downloading / ready / uptodate / error / unsupported。这里只做文案与按钮映射。 */
function updateBoxView() {
  const u = S.update || {};
  const cur = u.currentVersion || (S.app && S.app.version) || '';
  const version = u.version ? `v${String(u.version).replace(/^v/, '')}` : '';
  const checkBtn = '<button class="btn small" type="button" data-act="update.check">检查更新</button>';
  const currentLine = cur ? `当前 v${cur}` : '';

  switch (u.state) {
    case 'unsupported':
      return {
        title: u.reason === 'portable' ? '便携版不支持自动更新' : '当前运行方式不支持自动更新',
        desc: u.message || currentLine,
        buttons: u.releaseUrl
          ? `<button class="btn small" type="button" data-act="open" data-url="${esc(u.releaseUrl)}">打开发布页</button>`
          : '',
        percent: -1,
      };
    case 'checking':
      return { title: '正在检查更新…', desc: currentLine, buttons: '<button class="btn small" type="button" disabled>检查中…</button>', percent: -1 };
    case 'available':
      return {
        title: `发现新版本 ${version || '（版本未知）'}`,
        desc: `${currentLine ? currentLine + '，' : ''}下载后重启即可完成升级`,
        buttons: `<button class="btn small primary" type="button" data-act="update.download">下载更新</button>${checkBtn}`,
        percent: -1,
      };
    case 'downloading':
      return { title: `正在下载 ${version || '更新包'}`, desc: u.message || '', buttons: '', percent: u.percent || 0 };
    case 'ready':
      return {
        title: `${version || '新版本'} 已就绪`,
        desc: '重启后自动安装。安装前会先停掉控制台托管的隧道，更新完成后接回；系统服务模式不受影响',
        buttons: '<button class="btn small primary" type="button" data-act="update.install">重启并安装</button>',
        percent: -1,
      };
    case 'uptodate':
      return { title: '已是最新版本', desc: currentLine, buttons: checkBtn, percent: -1 };
    case 'error':
      return { title: '检查更新失败', desc: u.message || '', buttons: checkBtn, percent: -1 };
    default:
      return { title: '检查更新', desc: currentLine, buttons: checkBtn, percent: -1 };
  }
}

function renderUpdateBox() {
  const box = $('#update-box');
  if (!box) return;
  const v = updateBoxView();
  box.innerHTML = `
    <div class="ub-row">
      <div class="ub-text"><strong>${esc(v.title)}</strong>${v.desc ? `<span>${esc(v.desc)}</span>` : ''}</div>
      ${v.buttons ? `<div class="ub-actions">${v.buttons}</div>` : ''}
    </div>
    ${v.percent >= 0 && v.percent < 100 ? `<div class="ub-bar"><i style="width:${v.percent}%"></i></div>` : ''}`;
}

async function refreshUpdateState() {
  try {
    const res = await FRP.updateState();
    if (res && res.ok) S.update = res.data;
  } catch {
    /* 拿不到就按“未检查”展示 */
  }
  renderUpdateBox();
}

/* ---------------------------- 操作处理 ---------------------------- */

async function handleAction(act, dataset, btn) {
  try {
    switch (act) {
      case 'nav':
        setView(dataset.view);
        break;
      case 'tunnel.start': {
        await withBusy(btn, async () => {
          const res = await FRP.startTunnel();
          if (res && res.ok) { if (res.data && res.data.state) S.state = res.data.state; toast('success', '隧道已启动'); }
          else toastResult(res);
        });
        break;
      }
      case 'tunnel.stop': {
        await withBusy(btn, async () => {
          const res = await FRP.stopTunnel();
          if (res && res.ok) { if (res.data && res.data.state) S.state = res.data.state; toast('success', '隧道已停止'); }
          else toastResult(res);
        });
        break;
      }
      case 'tunnel.restart': {
        await withBusy(btn, async () => {
          const res = await FRP.restartTunnel();
          if (res && res.ok) { if (res.data && res.data.state) S.state = res.data.state; toast('success', '隧道已重启'); }
          else toastResult(res);
        });
        break;
      }
      case 'tunnel.reload': {
        await withBusy(btn, async () => {
          const res = await FRP.reloadTunnel();
          if (res && res.ok) { if (res.data && res.data.state) S.state = res.data.state; toast('success', '配置已热重载'); }
          else toastResult(res);
        });
        break;
      }
      case 'proxy.add':
        openProxyEditor({ mode: 'add' });
        break;
      case 'proxy.edit': {
        const proxy = ((S.state && S.state.proxies) || []).find((p) => p.name === dataset.name);
        if (proxy) openProxyEditor({ mode: 'edit', proxy });
        break;
      }
      case 'proxy.delete':
        confirmDeleteProxy(dataset.name);
        break;
      case 'proxy.test-local': {
        btn.disabled = true;
        const res = await FRP.probeTcp('127.0.0.1', Number(dataset.port));
        btn.disabled = false;
        if (res && res.ok) {
          if (res.data.ok) toast('success', '本机端口可连接', `127.0.0.1:${dataset.port} · ${res.data.ms} ms`);
          else toast('error', '本机端口不可达', res.data.error || '连接失败');
        } else toastResult(res);
        break;
      }
      case 'probe.remote': {
        btn.disabled = true;
        const res = await FRP.probeTcp(String(dataset.host), Number(dataset.port));
        btn.disabled = false;
        if (res && res.ok) {
          if (res.data.ok) toast('success', '公网端口可达', `${dataset.host}:${dataset.port} · ${res.data.ms} ms`);
          else toast('error', '公网端口不可达', res.data.error || '连接失败');
        } else toastResult(res);
        break;
      }
      case 'copy':
        await FRP.copy(dataset.text || '');
        toast('success', '已复制到剪贴板', dataset.text || '');
        break;
      case 'open':
        if (dataset.url) FRP.openUrl(dataset.url);
        break;
      case 'listeners.scan':
        await scanListeners();
        break;
      case 'listener.publish': {
        const proc = String(dataset.process || '').replace(/\.exe$/i, '').replace(/[^A-Za-z0-9._-]/g, '');
        openProxyEditor({ mode: 'add', preset: { name: uniqueName(`port-${dataset.port}${proc ? `-${proc}` : ''}`), localPort: Number(dataset.port), type: 'tcp' } });
        break;
      }
      case 'modal.close':
        closeModal();
        break;
      case 'logs.export': {
        const res = await FRP.exportLogs();
        if (res && res.ok && !res.data.canceled) toast('success', '日志已导出', res.data.file);
        else if (res && res.ok) { /* 用户取消 */ }
        else toastResult(res);
        break;
      }
      case 'logs.clear':
        await FRP.clearLogs();
        S.logs = [];
        renderLogs(true);
        toast('success', '已清空日志显示');
        break;
      case 'logs.refresh': {
        const res = await FRP.getLogs(1000);
        if (res && res.ok) {
          S.logs = res.data.lines || [];
          renderLogs(true);
          toast('success', '日志已刷新');
        } else toastResult(res);
        break;
      }
      case 'logs.file':
        FRP.revealPath('log');
        break;
      case 'logs.level':
        S.logLevel = dataset.level || '';
        renderLogs(true);
        break;
      case 'logs.follow':
        S.follow = !S.follow;
        renderLogs(true);
        break;
      case 'server.profile.new':
        openServerProfileModal('new');
        break;
      case 'server.profile.edit':
        openServerProfileModal('edit');
        break;
      case 'server.profile.delete':
        confirmDeleteServerProfile();
        break;
      case 'server.profile.modal.save':
        await saveServerProfileModal(btn);
        break;
      case 'server.apply':
        confirmApplyProfile();
        break;
      case 'server.apply.keep':
        keepViewingOnly();
        break;
      case 'server.connect':
        await connectServer(btn);
        break;
      case 'server.disconnect':
        await disconnectServer();
        break;
      case 'server.refresh': {
        await withBusy(btn, async () => {
          const res = await FRP.serverRefresh();
          if (!res || !res.ok) return toastResult(res);
          applyServerState(res.data);
          toast('success', '服务器状态已刷新');
          renderServer(true);
          await loadServerLogs();
        });
        break;
      }
      case 'server.control':
        await controlServer(btn, dataset.op);
        break;
      case 'server.bootstrap':
        await runServerBootstrap(btn);
        break;
      case 'server.selftest':
        await runServerSelfTest();
        break;
      case 'server.template':
        applyServerTemplate(dataset.template);
        break;
      case 'server.gen.token': {
        const input = $('#wizard-form [name="token"]');
        if (input) {
          input.value = randomToken(20);
          S.server.template = 'custom';
          S.server.wizardDirty = true;
          schedulePreview();
        }
        break;
      }
      case 'server.gen.password': {
        const input = $('#wz-webpass');
        if (input) {
          input.value = randomToken(14);
          input.type = 'text';
          S.server.template = 'custom';
          S.server.wizardDirty = true;
          schedulePreview();
        }
        break;
      }
      case 'server.eye.web': {
        const input = $('#wz-webpass');
        if (!input) break;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = icon(show ? 'eyeoff' : 'eye');
        break;
      }
      case 'server.mode':
        setServerMode(dataset.mode);
        break;
      case 'server.save':
        await saveServerConfig(false, btn);
        break;
      case 'server.save.restart':
        await saveServerConfig(true, btn);
        break;
      case 'server.advanced.reload':
        await loadServerConfig();
        break;
      case 'server.copy.preview':
        await FRP.copy(S.server.previewText || '');
        toast('success', '已复制配置预览');
        break;
      case 'server.copy.path':
        await FRP.copy(S.server.configPath || '');
        toast('success', '已复制配置路径', S.server.configPath || '');
        break;
      case 'server.logs.refresh':
        await withBusy(btn, async () => { await loadServerLogs(); });
        break;
      case 'server.logs.expand':
        S.server.logExpanded = !S.server.logExpanded;
        renderServerLogs();
        break;
      case 'server.logs.errors':
        S.server.logErrorsOnly = !S.server.logErrorsOnly;
        renderServerLogs();
        break;
      case 'server.scroll.logs': {
        const card = $('#server-log-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (!S.server.logs) await loadServerLogs();
        break;
      }
      case 'server.guide':
        openTroubleshoot();
        break;
      case 'server.open.dashboard': {
        const summary = S.server.summary || {};
        const host = S.server.host;
        if (!summary.webPort || !host) {
          toast('error', '未配置 Dashboard 或缺少服务器地址');
          break;
        }
        FRP.openUrl(`http://${host}:${summary.webPort}/`);
        break;
      }
      case 'goto.proxies':
        setView('proxies');
        break;
      case 'server.eye': {
        const group = btn.closest('.input-group');
        const input = (group && group.querySelector('input')) || $('#server-password');
        if (!input) break;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = icon(show ? 'eyeoff' : 'eye');
        break;
      }
      case 'settings.pick': {
        const res = await FRP.pickPath(dataset.kind);
        if (res && res.ok && res.data && res.data.state) {
          S.state = res.data.state;
          S.lastKeys.settings = '';
          renderSettings(true);
        } else if (res && !res.ok) toastResult(res);
        break;
      }
      case 'settings.reveal':
        FRP.revealPath('config');
        break;
      case 'reveal.log':
        FRP.revealPath('log');
        break;
      case 'app.shortcut':
        await withBusy(btn, async () => {
          const res = await FRP.createShortcut();
          if (res && res.ok) {
            const data = res.data || {};
            const n = (data.created || []).length;
            toast('success', '快捷方式已创建', n ? `已写入 ${n} 处（桌面${n > 1 ? ' / 开始菜单' : ''}），之后直接双击启动即可` : '');
          } else toastResult(res);
        });
        break;
      case 'app.tray.hide': {
        // 走窗口控制，效果和点标题栏的“最小化到托盘”一致
        const res = await FRP.windowControl('hide');
        if (res && res.ok) toast('info', '已收进托盘', '右键托盘图标可以显示界面或完全退出');
        else toastResult(res);
        break;
      }
      case 'app.quit': {
        const okQuit = await confirmDialog({
          title: '完全退出 FRP 控制台',
          body: '会先停掉控制台自己拉起的 frpc，再结束进程。<br>系统服务模式的隧道不受影响。',
          confirmText: '退出',
          danger: true,
        });
        if (okQuit) await FRP.quit();
        break;
      }
      case 'settings.save.behavior':
        await saveBehavior(btn);
        break;
      case 'admin.enable': {
        await withBusy(btn, async () => {
          const res = await FRP.enableAdmin();
          if (res && res.ok) {
            if (res.data && res.data.state) S.state = res.data.state;
            toast('success', res.data && res.data.changed ? '管理 API 已启用' : '管理 API 正常', res.data && res.data.changed ? '如隧道已在运行，可能需要重启一次服务' : '');
            S.lastKeys.settings = '';
            renderSettings(true);
          } else toastResult(res);
        });
        break;
      }
      case 'service.control': {
        await withBusy(btn, async () => {
          const res = await FRP.serviceControl(dataset.op);
          if (res && res.ok) {
            if (res.data && res.data.state) S.state = res.data.state;
            toast('success', `服务已${ { start: '启动', stop: '停止', restart: '重启' }[dataset.op] || '操作'}`);
          } else toastResult(res);
          S.lastKeys.settings = '';
          if (S.view === 'settings') renderSettings(true); else if (S.view === 'overview') renderOverview(true);
        });
        break;
      }
      case 'toggle': {
        const target = btn.classList.toggle('on');
        btn.setAttribute('aria-pressed', String(target));
        break;
      }
      case 'proxyform.suggest': {
        const res = await FRP.suggestPort($('#pf-type') ? $('#pf-type').value : 'tcp');
        if (res && res.ok) {
          const input = $('#pf-remote');
          if (input) input.value = res.data.port;
        }
        break;
      }
      case 'proxyform.type': {
        setProxyFormType(dataset.type);
        break;
      }
      case 'update.check': {
        S.update = { ...(S.update || {}), state: 'checking', message: '正在检查更新…' };
        renderUpdateBox();
        /* 这里自己兜异常：外层 catch 只弹提示，不会重置状态，
         * 一旦 IPC 抛错界面就会永远停在“检查中…”。 */
        let result;
        try {
          const res = await FRP.checkUpdate();
          result = (res && res.ok && res.data) || { state: 'error', message: (res && res.error) || '未知错误' };
        } catch (e) {
          result = { state: 'error', message: e && e.message ? e.message : String(e) };
        }
        S.update = result;
        renderUpdateBox();
        if (result.state === 'available') toast('success', `发现新版本 v${result.version}`, '点「下载更新」获取安装包');
        else if (result.state === 'uptodate') toast('info', '已是最新版本');
        else if (result.state === 'error') toast('error', '检查更新失败', result.message || '');
        else if (result.state === 'unsupported') toast('info', '无法自动更新', result.message || '');
        break;
      }
      case 'update.download': {
        await withBusy(btn, async () => {
          let res = null;
          try {
            res = await FRP.downloadUpdate();
          } catch (e) {
            toast('error', '下载更新失败', e && e.message ? e.message : String(e));
            return;
          }
          if (res && res.ok) {
            S.update = res.data;
            renderUpdateBox();
            if (res.data && res.data.state === 'error') toast('error', '下载更新失败', res.data.message || '');
          } else toastResult(res);
        });
        break;
      }
      case 'update.install': {
        /* 安装会结束当前进程，必须让用户明确知道隧道会短暂中断 */
        const confirmed = await confirmDialog({
          title: '重启并安装更新',
          body: '控制台会关闭，随后安装新版本并自动重新打开。安装前会先停掉控制台托管的隧道，新版本启动后接回；使用系统服务模式时隧道不会中断。',
          confirmText: '重启并安装',
        });
        if (!confirmed) break;
        await withBusy(btn, async () => {
          const res = await FRP.installUpdate();
          if (!res || !res.ok) toast('error', '安装失败', (res && res.error) || '未知错误');
        });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    toast('error', '操作异常', e && e.message ? e.message : String(e));
  }
}

async function withBusy(btn, fn) {
  if (btn) {
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-sm"></span><span>处理中…</span>`;
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  } else {
    await fn();
  }
}

/* ---------------------------- 代理表单 ---------------------------- */

function uniqueName(base) {
  const clean = String(base || 'proxy').replace(/\s+/g, '-').replace(/[^\w.-]/g, '') || 'proxy';
  const existing = new Set(((S.state && S.state.proxies) || []).map((p) => p.name));
  if (!existing.has(clean)) return clean;
  let i = 2;
  while (existing.has(`${clean}-${i}`)) i += 1;
  return `${clean}-${i}`;
}

function openProxyEditor({ mode, proxy = null, preset = null }) {
  const current = proxy || {};
  const initial = {
    name: preset && preset.name ? preset.name : current.name || '',
    type: current.type || (preset && preset.type) || 'tcp',
    localIP: current.localIP || '127.0.0.1',
    localPort: current.localPort || (preset && preset.localPort) || '',
    remotePort: current.remotePort || '',
    customDomains: (current.customDomains || []).join(', '),
    subdomain: current.subdomain || '',
    useCompression: current.transport ? !!current.transport.useCompression : true,
    useEncryption: current.transport ? !!current.transport.useEncryption : false,
  };
  S.proxyEdit = { mode, originalName: current.name || '' };
  const types = ['tcp', 'udp', 'http', 'https'];
  if (!types.includes(initial.type)) types.push(initial.type);

  openModal(`
    <div class="modal" style="width:620px">
      <div class="modal-head">
        <div class="mh-icon">${icon('link')}</div>
        <div class="grow">
          <h3>${mode === 'edit' ? '编辑代理' : '新增代理'}</h3>
          <p>本地服务通过 frpc 映射到服务器公网入口。</p>
        </div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close" aria-label="关闭">${icon('x')}</button>
      </div>
      <form id="proxy-form" class="modal-body" autocomplete="off">
        <div class="form-grid">
          <div class="field span-2">
            <label>名称 <span class="req">*</span></label>
            <input class="input" id="pf-name" name="name" value="${esc(initial.name)}" placeholder="例如 jellyfin、web、rdp" />
            <div class="field-hint">名称会显示在控制台与服务端，不能与已有代理重复。</div>
          </div>
          <div class="field span-2">
            <label>协议类型</label>
            <input type="hidden" id="pf-type" name="type" value="${esc(initial.type)}" />
            <div class="type-chips" id="pf-types">
              ${types.map((t) => `<button class="type-chip" type="button" data-act="proxyform.type" data-type="${t}" data-label="${esc(TYPE_LABEL[t])}">${esc(TYPE_LABEL[t])}<small>${t}</small></button>`).join('')}
            </div>
          </div>
          <div class="field">
            <label>本地 IP</label>
            <input class="input" id="pf-localip" name="localIP" value="${esc(initial.localIP)}" />
          </div>
          <div class="field">
            <label>本地端口 <span class="req">*</span></label>
            <input class="input" id="pf-localport" name="localPort" type="number" min="1" max="65535" value="${esc(initial.localPort)}" placeholder="例如 8080" />
          </div>
          <div class="field" id="pf-remote-field">
            <label>公网端口 <span class="req">*</span></label>
            <div class="input-group">
              <input class="input" id="pf-remote" name="remotePort" type="number" min="1" max="65535" value="${esc(initial.remotePort)}" placeholder="例如 23180" />
              <button class="btn icon" type="button" data-act="proxyform.suggest" title="自动选择空闲端口">${icon('reload')}</button>
            </div>
            <div class="field-hint">服务器上对外开放的端口，注意不要与已有服务冲突。</div>
          </div>
          <div class="field span-2 hidden" id="pf-domain-field">
            <label>自定义域名（逗号分隔）</label>
            <input class="input" id="pf-domains" name="customDomains" value="${esc(initial.customDomains)}" placeholder="example.com, sub.example.com" />
            <div class="field-hint">HTTP/HTTPS 类型必填；使用 frps 的 vhost 域名转发。</div>
          </div>
          <div class="field span-2">
            <label>传输选项</label>
            <div class="stack" style="gap:0">
              ${switchRow('启用压缩', '对传输数据进行压缩，适合文本流量', 'pf-compression', initial.useCompression)}
              ${switchRow('启用加密', '对传输数据加密（会增加少量 CPU 开销）', 'pf-encryption', initial.useEncryption)}
            </div>
          </div>
        </div>
        <div class="form-error hidden" id="pf-error">${icon('alert')}<span></span></div>
      </form>
      <div class="modal-foot">
        <span class="mf-left">保存后会写入 frpc.toml，隧道在运行时再尽力热重载</span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
        <button class="btn primary" type="button" id="pf-submit">${icon('check')}<span>${mode === 'edit' ? '保存修改' : '创建代理'}</span></button>
      </div>
    </div>`);

  setProxyFormType(initial.type);
  const form = $('#proxy-form');
  const submit = $('#pf-submit');
  if (submit) submit.addEventListener('click', () => submitProxyForm(form, mode));
  if (form) {
    form.addEventListener('submit', (e) => { e.preventDefault(); submitProxyForm(form, mode); });
    const remoteInput = $('#pf-remote');
    if (remoteInput && initial.remotePort) remoteInput.value = initial.remotePort;
    if (!initial.remotePort && (initial.type === 'tcp' || initial.type === 'udp') && !proxy) {
      suggestRemotePort(initial.type);
    }
  }
  setTimeout(() => { const name = $('#pf-name'); if (name) name.focus(); }, 30);
}

async function suggestRemotePort(type) {
  const res = await FRP.suggestPort(type);
  if (res && res.ok) {
    const input = $('#pf-remote');
    if (input && !input.value) input.value = res.data.port;
  }
}

function setProxyFormType(type) {
  const hidden = $('#pf-type');
  if (hidden) hidden.value = type;
  $$('#pf-types [data-type]').forEach((btn) => btn.classList.toggle('active', btn.dataset.type === type));
  const needsRemote = type === 'tcp' || type === 'udp' || type === 'tcpmux';
  const domainType = type === 'http' || type === 'https';
  const remoteField = $('#pf-remote-field');
  const domainField = $('#pf-domain-field');
  if (remoteField) remoteField.classList.toggle('hidden', !needsRemote);
  if (domainField) domainField.classList.toggle('hidden', !domainType);
  const remoteInput = $('#pf-remote');
  if (needsRemote && remoteInput && !remoteInput.value) suggestRemotePort(type);
}

async function submitProxyForm(form, mode) {
  const errorEl = $('#pf-error');
  const showError = (msg) => {
    if (!errorEl) return;
    errorEl.classList.remove('hidden');
    errorEl.querySelector('span').textContent = msg;
    toast('error', '无法保存代理', msg);
  };
  if (!form) return;
  const name = $('#pf-name').value.trim();
  const type = $('#pf-type').value;
  const localIP = $('#pf-localip').value.trim();
  const localPort = Number($('#pf-localport').value);
  const remotePort = Number($('#pf-remote').value);
  const domains = $('#pf-domains').value;
  const useCompression = isOn('pf-compression');
  const useEncryption = isOn('pf-encryption');

  if (!name) return showError('请填写代理名称');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return showError('名称建议只包含字母、数字、点、下划线或短横线');
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) return showError('本地端口必须是 1 - 65535 的整数');
  const needsRemote = type === 'tcp' || type === 'udp' || type === 'tcpmux';
  const domainType = type === 'http' || type === 'https';
  if (needsRemote && (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)) return showError('公网端口必须是 1 - 65535 的整数');
  if (domainType && !domains.trim()) return showError('HTTP/HTTPS 类型需要填写自定义域名');

  const input = {
    name, type, localIP, localPort,
    remotePort: needsRemote ? remotePort : null,
    customDomains: domains,
    useCompression,
    useEncryption,
  };
  if (errorEl) errorEl.classList.add('hidden');
  const submit = $('#pf-submit');
  if (submit) {
    submit.disabled = true;
    submit.innerHTML = `<span class="spinner-sm"></span><span>保存中…</span>`;
  }
  const res = await FRP.saveProxy(mode, mode === 'edit' ? S.proxyEdit.originalName : '', input);
  if (!res || !res.ok) {
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = `${icon('check')}<span>${mode === 'edit' ? '保存修改' : '创建代理'}</span>`;
    }
    showError((res && res.error) || '保存失败');
    return;
  }
  if (res.data && res.data.state) S.state = res.data.state;
  closeModal();
  // 隧道没运行时不会真的热重载（没有管理 API），别在这种时候说“已热重载”。
  const reloaded = !!(res.data && res.data.reloaded);
  toast(
    'success',
    mode === 'edit' ? '代理已更新' : '代理已创建',
    `${name} · 配置已写入${reloaded ? '并已热重载' : '，隧道启动后生效'}`,
  );
  S.lastKeys.proxies = '';
  S.lastKeys.overview = '';
  renderCurrent({ force: true });
}

/* 通用确认框：返回 Promise<boolean>。取消 / 点 X / 点遮罩都算 false。 */
function confirmDialog({ title = '确认', body = '', confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal(`
      <div class="modal" style="width:460px">
        <div class="modal-head">
          <div class="mh-icon" style="color:${danger ? 'var(--red)' : 'var(--accent)'}">${icon(danger ? 'alert' : 'check')}</div>
          <div class="grow"><h3>${esc(title)}</h3></div>
          <button class="icon-btn modal-close" type="button" id="cd-x">${icon('x')}</button>
        </div>
        <div class="modal-body"><div class="note ${danger ? 'warn' : ''}">${icon(danger ? 'alert' : 'check')}<div>${body}</div></div></div>
        <div class="modal-foot">
          <span class="mf-left"></span>
          <button class="btn" type="button" id="cd-cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" type="button" id="cd-ok">${esc(confirmText)}</button>
        </div>
      </div>`);
    const on = (id, value) => {
      const el = $(`#${id}`);
      if (el) el.addEventListener('click', () => finish(value));
    };
    on('cd-ok', true);
    on('cd-cancel', false);
    on('cd-x', false);
  });
}

function confirmDeleteProxy(name) {
  openModal(`
    <div class="modal" style="width:440px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--red)">${icon('trash')}</div>
        <div class="grow"><h3>删除代理</h3><p>此操作会从 frpc.toml 中移除该映射（隧道运行时会一并热重载）。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="note warn">${icon('alert')}<div>确定要删除代理 <strong>${esc(name)}</strong> 吗？删除后公网地址会立即失效。</div></div>
      </div>
      <div class="modal-foot">
        <span class="mf-left"></span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
        <button class="btn danger" type="button" id="del-confirm">${icon('trash')}<span>删除</span></button>
      </div>
    </div>`);
  const btn = $('#del-confirm');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await FRP.deleteProxy(name);
      if (res && res.ok) {
        if (res.data && res.data.state) S.state = res.data.state;
        closeModal();
        toast('success', '代理已删除', name);
        S.lastKeys.proxies = '';
        S.lastKeys.overview = '';
        renderCurrent({ force: true });
      } else {
        btn.disabled = false;
        toastResult(res);
      }
    });
  }
}

/* ----------------------------- 模态框 ---------------------------- */

function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-act="modal.close"></div>${html}`;
  root.classList.add('open');
  S.modalOpen = true;
  const backdrop = root.querySelector('.modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
}

function closeModal() {
  const root = $('#modal-root');
  if (!root) return;
  root.classList.remove('open');
  root.innerHTML = '';
  S.modalOpen = false;
  S.proxyEdit = null;
}

/* ----------------------------- 设置保存 --------------------------- */

/* 日志级别与 loginFailExit 属于 frpc.toml，但服务器地址 / 端口 / Token 一律
 * 不在这里改 —— 那是「服务器」页的职责。所以这里把现有连接参数原样带回去，
 * 只覆盖 log 与 loginFailExit，避免设置页变成第二个能改隧道的地方。
 *
 * 全新安装时 frpc.toml 里还没有 serverAddr，config:save 会以「服务器地址不能为空」
 * 拒绝。这种情况直接跳过：等用户在服务器页连上服务器、隧道指向确定之后，
 * 这两个值会在下一次保存时一起写进去。 */
async function saveClientLogOptions(level, loginFailExit) {
  const config = (S.state || {}).config || {};
  if (!config.serverAddr) return { ok: true, skipped: true };
  const res = await FRP.saveConfig({
    serverAddr: config.serverAddr,
    serverPort: config.serverPort,
    loginFailExit,
    auth: config.auth || { method: 'token', token: '' },
    log: { ...(config.log || {}), level },
    transport: config.transport || null,
  });
  if (res && res.ok && res.data && res.data.state) S.state = res.data.state;
  return res;
}

async function saveBehavior(btn) {
  const form = $('#form-behavior');
  if (!form) return;
  const patch = {
    runMode: form.querySelector('[name="runMode"]').value,
    pollIntervalMs: Number(form.querySelector('[name="pollIntervalMs"]').value),
    autoReload: isOn('autoReload'),
    closeToTray: isOn('closeToTray'),
    launchTunnelOnStart: isOn('launchTunnelOnStart'),
    launchAtLogin: isOn('launchAtLogin'),
    startMinimized: isOn('startMinimized'),
    confirmStopService: isOn('confirmStopService'),
    stripProxyEnv: isOn('stripProxyEnv'),
  };
  await withBusy(btn, async () => {
    const level = form.querySelector('[name="logLevel"]').value;
    const loginFailExit = isOn('loginFailExit');
    const res = await FRP.saveSettings(patch);
    if (!res || !res.ok) {
      toastResult(res);
      // 保存失败时把开关拨回系统里的真实状态（例如启动项被组策略拦下）
      renderSettings(true);
      return;
    }
    if (res.data && res.data.state) S.state = res.data.state;
    /* 日志级别 / loginFailExit 落在 frpc.toml 里，同一个按钮一起写掉，
     * 免得用户改完日志级别还要再找一次“保存配置在哪”。 */
    const cfg = await saveClientLogOptions(level, loginFailExit);
    if (!cfg || !cfg.ok) {
      toastResult(cfg);
      renderSettings(true);
      return;
    }
    S.lastKeys.settings = '';
    if (cfg.skipped) {
      toast('success', '行为设置已保存', '还没有配置服务器，日志级别与 loginFailExit 会在隧道建立后一起写入');
      return;
    }
    toast('success', '设置已保存', cfg.data && cfg.data.reloaded ? 'frpc 配置已热重载' : '');
  });
}

/* ----------------------------- 扫描 ------------------------------ */

async function scanListeners({ silent = false } = {}) {
  if (S.listenersBusy) return;
  S.listenersBusy = true;
  if (S.view === 'discovery') { S.lastKeys.discovery = ''; renderDiscovery(true); }
  try {
    const res = await FRP.scanListeners();
    if (res && res.ok) {
      S.listeners = res.data.listeners || [];
      S.listenersError = res.data.processError || '';
      if (!silent) toast('success', '端口扫描完成', `发现 ${S.listeners.length} 个 TCP 监听`);
    } else if (res && !res.ok) {
      toast('error', '端口扫描失败', res.error);
    }
  } catch (e) {
    if (!silent) toast('error', '端口扫描异常', e.message);
  } finally {
    S.listenersBusy = false;
    if (S.view === 'discovery') { S.lastKeys.discovery = ''; renderDiscovery(true); }
  }
}

/* ----------------------------- 启动 ------------------------------ */

// 最大化与还原用两个字形，只切 class 不动 DOM。
function setMaximizedState(maximized) {
  const btn = $('#win-max');
  if (!btn) return;
  btn.classList.toggle('is-max', !!maximized);
  btn.title = maximized ? '还原' : '最大化';
  btn.setAttribute('aria-label', maximized ? '还原' : '最大化');
}

function bindStaticEvents() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'modal.close' && !btn.classList.contains('modal-close') && !btn.classList.contains('modal-backdrop')) {
      // 底部取消按钮也走这里
    }
    handleAction(btn.dataset.act, btn.dataset, btn);
  });
  document.addEventListener('input', (e) => {
    if (!e.target.closest('#wizard-form')) return;
    S.server.template = 'custom';
    S.server.wizardDirty = true;
    document.querySelectorAll('.wz-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.template === 'custom'));
    toggleWizardGroups();
    schedulePreview();
  });
  document.addEventListener('change', (e) => {
    const profileSelect = e.target.closest('#server-profile-select');
    if (profileSelect) {
      selectServerProfile(profileSelect.value).catch((error) => toast('error', '切换档案失败', String(error && error.message || error)));
      return;
    }
    if (!e.target.closest('#wizard-form')) return;
    toggleWizardGroups();
    schedulePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.modalOpen) closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
      e.preventDefault();
      FRP.refresh().then((res) => { if (res && res.ok) { S.state = res.data; updateChrome(); renderCurrent({ force: true }); } }).catch(() => {});
    }
  });

  const min = $('#win-min');
  const max = $('#win-max');
  const close = $('#win-close');
  if (min) min.addEventListener('click', () => FRP.windowControl('minimize'));
  if (max) max.addEventListener('click', () => FRP.windowControl('maximize'));
  if (close) close.addEventListener('click', () => FRP.windowControl('close'));
  const titlebar = $('.titlebar');
  if (titlebar) {
    titlebar.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      FRP.windowControl('maximize');
    });
  }

  const pill = $('#tb-status');
  if (pill) {
    pill.addEventListener('click', () => {
      FRP.refresh().then((res) => {
        if (res && res.ok) { S.state = res.data; updateChrome(); renderCurrent({ force: true }); toast('info', '状态已刷新'); }
      }).catch(() => {});
    });
  }
}

async function boot() {
  bindStaticEvents();
  const info = runtimeInfo();
  updateChrome();
  try {
    const res = await FRP.init();
    if (!res || !res.ok) {
      showBootError((res && res.error) || '无法读取应用状态');
      return;
    }
    S.state = res.data.state;
    S.app = res.data.app;
    S.logs = res.data.logs || [];
    // 窗口启动时可能就是最大化状态（上次退出前最大化），按钮字形要跟着对。
    setMaximizedState(S.app && S.app.maximized);
    S.ready = true;
    buildNav();
    setView('overview');
    updateChrome();

    FRP.on('state:update', (st) => {
      if (!st) return;
      const prevKey = overviewKey();
      S.state = st;
      updateChrome();
      const nextKey = overviewKey();
      if (S.view === 'proxies') {
        const nextP = proxiesKey();
        if (nextP !== S.lastKeys.proxies) renderProxies(true);
      } else if (S.view === 'overview' && prevKey !== nextKey) {
        renderOverview(true);
      }
      if (S.view === 'server' && S.server.connected) {
        // 服务器页的“映射表”读的是本机 state.proxies，要跟着状态更新；
        // 但每 3 秒无条件重写 tbody 会让徽标里的脉冲小点重新开始动画，看起来像屏闪。
        const rowsKey = JSON.stringify({
          addr: (st.config && st.config.serverAddr) || '',
          list: (st.proxies || []).map((p) => [p.name, p.status, p.publicAddress, p.remotePort, p.localPort, p.health && p.health.ok, p.health && p.health.reason]),
        });
        if (S.lastKeys.serverProxies !== rowsKey) {
          S.lastKeys.serverProxies = rowsKey;
          const body = $('#server-proxies tbody');
          if (body) body.innerHTML = serverProxyRows();
        }
      }
      // 本机隧道目标被别处改动（设置页保存、外部编辑 frpc.toml）时，
      // 服务器页的档案栏必须跟着重算，否则会一直显示旧的绑定关系。
      const boundId = st.settings ? st.settings.clientServerId : undefined;
      if (boundId !== undefined && S.server.loaded && boundId !== S.server.clientServerId) {
        loadServerState().catch(() => {});
      }
    });

    FRP.on('server:binding-changed', () => {
      if (S.server.loaded) loadServerState().catch(() => {});
    });

    FRP.on('server:install-progress', (payload) => updateBootstrapProgress(payload));
    FRP.on('server:switch-progress', (payload) => {
      const step = payload && payload.step;
      if (!step) return;
      // 只有第一个阶段才自动浮现进度层：避免迟到的消息把刚收起的浮层又弹出来。
      if (step === 'write' && !$('#switch-overlay')) showSwitchProgress(payload.name || '');
      setSwitchProgress(step, payload.ok);
      if (step === 'done' && payload.ok === false) failSwitchProgress();
    });
    FRP.on('logs:append', (lines) => appendLogs(lines));
    FRP.on('logs:reset', ({ lines } = {}) => { S.logs = lines || []; if (S.view === 'logs') renderLogs(true); });
    FRP.on('update:status', (payload) => {
      if (!payload) return;
      S.update = payload;
      renderUpdateBox();
      // 下载是主进程异步推进的，完成时给一次明确反馈（进度条本身不弹提示）
      if (payload.state === 'ready') {
        toast('success', '更新已就绪', `${payload.version ? `v${payload.version}` : '新版本'} 下载完成，点「重启并安装」生效`);
      }
    });
    FRP.on('notify', (payload) => {
      if (!payload) return;
      toast(payload.kind === 'error' ? 'error' : payload.kind === 'warn' ? 'warn' : 'info', payload.title || '提示', payload.message || '');
    });
    FRP.on('window:maximized', (maximized) => setMaximizedState(maximized));
  } catch (e) {
    showBootError(e && e.message ? e.message : String(e));
  }
}

function showBootError(message) {
  const view = $('#view');
  if (!view) return;
  view.innerHTML = `<div class="boot" style="height:100%">
    <div class="empty-illustration" style="color:var(--red)">${icon('alert')}</div>
    <p style="color:var(--red)">无法初始化控制台</p>
    <p style="max-width:420px;text-align:center">${esc(message)}</p>
    <button class="btn" type="button" id="boot-reload">重新加载</button>
  </div>`;
  const reload = $('#boot-reload');
  if (reload) reload.addEventListener('click', () => location.reload());
}

document.addEventListener('DOMContentLoaded', () => {
  if (!FRP) {
    showBootError('preload 脚本未加载');
    return;
  }
  boot();
});

})();
