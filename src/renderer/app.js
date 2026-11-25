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
  logSource: 'local',   // 'local' = 本机 frpc；'server' = 服务器 frps（1.2.91 起两者都在「实时日志」页）
  modalOpen: false,
  proxyEdit: null,
  update: null,
  /* 已知服务器指纹（userData/known-hosts.json）：首次连接记录、之后比对，设置页可以查看与删除 */
  knownHosts: { loaded: false, loading: false, hosts: [], error: '' },
  certs: { list: [], dns: { dnsProvider: '', hasToken: false, acmeEmail: '' }, loaded: false, busy: false, issuing: false, wizard: { domain: '', checking: false, dns: null, setA: false, result: null }, server: { loaded: false, loading: false, certs: [], host: '', scannedAt: 0, truncated: false, error: '' } },
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
    mode: 'frps',
    frpcRaw: '',
    wizard: null,
    wizardDirty: false,
    logs: '',
    logsSource: '',
    logsError: '',
    logExpanded: false,
    logErrorsOnly: false,
    selftest: null,
    /* 配置体检（1.2.72）：nginx -t 结果 + 引用缺失证书的文件清单。 */
    nginxHealth: null,
    nginxHealthBusy: false,
    nginxRepairBusy: false,
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
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.6a7.6 7.6 0 0 0 .1-3.2l2-1.5-2-3.4-2.4 1a7.6 7.6 0 0 0-2.7-1.6L14 2.4h-4l-.4 2.5A7.6 7.6 0 0 0 6.9 6.5l-2.4-1-2 3.4 2 1.5a7.6 7.6 0 0 0-.1 3.2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 0 0 2.7 1.6l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.7-1.6l2.4 1 2-3.4-2-1.5z"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>',
  reload: '<path d="M4 12a8 8 0 0 1 13.6-5.7"/><path d="M20 12a8 8 0 0 1-13.6 5.7"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6M4 4l5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15a2 2 0 0 1-1-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 1"/>',
  external: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M17 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h5"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6.5 7l.8 12h9.4l.8-12M10 10.5v5M14 10.5v5"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2.2 2.2 0 0 0-3-3L5 17z"/><path d="m13.5 5.5 3 3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 6.5"/>',
  save: '<path d="M5 4.5h10.5L19 8v11.5H5z"/><path d="M8.5 4.5v5h6v-5"/><path d="M8.5 13h7v6.5h-7z"/>',
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
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
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

/* 术语：给小白解释黑话，悬停显示说明。 */
function term(text, tip) {
  return `<span class="term" data-tip="${esc(tip)}">${esc(text)}</span>`;
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
const SCOPE_LABEL = { loopback: '回环', all: '全网', docker: 'Docker', lan: '内网', public: '公网', other: '其它' };

/* 通配符覆盖判定（渲染层副本，主进程 acme.js 里还有一份）。 */
function coversDomain(pattern, host) {
  const p = String(pattern || '').trim().toLowerCase();
  const h = String(host || '').trim().toLowerCase();
  if (!p || !h) return false;
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    if (!h.endsWith(suffix)) return false;
    const label = h.slice(0, h.length - suffix.length);
    return label && !label.includes('.');
  }
  return false;
}

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
    /* 404 时说「通（但返回 404）」比说「不通」准确：TCP/TLS/HTTP 都成功了。 */
    h.pathMissing ? '公网：通，但返回 404' : label('公网', h.layers.public),
  ];
  /* 靠浏览器网络栈复验通过的，标一下来源：本机 node 直连是被重置的，
   * 用户看到「通」才知道不是靠 HTTP 412 之类的宽松判定蒙过去的。 */
  if (h.layers.public && h.layers.public.via === 'browser') parts[parts.length - 1] = '公网：通（浏览器网络栈复验）';
  const hint = h.layers.public && h.layers.public.hint;
  return hintsText(parts.join(' · '), hint);
}

/* 提示文案拼接：有细节时换行显示（title 支持换行）。 */
function hintsText(base, hint) {
  return hint ? `${base}\n${hint}` : base;
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
  /* 管理 API 有响应，但 /api/config 显示它不是这份配置的 frpc：
   * 那个端口上跑的是别人的隧道，既不能接管，也不能让“停止隧道”去杀它。 */
  const foreign = !!r.foreign || r.mode === 'foreign';
  /* 自动重连进行中：hero 直接说“第几次、还有几秒”，比笼统的“未连接”有用得多。 */
  const rc = r.reconnect || {};
  const reconnecting = (rc.state === 'waiting' || rc.state === 'running') && !online;
  // 只有在“本来该由系统服务提供隧道”的模式下，服务停了才值得单独提示。
  // 托管模式下服务停着是常态，再报“系统服务未运行”只会把人引偏。
  const wantsService = runMode === 'auto' || runMode === 'service';
  const serviceDown = wantsService && service.installed && !online && (service.state === 'stopped' || service.state === 'paused' || service.state === 'stop-pending');
  /* 隧道在跑，但它连的那台服务器在本机已经没有档案了（档案被删、或 frpc.toml 是手改的）。
   * 连通性是真通，可控制台已经管不到它 —— 不能再亮绿灯说“一切正常”。
   * 注意区分「档案还在、只是没绑到隧道上」（matchProfileName 有值），那种情况不严重。 */
  const orphan = !!(state.binding && state.binding.unarchived && !state.binding.matchProfileName);
  let tone = 'warn';
  let label = '未连接';
  let title = '隧道未运行';
  let desc = '';
  if (reconnecting) {
    tone = 'warn';
    label = '自动重连中';
    title = `第 ${rc.attempts} 次重连中`;
    desc = rc.state === 'waiting'
      ? `${Math.max(1, Math.round((rc.nextInMs || 0) / 1000))} 秒后重试${rc.slowMode ? '（慢速，每 5 分钟一次）' : ''}`
      : '正在拉起 frpc…';
  } else if (online && !starting) {
    if (orphan) {
      tone = 'warn';
      label = '隧道在线 · 未登记';
      title = '隧道仍在运行，但这台服务器不在连接列表里';
      desc = `frpc.toml 还在连 ${state.binding.addr}:${state.binding.port || '—'}`;
    } else {
      tone = 'online';
      label = '隧道在线';
      title = '隧道已连接';
      desc = modeLabel(r.mode);
    }
  } else if (foreign) {
    // 管理端口上是别人的 frpc：既没连上，也不能报“外部进程（可能是正常隧道）”
    tone = 'error';
    label = '端口冲突';
    title = `管理端口 ${r.adminPort || 7400} 被别的 frpc 占用`;
    desc = '那不是这份配置的隧道';
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
    const why = { refused: '端口未监听', unreachable: '网络不可达', firewall: '被防火墙/安全组拦截', auth: 'Token 校验失败', proxy: '被代理/网关拦截', unconfirmed: '服务器未确认代理' }[r.connectKind] || '连接失败';
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
  return { tone, label, title, desc, online, running, starting, external, foreign, r, service };
}

/* ---------------------------- 页面骨架 ---------------------------- */

const NAV_ITEMS = [
  { id: 'overview', label: '概览', icon: 'gauge', sub: '运行状态与快捷入口' },
  { id: 'proxies', label: '代理映射', icon: 'link', sub: '穿透规则与公网地址' },
  { id: 'discovery', label: '服务发现', icon: 'box', sub: '本机端口扫描' },
  { id: 'server', label: '服务器', icon: 'server', sub: 'frps 远程管理' },
  { id: 'certs', label: 'HTTPS 证书', icon: 'shield', sub: 'Let\'s Encrypt 证书签发与管理' },
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


/* ===== 多连接：侧栏切换器 =====
 * 只在「连接 >1 条」时出现；单连接用户界面与以前完全一致。
 * 切换会停掉正在跑的隧道（主进程如此设计：全局 manager 的配置上下文是一个），
 * 所以按钮文案直接把后果写出来，别让人以为是点击无反应。 */
function connList() {
  const state = S.state || {};
  return Array.isArray(state.connections) ? state.connections : [];
}
function activeConnId() {
  const state = S.state || {};
  return state.activeConnectionId || (connList()[0] || {}).id || '';
}
function connRuntimeLabel(conn) {
  const rt = conn.runtime || {};
  if (rt.connected) return '已连上服务器';
  if (rt.mode === 'starting') return '正在连接';
  if (rt.mode === 'external') return '外部 frpc 在跑';
  return '未启动';
}
function renderConnectionSwitch() {
  const box = $('#conn-switch');
  if (!box) return;
  const list = connList();
  if (list.length <= 1) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const activeId = activeConnId();
  const active = list.find((c) => c.id === activeId) || list[0];
  const running = !!(active && active.runtime && active.runtime.connected);
  box.innerHTML = `
    <div class="cs-head">
      <span class="cs-dot ${running ? 'on' : ''}"></span>
      <span class="grow">隧道连接 · ${list.length}</span>
      <button class="icon-btn" type="button" data-act="conn.add" title="再加一条连接（连另一台 frps）">${icon('plus')}</button>
    </div>
    <select class="cs-select" id="conn-select" title="切换当前连接（会先停掉正在跑的隧道）">
      ${list.map((c) => `<option value="${esc(c.id)}"${c.id === activeId ? ' selected' : ''}>${esc(c.name || c.id)}${c.runtime && c.runtime.connected ? ' · 在线' : ''}</option>`).join('')}
    </select>
    <div class="cs-row">
      ${running
        ? `<button class="btn small danger" type="button" data-act="conn.toggle" data-id="${esc(activeId)}">${icon('stop')}<span>停止</span></button>`
        : `<button class="btn small primary" type="button" data-act="conn.toggle" data-id="${esc(activeId)}">${icon('play')}<span>启动</span></button>`}
      <button class="btn small" type="button" data-act="nav" data-view="proxies">${icon('link')}<span>代理</span></button>
    </div>`;
}

/* 概览里的「连接」卡片：多于一条时才有意义。 */
function connectionsSection() {
  const list = connList();
  if (list.length <= 1) return '';
  const activeId = activeConnId();
  const agg = (S.state && S.state.connectionsAgg) || {};
  const rows = list.map((c) => {
    const rt = c.runtime || {};
    const counts = c.counts || {};
    const isActive = c.id === activeId;
    return `
      <div class="conn-row${isActive ? ' active' : ''}">
        <span class="cs-dot ${rt.connected ? 'on' : (rt.mode === 'starting' ? 'warn' : '')}"></span>
        <div class="grow">
          <div class="cr-name">${esc(c.name || c.id)}${isActive ? ' <span class="tag ok">当前</span>' : ''}</div>
          <div class="cr-meta">${esc(connRuntimeLabel(c))} · 在线 ${esc(String(counts.online || 0))} / ${esc(String(counts.total || 0))}</div>
        </div>
        ${rt.connected
          ? `<button class="btn small danger" type="button" data-act="conn.toggle" data-id="${esc(c.id)}">${icon('stop')}<span>停止</span></button>`
          : `<button class="btn small primary" type="button" data-act="conn.toggle" data-id="${esc(c.id)}">${icon('play')}<span>启动</span></button>`}
        ${isActive
          ? ''
          : `<button class="btn small ghost" type="button" data-act="conn.switch" data-id="${esc(c.id)}" title="切换当前连接（会先停掉所有在跑的隧道；只想让两条同时跑就别切换，直接点左侧的启动）">设为当前</button>`}
      </div>`;
  }).join('');
  return `
    <section class="card section" style="margin-top:16px">
      <div class="section-head">
        <div class="section-title">
          <strong>隧道连接</strong>
          <span>${esc(String(agg.connections || list.length))} 条 · ${esc(String(agg.running || 0))} 条已连上 · 合计在线代理 ${esc(String(agg.online || 0))} / ${esc(String(agg.total || 0))}</span>
          <span class="field-hint" style="margin:0">每条连接一份 frpc.toml、各自一条隧道；想让两条同时在线就分别点「启动」，不需要来回切换。</span>
        </div>
        <button class="btn ghost small" type="button" data-act="conn.add">${icon('plus')}再连一台</button>
      </div>
      <div class="conn-list" style="padding:0 16px 16px">${rows}</div>
    </section>`;
}

/* 代理页顶部提醒：当前页只显示「当前连接」的代理。 */
function otherConnectionsNote() {
  const list = connList().filter((c) => c.id !== activeConnId());
  if (!list.length) return '';
  const running = list.filter((c) => c.runtime && c.runtime.connected);
  const detail = list
    .map((c) => `${esc(c.name || c.id)}（${c.runtime && c.runtime.connected ? `在线 ${esc(String((c.counts || {}).online || 0))}` : '未启动'}）`)
    .join('、');
  return `<div class="note">${icon('link')}<div>这一页只列出<b>当前连接</b>的代理；另有 ${list.length} 条连接（${detail}）${running.length ? '，它们的隧道仍在跑' : ''}。
    要管理别的连接，用左下角的连接切换器。</div></div>`;
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
  renderConnectionSwitch();
}

function setView(view, { force = false } = {}) {
  const changed = !S.view || S.view !== view;
  if (changed) {
    S.viewScroll[S.view] = $('#view') ? $('#view').scrollTop : 0;
    S.view = view;
    // 离开服务器页时终端 DOM 会被整页重写；后端会话保留，回来时 remount 恢复。
    $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    updateChrome();
  }
  renderCurrent({ force: true });
  /* 一进服务器页就跟主进程对一次连接状态：慢一点也没关系，
   * 但别让用户对着“未连接”的表单干等（自动连接被竞态吞掉时就是这样）。 */
  if (view === 'server') syncServerSession().catch(() => {});
  /* 进页面就把服务器侧的三份状态拉齐。以前 nginx / 防火墙 / 体检只在
   * 「连接表单点连接」这一条路径上加载，从托盘、自动连接、脚本进来的会话
   * 会看到「检测中…」「端口与连通（未知）」——数据就在服务器上，界面却说自己不知道。 */
  if (view === 'server' && S.server.connected) {
    if (!S.server.nginxReady) loadServerNginx(true).catch(() => {});
    if (!S.server.firewallReady) loadServerFirewall(true).catch(() => {});
    if (!S.server.nginxHealth) loadServerNginxHealth({ force: false }).catch(() => {});
  }
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
  else if (S.view === 'certs') renderCerts(force);
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
    // 隧道在跑但已无档案：这个提示的出现/消失必须触发重绘
    orph: s.binding && s.binding.unarchived ? `${s.binding.addr}:${s.binding.port}` : '',
    val: s.validation && s.validation.errors ? s.validation.errors.length : 0,
    // 服务器面板地址可能在连上服务器后被自动探测出来，变化时要重绘 hero 按钮
    durl: s.dashboardUrl || '',
    // 多连接：连接条数/名称/在线状态变了就要重绘（否则新增一条连接后概览不刷新）
    conn: (s.connections || []).map((c) => [c.id, c.name, !!(c.runtime && c.runtime.connected), (c.counts || {}).online || 0].join(':')).join('|'),
    connAct: s.activeConnectionId || '',
    // 管理 API 口令由弱变强（或反过来）时，概览那条提示要跟着出现/消失
    aw: s.app && s.app.adminWeak ? (s.app.adminWeak.weak ? 1 : 0) : 0,
    stale: s.runtime && s.runtime.staleConfig ? 1 : 0,
    proxies: (s.proxies || []).map((p) => [p.name, p.status, p.publicAddress, p.health && p.health.ok, p.health && p.health.reason, p.statusError]),
  });
}

/* 概览页“最近日志”卡片的最小刷新：只换日志区，不重建整页 */
function miniLogHtml() {
  const recent = S.logs.slice(-22).reverse();
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
  // 域名没解析/没指过来时别再说「公网不可达」：那句话会把人骗去查防火墙
  if (counts.dnsFailed) return `${counts.dnsFailed} 个域名没解析到服务器`;
  if (counts.unhealthyPublic) return `${counts.unhealthyPublic} 个公网不可达`;
  // start = [...] 里没列出来的代理：不是坏了，是被配置排除了
  if (counts.startExcluded) return `${counts.startExcluded} 个不在 start 列表里`;
  return '存在隧道或公网检查失败';
}

/* 隧道就绪进度链：把“frpc 起来 → 登录 frps → 代理注册 → 公网能访问”这四步
 * 画成一条链。小白不用懂 managed/pending/loggedIn 这些词，只看哪一步卡住。 */
function tunnelProgress(state) {
  const r = state.runtime || {};
  const counts = state.counts || {};
  const config = state.config || {};
  const hasProxies = counts.total > 0;
  const registered = (r.proxies || []).filter((p) => p.status === 'running').length;
  const frpcUp = !!(r.connected || r.mode === 'external' || r.mode === 'foreign');
  const loggedIn = !!r.loggedIn;
  const blocked = !!(r.loginFailed || r.connectFailed);

  const step1 = frpcUp ? 'done' : (config.serverAddr ? 'fail' : 'idle');
  const step2 = step1 !== 'done' ? 'idle' : (loggedIn ? 'done' : (blocked ? 'fail' : 'wait'));
  // 后续步骤是「级联」：前一步没到位，后面的还没轮到（不报红，免得把根因淹掉）。
  const step3 = step2 !== 'done' ? 'idle' : (!hasProxies ? 'na' : (registered > 0 ? 'done' : 'fail'));
  const step4 = step3 === 'na' ? 'na' : (step3 !== 'done' ? 'idle' : (counts.online > 0 ? 'done' : (counts.unhealthy > 0 ? 'fail' : 'wait')));

  return [
    { label: '本机 frpc', tip: 'frpc 是「客户端」程序，装在你电脑上，负责把本地服务连到服务器。', state: step1, text: frpcUp ? '运行中' : (config.serverAddr ? '未启动' : '还没配置') },
    { label: '连上服务器', tip: 'frpc 用服务器地址、端口和 Token 登录到 frps（服务器端程序）。', state: step2, text: loggedIn ? '已登录' : (blocked ? '未连上' : (frpcUp ? '连接中' : '—')) },
    { label: '代理已注册', tip: '你配置的每一条映射（如把本机 8080 暴露成公网端口）都已在服务器上登记。', state: step3, text: !hasProxies ? '暂无代理' : (step3 === 'idle' ? '—' : (registered > 0 ? `${registered} 条已注册` : '未注册')) },
    { label: '公网可访问', tip: '通过公网地址真正访问一次，确认「本地服务 → 隧道 → 公网」整条链路都通。', state: step4, text: !hasProxies ? '暂无代理' : (step4 === 'idle' ? '—' : (counts.online > 0 ? `在线 ${counts.online} 条` : '未通过')) },
  ];
}

function tunnelProgressHtml(state) {
  const glyph = { done: '✓', fail: '✗', wait: '…', idle: '·', na: '—' };
  return `<div class="tunnel-progress">${tunnelProgress(state).map((s, i) => `
    ${i ? '<span class="tp-arrow">→</span>' : ''}
    <span class="tp-step tp-${s.state}"><span class="tp-dot">${glyph[s.state]}</span><span class="tp-body"><span class="tp-label">${s.tip ? term(s.label, s.tip) : esc(s.label)}</span><small>${esc(s.text)}</small></span></span>
  `).join('')}</div>`;
}

/* 首跑欢迎引导：小白只有一台服务器账号密码，把它变成能用的隧道，一共三步。 */
function welcomeGuideHtml() {
  const step = (n, title, desc) => `
    <div class="wg-step">
      <span class="wg-num">${n}</span>
      <div class="wg-body"><strong>${esc(title)}</strong><span>${desc}</span></div>
    </div>`;
  return `<div class="note welcome-guide">${icon('shield')}<div>
      <strong>欢迎！三步把你的服务放到公网</strong>
      <div class="wg-steps">
        ${step(1, '连接服务器', '到「服务器」页填 IP 与 SSH 账号密码，连上后控制台会自动摸清服务器状态。')}
        ${step(2, '一键初始化 frps', '点「一键初始化并启动」，自动装 frps、写配置、启动服务、放行防火墙，再把地址和 Token 写回本机。')}
        ${step(3, '加代理、启动隧道', '去「代理映射」加一条穿透规则，回来点「启动隧道」，看上面进度链变绿即可。')}
      </div>
      <div style="margin-top:12px"><button class="btn primary" type="button" data-act="nav" data-view="server">${icon('server')}<span>开始配置</span></button></div>
    </div></div>`;
}

/* 隧道还在跑、但它连的服务器在本机已经没有档案了。
 *
 * 这时候三层检查是真的全绿（frpc 确实还在正常登录 frps），所以不能简单把状态改红
 * ——那是在说谎；但也不能继续报"一切正常"，因为控制台已经管不到这条隧道了。
 * 用一个警示条把事实说清楚，并给两个出口：重建档案 / 停掉隧道。 */
function orphanTunnelNote() {
  const b = (S.state && S.state.binding) || {};
  if (!b.unarchived) return '';
  /* 只在隧道真的还在跑的时候提示。停掉之后 frpc.toml 仍然指向老地址（我们从不擅自
   * 改用户配置），但那时候没有任何东西在对外提供服务，再挂一条警示只是噪音。 */
  const r = (S.state && S.state.runtime) || {};
  const running = !!r.connected || !!r.pending || r.mode === 'starting' || r.mode === 'external';
  if (!running) return '';
  const where = `${esc(b.addr || '—')}:${esc(b.port || '—')}`;
  // 档案还在、只是没绑到隧道上：说清楚绑一下就行，别吓唬人说“档案没了”。
  if (b.matchProfileName) {
    return `<div class="note warn" style="margin-bottom:14px">${icon('alert')}<div>
      <strong>本机隧道目标没有对应到任何连接</strong><br>
      <code>frpc.toml</code> 指向 <code>${where}</code>，本机有连接「${esc(b.matchProfileName)}」与它对应，只是没登记为「当前连接」。
      <div style="margin-top:10px"><button class="btn small" type="button" data-act="nav" data-view="server">${icon('server')}<span>去服务器页绑定</span></button></div>
    </div></div>`;
  }
  return `<div class="note warn" style="margin-bottom:14px">${icon('alert')}<div>
    <strong>隧道还在跑，但这条隧道已经不属于任何连接</strong><br>
    本机 <code>frpc.toml</code> 仍指向 <code>${where}</code>，这台服务器已经不在连接列表里了。隧道确实还能通，所以下面的状态不是误报——只是它已经不在控制台的记录里，出问题也没人帮你核对服务器侧。
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn small" type="button" data-act="nav" data-view="server">${icon('server')}<span>去服务器页新建连接</span></button>
      <button class="btn small" type="button" data-act="tunnel.stop">${icon('stop')}<span>停止隧道</span></button>
    </div>
  </div></div>`;
}

function renderOverview(force = false) {
  const key = overviewKey();
  if (!force && S.lastKeys.overview === key) return;
  S.lastKeys.overview = key;
  const state = S.state || {};
  const info = runtimeInfo();
  const counts = state.counts || { total: 0, online: 0, unhealthy: 0, unchecked: 0, unhealthyLocal: 0 };
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

  const addrList = proxies.filter((p) => p.publicAddress);
  const onlineCount = addrList.filter((p) => p.status === 'running' && p.health && p.health.ok).length;
  const addresses = addrList
    .map((p) => {
      const failed = p.health && !p.health.ok;
      const online = p.status === 'running' && p.health && p.health.ok;
      /* 有访问路径时，展示/复制/打开都用带上路径的链接——
       * 根路径常常是 404，用户点开只会看到 "404 page not found"。 */
      const link = p.openUrl || p.publicAddress;
      const soft = failed && (p.health.pathMissing || p.health.startExcluded);
      const dotColor = online ? 'var(--green)' : soft ? 'var(--amber)' : failed ? 'var(--red)' : 'var(--amber)';
      const dotTip = online ? '三层连通' : failed ? (p.health.reason || '链路异常') : '正在检测连通性';
      const canOpen = !!openableLink(link) && ['http', 'https', 'tcp', 'tcpmux'].includes(p.type);
      return `
        <div class="addr-row">
          <span class="ar-dot" title="${esc(dotTip)}" style="background:${dotColor}"></span>
          <div class="ar-main">
            <span class="ar-name">${esc(p.name)}</span>
            <span class="ar-addr" title="${esc(link)}">${esc(link)}</span>
          </div>
          <div class="ar-actions">
            <button class="icon-btn" type="button" data-act="copy" data-text="${esc(link)}" title="复制地址">${icon('copy')}</button>
            ${canOpen
              ? `<button class="icon-btn" type="button" data-act="open" data-url="${esc(link)}" title="在浏览器中打开">${icon('external')}</button>`
              : `<button class="icon-btn" type="button" data-act="probe.remote" data-host="${esc(config.serverAddr || '')}" data-port="${esc(p.remotePort || '')}" data-name="${esc(p.name)}" title="测试公网端口">${icon('activity')}</button>`}
          </div>
        </div>`;
    })
    .join('');

  const logLines = miniLogHtml();

  const issues = [];
  if (state.binding && state.binding.unarchived) issues.push(orphanTunnelNote());
  if (state.configError) issues.push(`<div class="note error">${icon('alert')}<div>${esc(state.configError)}</div></div>`);
  if (state.configVerifyError) issues.push(`<div class="note error">${icon('alert')}<div>${esc(state.configVerifyError)}<br><span style="opacity:.75">隧道仍在用上一次的配置运行；把 frpc.toml 改对后会自动重新载入。</span></div></div>`);
  if (info.foreign) {
    const port = (info.r && info.r.adminPort) || 7400;
    issues.push(`<div class="note error">${icon('alert')}<div><strong>管理端口 ${esc(port)} 上跑着另一个 frpc</strong><br>它连的服务器或代理名单跟这份配置对不上（多半是另一份配置、另一个控制台实例，或手工开的 frpc）。本配置的隧道没有在跑，这里也不能停它。<br><span style="opacity:.75">到「设置 → 运行模式与行为 → 客户端管理 API」换个端口，或先把那个 frpc 关掉。</span></div></div>`);
  }
  if (onlyMissingServer) {
    issues.push(welcomeGuideHtml());
  } else if (validationErrors.length) {
    issues.push(`<div class="note error">${icon('alert')}<div><strong>配置存在 ${validationErrors.length} 处错误</strong><br>${esc(validationErrors[0].message)}</div></div>`);
  }
  const runtime = state.runtime || {};
  /* 自动重连进行中：先说清楚“它自己在救自己”，别让人以为卡死了又要手点。
   * 慢速阶段（第 10 次之后）明说是每 5 分钟一次，用户才知道该等还是该查。 */
  const rc = runtime.reconnect || null;
  if (rc && (rc.state === 'waiting' || rc.state === 'running')) {
    const secs = Math.max(1, Math.round((rc.nextInMs || 0) / 1000));
    const head =
      rc.state === 'waiting'
        ? `隧道断了，正在自动重连：第 ${esc(String(rc.attempts))} 次，${esc(String(secs))} 秒后开始`
        : `正在重连（第 ${esc(String(rc.attempts))} 次）…`;
    const tail = rc.slowMode
      ? '已经重试 10 次仍没连上，现在改成每 5 分钟试一次。先看看下面的原因，改完会自动连上。'
      : '不用手动点，连上之后这条提示会自己消失。';
    issues.push(`<div class="note warn">${icon('refresh')}<div><strong>${head}</strong><br>${esc(tail)}${rc.reason ? `<br><span style="opacity:.75">上次断开的原因：${esc(rc.reason)}</span>` : ''}
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small" type="button" data-act="tunnel.start">${icon('play')}<span>立即重连</span></button>
        <button class="btn small" type="button" data-act="tunnel.stop">${icon('stop')}<span>停止重试</span></button>
      </div></div></div>`);
  }
  // 两种情况都算“没连上”：frpc 没起来 / 起来了但没登录上 frps / 日志里明确记着连不上。
  const offline = !!(runtime.loginFailed || runtime.connectFailed);
  // 隧道根本没连上时，代理“三层不通”只是结果。这时说清楚连不上谁、为什么，
  // 别让人去查本地服务（本地可能完全正常）。
  if (offline) {
    const target = config.serverAddr ? `${config.serverAddr}:${config.serverPort || 7000}` : '服务器';
    const why = {
      refused: `服务器上的 frps 没在 ${config.serverPort || 7000} 端口监听：服务没启动、端口改过，或被防火墙拒绝。`,
      unreachable: '连不到服务器端口：网络 / 安全组把它丢了，也可能本机的代理、VPN 在拦截。',
      firewall: '隧道连上了服务器端口，但数据被中间设备掐断——很可能是云厂商防火墙/安全组没放行这个端口（阿里云安全组、轻量服务器防火墙等），也可能服务器内的 ufw/firewalld 在拦。',
      auth: 'frps 在线，但 Token 校验没过：这条连接的 frpc.toml 里的 Token 与服务端 auth.token 不一致。',
      proxy: '本机到服务器的链路走了 HTTP 代理，请求被网关挡回 502/503。到「设置 → 运行模式与行为」打开“不继承系统代理”，或让代理放行该端口。',
      unconfirmed: 'frpc 进程起来了，但配置里的代理一个都没在服务器上注册成功，说明还没登录上 frps（端口不对、Token 不符或被网络挡了）。',
      unknown: '具体原因见概览下方的 frpc 日志。',
    }[runtime.connectKind] || '具体原因见概览下方的 frpc 日志。';
    const offlineAct = {
      auth: `<button class="btn small primary" type="button" data-act="nav" data-view="server">${icon('server')}<span>去服务器页同步 Token</span></button>`,
      refused: `<button class="btn small primary" type="button" data-act="nav" data-view="server">${icon('server')}<span>去服务器页检查 frps</span></button>`,
      unreachable: `<button class="btn small primary" type="button" data-act="nav" data-view="server">${icon('server')}<span>去服务器页检查端口</span></button>`,
      firewall: `<button class="btn small primary" type="button" data-act="nav" data-view="server">${icon('server')}<span>去服务器页放行端口</span></button>`,
      unconfirmed: `<button class="btn small primary" type="button" data-act="nav" data-view="server">${icon('server')}<span>去服务器页核对配置</span></button>`,
      proxy: `<button class="btn small primary" type="button" data-act="nav" data-view="settings">${icon('gear')}<span>打开设置关系统代理</span></button>`,
    }[runtime.connectKind] || `<button class="btn small" type="button" data-act="nav" data-view="logs">${icon('terminal')}<span>查看 frpc 日志</span></button>`;
    issues.push(`<div class="note error">${icon('alert')}<div><strong>隧道没连上 ${esc(target)}</strong><br>${esc(why)}${runtime.connectError ? `<br><span class="mono" style="font-size:11px;opacity:.75">${esc(runtime.connectError)}</span>` : ''}<br><span style="opacity:.75">本地服务（如 localhost:8080）通不通都不影响这一步——先把隧道连上，公网才会有转发。</span>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">${offlineAct}<button class="btn small" type="button" data-act="tunnel.restart">${icon('restart')}<span>重试连接</span></button></div>
    </div></div>`);
  } else if (counts.unhealthy > 0) {
    const parts = [];
    if (counts.unhealthyLocal) parts.push(`本地服务不通 ${counts.unhealthyLocal} 个`);
    if (counts.unhealthyTunnel) parts.push(`隧道未建立 ${counts.unhealthyTunnel} 个`);
    if (counts.dnsFailed) parts.push(`域名没解析到服务器 ${counts.dnsFailed} 个`);
    if (counts.unhealthyPublic) parts.push(`公网不可达 ${counts.unhealthyPublic} 个`);
    const detail = parts.length ? `（${parts.join('、')}）` : '';
    issues.push(`<div class="note warn">${icon('alert')}<div>有 ${counts.unhealthy} 个代理未通过三层连通性检查${detail}，公网访问会失败。
      <div style="margin-top:10px"><button class="btn small" type="button" data-act="nav" data-view="proxies">${icon('link')}<span>去代理映射看是哪条</span></button></div>
    </div></div>`);
  }
  /* 跑着的 frpc 不是用当前配置起的：最容易出现在「改了服务器地址但没重启」之后 */
  const staleNote = staleConfigNote();
  if (staleNote) issues.unshift(staleNote);

  /* 本机 frpc 管理 API 用默认口令：不提示的话没人会想起它 */
  const adminWeak = (state.app && state.app.adminWeak) || null;
  if (adminWeak && adminWeak.weak) {
    const adminPortShown = (state.settings && state.settings.adminPort) || 7400;
    issues.push(`<div class="note warn">${icon('alert')}<div>本机 frpc 的<b>管理 API</b>（${esc(String(adminPortShown))} 端口）<b>${esc((adminWeak.reasons || []).join('、'))}</b>。它只监听 127.0.0.1，但本机任何程序都能连上去读配置、改代理——顺手换一个随机口令更稳妥。
      <div style="margin-top:10px"><button class="btn small" type="button" data-act="admin.rotate">${icon('shield')}<span>生成随机口令</span></button></div>
    </div></div>`);
  }
  /* 路径 404 单独一条：隧道是通的，只是访问的路径在目标服务上不存在
   *（最常见：入口在 /panel/ 这类子路径）。混进「连通性异常」会把人拉去查安全组。 */
  if (counts.path404 > 0) {
    issues.push(`<div class="note warn">${icon('alert')}<div>有 ${counts.path404} 条代理公网返回 <b>404</b>：隧道和端口都通了，只是这个路径在目标服务上不存在（不少服务的根路径就是 404，入口在 <code>/panel/</code> 这类子路径）。
      <div style="margin-top:10px"><button class="btn small" type="button" data-act="nav" data-view="proxies">${icon('link')}<span>去代理映射填「访问路径」</span></button></div>
    </div></div>`);
  }

  /* 多条连接时，hero 必须点名「这是哪一条」，否则上面列着日本/广州、下面只说一个地址，认不出来。 */
  const connListNow = (S.state && S.state.connections) || [];
  const heroConn = connListNow.length > 1
    ? (connListNow.find((c) => c.id === S.state.activeConnectionId) || {}).name || ''
    : '';
  $('#view').innerHTML = `
    <div class="view">
      <section class="card hero">
        <div class="hero-main">
          <div class="hero-status">
            <div class="hero-orb ${info.tone === 'online' ? 'online' : info.tone === 'error' ? 'error' : 'warn'}">${icon(info.tone === 'online' ? 'shield' : info.starting ? 'clock' : 'alert')}</div>
            <div class="hero-titles">
              <h2>${esc(info.title)}</h2>
              <p>${heroConn ? `<span class="hero-conn">${esc(heroConn)}</span> · ` : ''}${esc(config.serverAddr ? `${config.serverAddr}:${config.serverPort}` : '尚未配置服务器')} · ${esc(info.desc)}</p>
            </div>
          </div>
          <div class="hero-actions">
            ${info.running
              ? `<button class="btn" type="button" data-act="tunnel.restart" title="重启 frpc（连不上服务器时先试这个）">${icon('restart')}<span>重启</span></button>
                 <button class="btn danger" type="button" data-act="tunnel.stop">${icon('stop')}<span>停止隧道</span></button>`
              : `<button class="btn primary" type="button" data-act="tunnel.start">${icon('play')}<span>启动隧道</span></button>`}
            <button class="btn" type="button" data-act="tunnel.reload" title="从磁盘重新载入代理配置，不断开连接">${icon('reload')}<span>热重载</span></button>
            ${dashboard ? `<button class="btn" type="button" data-act="open" data-url="${esc(dashboard)}" title="打开 frps 面板">${icon('globe')}<span>服务器面板</span></button>` : ''}
          </div>
          ${tunnelProgressHtml(state)}
        </div>
      </section>

      ${connectionsSection()}

      <section class="card section" style="margin-top:16px">
        <div class="section-head">
          <div class="section-title"><strong>公网地址</strong><span>${addrList.length ? (!info.online ? `隧道未运行，下面这些地址暂时打不开 · 共 ${addrList.length} 条` : `在线 ${onlineCount} / 共 ${addrList.length} 条 · 别人通过这些地址访问你的服务`) : '还没有公网映射'}</span></div>
          ${addrList.length ? `<button class="btn ghost small" type="button" data-act="nav" data-view="proxies">管理代理 ${icon('up')}</button>` : ''}
        </div>
        <div class="addr-list${addrList.length && !info.online ? ' paused' : ''}" style="padding:0 16px 16px">
          ${addresses || '<div class="muted" style="font-size:11.5px;padding:10px 2px">还没有可用的公网映射</div>'}
        </div>
      </section>

      <section class="metrics" style="margin-top:16px">
        <div class="card metric">
          <div class="metric-top"><span class="metric-label">代理总数</span><span class="metric-icon">${icon('link')}</span></div>
          <div class="metric-value">${esc(counts.total)}</div>
          <div class="metric-foot"><span>已配置的穿透规则</span></div>
        </div>
        <div class="card metric">
          <div class="metric-top"><span class="metric-label">${term('在线代理', '真正通过了「本地服务 → 隧道 → 公网」三层检测的映射；没测完的不算。')}</span><span class="metric-icon">${icon('activity')}</span></div>
          <div class="metric-value">${esc(counts.online)}<small> / ${esc(counts.total)}</small></div>
          <div class="metric-foot"><span class="${!config.serverAddr ? '' : (counts.online === counts.total && counts.total ? 'up' : counts.unchecked > 0 ? '' : 'down')}">${!config.serverAddr ? '配置服务器后自动检测' : !counts.total ? '暂无代理' : counts.online === counts.total ? '全部在线' : counts.unchecked > 0 && counts.unhealthy === 0 ? `${counts.unchecked} 条待检测` : `${counts.total - counts.online} 条未通过连通性检查`}</span></div>
        </div>
        <div class="card metric">
          <div class="metric-top"><span class="metric-label">${term('连通性异常', '三层（本地服务 → 隧道 → 公网）中至少一层没通的映射数；点击可看是哪条、哪一层。')}</span><span class="metric-icon">${icon('cpu')}</span></div>
          <div class="metric-value">${config.serverAddr ? esc((counts.unhealthy || 0) + (counts.path404 || 0)) : '—'}</div>
          <div class="metric-foot"><span class="${!config.serverAddr ? '' : (counts.unhealthy ? 'down' : (counts.path404 || counts.startExcluded ? 'down' : counts.unchecked > 0 ? '' : 'up'))}">${!config.serverAddr ? '尚未开始检测' : counts.unhealthy ? layerFailText(counts) : counts.path404 ? `${counts.path404} 条路径 404（隧道通，改访问路径即可）` : counts.startExcluded ? `${counts.startExcluded} 个被 start 列表排除（frpc 不会启动它们）` : counts.unchecked > 0 ? `${counts.unchecked} 条还没测完` : '全部代理三层全通（本地 → 隧道 → 公网）'}</span></div>
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
                ${detailRow('运行模式', modeLabel(info.r.mode))}
                ${detailRow('认证方式', `${config.auth && config.auth.method || 'token'}${config.auth && config.auth.token ? ' · 已设置' : ' · 未设置'}`, config.auth && config.auth.token ? 'ok' : 'bad')}
                ${detailRow('管理 API', info.r.adminPort ? `127.0.0.1:${info.r.adminPort}` : '未启用', info.r.connected ? 'ok' : 'bad')}
                ${detailRow('系统服务', info.service.installed ? `${info.service.name} · ${serviceStateText(info.service.state)}` : '未安装')}
                ${detailRow('进程 PID', info.r.pid || '—')}
                ${detailRow('运行时长', app.uptimeLabel || '—')}
                ${detailRow('frpc 版本', app.frpcVersion || '—')}
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
    // 隧道起停会决定「无档案」提示要不要出现，必须进 key，否则页面不重绘
    rc: (s.runtime && s.runtime.connected) ? 1 : 0,
    orph: s.binding && s.binding.unarchived ? `${s.binding.addr}:${s.binding.port}` : '',
    // 「另有 N 条连接」这行提示要跟着连接状态变，否则切了连接它还挂着
    conn: (s.connections || []).map((c) => [c.id, !!(c.runtime && c.runtime.connected)].join(':')).join('|') + (s.activeConnectionId || ''),
    /* 全量视图（1.2.190）：别的连接的代理变化也要触发重绘，所以 key 里带上
     * connectionId 与连接筛选。 */
    flt: S.proxyConnFilter || '',
    list: ((Array.isArray(s.proxiesAll) && s.proxiesAll.length ? s.proxiesAll : (s.proxies || []))).map((p) => [p.connectionId || '', p.name, p.type, p.status, p.statusError, p.publicAddress, p.localPort, p.health && p.health.ok, p.health && p.health.ms, p.health && p.health.reason]),
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
  /* 全量视图：主进程把每条连接的代理拍平后给 proxiesAll（1.2.190）。
   * 拿不到（老主进程/启动早期）时退回当前连接那一份，界面不至于空白。 */
  const all = Array.isArray(state.proxiesAll) && state.proxiesAll.length ? state.proxiesAll : (state.proxies || []);
  const connFilter = S.proxyConnFilter || '';
  const scoped = connFilter ? all.filter((p) => p.connectionId === connFilter) : all;
  const list = scoped.filter((p) => {
    if (!q) return true;
    const text = `${p.name} ${p.type} ${p.localPort} ${p.publicAddress} ${p.connectionName || ''}`.toLowerCase();
    return text.includes(q.toLowerCase());
  });

  const rows = list.map(proxyRowHtml).join('');
  const empty = !all.length;

  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>代理映射</h1>
          <p>把本机服务发布到公网。${all.length ? `${all.length ? `共 ${all.length} 条，${all.filter((p) => p.status === 'running').length} 条在线` : ''}${proxyConnCount() > 1 ? `（分布在 ${proxyConnCount()} 台服务器上）` : ''}。` : '还没有代理，先新增一条吧。'}</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" data-act="tunnel.reload">${icon('reload')}<span>热重载</span></button>
          <button class="btn primary" type="button" data-act="proxy.add">${icon('plus')}<span>新增代理</span></button>
        </div>
      </div>

      ${orphanTunnelNote()}
      ${state.configError ? `<div class="note error" style="margin-bottom:14px">${icon('alert')}<div>${esc(state.configError)}</div></div>` : ''}
      ${state.configVerifyError ? `<div class="note error" style="margin-bottom:14px">${icon('alert')}<div>${esc(state.configVerifyError)}<br><span style="opacity:.75">隧道仍在用上一次的配置运行；把 frpc.toml 改对后会自动重新载入。</span></div></div>` : ''}

      <section class="card table-card">
        <div class="toolbar">
          <div class="search">
            ${icon('search')}
            <input id="proxy-search" type="text" placeholder="搜索名称、本地端口或公网地址…" value="${esc(q)}" autocomplete="off" />
          </div>
          <span class="muted" style="font-size:11px">${esc(list.length)} 条结果</span>
        </div>
        ${proxyConnChips(all, connFilter)}
        ${empty
          ? `<div class="empty" style="padding:44px 20px">
              <div class="empty-illustration">${icon('link')}</div>
              <strong>还没有代理映射</strong>
              <p>点击右上角“新增代理”，把本机运行的 Web 服务、远程桌面或其他端口发布到公网。</p>
              <button class="btn primary" type="button" data-act="proxy.add">${icon('plus')}<span>新增代理</span></button>
            </div>`
          : `<table class="proxy-table">
              <thead><tr>
                <th>名称 / 类型</th><th>服务器</th><th>本地服务</th><th>公网地址</th><th>状态</th><th style="text-align:right">操作</th>
              </tr></thead>
              <tbody>${rows || `<tr><td colspan="6"><div class="empty" style="padding:26px"><p>没有匹配「${esc(q)}」的代理</p></div></td></tr>`}</tbody>
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

/* 通配符域名（*.x.com）只是给 frps 做匹配用的，浏览器打不开这种地址——
 * 别给「打开」按钮，否则点了必然白屏/报错。 */
function openableLink(link) {
  const text = String(link || '');
  if (!text || text.includes('*')) return '';
  /* 只有 http(s) 才谈得上「打开」：tcpmux 的地址是 http-connect://域名，
   * 交给浏览器只会弹一个没反应的标签页。复制按钮不受影响。 */
  return /^https?:\/\//i.test(text) ? text : '';
}

/* 顶部「服务器」筛选条：全部 + 每条连接（带条数）。只有一条连接时不显示，
 * 免得给单服务器用户增加一排没用的按钮。 */
function proxyConnCount() {
  const all = (S.state && Array.isArray(S.state.proxiesAll)) ? S.state.proxiesAll : null;
  if (!all) return 1;
  const ids = new Set(all.map((p) => p.connectionId || ''));
  return ids.size || 1;
}

function proxyConnChips(all, current) {
  const map = new Map();
  for (const p of all) {
    const id = p.connectionId || '';
    if (!map.has(id)) map.set(id, { id, name: p.connectionName || '' , count: 0 });
    map.get(id).count += 1;
  }
  if (map.size <= 1) return '';
  const chip = (id, label, count) => `<button class="chip${id === current ? ' on' : ''}" type="button" data-act="proxy.filter.conn" data-conn="${esc(id)}">${esc(label)}<span class="chip-count">${count}</span></button>`;
  const parts = [chip('', '全部', all.length)];
  for (const item of map.values()) parts.push(chip(item.id, item.name || '未命名连接', item.count));
  return `<div class="chips">${parts.join('')}</div>`;
}

/* 行内的服务器单元格：名字 + 地址，非当前连接标一个淡一点的徽标（那些代理
 * 的健康检查、编辑都发生在它们自己的连接里）。 */
function proxyConnCell(p) {
  const name = p.connectionName || '';
  if (!name) return '<span class="muted">—</span>';
  const addr = p.connectionAddr ? `<div class="muted mono" style="font-size:10.5px">${esc(p.connectionAddr)}</div>` : '';
  const tag = p.connectionActive ? '' : '<span class="badge muted" style="font-size:9.5px;padding:1px 6px">非当前</span>';
  return `<div><span class="conn-name">${esc(name)}</span> ${tag}</div>${addr}`;
}

function proxyRowHtml(p) {
  const failed = p.health && !p.health.ok;
  /* 路径 404：隧道与端口都通，只是路径不对 —— 用橙色，别和「断链」混成一片红。 */
  const pathMissing = !!(failed && p.health.pathMissing);
  /* 被 frpc.toml 里的 start = [...] 排除：既不是网络也不是本地服务的问题，
   * 是这份配置压根没让它启动，同样用橙色。这个事实来自配置（p.startExcluded），
   * 不依赖健康检查有没有跑过 —— 隧道停着的时候也要说清楚。 */
  const startSkipped = !!p.startExcluded;
  const softFail = pathMissing || startSkipped;
  const tip = healthTip(p.health);
  const status = startSkipped
    /* frpc 根本不会启动它：不给「未同步」这种含糊状态，直接说是配置里的 start 名单排除了 */
    ? `<span class="badge amber" title="${esc(tip)}"><span class="bdot"></span>不在 start 列表</span>`
    : p.status === 'running'
    ? (failed
      ? `<span class="badge ${softFail ? 'amber' : 'red'}" title="${esc(tip)}"><span class="bdot"></span>${esc(p.health.reason || '链路异常')}</span>`
      : '<span class="badge green"><span class="bdot"></span>在线</span>')
    : p.status === 'pending'
      ? '<span class="badge amber"><span class="bdot"></span>同步中</span>'
      : p.status === 'start error'
        ? `<span class="badge red" title="${esc(tip)}"><span class="bdot"></span>${esc((p.health && p.health.reason) || '启动失败')}</span>`
        : '<span class="badge muted"><span class="bdot"></span>未同步</span>';
  const health = p.health
    ? (p.health.ok
      ? `<span class="health-hint" title="${esc(tip)}">${icon('check')}三层连通 · ${esc(p.health.ms)}ms</span>`
      : `<span class="health-hint ${softFail ? '' : 'bad'}" title="${esc(tip)}">${icon('alert')}${esc(p.health.reason || p.health.error || '链路异常')}</span>`)
    : startSkipped
      ? `<span class="health-hint" title="frpc.toml 里有 start 列表，这条代理不在名单里">${icon('alert')}不在 start 列表里（frpc 不会启动它）</span>`
      : '';
  // DNS 软检查：不参与三层判定，只给 http/https 代理一个「域名没解析/没指向服务器」的提醒。
  const dnsLayer = p.health && p.health.layers && p.health.layers.dns;
  let dnsHint = '';
  if (dnsLayer && !dnsLayer.skipped) {
    if (!dnsLayer.ok) {
      dnsHint = `<span class="health-hint" title="${esc(dnsLayer.error || '域名未解析')}">${icon('alert')}域名未解析</span>`;
    } else if (!dnsLayer.pointsToServer) {
      dnsHint = `<span class="health-hint" title="域名已解析，但未指向当前服务器">${icon('alert')}域名未指向服务器</span>`;
    }
  }
  /* 带访问路径的链接（例如 http://1.2.3.4:45446/panel/）：展示、复制、打开都用它。 */
  const link = p.openUrl || p.publicAddress;
  const publicCell = link
    ? `<div class="pub-cell">
        <code title="${esc(link)}">${esc(link)}</code>
        ${p.openPath ? `<div class="muted" style="font-size:10px">访问路径 ${esc(p.openPath)}</div>` : ''}
        <div class="muted" style="font-size:10px">${esc(p.runtimeRemote || '')}${p.runtimeRemote && p.runtimeLocal ? ' · ' : ''}${esc(p.runtimeLocal || '')}</div>
      </div>`
    : '<span class="muted" style="font-size:11.5px">未分配</span>';
  return `
    <tr>
      <td>
        <div class="name-cell">
          <strong title="${esc(p.name)}">${esc(p.name)}</strong>
          <small><span class="badge ${esc(p.type)}" style="font-size:9.5px;padding:1px 6px">${esc(TYPE_LABEL[p.type] || p.type)}</span></small>
        </div>
      </td>
      <td>
        ${proxyConnCell(p)}
      </td>
      <td>
        <div class="mono">${esc(p.localIP || '127.0.0.1')}:${esc(p.localPort)}</div>
        ${health}
        ${dnsHint}
        ${p.statusError ? `<div class="health-hint bad">${icon('alert')}${esc(p.statusError)}</div>` : ''}
      </td>
      <td>${publicCell}</td>
      <td>${status}</td>
      <td>
        <div class="trow-actions">
          <button class="icon-btn" type="button" data-act="proxy.test-local" data-name="${esc(p.name)}" data-port="${esc(p.localPort)}" title="测试本机端口">${icon('activity')}</button>
          ${link ? `<button class="icon-btn" type="button" data-act="copy" data-text="${esc(link)}" title="复制公网地址">${icon('copy')}</button>` : ''}
          ${openableLink(link) && ['http', 'https', 'tcp', 'tcpmux'].includes(p.type)
            ? `<button class="icon-btn" type="button" data-act="open" data-url="${esc(openableLink(link))}" title="打开公网地址">${icon('external')}</button>` : ''}
          <button class="icon-btn" type="button" data-act="proxy.edit" data-name="${esc(p.name)}" data-conn="${esc(p.connectionId || '')}" title="编辑">${icon('edit')}</button>
          <button class="icon-btn danger" type="button" data-act="proxy.delete" data-name="${esc(p.name)}" data-conn="${esc(p.connectionId || '')}" title="删除">${icon('trash')}</button>
        </div>
      </td>
    </tr>`;
}

/* ---------------------------- 服务发现 ---------------------------- */

function renderDiscovery(force = false) {
  if (!force && S.lastKeys.discovery === 'rendered') return;
  S.lastKeys.discovery = 'rendered';
  const listeners = S.listeners || [];
  const scopeFilter = S.discoveryScope || '';
  const visible = scopeFilter ? listeners.filter((l) => (l.scopes || (l.loopbackOnly ? ['loopback'] : [])).includes(scopeFilter)) : listeners;
  const scopeCounts = { loopback: 0, all: 0, docker: 0, lan: 0, public: 0, other: 0 };
  listeners.forEach((l) => {
    const scopes = l.scopes || (l.loopbackOnly ? ['loopback'] : []);
    scopes.forEach((s) => { if (scopeCounts[s] !== undefined) scopeCounts[s] += 1; });
  });

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
          <span class="muted" style="font-size:11px">${listeners.length ? `${visible.length} / ${listeners.length} 个 TCP 监听` : '尚未扫描'}</span>
        </div>
        ${listeners.length
          ? `<div class="seg" id="discovery-scope" style="margin:0 16px 12px">
              ${[['', '全部'], ['loopback', '回环'], ['all', '全网'], ['docker', 'Docker'], ['lan', '内网'], ['public', '公网']].map(([key, label]) => `<button type="button" data-act="listeners.scope" data-scope="${key}" class="${scopeFilter === key ? 'active' : ''}">${label}${key ? ` ${scopeCounts[key] || 0}` : ''}</button>`).join('')}
            </div>`
          : ''}
        ${S.listenersError && listeners.length ? `<div class="note warn" style="margin:0 16px 12px">${icon('alert')}<div>有一部分端口的进程名读不出来：${esc(S.listenersError)}</div></div>` : ''}
        ${S.listenersBusy && !listeners.length
          ? `<div class="empty" style="padding:34px 20px"><span class="spinner-sm"></span><p style="margin-top:10px">正在扫描本机端口…</p></div>`
          : visible.length
            ? `<table class="listener-table">
                <thead><tr><th>端口</th><th>监听地址</th><th>进程</th><th>PID</th><th style="text-align:right">操作</th></tr></thead>
                <tbody>${visible.slice(0, 200).map(listenerRow).join('')}</tbody>
              </table>`
            : `<div class="empty" style="padding:30px 20px"><p>${listeners.length ? '这个分类下没有监听端口。' : '还没有扫描结果，点击右上角“扫描本机端口”。'}</p></div>`}
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
  const scopes = l.scopes && l.scopes.length ? l.scopes : (l.loopbackOnly ? ['loopback'] : ['other']);
  const scopeTitle = { loopback: '只监听 127.0.0.1 / ::1，只有本机能访问', all: '监听所有网卡（0.0.0.0 / ::），局域网内都能访问', docker: 'Docker 网桥段，通常是容器网络', lan: '内网地址（192.168 / 10.x 等），局域网内可访问', public: '公网地址，若防火墙放行则全网可访问', other: '无法归类' };
  const badges = scopes.slice(0, 3).map((s) => `<span class="badge scope-${esc(s)}" title="${esc(scopeTitle[s] || '')}">${esc(SCOPE_LABEL[s] || s)}</span>`).join('');
  const fullTitle = (l.hosts ? l.hosts.join(', ') : '') + (scopes.length ? ` · ${scopes.map((s) => SCOPE_LABEL[s] || s).join(' / ')}` : '');
  return `<tr>
    <td class="port-cell">${esc(l.port)}${l.risk ? ` <span class="badge ${l.risk.level === 'danger' ? 'bad' : 'amber'}" title="${l.risk.level === 'danger' ? '这类端口直接发布到公网风险很高：要么本身没有认证，要么一旦被爆破就是整台机器' : '这个端口的协议不加密（或就是登录入口），发布到公网请确认你真的需要'}">${esc(l.risk.label)}</span>` : ''}</td>
    <td class="addr-cell" title="${esc(fullTitle)}">${badges} ${esc(l.hosts ? l.hosts[0] : '')}${l.hosts && l.hosts.length > 1 ? ` +${l.hosts.length - 1}` : ''}</td>
    <td class="proc-cell" title="${esc(l.process || '权限不足时读不到进程名：以管理员身份运行能看到全部，或按 PID 在任务管理器里对照')}">${esc(l.process || '未知（权限）')}</td>
    <td class="addr-cell">${esc(l.pid)}</td>
    <td style="text-align:right"><button class="btn small" type="button" data-act="listener.publish" data-port="${esc(l.port)}" data-process="${esc(l.process)}"
            data-risk="${esc(l.risk ? l.risk.level : '')}" data-risklabel="${esc(l.risk ? l.risk.label : '')}">添加代理</button></td>
  </tr>`;
}

/* ----------------------------- 日志 ------------------------------ */

function logLineHtml(l) {
  const level = String(l.level || 'info').toLowerCase();
  const lv = { error: 'ERR', warn: 'WRN', info: 'INF', debug: 'DBG', trace: 'TRC' }[level] || level.toUpperCase().slice(0, 3);
  return `<div class="log-line ${esc(level)}">
    <span class="lt">${esc(l.time || fmtTime(l.ts))}</span>
    <span class="lv">${esc(lv)}</span>
    <span class="ltx" title="${esc(l.text)}">${esc(l.text)}</span>
  </div>`;
}

/* 日志从哪来：frpc 的 log.to 决定它写文件还是写标准输出。
 * 设成 "console" 时文件里不会有新内容，早点说清楚，免得以为日志页冻住了。 */
function logsSourceLine() {
  const cfg = (S.state && S.state.config) || {};
  const raw = cfg.log && cfg.log.to;
  const list = Array.isArray(raw) ? raw.map((v) => String(v)) : raw ? [String(raw)] : [];
  const toFile = list.some((v) => v && v !== 'console');
  if (!toFile) return 'frpc 把日志写到控制台（log.to = console）：下面显示的是进程输出。';
  return 'frpc 会持续写入日志文件，控制台实时跟随。';
}

function filteredLogs() {
  if (!S.logLevel) return S.logs;
  return S.logs.filter((l) => String(l.level || '').toLowerCase() === S.logLevel);
}

/* 日志来源切换：本机 frpc（文件/进程输出）与服务器 frps（SSH + journalctl）。
 * 两者都是日志，放在同一页更符合直觉，也省得在服务器页里再开一块。 */
function logSourceSeg() {
  const connected = !!S.server.connected;
  const host = connected ? String(S.server.host || '') : '';
  const connName = (activeConnectionInfo() || {}).name || '';
  const serverLabel = connected ? `服务器 frps${host ? ` · ${esc(host)}` : ''}${connName ? `（${esc(connName)}）` : ''}` : '服务器 frps（未连接）';
  return `<div class="seg log-src-seg">
    <button type="button" data-act="logs.source" data-source="local" class="${S.logSource === 'local' ? 'active' : ''}">本机 frpc</button>
    <button type="button" data-act="logs.source" data-source="server" class="${S.logSource === 'server' ? 'active' : ''}${connected ? '' : ' is-off'}"${connected ? '' : ' title="先连上服务器才能读它的 frps 日志"'}>${serverLabel}</button>
  </div>`;
}

function renderServerLogsView() {
  const connected = !!S.server.connected;
  const host = String(S.server.host || '');
  const source = S.server.logsSource || 'journalctl -u frps';
  const parsed = S.server.logs ? parseServerLogs(S.server.logs) : { items: [], stats: { start: '', logins: 0, errors: 0 } };
  const total = parsed.items.length;
  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>实时日志</h1>
          <p>${connected ? `${esc(host)} · ${esc(source)} · 最近 ${total} 行` : '还没有连上服务器：连上之后这里直接读 frps 的日志。'}</p>
        </div>
        <div class="page-actions">
          ${logSourceSeg()}
          ${connected ? `<button class="btn" type="button" data-act="logs.server.refresh">${icon('reload')}<span>刷新</span></button>` : ''}
        </div>
      </div>

      <section class="card log-panel">
        <div class="log-head">
          <div class="log-dots"><i></i><i></i><i></i></div>
          <span class="lh-title" title="${esc(source)}">${esc(connected ? `frps · ${host}` : 'frps 日志')}</span>
          <div class="lh-right">
            ${connected ? `<button class="btn ghost small" type="button" data-act="logs.server.errors">${icon('alert')}<span>${S.server.logErrorsOnly ? '显示全部' : '只看错误'}</span></button>
              <button class="btn ghost small" type="button" data-act="logs.server.expand">${icon('download')}<span>${S.server.logExpanded ? '收起' : '展开全部'}</span></button>` : ''}
            <span>${connected ? `共 ${total} 行` : '未连接'}</span>
          </div>
        </div>
        ${connected ? serverLogsMarkup() : `<div class="log-empty"><span>还没有连上服务器</span><p class="muted">到「服务器」页连上之后，这里会显示 journalctl -u frps 的内容。</p><div style="margin-top:10px"><button class="btn" type="button" data-act="goto.server">${icon('external')}<span>去服务器页</span></button></div></div>`}
      </section>
    </div>`;
  /* 刚连上（或连上后界面还没跟上）时，这里先把连接状态对齐再拉日志：
   * 否则用户会看到「还没有连上服务器」，其实主进程那头已经连着。 */
  if (!connected) { syncServerSession().catch(() => {}); return; }
  /* 空日志自动拉取：带 3 秒节流，失败过也会再试（不然一个陈旧的 logsError 就能让它永远不重试）。 */
  if (!S.server.logs && Date.now() - Number(S.server.logsAutoAt || 0) > 3000) {
    S.server.logsAutoAt = Date.now();
    loadServerLogs().catch(() => {});
  }
}

function renderLogs(force = false) {
  if (!force && S.lastKeys.logs === 'rendered') return;
  S.lastKeys.logs = 'rendered';
  if (S.logSource === 'server') { renderServerLogsView(); return; }
  const lines = filteredLogs();
  const pathText = (S.state && S.state.paths && S.state.paths.logPath) || '';
  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>实时日志</h1>
          <p>${logsSourceLine()}共缓存 ${S.logs.length} 条。</p>
        </div>
        <div class="page-actions">
          ${logSourceSeg()}
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
  /* 序号过期只说明「有更新的请求在飞」，不代表这份数据是错的。但连接状态是硬事实：
   * 一旦丢弃，界面会停在与主进程相反的那一侧，且没有任何东西会主动纠正它
   * （实测：自动连接重试期间 serverSeq 被反复推高，界面会永久显示「未连接」）。 */
  if (seq !== undefined && serverSeqStale(seq) && !!data.connected === !!S.server.connected) return false;
  S.server.loaded = true;
  const wasConnected = !!S.server.connected;
  S.server.connected = !!data.connected;
  // 从「断开」变「已连接」（或换了服务器）时，上一次的日志读取错误不该继续挂着。
  if (S.server.connected && (!wasConnected || S.server.sessionServerId !== (data.sessionServerId || data.serverId || ''))) {
    S.server.logsError = '';
    S.server.logs = S.server.logs || '';
    S.server.logsAutoAt = 0;
  }
  /* 断开之后不要再让「服务器 frps · <host>」继续高亮：正文已经是空的、页头却写着未连接，
   * 两处对不上。这里直接切回本机来源，并提示一句。 */
  if (wasConnected && !S.server.connected && S.logSource === 'server') {
    S.logSource = 'local';
    S.lastKeys.logs = '';
    if (S.view === 'logs') renderLogs(true);
    toast('info', '已切回本机日志', '服务器连接断开了，服务器上的 frps 日志读不到。');
  }
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
  S.server.epoch = Number(data.epoch) || 0;
  S.server.client = data.client || null;
  if (data.summary && !S.server.wizardDirty) {
    S.server.wizard = wizardFromSummary(data.summary);
  } else if (!data.summary && !S.server.wizard && !S.server.wizardDirty) {
    /* 服务器上还没有 frps.toml：向导直接沿用档案里那把已经自动生成的 Token。
     * 这样「一键初始化」写进服务端的 token 和本机 frpc.toml 的 token 一开始就是
     * 同一个值，用户完全不需要关心它。 */
    const activeProfile = (S.server.profiles || []).find((p) => p.id === S.server.activeServerId);
    S.server.wizard = {
      ...wizardDefaults(),
      token: (activeProfile && (activeProfile.clientToken || activeProfile.token)) || randomToken(20),
      webPassword: randomToken(14),
    };
  }
  return true;
}

async function loadServerState({ autoConnect = false } = {}) {
  const seq = serverSeq();
  const res = await FRP.serverState();
  if (serverSeqStale(seq)) {
    /* 同 applyServerState：连接状态与界面相反时不能丢，否则界面会一直停在错误状态。 */
    const flips = !!(res && res.ok && res.data && !!res.data.connected !== !!S.server.connected);
    if (!flips) return;
  }
  if (res && res.ok) {
    applyServerState(res.data, seq);
    if (S.view === 'server') renderServer(true);
    if (S.server.connected) {
      loadServerNginx(true).catch(() => {});
    loadServerNginxHealth({ force: false }).catch(() => {});
      loadServerFirewall(true).catch(() => {});
    }
    // 只在“第一次打开服务器页”时自动连；绑定变化之类的刷新不打扰已断开的会话。
    if (autoConnect) autoConnectActiveProfile().catch(() => {});
  } else if (res && !res.ok) toastResult(res);
}

/* 界面上的「连接状态」是主进程 SSH 会话的一个投影，但两边可能短暂不一致：
 * 比如自动连接成功的那一刻，另一次状态刷新把 serverSeq 抢走了，成功结果被丢弃，
 * 界面就永远停在「未连接」，用户只能切一次档案才好。
 * 这里做一次轻量对齐：只要 connected / 会话序号 / 所属档案 与主进程不一致就重新应用。 */
async function syncServerSession() {
  if (!S.server.loaded) return;
  if (S.server.autoConnecting || S.server.switching || S.server.connecting) return;
  const res = await FRP.serverState().catch(() => null);
  if (!res || !res.ok || !res.data) return;
  const d = res.data;
  refreshServerInfo().catch(() => {});
  const epochChanged = d.epoch !== undefined && Number(d.epoch) !== Number(S.server.epoch || 0);
  const connChanged = !!d.connected !== !!S.server.connected;
  const ownerChanged = !!d.connected && (d.sessionServerId || '') !== (S.server.sessionServerId || '');
  if (!epochChanged && !connChanged && !ownerChanged) return;
  applyServerState(d, serverSeq());
  if (S.view === 'server') renderServer(true);
  if (S.view === 'logs' && S.logSource === 'server') renderLogs(true);
  if (S.server.connected) {
    loadServerLogs().catch(() => {});
    loadServerNginx(true).catch(() => {});
    loadServerNginxHealth({ force: false }).catch(() => {});
    loadServerFirewall(true).catch(() => {});
  }
}

/* 服务器信息（hostname / OS / frps 状态与版本）以前只在「连上那一刻」抓过一次，
 * 之后 frps 被停掉、被升级、frps.toml 被手改，卡片都还拿旧快照说话——真机故障注入时
 * 出现过「自检写 frps 没有运行、运行状态卡还绿着 running」。这里按 30 秒节流重新抓。 */
async function refreshServerInfo(force = false) {
  if (!S.server.connected || S.server.rechecking) return;
  const now = Date.now();
  if (!force && now - (S.server.infoAt || 0) < 30000) return;
  S.server.rechecking = true;
  try {
    const res = await FRP.serverRecheck();
    if (!res || !res.ok || !res.data) return;
    const next = res.data.info || null;
    if (!next) return;
    const prev = S.server.info || {};
    S.server.infoAt = Date.now();
    S.server.info = next;
    /* 只有「状态 / 版本 / 服务名」真的变了才整块重绘，避免把用户正在编辑的 textarea 打断。 */
    const changed = prev.status !== next.status || prev.version !== next.version || prev.serviceName !== next.serviceName;
    /* 服务器上的 frps.toml 被外部改过：主进程已经重读了配置，这里把新的摘要拉回来，
     * 否则「配置文件」卡片里还是连接时那份旧内容。 */
    if (res.data.drifted) {
      const snap = await FRP.serverState();
      if (snap && snap.ok && snap.data) {
        applyServerState(snap.data, serverSeq());
        if (S.view === 'server') renderServer(true);
        return;
      }
    }
    if (changed && S.view === 'server') renderServer(true);
  } finally {
    S.server.rechecking = false;
  }
}

async function loadServerNginx(silent = false) {
  if (!S.server.connected) return;
  if (!silent) S.server.nginx = { ...(S.server.nginx || {}), loading: true };
  if (S.view === 'server') renderServer(true);
  let res = null;
  try {
    res = await FRP.serverNginxState();
  } catch (e) {
    res = { ok: false, error: '读取 nginx 状态失败：' + String((e && e.message) || e) };
  }
  S.server.nginxReady = true;
  if (res && res.ok) {
    S.server.nginx = { ...(S.server.nginx || {}), ...res.data, loading: false };
  } else {
    S.server.nginx = { ...(S.server.nginx || {}), loading: false, error: (res && res.error) || '检测 nginx 失败' };
  }
  if (S.view === 'server') renderServer(true);
}

/* 配置体检（1.2.72）：nginx -t + 所有 ssl_certificate 指向的文件是否还在。
 * 这条链路能抓到「配置还在指、证书已经没了」——nginx 平时靠旧 worker 撑着看不出，
 * 一旦 reload/重启就整站起不来，属于必须提前暴露的故障。 */
async function loadServerNginxHealth({ force = false, silent = true } = {}) {
  if (!S.server.connected) return;
  if (S.server.nginxHealthBusy) return;
  S.server.nginxHealthBusy = true;
  try {
    const res = await FRP.serverNginxHealth({ force });
    if (res && res.ok) S.server.nginxHealth = { ...res.data, error: '' };
    else if (res && !res.ok) S.server.nginxHealth = { error: res.error || '配置体检失败' };
  } catch (e) {
    S.server.nginxHealth = { error: String((e && e.message) || e) };
  } finally {
    S.server.nginxHealthBusy = false;
  }
  if (S.view === 'server') renderServer(true);
}
async function loadServerFirewall(silent = false) {
  if (!S.server.connected) return;
  if (!silent) S.server.firewall = { ...(S.server.firewall || {}), loading: true };
  if (S.view === 'server') renderServer(true);
  const res = await FRP.serverFirewallState();
  S.server.firewallReady = true;
  if (res && res.ok) {
    S.server.firewall = { ...(S.server.firewall || {}), ...res.data, loading: false };
  } else {
    S.server.firewall = { ...(S.server.firewall || {}), loading: false, error: (res && res.error) || '检测防火墙失败' };
  }
  if (S.view === 'server') renderServer(true);
}

/* 一键配置反代的主流程：遇端口冲突弹窗让用户决定，kill 后递归重跑。 */
async function runNginxSetup() {
  const res = await FRP.serverNginxSetup();
  if (!res || !res.ok) { toastResult(res); return; }
  if (res.data && res.data.conflict) {
    const choice = await confirmNginxPortConflict(res.data.conflicts || []);
    if (choice !== 'kill') { await loadServerNginx(true); return; }
    const freed = await FRP.serverNginxFree();
    if (!freed || !freed.ok) { toastResult(freed); return; }
    const after = freed.data && freed.data.after;
    if (after && (after.port80Conflict || after.port443Conflict)) {
      toast('error', '端口仍未释放', '终止后 80/443 仍被占用，请手动检查服务器上的服务再重试。');
      await loadServerNginx(true);
      return;
    }
    return runNginxSetup();
  }
  if (res.data && res.data.certMissing) {
    toast('warn', '还差一张证书', res.data.message || '请先到「HTTPS 证书」页签发证书');
  } else {
    const vhostNote = res.data && res.data.vhost && res.data.vhost.changed
      ? `（顺带给 frps 开了 vhostHTTPPort ${res.data.frpsHttpPort} 并重启）`
      : '';
    toast('success', '反代已配置', res.data && res.data.serverNames ? `${res.data.serverNames} → nginx 80/443 → frps ${res.data.frpsHttpPort}${vhostNote}` : 'nginx 反代已就绪');
  }
  S.server.nginx = { ...(S.server.nginx || {}), ...(res.data || {}), ok: !!(res.data && res.data.ok) };
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
  if (!S.server.connected || S.server.logsLoading) return;
  const serverId = S.server.sessionServerId;
  S.server.logsLoading = true;
  try {
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
  } finally {
    S.server.logsLoading = false;
    renderServerLogs();
  }
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

/* 服务器 frps 与本机 frpc 的版本关系：frp 要求主版本一致；次版本不同一般能连，但服务器不认的字段会被忽略。 */
function versionParts(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

function versionMismatchMarkup(info) {
  const serverVer = info && info.version && info.version !== 'unknown' ? String(info.version).trim() : '';
  const clientVer = (S.state && S.state.app && S.state.app.frpcVersion) || '';
  if (!serverVer || !clientVer) return '';
  const sv = versionParts(serverVer);
  const cv = versionParts(clientVer);
  if (!sv || !cv) return '';
  /* frp 目前全是 0.x，主版本恒为 0，兼容性其实由次版本决定：0.52 与 0.61 差 9 个次版本。 */
  const farApart = Math.abs(sv.minor - cv.minor) >= 2;
  if (sv.major !== cv.major || farApart) {
    return `<div class="note bad">${icon('alert')}<div><strong>服务器 frps ${esc(serverVer)} 与本机 frpc ${esc(clientVer)} 主版本不一致</strong><br>frp 要求客户端与服务端主版本相同，这条隧道很可能连不上（或者连上了也用不了）。在服务器上换成同版本 frps，或用「从零初始化」重装。</div></div>`;
  }
  if (sv.minor !== cv.minor) {
    return `<div class="note warn">${icon('alert')}<div><strong>服务器 frps ${esc(serverVer)} 与本机 frpc ${esc(clientVer)} 次版本不同</strong><br>通常还能连，但服务器不认的新字段会被忽略或让 frpc 报错；遇到莫名其妙的问题时先把两边版本对齐。</div></div>`;
  }
  return '';
}

function metricCard(label, value, sub = '', cls = '') {
  return `<div class="srv-metric ${cls}"><span>${esc(label)}</span><strong>${esc(value)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}

function selftestStepMarkup(steps, key, index, title, hint) {
  const step = (steps && steps[key]) || { state: 'idle' };
  const state = step.state || 'idle';
  const iconText = state === 'ok' && step.warn ? '!' : { idle: '○', running: '…', ok: '✓', fail: '✕', skipped: '—' }[state] || '○';
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
  /* 有「提醒级」结果（例如 frps 在跑但没设开机自启）时，徽标不再是纯绿，避免看着比实际更稳。 */
  const anyWarn = SELFTEST_LAYERS.some((k) => steps[k] && steps[k].warn && steps[k].state === 'ok');
  const tone = anyWarn && conclusion === SELFTEST_OK ? 'amber' : conclusion === SELFTEST_OK ? 'green' : conclusion ? 'red' : 'muted';
  const conclusionText = anyWarn && conclusion === SELFTEST_OK ? '就绪（有提醒）' : conclusion;
  return `
    <div class="card-head">
      <div class="ch-icon">${icon('activity')}</div>
      <div class="grow"><h3>服务器就绪检查</h3><p>只判断这台服务器是否准备好接收客户端：SSH → frps 运行 → bindPort 监听 → Token 一致。任一层失败立即短路。</p></div>
      <div class="page-actions">
        ${conclusion ? `<span class="badge ${tone}"><span class="bdot"></span>${esc(conclusionText)}</span>` : ''}
        <button class="btn primary" type="button" data-act="server.selftest" ${st.busy ? 'disabled' : ''}>${icon('activity')}<span>${st.busy ? '检查中…' : '检查服务器'}</span></button>
      </div>
    </div>
    <div class="st-steps">
      ${selftestStepMarkup(steps, 'ssh', '①', 'SSH 通道', '用一条最小命令确认还能在服务器上执行操作')}
      ${selftestStepMarkup(steps, 'service', '②', 'frps 运行状态', '进程 / systemd / Docker 任一种在跑，并顺带确认开机自启')}
      ${selftestStepMarkup(steps, 'bindPort', '③', 'bindPort 监听', '服务器本机 ss / netstat 里能否看到 frps 的 bindPort')}
      ${selftestStepMarkup(steps, 'token', '④', 'Token 一致', '服务端 auth.token 与本机 frpc.toml 里的 Token 是否完全相同')}
    </div>
    <p class="st-foot">服务器就绪 ≠ 隧道可用。真正的「本地 → 隧道 → 公网」三层连通性在概览与代理映射页检查。</p>`;
}

function frpsPane() {
  return `
    <div id="frps-pane" class="advanced-pane ${S.server.mode === 'frps' ? '' : 'hidden'}">
      <div class="adv-head">
        <span class="path-chip" title="${esc(S.server.configPath || 'frps.toml')}">${esc(S.server.configPath || 'frps.toml')}</span>
        <div class="page-actions adv-actions">
          <div class="btn-cluster">
            <button class="btn ghost" type="button" data-act="server.advanced.reload">${icon('download')}<span>重新读取</span></button>
          </div>
          <span class="btn-sep" aria-hidden="true"></span>
          <div class="btn-cluster">
            <button class="btn subtle" type="button" data-act="server.save"${S.server.config ? '' : ' disabled'}>${icon('check')}<span>仅保存</span></button>
            <button class="btn primary" type="button" data-act="server.save.restart"${S.server.config ? '' : ' disabled'}>${icon('restart')}<span>保存并重启 frps</span></button>
          </div>
        </div>
      </div>
      ${S.server.config ? '' : `<div class="note warn">${icon('alert')}<div>现在读不到服务器上的 frps 配置文件${S.server.configError ? `：${esc(S.server.configError)}` : ''}。为避免把空内容写回去覆盖掉原有文件，保存按钮先置灰；确认路径后点「重新读取」，或到服务器页用「从零初始化」重新生成。</div></div>`}
      <textarea class="textarea server-config" id="server-config" spellcheck="false" placeholder="frps 配置内容">${esc(S.server.config)}</textarea>
    </div>`;
}

function frpcPane() {
  const frpcPath = (S.state && S.state.paths && S.state.paths.configPath) || 'frpc.toml';
  return `
    <div id="frpc-pane" class="advanced-pane ${S.server.mode === 'frpc' ? '' : 'hidden'}">
      <div class="adv-head">
        <span class="path-chip" title="${esc(frpcPath)}">${esc(frpcPath)}</span>
        <div class="page-actions adv-actions">
          <div class="btn-cluster">
            <button class="btn ghost" type="button" data-act="server.frpc.reload">${icon('download')}<span>重新读取</span></button>
            <button class="btn ghost" type="button" data-act="server.frpc.verify">${icon('check')}<span>校验语法</span></button>
          </div>
          <span class="btn-sep" aria-hidden="true"></span>
          <div class="btn-cluster">
            <button class="btn subtle" type="button" data-act="server.frpc.save">${icon('save')}<span>仅保存</span></button>
            <button class="btn primary" type="button" data-act="server.frpc.save.restart">${icon('restart')}<span>保存并重启 frpc</span></button>
          </div>
        </div>
      </div>
      <div class="note" id="frpc-verify-result" hidden></div>
      <textarea class="textarea server-config" id="frpc-config" spellcheck="false" placeholder="frpc 配置内容（点击「重新读取」加载当前 frpc.toml）">${esc(S.server.frpcRaw || '')}</textarea>
    </div>`;
}

function serverProxyRows() {
  const proxies = (S.state && S.state.proxies) || [];
  if (!proxies.length) {
    return `<div class="empty small"><h3>还没有映射</h3><p>去「代理映射」新增一条，把本机服务发布到 frps。</p></div>`;
  }
  return proxies.map((p) => {
    const health = p.health;
    const ok = p.status === 'running' && health && health.ok;
    const failed = health && !health.ok;
    /* 「路径 404」与「被 start 列表排除」用橙色：隧道本身没问题，不是断链。
     * 后者来自配置标记，健康检查没跑过（隧道停着）时也要显示。 */
    const skipped = !!p.startExcluded;
    const tone = ok ? 'green' : (skipped || (failed && health.pathMissing)) ? 'amber' : failed ? 'red' : 'amber';
    const text = ok ? '三层连通' : skipped ? '不在 start 列表' : failed ? (health.reason || '链路异常') : '待检测';
    const link = p.openUrl || p.publicAddress;
    const target = link || (p.remotePort ? `${(S.state.config && S.state.config.serverAddr) || ''}:${p.remotePort}` : '-');
    return `
      <div class="sp-row" title="${esc(healthTip(health))}">
        <div class="sp-main"><strong>${esc(p.name)}</strong><small>${esc((p.type || '').toUpperCase())}</small></div>
        <div class="sp-addr mono">${esc(target)}</div>
        <span class="badge ${tone}"><span class="bdot"></span>${esc(text)}</span>
        <button class="icon-btn" type="button" data-act="copy" data-text="${esc(link || '')}" title="复制公网地址">${icon('copy')}</button>
      </div>`;
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

/* frps 日志的内容（结构化）：搬进「实时日志」页后复用同一份渲染。 */
function serverLogsMarkup() {
  if (!S.server.logs) {
    const hint = S.server.logsError || '服务器上的 frps 启动后，这里会显示它的 journalctl 输出。';
    return `<div class="log-empty"><span>暂无日志</span><p class="muted">${esc(hint)}</p></div>`;
  }
  const parsed = parseServerLogs(S.server.logs);
  const filtered = S.server.logErrorsOnly ? parsed.items.filter((item) => item.level === 'error') : parsed.items;
  const shown = S.server.logExpanded ? filtered : filtered.slice(-10);
  return `
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
    <div class="log-foot"><span class="field-hint">共 ${filtered.length} 行${S.server.logErrorsOnly ? '（仅错误）' : ''}${S.server.logExpanded ? '，已展开' : '，默认显示最近 10 行'}</span></div>`;
}

/* 服务器页不再内嵌 frps 日志卡片（1.2.91：日志统一到「实时日志」页），
 * 这里只负责：如果用户正停在日志页的「服务器 frps」来源，就重绘那一页。 */
function renderServerLogs() {
  if (S.view === 'logs' && S.logSource === 'server') renderLogs(true);
}

/* 「其它站点配置」的悬空引用：把那段配置原文摊开给用户看（只读）。
 * 光给路径用户没法判断该不该动，尤其宝塔那种一个站点一个文件的布局。 */
function confViewFor(file) {
  const v = S.server.confView;
  if (!v || !v.file || v.file !== file || !Array.isArray(v.lines)) return null;
  return v;
}

function confViewMarkup(v) {
  const body = v.lines.map((l) => `${String(l.no).padStart(4, ' ')} | ${l.text}`).join('\n');
  return `<pre class="mono conf-view" style="margin:6px 0 2px;padding:8px 10px;background:var(--bg-2);border-radius:8px;overflow:auto;max-height:220px;font-size:12px;line-height:1.5">${esc(body)}</pre>
    <div class="field-hint">第 ${v.startLine}–${v.startLine + v.lines.length - 1} 行（共 ${v.totalLines} 行）${v.hitLine ? `，命中的是第 ${v.hitLine} 行` : ''}</div>`;
}

/* 配置体检结果（1.2.72）：nginx -t 通不通 + 有没有引用已经不存在的证书文件。
 * 两种情况都要显式说出来，因为它们的后果都是「平时没事、重启 nginx 整站起不来」。 */
function nginxHealthMarkup() {
  const h = S.server.nginxHealth;
  if (!h) {
    return `<div class="field-hint" style="padding:0 16px 12px">正在体检 nginx 配置…</div>`;
  }
  if (h.error) {
    return `<div class="note warn" style="margin:0 16px 12px">${icon('alert')}<div><strong>配置体检失败</strong><br>${esc(h.error)}</div></div>`;
  }
  const missing = Array.isArray(h.missing) ? h.missing : [];
  const ours = missing.filter((m) => m.ours);
  const foreign = missing.filter((m) => !m.ours);
  const testBad = h.testOk === false;
  if (!testBad && !missing.length) {
    return `<div class="note" style="margin:0 16px 12px">${icon('check')}<div><strong>配置体检通过</strong><br>nginx -t 正常；${Number(h.fileCount) || 0} 个证书/私钥文件都在（共 ${Number(h.refCount) || 0} 处引用）。</div></div>`;
  }
  const testLine = testBad
    ? `<div class="mono" style="margin-top:6px;white-space:pre-wrap">${esc(h.testText || 'nginx -t 失败')}</div>`
    : '';
  const listHtml = missing.length
    ? `<ul style="margin:8px 0 0;padding-left:18px">${missing.slice(0, 8).map((m) => {
      const sites = (m.sites || []).filter(Boolean).join('、');
      const file = (m.files || [])[0] || '';
      const isForeign = !m.ours && file;
      return `<li><code>${esc(m.path)}</code>${sites ? `（站点 ${esc(sites)}）` : ''}${m.ours ? '' : ' · 其它站点配置'}`
        + (isForeign
          ? `<div class="page-actions" style="margin:6px 0 2px">
               <button class="btn tiny" type="button" data-act="server.nginx.view" data-file="${esc(file)}" data-path="${esc(m.path)}">查看这段配置</button>
               <button class="btn tiny" type="button" data-act="server.nginx.commentref" data-file="${esc(file)}" data-path="${esc(m.path)}">注释掉这条引用</button>
             </div>
             ${confViewFor(file) ? confViewMarkup(confViewFor(file)) : ''}`
          : '')
        + '</li>';
    }).join('')}${missing.length > 8 ? `<li>…还有 ${missing.length - 8} 处</li>` : ''}</ul>`
    : '';
  const tone = testBad || ours.length ? 'error' : 'warn';
  const title = testBad
    ? (missing.length ? `nginx -t 失败，另有 ${missing.length} 处引用了不存在的证书` : 'nginx -t 失败')
    : `${missing.length} 处引用了不存在的证书文件`;
  /* nginx -t 通过但仍有悬空引用：说明引用它的配置没被加载（未 include 的片段/未启用站点），
   * 不会立刻炸，但属于要清理的脏数据 —— 明确说清楚，别让用户以为「反正没影响」。 */
  const benignNote = (!testBad && missing.length)
    ? '<div class="field-hint" style="margin-top:6px">nginx -t 仍然通过，说明引用这些文件的配置没有被加载（未 include 的片段或未启用的站点）；不会立刻出事，但建议清理，免得哪天启用后重启就起不来。</div>'
    : '';
  return `
    <div class="note ${tone}" style="margin:0 16px 12px">${icon('alert')}<div>
      <strong>${esc(title)}</strong><br>
      配置里还指着这些文件，但它们已经不在了。nginx 现在靠旧进程撑着，<b>一旦 reload 或重启就会整站起不来</b>。
      ${testLine}
      ${listHtml}
      ${benignNote}
      ${foreign.length ? `<div class="field-hint" style="margin-top:8px">其中 ${foreign.length} 处属于其它站点配置（宝塔/系统站点），不会自动改动；需要你到证书页用「换成别的证书」处理，或自行编辑那些配置文件。</div>` : ''}
      <div class="page-actions" style="margin-top:10px">
        <button class="btn small" type="button" data-act="server.nginx.health">${icon('reload')}<span>重新体检</span></button>
        ${ours.length
          ? `<button class="btn small primary" type="button" data-act="server.nginx.repair" ${S.server.nginxRepairBusy ? 'disabled' : ''}>${S.server.nginxRepairBusy ? '<span class="spinner-sm"></span>' : icon('check')}<span>${S.server.nginxRepairBusy ? '修复中…' : `修复我们自己的配置（${ours.length} 处）`}</span></button>`
          : ''}
      </div>
    </div>`;
}

function nginxCardMarkup() {
  const n = S.server.nginx || {};
  /* 状态还没拉回来时不能断言「未安装」——以前 `!n` 对空对象恒为假，
   * 结果卡片直接落到 installed=false 分支，写着「服务器还没装 nginx」，
   * 用户看到的第一眼就是假结论（连接成功的头几百毫秒就是这样）。 */
  if (!S.server.nginx) {
    return `<section class="card"><div class="card-head"><div class="ch-icon">${icon('globe')}</div><div class="grow"><h3>HTTPS 域名反代（nginx）</h3><p>检测服务器 nginx，让域名走 80/443、不用带端口。</p></div></div><div class="field-hint" style="padding:0 16px 12px">检测中…</div></section>`;
  }
  if (n.error) {
    return `<section class="card"><div class="card-head"><div class="ch-icon">${icon('globe')}</div><div class="grow"><h3>HTTPS 域名反代（nginx）</h3><p>检测服务器 nginx，让域名走 80/443、不用带端口。</p></div></div><div class="note warn" style="margin:0 16px 12px">${icon('alert')}<div>${esc(n.error)}</div></div></section>`;
  }
  const installed = !!n.installed;
  // 真冲突 = 80/443 被「非 nginx」的进程占用。nginx 自己占着 80/443 是正常就绪，
  // 不能用 port80Free/port443Free（那会把 nginx 自身也算成「被占」）。
  const conflict = !!(n.port80Conflict || n.port443Conflict);
  /* 只有「80 段 + 443 段都写过」才算 https 真的能用。以前只要 nginx 在跑、端口没被占
   * 就挂绿「就绪」，于是删掉证书、443 段被摘掉之后，卡片还写着「80/443 可用」，
   * 用户拿域名用 https 访问却直接被拒——假绿 (1.2.68)。 */
  const certsList = Array.isArray(n.certs) ? n.certs : (n.certs ? [n.certs] : []);
  const hasTls = certsList.length > 0;
  const httpsListening = !n.port443Free;
  /* 体检结论（nginx -t / 悬空证书引用）优先于「就绪」判据：配置都过不了 nginx -t，
   * 头上还挂绿「就绪」，就等于跟下面的红字自相矛盾（真机故障注入复现）。 */
  const healthState = S.server.nginxHealth || null;
  const healthIssue = !!(healthState && (healthState.testOk === false || Number(healthState.missingCount || 0) > 0));
  let statusBadge;
  let detail;
  let setupLabel;
  if (installed && !conflict) {
    if (n.proxyConfigured && !hasTls) {
      statusBadge = `<span class="badge amber"><span class="bdot"></span>已配 80 · 缺 443 证书</span>`;
      detail = httpsListening
        ? '443 端口有监听，但我们的 frp-console.conf 里没有 ssl 证书段——你的域名走 https 会落到别的站点（证书不匹配）。'
        : 'frp-console.conf 里没有 ssl 证书段，443 也没有监听：现在域名只能走 http://域名。';
      setupLabel = '配置 HTTPS 反代';
    } else {
      statusBadge = `<span class="badge green"><span class="bdot"></span>${n.version ? esc(n.version) : 'nginx'} · 就绪</span>`;
      detail = hasTls
        ? 'nginx 已装，80/443 都已配置：域名可直接用 https:// 访问，不用带端口。'
        : 'nginx 已装，80/443 可用：配置后域名可直接 https:// 访问，不用带端口。';
      setupLabel = '一键配置反代';
    }
  } else if (installed && conflict) {
    const by = [n.port80By, n.port443By].filter(Boolean).join('、') || '其它进程';
    statusBadge = '<span class="badge amber"><span class="bdot"></span>80/443 被占</span>';
    detail = `80/443 正在被 ${by} 占用（不是 nginx），nginx 无法绑定标准端口。可点「清理占用并配置」终止这些进程后再配置。`;
    setupLabel = '清理占用并配置';
  } else {
    statusBadge = '<span class="badge amber"><span class="bdot"></span>未安装</span>';
    detail = '服务器还没装 nginx。一键配置会自动安装并写好反代规则。';
    setupLabel = '安装 nginx 并配置';
  }
  if (healthIssue && installed && !conflict) {
    statusBadge = '<span class="badge red"><span class="bdot"></span>' + (n.version ? esc(n.version) : 'nginx') + ' · 配置异常</span>';
    detail = healthState.testOk === false
      ? 'nginx 当前这份配置过不了 nginx -t：现在还能访问是因为旧进程还在跑，一旦 reload 或重启就会整站起不来。'
      : '配置里有引用不存在的证书文件，reload / 重启 nginx 会失败。详见下方配置体检。';
  }
  const certMissing = n.certMissing;
  /* 1.2.60 起 detectNginx 会带回 serverNames（数组）与 certs：把「这台服务器的
   * frp-console.conf 里到底配了哪些域名」直接摊开，用户一眼能看出自己的域名
   * 在不在里面（以前只笼统显示「反代已就绪」，域名没配也不知道）。 */
  const namesText = Array.isArray(n.serverNames) ? n.serverNames.join('、') : String(n.serverNames || '');
  const certsText = certsList.join('、');
  /* `n.ok` 服务端从来没给过（nginx:state 只回 detectNginx 的字段），
   * 所以「反代已就绪」这条提示一直是死代码。改成按「配置在 + 有证书」自己算。 */
  /* 体检结论优先：nginx -t 失败或引用了不存在的证书时，卡片头不能再挂绿「就绪」——
   * 那会和下方的红字直接打架（真机复现：上头「1.22.1 · 就绪」，下头「nginx -t 失败…」。 */
  const ready = !!(n.proxyConfigured && hasTls) && !healthIssue;
  const configuredNote = (n.proxyConfigured && namesText && !ready)
    ? `<div class="note" style="margin:0 16px 12px">${icon('globe')}<div><strong>nginx 已配置的域名</strong><br>${esc(namesText)}${certsText ? `<br><span class="field-hint mono">${esc(certsText)}</span>` : ''}<br>你的域名不在这个列表里时，https 访问会落到默认站点（证书不匹配、浏览器会告警）。</div></div>`
    : '';
  return `
    <section class="card">
      <div class="card-head">
        <div class="ch-icon">${icon('globe')}</div>
        <div class="grow"><h3>HTTPS 域名反代（nginx）</h3><p>${esc(detail)}</p></div>
        <div class="page-actions">
          ${statusBadge}
          <button class="btn" type="button" data-act="server.nginx.refresh">${icon('reload')}<span>重新检测</span></button>
          ${hasTls ? '' : `<button class="btn" type="button" data-act="nav" data-view="certs">${icon('shield')}<span>去签发证书</span></button>`}
          <button class="btn primary" type="button" data-act="server.nginx.setup" ${S.server.nginxBusy ? 'disabled' : ''}>${S.server.nginxBusy ? '<span class="spinner-sm"></span>' : icon('globe')}<span>${S.server.nginxBusy ? '配置中…' : setupLabel}</span></button>
        </div>
      </div>
      ${certMissing
        ? `<div class="note warn" style="margin:0 16px 12px">${icon('alert')}<div><strong>还没有可用证书</strong><br>反代需要一张证书来终止 HTTPS。请先到「HTTPS 证书」页签发一张，再回来点「一键配置反代」。</div></div>`
        : ''}
      ${configuredNote}
      ${ready
        ? `<div class="note" style="margin:0 16px 12px">${icon('check')}<div><strong>反代已就绪</strong><br>${esc(namesText || '你的域名')} → nginx 80/443${n.frpsHttpPort ? ` → frps HTTP vhost（${esc(String(n.frpsHttpPort))}）` : ' → frps HTTP vhost'}。现在用 <code>https://你的域名</code> 就能访问，不带端口。</div></div>`
        : ''}
      ${installed ? nginxHealthMarkup() : ''}
    </section>`;
}

/* 解析规则 spec（ufw '7000/tcp'、'1:65535/tcp'；firewalld '8000-9000/tcp'）成范围。 */
function fwSpecRange(spec) {
  const m = /^([0-9]+)(?::([0-9]+)|-([0-9]+))?\/(tcp|udp)$/i.exec(String(spec || ''));
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2] || m[3] || m[1]);
  return { start, end, proto: m[4].toLowerCase() };
}

function firewallCardMarkup() {
  const f = S.server.firewall || {};
  const title = '端口与连通';
  if (!f) {
    return `<section class="card"><div class="card-head"><div class="ch-icon">${icon('shield')}</div><div class="grow"><h3>${title}</h3><p>检测每个端口的「监听 / 规则 / 实测」，定位到底拦在哪一层。</p></div></div><div class="field-hint" style="padding:0 16px 12px">检测中…</div></section>`;
  }
  if (f.error) {
    return `<section class="card"><div class="card-head"><div class="ch-icon">${icon('shield')}</div><div class="grow"><h3>${title}</h3><p>检测每个端口的「监听 / 规则 / 实测」，定位到底拦在哪一层。</p></div></div><div class="note warn" style="margin:0 16px 12px">${icon('alert')}<div>${esc(f.error)}</div></div></section>`;
  }
  const managerLabel = { ufw: 'ufw', firewalld: 'firewalld', iptables: 'iptables', none: '无防火墙' }[f.manager] || esc(f.manager || '未知');
  const frpsPorts = Array.isArray(f.frpsPorts) && f.frpsPorts.length ? f.frpsPorts : (Array.isArray(f.ports) ? f.ports : []);
  const proxyPorts = Array.isArray(f.proxyPorts) && f.proxyPorts.length ? f.proxyPorts : [];
  const allowedRules = Array.isArray(f.allowed) ? f.allowed : [];
  /* 一个端口算「已放行」= 存在协议匹配、且范围覆盖它的规则。 */
  const covered = (port, proto) => allowedRules.some((a) => {
    const r = fwSpecRange(a.spec || `${a.port}/${a.proto}`);
    return r && r.proto === proto && port >= r.start && port <= r.end;
  });
  const coverTag = (p) => {
    if (!f.active) {
      // 防火墙未启用 = 不拦截任何端口，谈不上「放行」，统一标绿，避免误导。
      return `<span class="tag ok">${esc(p.label)} ${p.port}/${p.proto} 未启用不拦截</span>`;
    }
    if (covered(p.port, p.proto)) {
      return `<span class="tag ok">${esc(p.label)} ${p.port}/${p.proto} ✓</span>`;
    }
    // 规则没写这条，但实测可达 —— 通常是云平台防火墙（阿里云轻量、腾讯云安全组等）
    // 在服务器外放行，服务器内 ufw 看到「未放行」其实不拦。标中性色并说明，不再误导。
    if (p.proto === 'tcp' && p.reachable === true) {
      return `<span class="tag amber">${esc(p.label)} ${p.port}/${p.proto} 规则未放行 · 实测可达</span>`;
    }
    return `<span class="tag bad">${esc(p.label)} ${p.port}/${p.proto} 未放行</span>`;
  };
  const statusBadge = f.active
    ? '<span class="badge amber"><span class="bdot"></span>已启用</span>'
    : '<span class="badge green"><span class="bdot"></span>未启用</span>';
  const notes = Array.isArray(f.notes) && f.notes.length ? f.notes : null;
  const busy = S.server.firewallBusy ? 'disabled' : '';
  const mainBtn = f.manager === 'none'
    ? `<button class="btn primary" type="button" data-act="server.firewall.install" ${busy}>${S.server.firewallBusy ? '<span class="spinner-sm"></span>' : icon('shield')}<span>${S.server.firewallBusy ? '安装中…' : '安装并启用防火墙'}</span></button>`
    : `<button class="btn primary" type="button" data-act="server.firewall.open" ${busy}>${S.server.firewallBusy ? '<span class="spinner-sm"></span>' : icon('shield')}<span>${S.server.firewallBusy ? '放行中…' : '一键放行全部端口'}</span></button>`;

  /* ---- 矩阵：监听 / 规则 / 实测 三信号 + 结论（v1.2.56） ---- */
  const rows = Array.isArray(f.matrix) ? f.matrix : [];
  const conclusion = f.conclusion || null;
  const cell = (state, proto) => {
    if (proto === 'udp' && state === 'reach') return '<span class="pm pm-warn">疑似</span>';
    if (state === 'yes') return '<span class="pm pm-ok">✓</span>';
    if (state === 'no') return '<span class="pm pm-bad">✗</span>';
    return '<span class="pm pm-muted">—</span>';
  };
  const tri = (v) => (v === true ? 'yes' : (v === false ? 'no' : 'unknown'));
  const rowAction = (r) => {
    if (r.action === 'open') {
      /* 行内「放行」只放行这一条端口（系统端口如 nginx 443 不在 frps/代理清单里，
       * 以前点它执行的是「放行 frps 与代理端口」，等于什么都没做）。 */
      return `<button class="btn tiny" type="button" data-act="server.firewall.openone" data-port="${r.port}" data-proto="${esc(r.proto)}" ${busy}>放行</button>`;
    }
    if (r.action === 'cloud') return `<button class="btn tiny" type="button" data-act="server.ports.copy">复制规则</button>`;
    if (r.action === 'service') return `<button class="btn tiny" type="button" data-act="server.firewall.refresh">重新检测</button>`;
    return '';
  };
  const GROUP_LABEL = { frps: 'frps 端口', proxy: '代理映射端口', system: '系统端口（SSH / nginx）' };
  const groupOrder = ['frps', 'proxy', 'system'];
  /* 代理一多（几十条）矩阵会把页面撑得很长、把真正有问题的行埋掉。
   * 超过 12 行时默认只显示「有问题的行」，其余折叠，给一个按钮展开。 */
  const showAll = !!S.server.portShowAll;
  const collapsed = rows.length > 12 && !showAll;
  const visibleRows = collapsed ? rows.filter((r) => r.tone !== 'ok') : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const moreHtml = rows.length > 12 ? `
        <div class="port-matrix-more">
          <span class="field-hint">${collapsed
            ? (hiddenCount ? `已折叠 ${hiddenCount} 个正常的端口` : '所有端口都正常')
            : `显示全部 ${rows.length} 个端口`}</span>
          <button class="btn tiny" type="button" data-act="server.ports.showall">${collapsed ? '显示全部' : '只看有问题的'}</button>
        </div>` : '';
  const matrixHtml = rows.length ? `
      <div class="port-matrix-wrap">
        <table class="port-matrix">
          <thead><tr><th>用途</th><th>端口</th><th>监听</th><th>规则</th><th>实测</th><th>结论</th><th></th></tr></thead>
          <tbody>
            ${visibleRows.length ? '' : '<tr><td colspan="7" class="pm-muted" style="padding:12px 14px">没有需要处理的端口</td></tr>'}
            ${groupOrder.map((g) => {
              const list = visibleRows.filter((r) => r.group === g);
              if (!list.length) return '';
              return `<tr class="pm-group"><td colspan="7">${GROUP_LABEL[g] || g}</td></tr>`
                + list.map((r) => `
                  <tr>
                    <td class="pm-label">${esc(r.label || '')}</td>
                    <td class="mono">${r.port}/${esc(r.proto)}</td>
                    <td>${r.listen === false && r.proto === 'tcp' ? cell('no') : cell(tri(r.listen))}</td>
                    <td>${f.active ? cell(r.rule ? 'yes' : 'no') : '<span class="pm pm-muted">—</span>'}</td>
                    <td>${r.proto === 'udp'
                      ? (r.reachable === false ? cell('no') : cell('reach', 'udp'))
                      : cell(tri(r.reachable))}</td>
                    <td class="pm-text pm-${esc(r.tone || 'ok')}">${esc(r.text || '')}</td>
                    <td class="pm-act">${rowAction(r)}</td>
                  </tr>`).join('');
            }).join('')}
          </tbody>
        </table>
        ${moreHtml}
      </div>` : '';
  const conclusionHtml = conclusion ? `
      <div class="note ${conclusion.level === 'ok' ? '' : 'warn'}" style="margin:0 16px 10px">
        ${icon(conclusion.level === 'ok' ? 'check' : 'alert')}
        <div><b>${esc(conclusion.text)}</b>${conclusion.total ? `（共 ${conclusion.total} 个端口，${conclusion.ok} 个正常）` : ''}</div>
      </div>` : '';

  return `
    <section class="card">
      <div class="card-head">
        <div class="ch-icon">${icon('shield')}</div>
        <div class="grow"><h3>${title}（${managerLabel}）</h3><p>${esc(f.statusText || '')}</p></div>
        <div class="page-actions">
          ${statusBadge}
          <button class="btn" type="button" data-act="server.firewall.refresh">${icon('reload')}<span>重新检测</span></button>
          ${mainBtn}
        </div>
      </div>
      ${conclusionHtml}
      ${matrixHtml || `
      ${frpsPorts.length ? `<div style="padding:0 16px 6px"><div class="field-hint" style="padding:0 0 6px">frps 端口放行状态：</div><div style="display:flex; flex-wrap:wrap; gap:6px;">${frpsPorts.map(coverTag).join('')}</div></div>` : ''}
      ${proxyPorts.length ? `<div style="padding:0 16px 6px"><div class="field-hint" style="padding:0 0 6px">代理映射端口放行状态：</div><div style="display:flex; flex-wrap:wrap; gap:6px;">${proxyPorts.map(coverTag).join('')}</div></div>` : ''}
      `}
      ${f.active ? `<div class="field-hint" style="padding:0 16px 10px">「监听」= 服务器上有没有程序在这个端口监听；「规则」= 服务器内 ${managerLabel} 有没有放行；「实测」= 从本机能不能连上。三者交叉才能定位拦住的是本机防火墙还是云安全组。</div>` : ''}
      ${allowedRules.length ? `
      <div style="padding:0 16px 8px">
        <div class="field-hint" style="padding:0 0 6px">已放行规则（${allowedRules.length} 条，当前实际规则，勾选后可删除）：</div>
        <div style="display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; max-height:180px; overflow-y:auto;">
          <label class="check-inline" style="color:var(--muted,inherit)"><input type="checkbox" id="fw-rule-all"><span>全选</span></label>
          ${allowedRules.map((a) => `<label class="check-inline"><input type="checkbox" class="fw-rule-del" value="${esc(a.spec || `${a.port}/${a.proto}`)}"><span class="mono">${esc(a.spec || `${a.port}/${a.proto}`)}</span></label>`).join('')}
        </div>
        <div style="padding-top:8px;"><button class="btn" type="button" data-act="server.firewall.close" ${busy}>${icon('trash')}<span>删除选中规则</span></button></div>
      </div>` : (f.manager !== 'none' ? '<div class="field-hint" style="padding:0 16px 10px">当前防火墙没有任何放行规则。</div>' : '')}
      ${notes
        ? `<div class="note warn" style="margin:0 16px 12px">${icon('alert')}<div>${esc(notes.join('；'))}</div></div>`
        : ''}
      <div class="cloud-hint">
        <div class="cloud-hint-head">${icon('alert')}<b>本机防火墙放行 ≠ 公网可访问</b></div>
        <p>云服务器（阿里云 / 腾讯云 / 华为云等）在机器之外还有一层「云防火墙 / 安全组」，服务器里的 ${managerLabel} 管不到它。
        判定方法：<b>本机在监听</b> + <b>本机防火墙已放行</b> + <b>上面「实测」不通</b> → 拦截点在云平台层。</p>
        <ul>
          <li>阿里云 ECS：控制台 → 实例 → 安全组 → 配置规则 → 入方向 → 手动添加</li>
          <li>阿里云轻量应用服务器：控制台 → 服务器详情 → 防火墙 → 添加规则</li>
          <li>腾讯云 CVM：控制台 → 安全组 → 入站规则 → 添加规则</li>
          <li>华为云 ECS：控制台 → 安全组 → 入方向规则 → 添加规则</li>
        </ul>
        <p class="cloud-hint-warn">图省事可先放行 <b>1–65535 TCP + UDP</b>，但那等于把全部端口暴露到公网，只建议在自用/测试服务器上这么做；长期请按上面的端口清单精确放行。</p>
      </div>
      ${f.manager !== 'none'
        ? `
      <div class="field-hint" style="padding:0 16px 6px">手动放行端口：</div>
      <div class="input-group" style="padding:0 16px 12px; align-items:center;">
        <input id="fw-manual-port" class="input" type="text" placeholder="如 1-65500、8080、8000-9000,10000" ${busy ? 'disabled' : ''} />
        <select id="fw-manual-proto" class="select" style="width:96px; flex:none;" ${busy ? 'disabled' : ''}>
          <option value="both">tcp+udp</option>
          <option value="tcp">tcp</option>
          <option value="udp">udp</option>
        </select>
        <button class="btn" type="button" data-act="server.firewall.openports" ${busy}>${icon('plus')}<span>放行</span></button>
      </div>
      <div class="field-hint" style="padding:0 16px 12px">支持单个端口、端口范围（1-65500）、逗号分隔多个；放行 / 删除后列表实时刷新为防火墙里的真实规则。</div>
      `
        : ''}
    </section>`;
}

/* ---------------- SSH 交互式终端（xterm.js）----------------
 * 终端实例 / 事件退订函数放在模块级：renderServer 会整页重写 #view，
 * DOM 里的终端容器随时可能被换掉，靠这两个引用在重渲染后重新挂载或清理。
 * term 存活期间 renderServer 重渲染只重画「打开终端」按钮状态，不销毁会话。 */
const shellState = {
  term: null,        // xterm Terminal 实例
  fit: null,         // FitAddon
  unSub: null,       // ssh:data 退订函数
  resizeObs: null,   // 容器尺寸监听
  open: false,       // 后端 shell 是否在跑
  opening: false,    // 正在打开（防连点）
  ctxMenu: null,     // 右键菜单 DOM
  ctxSelection: '',  // 打开菜单那一刻的选区（点菜单会让 xterm 选区失效）
};

function terminalCardMarkup() {
  const st = shellState;
  const busy = st.opening ? 'disabled' : '';
  if (st.open || st.opening) {
    return `
      <section class="card terminal-card" id="terminal-card">
        <div class="card-head">
          <div class="ch-icon">${icon('terminal')}</div>
          <div class="grow"><h3>SSH 终端</h3><p>${st.open ? `${esc(S.server.username || 'root')}@${esc(S.server.host)} · 命令直接在服务器上执行，没有二次确认` : '正在请求服务器的交互式 shell…'}</p></div>
          <div class="page-actions">
            ${st.open ? `<button class="btn ghost" type="button" data-act="server.shell.close">${icon('x')}<span>关闭终端</span></button>` : ''}
          </div>
        </div>
        <div class="term-shell" id="ssh-term-shell"><div id="ssh-term"></div></div>
      </section>`;
  }
  return `
    <section class="card terminal-card" id="terminal-card">
      <div class="card-head">
        <div class="ch-icon">${icon('terminal')}</div>
        <div class="grow"><h3>SSH 终端</h3><p>在服务器上打开一个真实的交互式终端（bash / vim / htop 都能用）</p></div>
        <div class="page-actions">
          <button class="btn" type="button" data-act="server.shell.open" ${busy}>${icon('terminal')}<span>${st.opening ? '正在打开…' : '打开终端'}</span></button>
        </div>
      </div>
      <div class="note warn" style="margin:0 16px 14px">${icon('alert')}<div>终端以登录账号直连服务器，<strong>命令直接执行、没有确认步骤</strong>（rm、ufw、systemctl 都是实打实的）。改防火墙时记得先放行 SSH 端口，避免把自己锁在外面。</div></div>
    </section>`;
}

/* renderServer 整页 innerHTML 重写后调用：把还活着的终端重新挂回新 DOM。
 * xterm 的 Term.open() 只能对一个容器调一次，所以这里「搬家」——
 * 把旧 .xterm 元素 append 进新容器，canvas 渲染层会跟着走。 */
function remountShellTerm() {
  const st = shellState;
  if (!st.open || !st.term) return;
  const host = $('#ssh-term');
  if (!host) return;
  if (st.term.element && st.term.element.parentElement === host) return; // 已挂载
  if (st.term.element) host.appendChild(st.term.element);
  else st.term.open(host);
  if (st.fit) { try { st.fit.fit(); } catch { /* ignore */ } }
  st.term.focus();
}

function disposeShellTerm(notifyClosed) {
  const st = shellState;
  st.open = false;
  st.opening = false;
  if (st.unSub) { try { st.unSub(); } catch { /* ignore */ } st.unSub = null; }
  if (st.resizeObs) { try { st.resizeObs.disconnect(); } catch { /* ignore */ } st.resizeObs = null; }
  if (st.term) { try { st.term.dispose(); } catch { /* ignore */ } st.term = null; }
  st.fit = null;
  closeShellContextMenu();
  if (window.__shellTerm) window.__shellTerm = null;
  if (notifyClosed) FRP.shellClose().catch(() => {});
}

/* 终端右键菜单：只做三件最常用的事（复制 / 粘贴 / 清屏）。
 * 菜单挂在 document.body 上，避免被 .term-shell 的 overflow 裁掉；
 * 点外面 / 按 Esc / 滚轮 / 窗口失焦都会关掉它。 */
/* 统一的多行粘贴入口：>1 行（非空）先确认，避免一次性把整段脚本灌进 root shell。 */
async function pasteIntoShell(term, text) {
  if (!term || !text) return false;
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length <= 1) {
    term.paste(text);
    return true;
  }
  const preview = lines.slice(0, 5).map((l) => l.length > 100 ? l.slice(0, 100) + '…' : l).join('\n');
  const more = lines.length > 5 ? `\n…还有 ${lines.length - 5} 行` : '';
  const go = await confirmDialog({
    title: `粘贴 ${lines.length} 行命令？`,
    body: `这个终端是服务器上的 root shell：粘进去的每一行都会被**立刻执行**。\n\n${preview.replace(/[<>]/g, '')}${more}\n\n确认是你想执行的命令再继续。`,
    confirmText: '粘贴并执行',
    cancelText: '取消',
    danger: true,
  });
  if (!go) return false;
  term.paste(text);
  return true;
}

const SHELL_CTX_ITEMS = [
  { id: 'copy', label: '复制' },
  { id: 'paste', label: '粘贴' },
  { id: 'clear', label: '清屏' },
];

function closeShellContextMenu() {
  const menu = shellState.ctxMenu;
  if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
  shellState.ctxMenu = null;
}

function openShellContextMenu(x, y) {
  const st = shellState;
  if (!st.term) return;
  closeShellContextMenu();
  // 打开时先记住选区：点菜单可能让 xterm 的选区失效，复制时用这份快照兜底。
  const selection = String((st.term.getSelection && st.term.getSelection()) || '');
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = SHELL_CTX_ITEMS.map((it) => {
    const disabled = it.id === 'copy' && !selection;
    return `<button class="ctx-item${disabled ? ' disabled' : ''}" type="button" data-ctx="${it.id}"${disabled ? ' disabled' : ''}>${it.label}</button>`;
  }).join('');
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  st.ctxMenu = menu;
  st.ctxSelection = selection;

  menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
  menu.addEventListener('click', async (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-ctx]') : null;
    if (!btn || btn.disabled) return;
    const action = btn.dataset.ctx;
    const term = shellState.term;
    closeShellContextMenu();
    if (!term) return;
    if (action === 'copy') {
      const text = selection || String((term.getSelection && term.getSelection()) || '');
      if (text) FRP.copy(text).catch(() => {});
    } else if (action === 'paste') {
      const res = await FRP.clipboardRead().catch(() => null);
      const text = res && res.ok && res.data && res.data.text;
      if (text) await pasteIntoShell(term, text);
    } else if (action === 'clear') {
      // 先本地清屏（立刻见效），再发一个 ^L（Ctrl+L）让 bash/zsh 重画提示符。
      // 只写 ESC[2J 会把提示符一起擦掉、屏幕上只剩光标，看着像终端挂了。
      term.write('\x1b[2J\x1b[H');
      FRP.shellInput('\x0c');
    }
    term.focus();
  });
}

document.addEventListener('mousedown', (e) => {
  if (!shellState.ctxMenu) return;
  if (e.target && e.target.closest && e.target.closest('.ctx-menu')) return;
  closeShellContextMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (shellState.ctxMenu && e.key === 'Escape') closeShellContextMenu();
}, true);
window.addEventListener('blur', () => closeShellContextMenu());
window.addEventListener('resize', () => closeShellContextMenu());
document.addEventListener('wheel', () => closeShellContextMenu(), { passive: true });

async function openShellTerm() {
  const st = shellState;
  if (st.open || st.opening) return;
  st.opening = true;
  renderServer(true);
  try {
    // 先建 xterm（拿到真实行列数），再让服务器开 PTY，两边尺寸一开始就对齐。
    const TermCtor = window.Terminal;
    const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
    if (!TermCtor || !FitCtor) throw new Error('xterm 组件未加载（vendor/xterm）');
    const term = new TermCtor({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      scrollback: 4000,
      theme: { background: '#0d1117' },
    });
    const fit = new FitCtor();
    term.loadAddon(fit);
    if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    }
    st.term = term;
    st.fit = fit;
    // 暴露给测试 / 调试读取 xterm 缓冲区（canvas 渲染，DOM textContent 读不到终端内容）。
    window.__shellTerm = term;

    // 挂到一个临时容器拿尺寸；renderServer(true) 之后 remountShellTerm 会搬进真正的卡。
    renderServer(true);
    const host = $('#ssh-term');
    if (!host) throw new Error('终端容器未创建');
    term.open(host);
    try { fit.fit(); } catch { /* ignore */ }
    /* 右键菜单：xterm 默认把右键交给浏览器（会弹出 Chromium 的“检查/另存为”）。
     * 监听挂在 term.element 上——重渲染时 xterm 元素会被“搬家”，监听跟着走。 */
    if (term.element) {
      term.element.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openShellContextMenu(ev.clientX, ev.clientY);
      });
    }
    const cols = Math.max(2, Math.min(500, term.cols || 100));
    const rows = Math.max(2, Math.min(200, term.rows || 30));

    // 先接好「后端输出 → 终端」「终端按键 → 后端」两条流，再开 shell。
    // 关键顺序：服务器可能在 shell 一 accept 就立刻吐欢迎语 / 提示符，
    // 如果等 shellOpen 的 Promise 回来才订阅 ssh:data，这些首批字节会被丢掉。
    st.unSub = FRP.on('ssh:data', (payload) => {
      if (!shellState.term) return;
      if (payload && payload.closed) {
        shellState.term.write('\r\n\x1b[33m[连接已关闭]\x1b[0m\r\n');
        // 后端主动断（切服务器 / 网络断）：把本地状态收掉，回到「打开终端」卡。
        setTimeout(() => { disposeShellTerm(false); renderServer(true); }, 400);
        return;
      }
      if (payload && typeof payload.chunk === 'string') shellState.term.write(payload.chunk);
    });
    term.onData((data) => { FRP.shellInput(data); });

    // Ctrl+C 复制 / Ctrl+V 粘贴：终端里默认 Ctrl+C 是「发送中断信号」、Ctrl+V 是字面量 ^V，
    // 但桌面习惯是「选中后 Ctrl+C 复制、Ctrl+V 粘贴」。这里按选中状态区分：
    // 选中了文字 → Ctrl+C 复制（不发中断）；没选中 → 交回 xterm 发 \x03 中断。
    // xterm 6 的 attachCustomKeyEventHandler 回调参数就是原生 KeyboardEvent（不是 { domEvent } 包装）。
    // 注意：xterm 对 keydown / keypress / keyup 三种事件都会调用这个 handler——
    // 必须只处理 keydown，否则按一次 Ctrl+V 会粘贴 3 份（真实键盘一次按键产生 3 个 DOM 事件）。
    // 另外必须 preventDefault：真实的 Ctrl+V 按键若不被拦下，浏览器还会把剪贴板「原生粘贴」进
    // xterm 的隐藏输入框，xterm 自己再发一遍 → 我们自己粘一次 + 原生粘一次 = 看到 pwdpwd 这种重复。
    term.attachCustomKeyEventHandler((ev) => {
      if (!ev || ev.type !== 'keydown') return true; // 只处理 keydown；keypress/keyup 交回 xterm
      const ctrl = !!(ev.ctrlKey || ev.metaKey);
      if (ctrl && !ev.shiftKey && !ev.altKey) {
        const k = String(ev.key || '').toLowerCase();
        if (k === 'c') {
          const sel = term.getSelection();
          if (sel) {
            if (ev.preventDefault) ev.preventDefault();
            if (ev.stopPropagation) ev.stopPropagation();
            FRP.copy(sel).catch(() => {});
            term.focus();
            return false; // 已处理：复制选中文字，不再发 \x03
          }
          return true; // 没选中 → 正常发 \x03 中断当前命令
        }
        if (k === 'v') {
          // 拦下浏览器默认粘贴，只走我们这一条路径，避免重复粘贴两份。
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopPropagation) ev.stopPropagation();
          FRP.clipboardRead().then((res) => {
            const text = res && res.ok && res.data && res.data.text;
            if (text) pasteIntoShell(term, text);
          }).catch(() => {});
          term.focus();
          return false; // 已处理：粘贴剪贴板内容
        }
      }
      return true; // 其余按键交回 xterm
    });

    const res = await FRP.shellOpen({ rows, cols });
    if (!res || !res.ok) throw new Error((res && res.error) || '打开终端失败');

    st.open = true;
    st.opening = false;
    // 容器尺寸变化 → fit（本地重排）+ setWindow（远端 PTY 跟着变，vim 才不会错位）。
    const shell = $('#ssh-term-shell');
    if (shell && typeof ResizeObserver === 'function') {
      st.resizeObs = new ResizeObserver(() => {
        if (!shellState.term || !shellState.fit) return;
        try {
          shellState.fit.fit();
          FRP.shellResize(shellState.term.rows, shellState.term.cols);
        } catch { /* ignore */ }
      });
      st.resizeObs.observe(shell);
    }
    renderServer(true);
    term.focus();
  } catch (e) {
    disposeShellTerm(false);
    toast(String((e && e.message) || e), 'error');
    renderServer(true);
  }
}

function closeShellTerm() {
  disposeShellTerm(true);
  renderServer(true);
}

/* 代理表单里「公网端口」的协议：udp 代理查 udp 规则，其余都按 tcp 查。 */
function proxyFormProto() {
  const t = $('#pf-type');
  return t && t.value === 'udp' ? 'udp' : 'tcp';
}

/* 「检测」按钮的完整判定：服务器上有没有被占 → allowPorts 允不允许 → 防火墙放没放行。
 * 前两层以前就有；第三层是 1.2.70 加的——三层都过才算「可用」，缺一层就是配好了也连不上。 */
async function checkRemotePortUI() {
  const input = $('#pf-remote');
  const status = $('#pf-remote-status');
  const fwBox = $('#pf-fw-status');
  const port = input ? Number(input.value) : 0;
  const say = (tone, text) => { if (status) { status.textContent = text; status.className = `field-hint${tone ? ` ${tone}` : ''}`; } };
  const sayFw = (tone, text, showOpen) => {
    if (!fwBox) return;
    if (!text) { fwBox.innerHTML = ''; fwBox.className = 'field-hint'; return; }
    fwBox.className = `field-hint${tone ? ` ${tone}` : ''}`;
    fwBox.innerHTML = `<span>${esc(text)}</span>${showOpen
      ? '<button class="btn tiny" type="button" data-act="proxyform.openfw" title="在服务器防火墙里放行这个端口">一键放行</button>'
      : ''}`;
  };
  if (!input || !Number.isInteger(port) || port < 1 || port > 65535) {
    say('warn', '先填一个 1 - 65535 的端口再检测');
    sayFw('', '');
    return;
  }
  say('', '正在连接服务器检测端口占用与防火墙…');
  sayFw('', '');
  const proto = proxyFormProto();
  const res = await FRP.checkPort({ port, proto });
  if (!res || !res.ok) {
    say('warn', (res && res.error) || '检测失败');
    return;
  }
  const d = res.data || {};
  const fw = d.firewall || {};
  if (d.inUse) {
    const who = d.process ? `（被 ${d.process} 占用` + (d.pid ? `，PID ${d.pid}` : '') + '）' : '';
    say('warn', `端口 ${port} 已被占用${who}，建议换一个`);
  } else if (!d.allowOk) {
    say('warn', `端口 ${port} 空闲，但不在服务器 allowPorts 允许范围` + (d.allowPortsText ? `（${d.allowPortsText}）` : '') + '，frps 会拒绝注册');
  } else if (fw.allowed === false) {
    say('warn', `端口 ${port} 空闲且 allowPorts 允许，但服务器防火墙（${fw.manager || '未知'}）没有放行，外面连不进来`);
  } else {
    say('ok', `端口 ${port} 可用（服务器未占用、allowPorts 允许${fw.allowed === true ? '、防火墙已放行' : ''}）`);
  }
  /* 防火墙一行单独说：已放行绿字，未放行橙字 + 一键放行，判断不了灰字也给放行按钮。 */
  if (fw.allowed === true) sayFw('ok', `防火墙：${fw.detail || '已放行'}`, false);
  else if (fw.allowed === false) sayFw('warn', `防火墙：${fw.detail || '没有放行这个端口'}`, true);
  else if (fw.detail) sayFw('', `防火墙：${fw.detail}（${fw.manager || '未知'}）`, true);
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

  /* Dashboard 的暴露面：frp 在面板没密码时压根不校验身份，
   * 而 addr = 0.0.0.0 就等于把它摆到公网上（能看到 token、改配置、重启 frps）。 */
  const dashRisk = (() => {
    if (!summary.webPort) return null;
    const addr = String(summary.webAddr || '');
    const exposed = addr === '0.0.0.0' || addr === '::' || addr === '[::]' || addr === '';
    if (!exposed) return null;
    const len = String(summary.webPassword || '').length;
    if (len === 0) {
      return {
        cls: 'bad',
        title: `frps 面板对公网开放，而且没有密码（:${summary.webPort}）`,
        detail: `webServer.addr 是 ${addr}，frp 在面板没设口令时不校验身份——谁都能打开 :${summary.webPort} 看到 auth.token、改配置并重启 frps。去 frps.toml 的 [webServer] 里加一句 password，或把 addr 改成 127.0.0.1。`,
      };
    }
    if (len < 10) {
      return {
        cls: 'warn',
        title: `frps 面板对公网开放，口令偏短（:${summary.webPort}）`,
        detail: `webServer.addr 是 ${addr}，当前口令 ${len} 位。公网上的面板建议 16 位以上随机口令；只想自己看的话，把 addr 改成 127.0.0.1，用 SSH 隧道访问更安全。`,
      };
    }
    /* 口令够长也提醒一句：面板里存着 auth.token，公网上被扫到就是白给一个攻击面。 */
    return {
      cls: 'warn',
      title: `frps 面板对公网开放（:${summary.webPort}）`,
      detail: `webServer.addr 是 ${addr}，口令 ${len} 位。口令本身够长，但这个端口对整个互联网开放，面板里又能看到 auth.token。不需要外网访问的话，把 addr 改成 127.0.0.1（配合 SSH 隧道）或用云厂商安全组限定来源 IP。`,
    };
  })();

  $('#view').innerHTML = `
    <div class="view server-view">
      <div class="page-head">
        <div class="page-title">
          <h1>服务器</h1>
          <p>${esc(s.username)}@${esc(s.host)}:${esc(s.port)} · SSH 已连接 · ${esc(osText)}</p>
        </div>
        <div class="page-actions">
          ${localTunnelBtn()}
          <button class="btn" type="button" data-act="server.refresh">${icon('reload')}<span>刷新</span></button>
          <button class="btn ghost" type="button" data-act="server.disconnect">${icon('x')}<span>断开 SSH</span></button>
        </div>
      </div>

      ${serverConnBar()}
      ${connCardMarkup()}

      ${terminalCardMarkup()}

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
            <button class="btn ghost" type="button" data-act="server.openlogs">${icon('terminal')}<span>frps 日志</span></button>
            ${summary.webPort ? `<button class="btn ghost" type="button" data-act="server.open.dashboard">${icon('external')}<span>打开面板 :${summary.webPort}</span></button>` : ''}
            <button class="btn ghost" type="button" data-act="server.guide">${icon('shield')}<span>排错指南</span></button>
            ${info.frpsInstalled ? `<button class="btn ghost danger-text" type="button" data-act="server.uninstall">${icon('trash')}<span>卸载</span></button>` : ''}
          </div>
        </div>
      </section>

      ${versionMismatchMarkup(info)}

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

      ${dashRisk ? `<div class="note ${dashRisk.cls}">${icon('alert')}<div><strong>${esc(dashRisk.title)}</strong><br>${esc(dashRisk.detail)}
        <div style="margin-top:10px"><button class="btn small" type="button" data-act="dash.rotate">${icon('shield')}<span>换成随机口令</span></button></div>
      </div></div>` : ''}

      <section class="card selftest-card" id="selftest-panel">${selftestMarkup()}</section>

      ${nginxCardMarkup()}

      ${firewallCardMarkup()}

      <div class="srv-section-title">配置管理</div>

      <section class="card config-card">
        <div class="card-head">
          <div class="ch-icon">${icon('edit')}</div>
          <div class="grow"><h3>配置文件</h3><p>直接编辑 TOML，保存前自动校验语法并备份；改完可一键重启对应进程。</p></div>
          <div class="mode-tabs">
            <button class="mode-tab ${s.mode === 'frps' ? 'active' : ''}" type="button" data-act="server.mode" data-mode="frps">frps.toml · 服务器</button>
            <button class="mode-tab ${s.mode === 'frpc' ? 'active' : ''}" type="button" data-act="server.mode" data-mode="frpc">frpc.toml · 本机</button>
          </div>
        </div>
        ${frpsPane()}
        ${frpcPane()}
      </section>

      <div class="srv-section-title">运行监控</div>

      <div class="srv-monitor-grid">
        <section class="card">
          <div class="card-head">
            <div class="ch-icon">${icon('link')}</div>
            <div class="grow"><h3>本机映射${(S.state && S.state.proxies || []).length ? ` <span class="count-chip">${(S.state.proxies || []).length}</span>` : ''}</h3><p>frpc 当前规则 · 链路状态来自三层检查。</p></div>
            <div class="page-actions">
              <button class="btn ghost" type="button" data-act="goto.proxies">${icon('external')}<span>去代理映射</span></button>
            </div>
          </div>
          <div class="server-proxy-list" id="server-proxies">${serverProxyRows()}</div>
        </section>
      </div>
    </div>`;

  renderServerLogs();
  // 终端会话跨重渲染存活：DOM 被 innerHTML 换掉后把 xterm 搬回新容器。
  remountShellTerm();
  /* 连接表单里的「这台机器已有档案」提示要在渲染后立刻反映当前预填地址。 */
  updateConnectHostNote();
  if (s.connected && !s.logs && !s.logsLoading) {
    s.logsLoading = true;
    loadServerLogs().catch(() => {}).finally(() => { s.logsLoading = false; });
  }
  /* nginx / 防火墙 / 配置体检：从 IPC 连上服务器时（自动连接、恢复会话、脚本）不会走
   * connectServer 分支，这三份状态就没人拉，卡片永久停在「检测中…」/「（未知）」。
   * 渲染时发现是空的就补拉一次，用单独的 in-flight 标记防止重入。 */
  if (s.connected) {
    if (!s.nginxReady && !s.nginxLoading) {
      s.nginxLoading = true;
      loadServerNginx(true).catch(() => {}).finally(() => { s.nginxLoading = false; });
    }
    if (!s.firewallReady && !s.firewallLoading) {
      s.firewallLoading = true;
      loadServerFirewall(true).catch(() => {}).finally(() => { s.firewallLoading = false; });
    }
    if (!s.nginxHealth && !s.nginxHealthBusy) {
      loadServerNginxHealth({ force: false }).catch(() => {});
    }
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
          ${s.installBusy ? `<button class="btn ghost" type="button" data-act="server.bootstrap.cancel">${icon('x')}<span>取消</span></button>` : ''}
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

/* 服务器页顶部的「连接」chips：一条连接 = 一台服务器（自己的 frpc.toml、管理端口、日志）。
 * 点标签 = 切换「当前连接」；切换会先停掉正在跑的隧道（每条连接各自一个 frpc，带着旧隧道
 * 换目标会让配置、健康检查、日志都错位），所以有隧道在跑时先确认一次。 */
function serverConnBar() {
  const state = S.state || {};
  const list = Array.isArray(state.connections) ? state.connections : [];
  if (list.length <= 1) return '';
  const activeId = state.activeConnectionId || '';
  const chips = list.map((c) => {
    const rt = c.runtime || {};
    const dot = rt.connected ? 'ok' : (rt.running ? 'warn' : 'idle');
    const counts = c.counts ? `${c.counts.online}/${c.counts.total}` : '';
    const tip = c.host ? ` title="SSH ${esc(c.username || 'root')}@${esc(c.host)}:${esc(c.port || 22)}"` : '';
    return '<button class="chip' + (c.id === activeId ? ' on' : '') + '" type="button"' + tip + ' data-act="server.conn.switch" data-conn="' + esc(c.id) + '">' +
      '<span class="schip-dot ' + dot + '"></span>' + esc(c.name || c.id) +
      (counts ? '<span class="chip-count">' + esc(counts) + '</span>' : '') + '</button>';
  }).join('');
  const cur = list.find((c) => c.id === activeId) || null;
  const ssh = S.server && S.server.connected ? `SSH 已连接 ${esc(S.server.host || '')}` : 'SSH 未连接';
  return `<div class="chips server-chips">${chips}</div>
    <div class="field-hint" style="margin:-6px 0 14px">当前查看：${esc(cur ? (cur.name || cur.id) : '—')} · ${ssh}。切换标签会先停掉正在跑的隧道。</div>`;
}

/* 当前连接的隧道启停：服务器页也能直接操作，不用回概览。 */
function localTunnelBtn() {
  const st = S.state || {};
  const id = st.activeConnectionId || '';
  const c = (st.connections || []).find((x) => x.id === id);
  if (!c) return '';
  const running = !!(c.runtime && (c.runtime.running || c.runtime.connected));
  const label = running ? '停止隧道' : '启动隧道';
  return `<button class="btn ${running ? 'ghost' : 'primary'}" type="button" data-act="conn.toggle" data-id="${esc(id)}">${icon(running ? 'stop' : 'play')}<span>${label}</span></button>`;
}

/* 服务器页顶部那张紧凑卡（1.2.193）：一条连接 = 一台服务器，
 * 这里只说清「我是谁、连的是哪、frps 什么状态、密码存没存」，编辑走弹窗。 */
function connCardMarkup() {
  const conn = activeConnectionInfo();
  if (!conn) return '';
  const st = S.state || {};
  const summary = (st.config && st.config.summary) || {};
  /* token 的真相在磁盘上的 frpc.toml（连接里刻意不存），所以先看配置里的 auth.token，
   * 再回退老字段 settings.hasToken —— 否则配置里有 token 也会显示「未设置」，误导用户去重填。 */
  const cfgToken = !!(st.config && st.config.auth && st.config.auth.token);
  const tokenState = (cfgToken || (st.settings && st.settings.hasToken)) ? '已设置' : '未设置';
  /* 连接还没回写过地址时，退回显示配置文件里的 serverAddr：
   * 否则卡片说「还没有填 SSH 地址」而下面的表单里明明有地址，用户会以为是两回事。 */
  const cfgAddr = (S.state && S.state.config && S.state.config.serverAddr) || '';
  const sshHost = conn.host || cfgAddr;
  const ssh = sshHost
    ? `SSH ${esc(conn.username || 'root')}@${esc(sshHost)}:${esc(conn.host ? (conn.port || 22) : 22)}${conn.host ? '' : '（来自配置文件）'}`
    : '还没有填 SSH 地址';
  const facts = [
    ssh,
    summary.bindPort ? `frps 端口 ${summary.bindPort}` : '',
    `Token ${tokenState}`,
    conn.hasPassword ? '密码已保存' : '密码未保存',
  ].filter(Boolean);
  const rt = conn.runtime || {};
  const dot = rt.connected ? 'ok' : (rt.running ? 'warn' : 'idle');
  const stateText = rt.connected ? '隧道已连接' : (rt.running ? '隧道运行中（还没连上）' : '隧道未运行');
  return `<section class="card conn-card">
    <div class="conn-main">
      <span class="schip-dot ${dot}" style="width:9px;height:9px"></span>
      <div class="grow">
        <div class="conn-title"><h3>${esc(conn.name || conn.id)}</h3><span class="badge muted" style="font-size:10px">${esc(stateText)}</span></div>
        <p class="conn-facts">${facts.map((x) => esc(x)).join('<span class="conn-sep">·</span>')}</p>
      </div>
      <div class="conn-actions">
        <button class="btn" type="button" data-act="conn.edit">${icon('edit')}<span>编辑连接</span></button>
        ${S.server.connected ? `<button class="btn ghost" type="button" data-act="server.disconnect">${icon('x')}<span>断开 SSH</span></button>` : ''}
      </div>
    </div>
  </section>`;
}

/* 编辑连接：SSH 地址 / 端口 / 用户名 / 密码（密码进 DPAPI，不写 frpc.toml）。 */
function openConnectionEditor() {
  const conn = activeConnectionInfo();
  if (!conn) return;
  openModal(`
    <div class="modal" style="width:560px">
      <div class="modal-head">
        <div class="mh-icon">${icon('server')}</div>
        <div class="grow"><h3>连接设置</h3><p>这台服务器的 SSH 地址与密码。frps 的地址与 Token 在「配置文件」卡里改。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <form id="conn-edit-form" class="modal-body" autocomplete="off" data-id="${esc(conn.id)}">
        <div class="form-grid">
          <div class="field span-2">
            <label>连接名称</label>
            <input class="input" name="name" value="${esc(conn.name || '')}" placeholder="例如 日本 frps">
          </div>
          <div class="field span-2">
            <label>服务器 IP / 域名</label>
            <input class="input" name="host" value="${esc(conn.host || '')}" placeholder="例如 frps.example.com" spellcheck="false">
          </div>
          <div class="field">
            <label>SSH 端口</label>
            <input class="input" name="port" type="number" min="1" max="65535" value="${esc(conn.port || 22)}">
          </div>
          <div class="field">
            <label>SSH 用户名</label>
            <input class="input" name="username" value="${esc(conn.username || 'root')}" spellcheck="false">
          </div>
          <div class="field span-2">
            <label>SSH 密码 ${conn.hasPassword ? '<span class="field-hint">已保存，留空保持不变</span>' : ''}</label>
            <input class="input" name="password" type="password" placeholder="${conn.hasPassword ? '使用已保存的密码' : '登录密码'}" autocomplete="new-password">
          </div>
        </div>
        <div class="field-hint" id="conn-edit-hint">密码用 Windows DPAPI 加密保存在本机，不会写进 frpc.toml，也不会进日志。</div>
      </form>
      <div class="modal-foot">
        <span class="mf-left"></span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
        <button class="btn primary" type="button" id="conn-edit-save">${icon('check')}<span>保存</span></button>
      </div>
    </div>`);
  const btn = $('#conn-edit-save');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const form = $('#conn-edit-form');
    if (!form) return;
    const fd = new FormData(form);
    const id = form.dataset.id;
    btn.disabled = true;
    try {
      const patch = {
        id,
        name: String(fd.get('name') || '').trim(),
        host: String(fd.get('host') || '').trim(),
        port: Number(fd.get('port') || 22),
        username: String(fd.get('username') || '').trim() || 'root',
      };
      if (!patch.host) patch.host = '';
      const res = await FRP.connectionUpdate(patch);
      if (!res || !res.ok) { toast('error', '保存失败', (res && res.error) || '请稍后再试'); return; }
      const pw = String(fd.get('password') || '');
      if (pw) {
        const sres = await FRP.connectionSecret({ id, password: pw });
        if (!sres || !sres.ok) { toast('error', '密码没保存成功', (sres && sres.error) || ''); return; }
      }
      closeModal();
      toast('success', '连接设置已保存', patch.host || '未填写地址');
      await reloadAfterConnectionChange();
      renderServer(true);
    } finally { btn.disabled = false; }
  });
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
  const profileOptions = profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === s.activeServerId ? 'selected' : ''}>${esc(p.name || p.host)}${p.host ? ` · ${esc(p.host)}:${esc(p.port || 22)}` : ''}${p.id === s.clientServerId ? '（本机隧道）' : ''}</option>`).join('');
  /* 历史遗留：同一个 IP 可能堆着多条档案（老版本每连一次就新建一条）。
   * 有重复时给一个「整理」入口；平时不出现，避免干扰。 */
  const keyCounts = new Map();
  for (const p of profiles) {
    const k = profileKeyOf(p.host, p.port);
    if (k) keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
  }
  const dupExtra = [...keyCounts.values()].reduce((n, c) => n + (c > 1 ? c - 1 : 0), 0);

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
          ${dupExtra ? `<button class="btn ghost" type="button" data-act="server.profiles.dedupe" title="同一台机器（IP + SSH 端口）只保留一条档案，其余合并进来">${icon('box')}<span>整理重复（${dupExtra}）</span></button>` : ''}
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
            <div class="pd-actions"><span class="badge muted"><span class="bdot"></span>仅提示，不会自动改隧道</span></div>
          </div>
          ${rows.length ? `<div class="pd-rows">
            <div class="pd-row pd-head-row"><span>项目</span><span>当前档案</span><span>本机 frpc</span></div>
            ${rows.map((r) => `<div class="pd-row"><span>${esc(r.label)}</span><span class="mono">${esc(r.want)}</span><span class="mono bad">${esc(r.got)}</span></div>`).join('')}
          </div>` : ''}
          <p class="pd-note">${rows.length ? '' : '参数与本机 frpc 完全一致，只是绑定关系没有指向这个档案。'}${clientLine}。想换隧道目标请改<b>这条连接</b>的 frpc.toml（配置卡或「从零初始化」），不会影响其它连接。${active.hasToken ? '' : ' 此档案还没有 Token，请先编辑档案填写。'}</p>
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
  if (!S.server.savedCredential) {
    // 刚启动那一下，主进程可能还没把档案里的密码读出来（savedCredential 是快照），
    // 这时候如果直接放弃，界面就会一直停在「未连接」，用户只能切一次档案才好。
    // 档案里明明有密码就再拉一次状态重试一次；真的没存密码才走表单。
    const p = (S.server.profiles || []).find((x) => x.id === active.id);
    if (!p || !p.hasPassword) return;
    if (!S.server.credRetry) {
      S.server.credRetry = true;
      setTimeout(() => {
        S.server.credRetry = false;
        loadServerState({ autoConnect: true }).catch(() => {});
      }, 900);
    }
    return;
  }
  if (S.server.autoConnecting) return;
  S.server.autoConnecting = true;
  renderServer(true);
  const seq = serverSeq();
  try {
    let res = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      res = await FRP.serverConnect({
        host: active.host,
        port: Number(active.port) || 22,
        username: active.username || 'root',
        password: '',
        remember: true,
        serverId: active.id,
      });
      if (res && res.ok) break;
      // 需要人工介入（密码失效 / 地址与档案不一致）的错误重试也没意义
      if (res && (res.needsPassword || res.needsDecision)) break;
      // 开机那几秒 SSH 偶尔会失败一次（网络栈还没起来 / sshd 还在加载），等 1.5 秒再来一遍
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
    if (serverSeqStale(seq)) {
      /* 连接其实已经成功，但状态序号被别的刷新抢走了（连接过程中主进程会发
       * server:binding-changed，前端会顺带 refresh 一次），那次刷新的快照可能是在
       * 连接完成之前取的。直接 return 会让界面停在「无法连接」，后端却已经连上。
       * 所以这里补一次状态同步，让界面追上真实状态。 */
      if (res && res.ok) await loadServerState().catch(() => {});
      return;
    }
    if (!res || !res.ok) {
      // 保存的密码失效（服务器改过密码）时退回表单，让用户补一次。
      if (res && res.needsPassword) toast('info', '需要手动输入密码', `「${active.name}」保存的密码已不可用`);
      else toastResult(res);
      return;
    }
    S.server.wizard = null;
    S.server.wizardDirty = false;
    S.server.mode = 'frps';
    S.server.frpcRaw = '';
    S.server.logs = '';
    S.server.logsError = '';
    applyServerState(res.data, seq);
    S.server.nginx = null;      // 旧服务器的 nginx 状态不残留，连接后重新检测
    S.server.nginxReady = false;
    S.server.selftest = null;   // 旧服务器的就绪检查结果不残留
    S.server.nginxHealth = null; // 体检结果同理（1.2.73）
    S.server.confView = null;
    S.server.firewall = null;   // 旧服务器的防火墙状态不残留
    S.server.firewallReady = false;
    S.certs.server = { loaded: false, loading: false, certs: [], host: '', scannedAt: 0, truncated: false, error: '' }; // 换服务器后证书列表要重扫
  } catch (e) {
    toast('error', '自动连接失败', String((e && e.message) || e));
  } finally {
    S.server.autoConnecting = false;
    renderServer(true);
    if (S.server.connected) {
      loadServerLogs().catch(() => {});
      loadServerNginx(true).catch(() => {});
    loadServerNginxHealth({ force: false }).catch(() => {});
      loadServerFirewall(true).catch(() => {});
      openShellTerm().catch(() => {});   // SSH 终端默认打开
    }
  }
}

async function selectServerProfile(id) {
  if (!id) return;
  if (S.server.switching) return;
  S.server.switching = true;
  const seq = serverSeq();
  // 切档案会断开旧 SSH 连接，旧服务器上的终端会话必须一起收掉。
  if (shellState.open || shellState.term) disposeShellTerm(false);
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


function confirmDeleteServerProfile() {
  const active = activeServerProfile();
  if (!active) return;
  const bound = active.id === S.server.clientServerId;
  openModal(`
    <div class="modal" style="width:480px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--red)">${icon('trash')}</div>
        <div class="grow"><h3>清除这台服务器在本机保存的信息</h3><p>只删 SSH 地址、账号与 Token 记录；不会卸载服务器上的 frps，也不会删掉这条连接。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="note warn">${icon('alert')}<div>确定清除 <strong>${esc(active.name)}</strong>（${esc(active.host)}）保存的信息吗？保存的 SSH 密码会一并清除，下次连接需要重新输入。</div></div>
        ${bound ? `<label class="check-line" style="margin-top:12px"><input type="checkbox" id="profile-del-force"> 这是本机隧道当前目标，同时解除绑定<strong>并停止隧道</strong>（不会修改 frpc.toml，以后重建档案还能接着用）</label>` : ''}
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
        /* 删除可能顺手把隧道停了，全局状态（顶栏胶囊、概览、代理映射）得一起换掉，
         * 否则页面还停在“全绿”，看起来像删除没生效。 */
        if (res.data && res.data.appState) S.state = res.data.appState;
        updateChrome();
        renderCurrent({ force: true });
        if (res.data && res.data.stoppedTunnel) toast('success', '档案已删除，隧道已停止', active.name);
        else if (res.data && res.data.stopError) toast('warn', '档案已删除，但隧道没停下来', res.data.stopError);
        else if (res.data && res.data.stopSkipped === 'service') toast('warn', '档案已删除，但隧道还在跑', '隧道由系统服务托管，需要到「设置 → 隧道」里停止服务');
        else if (res.data && res.data.stopSkipped === 'external') toast('warn', '档案已删除，但隧道还在跑', '这个 frpc 不是控制台启动的，请到它的来源处停止');
        else toast('success', '档案已删除', active.name);
      } else {
        confirm.disabled = false;
        toastResult(res);
      }
    });
  }
}

/* 档案身份 = host + SSH 端口（用户名只是登录属性）。与服务端 settings.serverProfileKey 保持一致。 */
function profileKeyOf(host, port) {
  const h = String(host || '').trim().toLowerCase().replace(/\.+$/, '');
  const p = Number(port) || 22;
  return h ? `${h}:${p}` : '';
}

/* 连接表单里实时告诉用户：这个地址已经有档案了（连接会更新它），还是会被新建一条。 */
function updateConnectHostNote() {
  const note = $('#cf-host-note');
  const form = $('#server-form');
  if (!note || !form) return;
  const host = (form.querySelector('[name="host"]') || {}).value || '';
  const port = (form.querySelector('[name="port"]') || {}).value || 22;
  const key = profileKeyOf(host, port);
  if (!key) {
    note.className = 'field-hint';
    note.textContent = '同一台机器（IP + SSH 端口）只对应一条连接；连已有的机器会更新那条，不会新建。';
    return;
  }
  const hit = (S.server.profiles || []).find((p) => profileKeyOf(p.host, p.port) === key);
  if (hit) {
    const when = Number(hit.lastConnectedAt) ? new Date(Number(hit.lastConnectedAt)).toLocaleString('zh-CN', { hour12: false }) : '';
    note.className = 'field-hint ok';
    note.textContent = `已有连接「${hit.name || hit.host}」${when ? ` · 最近连接 ${when}` : ''}——会更新这条连接，不会新建。`;
  } else {
    note.className = 'field-hint';
    note.textContent = '这台机器还没有连接，连接成功后会新建一条。';
  }
}

/* 界面拿「当前连接」：它自己记着要连哪台机器（1.2.192）。 */
function activeConnectionInfo() {
  const st = S.state || {};
  return (st.connections || []).find((c) => c.id === st.activeConnectionId) || null;
}

function connectedFormMarkup() {
  const s = S.server;
  const saved = s.saved || {};
  const state = S.state || {};
  const active = (s.profiles || []).find((p) => p.id === s.activeServerId) || null;
  const connNow = activeConnectionInfo();
  const defaultHost = (connNow && connNow.host) || (active && active.host) || saved.host || (state.config && state.config.serverAddr) || '';
  const defaultUser = (connNow && connNow.username) || (active && active.username) || saved.username || 'root';
  const defaultPort = (connNow && connNow.port) || (active && active.port) || saved.port || 22;
  return `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>服务器</h1>
          <p>通过 SSH 登录自己的服务器，把 frps 装好、配置好、跑起来。</p>
        </div>
        <div class="page-actions">${localTunnelBtn()}</div>
      </div>
      ${serverConnBar()}
      ${connCardMarkup()}
      <section class="card">
        <div class="card-head">
          <div class="ch-icon">${icon('server')}</div>
          <div class="grow"><h3>连接 frps 服务器</h3><p>需要服务器开放 SSH（默认 22）和登录密码。全链路连通性在概览与代理映射页检查。</p></div>
        </div>
        <form id="server-form" class="server-form" autocomplete="off" onsubmit="return false">
          <div class="field span-2">
            <label>服务器 IP / 域名 <span class="req">*</span></label>
            <input class="input" name="host" value="${esc(defaultHost)}" placeholder="例如 frps.example.com" spellcheck="false">
            <div class="field-hint" id="cf-host-note">连过的机器会记住地址与密码（密码用 Windows DPAPI 加密保存），下次直接点「连接并获取状态」即可。</div>
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

/* 主机指纹变了：把「上次 / 现在」两个指纹摊给用户，让他自己决定要不要信任。
 * 这一步不能自动放行 —— 换机器是正常情况，中间人劫持也是这个表现。 */
function askTrustHost(info, onTrust) {
  const body = [
    `这台机器（${esc(info.host)}:${esc(String(info.port || 22))}）出示的主机密钥和上次记录的不一样。`,
    '',
    `上次：${esc(info.previous || '（无记录）')}`,
    `现在：${esc(info.fingerprint)}`,
    '',
    '换系统、重装 SSH、换机器都会导致这个变化；也可能是有人劫持了这台机器的 SSH 端口（中间人）。',
    '确认是你自己的改动之后再信任，否则先别连。',
    '',
    '怎么核对（在你自己能确认身份的地方执行，不要用这个连不上的机器）：',
    `① 在服务器本机：ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub（或 ssh_host_rsa_key.pub）`,
    '② 或在另一台已信任它的机器上：ssh-keyscan -t ed25519 <这台机器的地址> | ssh-keygen -lf -',
    '两条输出都是 SHA256:… 的形式，必须和上面「现在」那一串一字不差。',
  ].join('\n');
  confirmDialog({
    title: '主机密钥变了',
    body,
    confirmText: '信任新指纹并连接',
    danger: true,
    onConfirm: () => onTrust(),
  });
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
      if (res && res.needsTrustHost) {
        const info = res.needsTrustHost;
        askTrustHost(info, async () => {
          const trusted = await FRP.serverTrustHost({ host: info.host, port: info.port, fingerprint: info.fingerprint });
          if (!trusted || !trusted.ok) { toastResult(trusted); return; }
          connectServer(null, { adoptProfile: false }).catch((error) =>
            toast('error', '连接失败', String((error && error.message) || error)),
          );
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
    S.server.mode = 'frps';
    S.server.frpcRaw = '';
    S.server.logs = '';
    applyServerState(res.data, seq);
    S.server.nginx = null;      // 旧服务器的 nginx 状态不残留，连接后重新检测
    S.server.nginxReady = false;
    S.server.selftest = null;   // 旧服务器的就绪检查结果不残留
    S.server.nginxHealth = null; // 体检结果同理（1.2.73）
    S.server.confView = null;
    S.server.firewall = null;   // 旧服务器的防火墙状态不残留
    S.server.firewallReady = false;
    S.certs.server = { loaded: false, loading: false, certs: [], host: '', scannedAt: 0, truncated: false, error: '' }; // 换服务器后证书列表要重扫
    renderServer(true);
    openShellTerm().catch(() => {});   // SSH 终端默认打开
    if (res.data && res.data.adoptProfile) {
      toast('success', '已连接并更新档案地址', `${username}@${host}:${port}`);
    } else {
      toast('success', '已连接服务器', `${username}@${host}:${port}`);
    }
    await loadServerLogs();
    loadServerNginx(true).catch(() => {});
    loadServerNginxHealth({ force: false }).catch(() => {});
    loadServerFirewall(true).catch(() => {});
  });
}

function setServerMode(mode) {
  S.server.mode = mode === 'frpc' ? 'frpc' : 'frps';
  const frps = $('#frps-pane');
  const frpc = $('#frpc-pane');
  if (frps) frps.classList.toggle('hidden', S.server.mode !== 'frps');
  if (frpc) frpc.classList.toggle('hidden', S.server.mode !== 'frpc');
  document.querySelectorAll('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === S.server.mode));
  if (S.server.mode === 'frps') {
    const area = $('#server-config');
    if (area && S.server.config && !area.value) area.value = S.server.config;
  } else {
    loadFrpcRaw();
  }
}

async function loadFrpcRaw() {
  const res = await FRP.configRaw();
  if (res && res.ok) {
    S.server.frpcRaw = res.data.content;
    const area = $('#frpc-config');
    if (area) area.value = S.server.frpcRaw;
  } else {
    toastResult(res);
  }
}

async function saveFrpcConfig(restart, btn) {
  const area = $('#frpc-config');
  if (!area) return;
  const content = area.value;
  if (!content.trim()) return toast('error', '配置内容为空');
  await withBusy(btn, async () => {
    const res = await FRP.configSaveRaw(content, restart);
    if (!res || !res.ok) return toastResult(res);
    S.server.frpcRaw = content;
    setVerifyResult(null, '');
    toast('success', restart ? 'frpc.toml 已保存并重启 frpc' : 'frpc.toml 已保存' + (res.data && res.data.changed === false ? '（内容无变化）' : ''));
  });
}

function setVerifyResult(okFlag, msg) {
  const box = $('#frpc-verify-result');
  if (!box) return;
  if (msg) {
    box.hidden = false;
    box.className = `note ${okFlag ? 'ok' : 'warn'}`;
    box.textContent = msg;
  } else {
    box.hidden = true;
    box.textContent = '';
  }
}

async function verifyFrpcConfig(btn) {
  const area = $('#frpc-config');
  if (!area) return;
  const content = area.value;
  if (!content.trim()) return toast('error', '配置内容为空');
  await withBusy(btn, async () => {
    const res = await FRP.configVerifyRaw(content);
    if (res && res.ok) {
      setVerifyResult(true, '✓ 配置语法正确');
    } else {
      const msg = (res && res.error) || '校验失败';
      setVerifyResult(false, msg);
    }
  });
}

async function saveServerConfig(restart, btn) {
  if (!S.server.configPath) return runServerBootstrap(btn);
  const area = $('#server-config');
  if (!area) return;
  const content = area.value;
  if (!content.trim()) return toast('error', '配置内容为空');
  await withBusy(btn, async () => {
    const seq = serverSeq();
    const res = await FRP.serverSaveConfig(content, restart);
    if (serverSeqStale(seq)) return;
    if (!res || !res.ok) {
      const details = res && res.conflictDetails && res.conflictDetails.length ? res.conflictDetails : null;
      if (details) {
        const choice = await confirmFrpsPortConflict(details);
        if (choice === 'remap') {
          const retry = await FRP.serverSaveConfig(content, restart, { action: 'remap' });
          if (serverSeqStale(seq)) return;
          if (!retry || !retry.ok) return toastResult(retry);
          return applyServerConfigSave(retry, restart, seq);
        } else if (choice === 'kill') {
          const kill = await FRP.serverKillPorts(details.map((d) => d.port));
          if (kill && kill.ok) {
            const retry = await FRP.serverSaveConfig(content, restart);
            if (serverSeqStale(seq)) return;
            if (!retry || !retry.ok) return toastResult(retry);
            return applyServerConfigSave(retry, restart, seq);
          }
          toastResult(kill);
        }
        return;
      }
      return toastResult(res);
    }
    return applyServerConfigSave(res, restart, seq);
  });
}

async function applyServerConfigSave(res, restart, seq) {
  applyServerState(res.data && res.data.state, seq);
  S.server.wizardDirty = false;
  const backup = res.data && res.data.backup ? `备份：${res.data.backup}` : '';
  const remap = res.data && res.data.remap;
  const remapText = remap ? ` · 端口已自动调整：${Object.entries(remap).map(([o, n]) => `${o}→${n}`).join('、')}` : '';
  const nginxNote = res.data && res.data.nginx ? (res.data.nginx.ok ? ' · nginx 反代已同步' : ' · nginx 反代未同步') : '';
  const clientNote = res.data && res.data.client ? (res.data.client.ok ? ` · 本机隧道已指向 ${res.data.client.serverPort}` : ' · 本机隧道未同步') : '';
  if (restart) {
    const after = res.data && res.data.restarted && res.data.restarted.after;
    toast('success', '配置已保存并重启 frps', `${backup}${remapText}${nginxNote}${clientNote}${after && after.statusText ? ` · ${after.statusText}` : ''}`);
  } else {
    toast('success', '配置已保存', `${backup}${remapText}${nginxNote}${clientNote}`);
  }
  renderServer(true);
  await loadServerLogs();
}

async function runServerBootstrap(btn) {
  if (S.server.installBusy) return;
  /* 1.2.49 起配置卡片改成了 frps.toml / frpc.toml 两个编辑器，不再渲染「服务端配置向导」
   * 表单；一键初始化改用内存里的向导字段（连接时已按档案 token + 随机面板密码填好）。 */
  const fields = S.server.wizard || wizardDefaults();
  if (!fields || !Number(fields.bindPort)) return toast('error', '请先填写配置向导');
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
  if (res && res.cancelled) {
    S.server.installProgress = { percent: 0, text: '已取消' };
    renderServer(true);
    toast('warn', '已取消初始化', '服务器上已安装的内容已回滚清理');
    await loadServerLogs();
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
  /* 面板密码留空时后端会自动生成一个：必须让用户看到，否则他登录不进 Dashboard。 */
  const generatedPw = (res.data && res.data.generatedPassword) || '';
  /* 鉴权 token 留空时后端也会自动生成一个：本机 frpc 已被同步成它，但用户在别的设备上要用同一个。 */
  const generatedToken = (res.data && res.data.generatedToken) || '';
  renderServer(true);
  await loadServerLogs();
  if (generatedPw) {
    await confirmDialog({
      title: '已自动生成 Dashboard 密码',
      body: [
        'frps 面板（Dashboard）默认监听 0.0.0.0，也就是公网能访问；密码留空等于谁扫到谁能进。',
        '',
        '这次已自动生成一个密码，请记下来（面板用户可以填 admin）：',
        '',
        generatedPw,
        '',
        '想改成自己的密码：在「配置文件」里改 [webServer] 的 password，保存并重启 frps。',
      ].join('\n'),
      confirmText: '我记下了',
      cancelText: '关闭',
    });
  }
  if (generatedToken) {
    await confirmDialog({
      title: '已自动生成鉴权 Token',
      body: [
        '你开了鉴权但 Token 留空了——空 Token 的 frps 等于不校验身份，谁都能把流量接上去。',
        '',
        '这次已自动生成一个，请记下来（本机 frpc 已经换成它）：',
        '',
        generatedToken,
        '',
        '想自己定：在「配置文件」里改 [auth] 的 token，保存并重启 frps（本机 frpc 会在保存后同步）。',
      ].join('\n'),
      confirmText: '我记下了',
      cancelText: '关闭',
    });
  }
}

async function runServerUninstall(btn) {
  const info = S.server.info || {};
  if (!info.frpsInstalled && !S.server.configPath && !(info.binaryPath && info.binaryPath !== 'frps')) {
    toast('warn', '没有可卸载的 frps', '服务器上未检测到 frps 安装');
    return;
  }
  const okConfirm = await confirmDialog({
    title: '卸载服务器上的 frps',
    body: '将停止并删除服务器上的 frps：删除二进制、删除 systemd 服务（frps.service）、备份后删除配置（备份保留为 .bak-uninstalled-时间戳）。本机 frpc 与隧道不受影响。确定继续吗？',
    confirmText: '卸载',
    cancelText: '取消',
    danger: true,
  });
  if (!okConfirm) return;
  await withBusy(btn, async () => {
    const res = await FRP.serverUninstall({ removeConfig: true }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    if (res && res.ok) {
      applyServerState(res.data && res.data.state);
      if (res.data && res.data.appState) S.state = res.data.appState;
      const removed = (res.data && res.data.removedBinary) ? `已删除 ${res.data.removedBinary}` : '';
      const backup = (res.data && res.data.configBackup) ? `，配置备份：${res.data.configBackup}` : '';
      toast('success', '已卸载服务器上的 frps', `${removed}${backup}`);
    } else {
      toastResult(res);
    }
    renderServer(true);
    await loadServerLogs();
  });
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
    const warnFlag = !!(res && res.ok && res.data && res.data.warn);
    S.server.selftest.steps[layer] = {
      state: data.ok ? 'ok' : 'fail',
      warn: data.ok ? warnFlag : false,
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
  refreshServerInfo(true).catch(() => {});
  renderSelfTest();
  if (failure) {
    toast('error', '服务器还没准备好', failure);
    return;
  }
  toast('success', '服务器已就绪', '接下来去「代理映射」添加隧道，三层全绿即可访问');
}

async function disconnectServer() {
  const seq = serverSeq();
  // 断开连接时后端 shell 也一并关了；前端终端状态跟着收掉，避免悬挂的事件订阅。
  if (shellState.open || shellState.term) disposeShellTerm(false);
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


/* ----------------------------- HTTPS 证书 ------------------------------ */

async function loadCerts({ silent = false } = {}) {
  if (!silent) S.certs.busy = true;
  try {
    const [listRes, dnsRes] = await Promise.all([FRP.certList(), FRP.dnsState()]);
    if (listRes && listRes.ok) S.certs.list = listRes.data.certs || [];
    if (dnsRes && dnsRes.ok) S.certs.dns = dnsRes.data;
    S.certs.loaded = true;
  } finally {
    S.certs.busy = false;
  }
  if (S.view === 'certs') renderCerts(true);
}

function certExpiryTone(days) {
  if (days > 30) return 'ok';
  if (days >= 15) return 'amber';
  return 'bad';
}

function certRow(c, hasToken = false) {
  const tone = certExpiryTone(c.daysLeft);
  const nginxOk = !!(c.nginx && c.nginx.ok);
  const nginxHost = (c.nginx && c.nginx.serverHost) || '';
  const deployedLabel = nginxOk ? `已部署到 ${nginxHost || 'nginx'}` : '未部署到 nginx';
  const deployedBadge = nginxOk
    ? `<span class="badge green">${esc(deployedLabel)}</span>`
    : `<span class="badge amber" title="证书还没上传到服务器 nginx，https://域名 暂时访问不了">${esc(deployedLabel)}</span>`;
  return `
    <div class="cert-row">
      <div class="cert-main">
        <div class="cert-title">
          <strong>${esc(c.domain)}</strong>
          ${c.domain.startsWith('*.') ? '<span class="badge">通配符</span>' : ''}
          ${c.origin === 'install' ? '<span class="badge" title="来自安装版的证书目录（只读扫描）">安装版</span>' : ''}
          ${c.imported ? `<span class="badge" title="从服务器 ${esc(c.imported.serverHost || '')} 导入">导入自 ${esc(c.imported.serverHost || '服务器')}</span>` : ''}
          ${deployedBadge}
          ${typeof c.daysLeft === 'number' && c.daysLeft <= 30 && !hasToken
            ? '<span class="badge amber" title="没有配置 DNS 渠道：自动续期不会运行，到期后 https://域名 会打不开">自动续期未开启</span>'
            : ''}
        </div>
        <div class="cert-meta mono">
          到期 ${c.notAfter ? new Date(c.notAfter).toLocaleString('zh-CN') : '—'}
          · 剩余 <span class="tag ${tone}">${c.daysLeft} 天</span>
          ${c.exists ? '' : ' · <span class="tag bad">文件缺失</span>'}
        </div>
        <div class="cert-paths mono">
          <div>证书 <code>${esc(c.crtPath)}</code> <button class="icon-btn" type="button" data-act="copy" data-text="${esc(c.crtPath)}" title="复制路径">${icon('copy')}</button></div>
          <div>私钥 <code>${esc(c.keyPath)}</code> <button class="icon-btn" type="button" data-act="copy" data-text="${esc(c.keyPath)}" title="复制路径">${icon('copy')}</button></div>
        </div>
      </div>
      <div class="cert-actions">
        <button class="btn small" type="button" data-act="cert.dns" data-domain="${esc(c.domain)}" title="查看这个域名的 DNS 记录与解析结果（可增删）">${icon('globe')}<span>DNS 记录</span></button>
        <button class="btn small" type="button" data-act="certs.nginx" data-domain="${esc(c.domain)}" title="上传到服务器 nginx 并配置反代">${icon('globe')}<span>部署到 nginx</span></button>
        <button class="btn small" type="button" data-act="certs.renew" data-domain="${esc(c.domain)}">${icon('reload')}<span>续期</span></button>
        <button class="btn small danger-text" type="button" data-act="certs.remove" data-domain="${esc(c.domain)}">${icon('trash')}<span>删除</span></button>
      </div>
    </div>`;
}

/* ---------------- 服务器上的证书（v1.2.62，只读扫描） ----------------
 * 本机 userData\certs 只是「本机签发/导入的」，服务器上往往还有企业面板（宝塔）或
 * 别的工具签的证书。这张卡片把服务器上实际存在的证书列出来：域名、来源、到期、路径。
 * 纯只读：只 grep 配置 + openssl 读文件，不改任何东西。 */
const CERT_SOURCE_LABEL = { bt: '宝塔', le: "Let's Encrypt", nginx: 'nginx' };

async function loadServerCerts({ force = false } = {}) {
  const st = S.certs.server;
  if (st.loading) return;
  if (!S.server.connected) {
    st.loaded = true;
    st.certs = [];
    st.host = '';
    st.error = '未连接服务器';
    if (S.view === 'certs') renderCerts(true);
    return;
  }
  if (!force && st.loaded && st.host === String(S.server.host || '')) return;
  st.loading = true;
  try {
    const res = await FRP.certServerScan({ force });
    if (res && res.ok) {
      st.certs = res.data.certs || [];
      st.host = res.data.host || String(S.server.host || '');
      st.scannedAt = res.data.scannedAt || Date.now();
      st.truncated = !!res.data.truncated;
      st.error = '';
    } else {
      st.error = (res && res.error) || '扫描服务器证书失败';
    }
    st.loaded = true;
  } catch (e) {
    st.error = String((e && e.message) || e);
    st.loaded = true;
  } finally {
    st.loading = false;
  }
  if (S.view === 'certs') renderCerts(true);
}

function serverCertRow(c, { hasLocal = false } = {}) {
  const tone = c.daysLeft === null || c.daysLeft === undefined ? 'amber' : certExpiryTone(c.daysLeft);
  const src = CERT_SOURCE_LABEL[c.source] || c.source || '未知';
  /* certbot 托管的证书不给「从服务器删除」的入口：文件删了 renewal 配置还在，
   * 下次 certbot renew 直接报错，站点也没证书了。 */
  const certbotManaged = c.source === 'le';
  const names = (Array.isArray(c.altNames) && c.altNames.length ? c.altNames : [c.domain]).filter(Boolean);
  const namesText = names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '');
  const daysText = c.daysLeft === null || c.daysLeft === undefined ? '到期未知' : `剩余 ${c.daysLeft} 天`;
  return `
    <div class="cert-row">
      <div class="cert-main">
        <div class="cert-title">
          <strong>${esc(c.domain || c.certPath)}</strong>
          <span class="badge">${esc(src)}</span>
          <span class="badge amber" title="这张证书在服务器上，本机库里还没有">仅服务器</span>
          ${String(c.domain || '').startsWith('*.') ? '<span class="badge">通配符</span>' : ''}
        </div>
        <div class="cert-meta mono">
          覆盖 ${esc(namesText)}
          · <span class="tag ${tone}">${esc(daysText)}</span>
          ${c.issuer ? ` · 签发者 ${esc(c.issuer)}` : ''}
        </div>
        <div class="cert-paths mono">
          <div>证书 <code>${esc(c.certPath)}</code> <button class="icon-btn" type="button" data-act="copy" data-text="${esc(c.certPath)}" title="复制路径">${icon('copy')}</button></div>
          ${c.keyPath ? `<div>私钥 <code>${esc(c.keyPath)}</code> <button class="icon-btn" type="button" data-act="copy" data-text="${esc(c.keyPath)}" title="复制路径">${icon('copy')}</button></div>` : ''}
        </div>
      </div>
      <div class="cert-actions">
        <button class="btn small" type="button" data-act="cert.import" data-domain="${esc(c.domain || '')}" data-cert-path="${esc(c.certPath)}" data-key-path="${esc(c.keyPath || '')}" title="把这张证书复制进本机库，之后可以统一查看/续期/部署" ${c.keyPath ? '' : 'disabled'}>${icon('down')}<span>导入到本机</span></button>
        <button class="btn small" type="button" data-act="cert.reissue" data-domain="${esc(c.domain || '')}" title="用本机的 ACME 渠道重新签一张同域名证书（需要已配置 DNS Token）">${icon('reload')}<span>用 ACME 重签</span></button>
        ${certbotManaged
          ? `<button class="btn small danger-text" type="button" disabled title="这张证书由 certbot 托管，直接删文件会让续期配置变成死链；请在服务器执行 certbot delete --cert-name ${esc(c.domain || '')}">${icon('trash')}<span>删除</span></button>`
          : `<button class="btn small danger-text" type="button" data-act="cert.server.remove" data-domain="${esc(c.domain || '')}" data-cert-path="${esc(c.certPath)}" data-key-path="${esc(c.keyPath || '')}" title="从服务器删除证书文件（删前先检查有没有站点在引用，删完自动重载 nginx）">${icon('trash')}<span>删除</span></button>`}
        ${hasLocal ? '<span class="badge">本机已有</span>' : ''}
      </div>
    </div>`;
}

/* 「有站点在引用这张证书」弹窗：不硬拒，给用户三条出路。
 * ①换证书（站点不动、证书换个文件）②停用引用它的站点 ③确认没用就强制删除。
 * 服务器是用户自己的，程序只负责把后果说清楚 + 每一步都留回滚。 */
function openCertRefsModal({ domain, certPath, keyPath, refs = [], sites = [] }) {
  const isOwnConf = (f) => /frp-console\.conf$/.test(String(f || ''));
  const refFiles = Array.from(new Set(refs.map((r) => r.file)));
  const disableable = refFiles.filter((f) => !isOwnConf(f));
  const ownsConf = refFiles.some(isOwnConf);

  /* 候选证书：服务器上现有的（除自己）+ 本机库里的，供「换成别的证书」用。 */
  const candidates = [];
  const pushCand = (c) => {
    const cp = String((c && (c.certPath || c.crtPath)) || '').trim();
    const kp = String((c && c.keyPath) || '').trim();
    if (!cp || cp === certPath) return;
    if (candidates.some((x) => x.certPath === cp)) return;
    candidates.push({ certPath: cp, keyPath: kp, domain: String((c && c.domain) || ''), from: c.from || '', daysLeft: c.daysLeft });
  };
  for (const c of (S.certs.server && S.certs.server.certs) || []) pushCand({ ...c, from: '服务器' });
  for (const c of S.certs.list || []) pushCand({ ...c, certPath: c.crtPath, from: '本机' });

  const candOptions = candidates.length
    ? candidates.map((c) => `<option value="${esc(c.certPath)}">${esc(c.domain || c.certPath)} · ${esc(c.from)} · ${c.daysLeft === null || c.daysLeft === undefined ? '到期未知' : `剩余 ${c.daysLeft} 天`}</option>`).join('')
    : '<option value="">（没有其它可用证书）</option>';

  const who = sites.length ? sites.map((s) => `<strong>${esc(s)}</strong>`).join('、') : refFiles.map((f) => `<code>${esc(f)}</code>`).join('、');

  openModal(`
    <div class="modal" style="width:620px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--amber)">${icon('alert')}</div>
        <div class="grow"><h3>还有站点在引用这张证书</h3><p>直接删会让这些站点在 nginx 重启后没有证书可用。你可以先断开引用，也可以确认没用了直接删。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="note warn">${icon('alert')}<div>引用它的站点：${who}</div></div>
        <div class="cert-paths mono" style="margin-top:10px;max-height:130px;overflow:auto">
          ${refs.map((r) => `<div><code>${esc(r.file)}:${esc(String(r.line))}</code> ${esc(r.content)}</div>`).join('')}
        </div>

        <div class="srv-section-title" style="margin-top:16px">① 换成别的证书（站点不动）</div>
        <div class="row-inline" style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <select id="cr-target" class="input" style="flex:1" ${candidates.length ? '' : 'disabled'}>${candOptions}</select>
          <button class="btn" type="button" id="cr-replace" ${candidates.length ? '' : 'disabled'}>换证书并删除旧的</button>
        </div>
        <div class="field-hint" style="margin-top:6px">把上面这些配置里的 <code>ssl_certificate</code> / <code>ssl_certificate_key</code> 改指到选中的证书，逐个文件 <code>nginx -t</code> 校验通过后重载；任一步失败会自动还原原文件。</div>

        <div class="srv-section-title" style="margin-top:16px">② 停用引用它的站点（可随时改回）</div>
        <div style="margin-top:8px">
          <button class="btn" type="button" id="cr-disable" ${disableable.length ? '' : 'disabled'}>停用这些站点并删除证书</button>
          <div class="field-hint" style="margin-top:6px">
            ${disableable.length
              ? `把 <code>${esc(disableable.map((f) => f.split('/').pop()).join('</code>、<code>'))}</code> 改名成 <code>*.disabled-frpconsole-&lt;时间戳&gt;</code>（nginx 只加载 *.conf，所以站点会下线），校验通过后重载；想恢复就把文件名改回去。`
              : '这些引用都在本程序生成的 frp-console.conf 里，请到「服务器 → HTTPS 域名反代」卡片里重新配置。'}
          </div>
        </div>

        <div class="srv-section-title" style="margin-top:16px">③ 确认这张证书没用了，直接删</div>
        <div style="margin-top:8px">
          <label class="field-hint" style="display:flex;gap:8px;align-items:flex-start">
            <input type="checkbox" id="cr-ack" style="margin-top:2px" />
            <span>我知道后果：证书删掉后这些站点会失去证书，<strong>下次重启 nginx 或服务器时 nginx 可能起不来</strong>，需要我自己去修配置。</span>
          </label>
          <button class="btn danger" type="button" id="cr-force" disabled style="margin-top:8px">${icon('trash')}<span>仍然删除</span></button>
        </div>
      </div>
      <div class="modal-foot">
        <span class="mf-left"></span>
        <button class="btn" type="button" data-act="modal.close">取消</button>
      </div>
    </div>`);

  const ack = $('#cr-ack');
  const forceBtn = $('#cr-force');
  if (ack && forceBtn) ack.addEventListener('change', () => { forceBtn.disabled = !ack.checked; });

  /* 统一的收尾：成功就关窗 + 重扫；失败留在弹窗里让用户换条路。 */
  const finish = async (btn, run, okTitle, okNote) => {
    if (btn) btn.disabled = true;
    try {
      const res = await run();
      if (res && res.ok) {
        closeModal();
        if (okNote) toast('success', okTitle, okNote);
        else toast('success', okTitle);
        try { await loadServerCerts({ force: true }); } catch { /* ignore */ }
        try { await loadCerts({ silent: true }); } catch { /* ignore */ }
        if (S.view === 'certs') renderCerts(true);
        return;
      }
      toast('error', '操作失败', (res && res.error) || '未知错误');
    } catch (e) {
      toast('error', '操作失败', String((e && e.message) || e));
    }
    if (btn) btn.disabled = false;
  };

  const replaceBtn = $('#cr-replace');
  if (replaceBtn) replaceBtn.addEventListener('click', () => {
    const sel = $('#cr-target');
    const target = sel ? candidates.find((c) => c.certPath === sel.value) : null;
    if (!target) return toast('warn', '请选择一张证书');
    finish(replaceBtn, async () => {
      const rep = await FRP.certReplaceRefs({ fromCert: certPath, fromKey: keyPath, toCert: target.certPath, toKey: target.keyPath });
      if (!rep || !rep.ok) return rep;
      const del = await FRP.certServerRemove({ domain, certPath, keyPath });
      if (!del || !del.ok) return { ok: false, error: `引用已换成 ${target.domain || target.certPath}，但删除旧证书失败：${(del && del.error) || '未知错误'}` };
      return { ok: true, data: del.data, replaced: target.domain || target.certPath };
    }, '已换证并删除旧证书', `${domain || certPath} → ${target.domain || target.certPath}`);
  });

  const disableBtn = $('#cr-disable');
  if (disableBtn) disableBtn.addEventListener('click', () => {
    finish(disableBtn, async () => {
      const dis = await FRP.certDisableRefs({ files: disableable });
      if (!dis || !dis.ok) return dis;
      const del = await FRP.certServerRemove({ domain, certPath, keyPath });
      if (!del || !del.ok) return { ok: false, error: `站点已停用，但删除证书失败：${(del && del.error) || '未知错误'}` };
      return { ok: true, data: del.data };
    }, '站点已停用，证书已删除', disableable.map((f) => `${f} → ${f.split('/').pop()}.disabled-frpconsole-*`).join('；'));
  });

  if (forceBtn) forceBtn.addEventListener('click', () => {
    finish(forceBtn, async () => {
      const res = await FRP.certServerRemove({ domain, certPath, keyPath, force: true });
      if (res && res.ok && res.data && res.data.warning) toast('warn', '已强制删除', res.data.warning);
      return res;
    }, '已强制删除证书', domain || certPath);
  });

  if (ownsConf) {
    const hint = $('#cr-disable') && $('#cr-disable').nextElementSibling;
    if (hint) hint.textContent += '（frp-console.conf 是本程序生成的，删证书前建议先去「HTTPS 域名反代」卡片里把它改成不依赖这张证书。）';
  }
}

/* 域名分组键：把 a.b.com / *.b.com 归到同一组 b.com；com.cn 这类二级后缀多留一段。 */
function certGroupKey(domain) {
  const d = String(domain || '').replace(/^\*\./, '').toLowerCase();
  const parts = d.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  const multi = /^(com|net|org|gov|edu)\.(cn|hk|tw|jp|uk|us)$/.test(two);
  return multi ? parts.slice(-3).join('.') : two;
}

/* 证书总览：本机库 + 服务器上的证书，按父域名分组展示（有通配符时组标题写成 *.theysh.cn）。 */
function certOverviewHtml() {
  const local = S.certs.list || [];
  const srvSt = S.certs.server || {};
  const srv = srvSt.certs || [];
  const localDomains = new Set(local.map((c) => String((c && c.domain) || '').toLowerCase()));
  const srvOnly = srv.filter((s) => !localDomains.has(String((s && s.domain) || '').toLowerCase()));

  const groups = new Map();
  const push = (key, entry) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  };
  for (const c of local) push(certGroupKey(c.domain), { kind: 'local', item: c });
  for (const s of srvOnly) push(certGroupKey(s.domain), { kind: 'server', item: s });

  const scanLine = !S.server.connected
    ? `<div class="field-hint" style="padding:0 16px 10px">还没连服务器：连上后会自动扫一遍它上面的证书（宝塔 / certbot / nginx），只读不改。</div>`
    : srvSt.error
      ? `<div class="note warn" style="margin:0 16px 10px">${icon('alert')}<div>${esc(srvSt.error)}</div></div>`
      : (!srvSt.loaded || srvSt.loading)
        ? `<div class="field-hint" style="padding:0 16px 10px">正在扫描 ${esc(S.server.host || '服务器')} 上的证书…</div>`
        : `<div class="field-hint" style="padding:0 16px 10px">${esc(S.server.host || '服务器')} 上找到 ${srv.length} 张证书${srvSt.scannedAt ? ` · ${new Date(srvSt.scannedAt).toLocaleTimeString('zh-CN')} 扫描` : ''}${srvOnly.length ? `，其中 ${srvOnly.length} 张本机还没有` : ''}${srvSt.truncated ? ' · 证书较多，只显示前 ' + srv.length + ' 张' : ''}</div>`;

  if (!local.length && !srvOnly.length) {
    return `${scanLine}<div class="empty"><span class="spinner"></span><h3>还没有证书</h3><p>照上面向导「签发证书」一步签发第一张；已经有证书的话，连上服务器会在这里列出来，点「导入到本机」即可纳入管理。</p></div>`;
  }

  const blocks = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, items]) => {
      const hasWildcard = items.some((e) => String((e.item && e.item.domain) || '').startsWith('*.'));
      const title = hasWildcard ? `*.${key}` : key;
      const localCount = items.filter((e) => e.kind === 'local').length;
      const srvCount = items.length - localCount;
      const counts = [localCount ? `本机 ${localCount}` : '', srvCount ? `服务器独有 ${srvCount}` : ''].filter(Boolean).join(' · ');
      const rows = items.map((e) => (e.kind === 'local' ? certRow(e.item, !!(S.certs.dns || {}).hasToken) : serverCertRow(e.item))).join('');
      return `
        <div class="cert-group">
          <div class="cert-group-head">
            <strong>${esc(title)}</strong>
            <span class="cert-group-count">${esc(counts)}</span>
          </div>
          <div class="cert-list">${rows}</div>
        </div>`;
    })
    .join('');

  return `${scanLine}${blocks}`;
}

/* ---------------- DNS 记录面板（v1.2.58） ----------------
 * 证书页每个域名旁提供「DNS 记录」入口：在一个面板里同时看到
 *   ① Cloudflare 里的记录（可增可删）  ② 四个 DNS 来源的实际解析结果
 *   ③ 一句话结论（已解析 / 公共 DNS 有了但本机还没有 / 记录不存在 / 橙云代理）
 * 数据源与「检测」按钮完全一致（都是 FRP.dnsInspect），不会再出现两边打架。 */
function openDnsPanel(nameOrDomain) {
  const fallback = (S.certs.list && S.certs.list[0] && S.certs.list[0].domain) || '';
  const name = String(nameOrDomain || fallback || '').trim().toLowerCase();
  if (!name) { toast('warn', '还没有域名', '先在下面签发一张证书，或填一个域名再查'); return; }
  S.dns = { name, loading: true, data: null, error: '', busy: false, addError: '' };
  openModal(dnsPanelMarkup());
  loadDnsPanel();
}

async function loadDnsPanel() {
  const st = S.dns;
  if (!st) return;
  st.loading = true;
  st.error = '';
  renderDnsPanel();
  let res = null;
  try {
    res = await FRP.dnsInspect({ name: st.name });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (!S.dns || S.dns.name !== st.name) return;
  st.loading = false;
  st.at = Date.now();
  if (res && res.ok) { st.data = res.data; st.error = ''; }
  else { st.error = (res && res.error) || '查询失败'; }
  renderDnsPanel();
}

function renderDnsPanel() {
  if (!S.dns) return;
  const root = $('#modal-root');
  if (!root || !root.classList.contains('open')) return;
  if (!root.querySelector('.dns-panel')) return;
  openModal(dnsPanelMarkup());
}

function dnsSourceRow(s) {
  const recs = (s.records || []).map((r) => `${r.type} ${esc(r.value)}${r.ttl ? ` <span class="pm pm-muted">ttl=${r.ttl}</span>` : ''}`);
  const body = recs.length ? recs.join('<br>') : `<span class="pm pm-muted">${esc(s.error || '无结果')}</span>`;
  const tone = s.ok && s.trusted !== false ? 'pm-ok' : (s.ok ? 'pm-warn' : 'pm-bad');
  /* 被劫持/透明代理污染的来源要显式标出来，否则用户会以为「权威 NS 也说有」。 */
  const guard = s.trusted === false
    ? `<div class="field-hint" style="margin:2px 0 0;color:var(--red)">可能被本机 DNS 拦截/透明代理污染，结果不可信</div>`
    : '';
  return `<tr>
      <td class="pm-label dns-cell-label">${esc(s.label || s.id)}<div class="field-hint mono dns-cell-server">${esc(s.server || '')}</div>${guard}</td>
      <td class="dns-cell-mark"><span class="pm ${tone}">${s.ok ? (s.trusted === false ? '?' : '✓') : '✗'}</span></td>
      <td class="mono dns-cell-records">${body}</td>
      <td class="mono dns-cell-nowrap">${s.ms != null ? `${s.ms} ms` : '—'}</td>
    </tr>`;
}

function dnsPanelMarkup() {
  const st = S.dns || { name: '', loading: false, data: null, error: '', busy: false };
  const d = st.data;
  const judge = (d && d.judge) || null;
  const cf = (d && d.cf) || null;
  const sources = (d && d.sources) || [];
  const isWildcard = String(st.name || '').startsWith('*.');
  const tone = judge ? (judge.tone === 'ok' ? '' : 'warn') : '';
  const when = st.at ? new Date(st.at).toLocaleTimeString('zh-CN') : '—';

  const conclusion = st.loading && !d
    ? '<div class="note"><span class="spinner-sm"></span><div>正在查询（本机解析器、1.1.1.1、8.8.8.8、权威 NS）…</div></div>'
    : st.error
      ? `<div class="note warn">${icon('alert')}<div><b>查询失败</b><div>${esc(st.error)}</div></div></div>`
      : judge
        ? `<div class="note ${tone}">${icon(judge.tone === 'ok' ? 'check' : 'alert')}<div><b>${esc(judge.title)}</b><div>${esc(judge.detail || '')}</div></div></div>`
        : '';

  const wildcardNote = isWildcard ? `
      <div class="note" style="margin-top:10px">
        ${icon('globe')}
        <div><b>通配符记录</b>
          <div>Cloudflare 里通配记录的名字存成 <code>*</code>（等价于 <code>*.${esc((d && d.apex) || '')}</code>）。
          ${d && d.wildcardProbe
            ? (d.wildcardProbe.ok
              ? `已用随机子域 <code>${esc(d.wildcardProbe.name)}</code> 实测：能解析到 ${esc((d.wildcardProbe.addrs || []).join('、'))} ✅`
              : `随机子域 <code>${esc(d.wildcardProbe.name)}</code> 探测失败（${esc(d.wildcardProbe.error || '没有返回记录')}）——通配 A 记录可能还没建或不生效。`)
            : '正在用随机子域验证通配是否生效…'}
          </div>
        </div>
      </div>` : '';

  const cfBlock = !cf || !cf.configured
    ? `<div class="field-hint">还没有配置 Cloudflare Token（下面的「DNS 验证渠道」填一次即可），此时只能看解析结果，无法在程序里增删记录。</div>`
    : cf.error
      ? `<div class="note warn">${icon('alert')}<div><b>读取 Cloudflare 记录失败</b><div>${esc(cf.error)}</div></div></div>`
      : `<div class="port-matrix-wrap" style="max-height:280px">
          <table class="port-matrix dns-table dns-table-cf">
            <colgroup><col style="width:9%"><col style="width:26%"><col><col style="width:10%"><col style="width:10%"><col style="width:78px"></colgroup>
            <thead><tr><th>类型</th><th>名称</th><th>内容</th><th>TTL</th><th>代理</th><th></th></tr></thead>
            <tbody>
              ${(cf.records || []).length ? (cf.records || []).map((r) => `<tr>
                <td class="mono dns-cell-nowrap">${esc(r.type)}</td>
                <td class="mono dns-cell-name">${esc(r.name)}</td>
                <td class="mono dns-cell-records">${esc(r.content)}</td>
                <td class="mono dns-cell-nowrap">${r.ttl === 1 ? '自动' : esc(String(r.ttl))}</td>
                <td class="dns-cell-nowrap">${r.proxied ? '<span class="tag ok">橙云</span>' : '<span class="tag">灰云</span>'}</td>
                <td class="pm-act"><button class="btn tiny danger-text" type="button" data-act="dns.del" data-id="${esc(r.id)}" data-type="${esc(r.type)}" data-content="${esc(r.content)}">删除</button></td>
              </tr>`).join('') : '<tr><td colspan="6" class="pm-muted" style="padding:12px 14px">Cloudflare 里还没有这个域名的记录</td></tr>'}
            </tbody>
          </table>
        </div>`;

  const canProxy = true;
  return `
    <div class="modal dns-panel">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--blue)">${icon('globe')}</div>
        <div class="grow">
          <h3>DNS 记录 · <span class="mono">${esc(st.name)}</span></h3>
          <p>域名解析与 Cloudflare 记录（查询时间 ${esc(when)}）</p>
        </div>
        <button class="icon-btn" type="button" data-act="modal.close" title="关闭">✕</button>
      </div>
      <div class="modal-body">
        ${conclusion}
        ${wildcardNote}
        <div class="field-hint" style="margin:12px 0 6px">解析结果对比（同一个域名，四个来源各自怎么说）</div>
        <div class="port-matrix-wrap">
          <table class="port-matrix dns-table dns-table-sources">
            <colgroup><col style="width:26%"><col style="width:9%"><col><col style="width:13%"></colgroup>
            <thead><tr><th>查询来源</th><th>结果</th><th>记录</th><th>耗时</th></tr></thead>
            <tbody>${sources.length ? sources.map(dnsSourceRow).join('') : '<tr><td colspan="4" class="pm-muted" style="padding:12px 14px">查询中…</td></tr>'}</tbody>
          </table>
        </div>
        ${d && d.soaMinTtl ? `<div class="field-hint">${judge && judge.stale
          ? `这个域名的 SOA 负缓存上限是 ${Math.round(d.soaMinTtl / 60)} 分钟。记录已删除，但本机/运营商 DNS 还会在旧记录的 TTL 内继续返回它——等 TTL 过期或执行 ipconfig /flushdns 就一致了。`
          : `这个域名的 SOA 负缓存上限是 ${Math.round(d.soaMinTtl / 60)} 分钟：刚在 Cloudflare 加完记录时，本机/运营商 DNS 可能还会继续返回「不存在」，最多等这么久才全世界生效。公共 DNS（1.1.1.1）通常立刻就能查到。`}</div>` : ''}

        <div class="field-hint" style="margin:14px 0 6px">Cloudflare 里的记录</div>
        ${cfBlock}

        ${cf && cf.configured ? `
        <div class="field-hint" style="margin:14px 0 6px">新增记录</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end">
          <div class="field" style="width:96px"><label>类型</label>
            <select class="select" id="dns-add-type">
              <option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option><option value="TXT">TXT</option>
            </select></div>
          <div class="field" style="flex:1;min-width:180px"><label>名称</label>
            <input class="input mono" id="dns-add-name" value="${esc(isWildcard ? `*.${esc((d && d.apex) || '')}` : st.name)}"></div>
          <div class="field" style="flex:1;min-width:180px"><label>内容（IP / 目标域名 / 文本）</label>
            <input class="input mono" id="dns-add-content" placeholder="${esc((d && d.serverAddr) || '1.2.3.4')}"></div>
          <div class="field" style="width:96px"><label>TTL</label>
            <input class="input mono" id="dns-add-ttl" type="number" min="1" value="120"></div>
          <label class="check-inline" style="margin-bottom:10px"><input type="checkbox" id="dns-add-proxied"> 橙云代理</label>
          <button class="btn primary" type="button" data-act="dns.add" ${st.busy ? 'disabled' : ''}>${icon('plus')}<span>添加</span></button>
        </div>
        ${st.addError ? `<div class="field-hint" style="color:var(--red)">${esc(st.addError)}</div>` : ''}
        <div class="field-hint">提示：证书 + nginx 反代的场景建议用<b>灰云（仅 DNS）</b>，否则 Cloudflare 会先接管 TLS，我们签的证书就用不上了；要开橙云就别在本地做 https2http。</div>
        ` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn" type="button" data-act="dns.refresh" ${st.loading ? 'disabled' : ''}>${icon('reload')}<span>${st.loading ? '查询中…' : '重新查询'}</span></button>
        <button class="btn" type="button" data-act="modal.close">关闭</button>
      </div>
    </div>`;
}

/* 与检测同源的一次轻查询：只用来更新表单里的 DNS 徽标文案 */
async function dnsBadgeInfo(domain) {
  try {
    const res = await Promise.race([
      FRP.dnsInspect({ name: domain }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS 查询超时')), 12000)),
    ]);
    if (res && res.ok && res.data) return res.data;
    return { judge: { tone: 'warn', title: '查询失败', detail: (res && res.error) || '' }, sources: [] };
  } catch (e) {
    return { judge: { tone: 'warn', title: '查询超时', detail: String((e && e.message) || e) }, sources: [] };
  }
}

/* 把「配置渠道 → DNS 解析 → 签发证书 → 填进代理」做成可交互四步，
 * 每步内联对应表单，小白不用懂 DNS/TXT/ACME：从上到下一条流水线。 */
function domainWizardHtml() {
  const w = S.certs.wizard || {};
  const dns = w.dns || null;
  const dnsCfg = S.certs.dns || {};
  const hasToken = !!dnsCfg.hasToken;
  const provider = dnsCfg.dnsProvider || '';
  const checking = w.checking;
  const domain = String(w.domain || '').trim().toLowerCase();
  const certs = S.certs.list || [];

  // 当前输入域名是否已有证书覆盖（按域名本身 + SAN 逐一判断）
  const coveringCert = domain ? (certs.find((c) => {
    const names = [c.domain, ...(c.domains || [])].map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    return names.some((n) => n === domain || coversDomain(n, domain));
  }) || null) : null;
  const certCovers = !!coveringCert;
  // 证书已覆盖，但还没部署到服务器 nginx 时，https://域名 实际访问不了，向导要提示。
  const certNginxPending = !!(coveringCert && !(coveringCert.nginx && coveringCert.nginx.ok));

  const dnsOk = !!(dns && (dns.resolved || []).length && dns.pointsToServer);
  const dnsResolvedOther = !!(dns && (dns.resolved || []).length && !dns.pointsToServer);

  const step1 = hasToken ? 'ok' : 'warn';
  const step2 = dns ? (dnsOk ? 'ok' : 'warn') : 'idle';
  const step3 = domain ? (certCovers && !certNginxPending ? 'ok' : 'warn') : 'idle';
  const step4 = 'idle'; // 填进代理在代理页完成，这里只做跳转提示

  return `
    <div class="domain-wizard">
      <div class="dw-input-row">
        <input class="input" id="dw-domain" placeholder="你的域名，如 app.example.com 或 *.example.com" value="${esc(w.domain || '')}" spellcheck="false" />
        <button class="btn" type="button" data-act="dw.check" ${checking ? 'disabled' : ''}>${checking ? '<span class="spinner-sm"></span>' : icon('search')}<span>${checking ? '检测中…' : '检测'}</span></button>
      </div>

      <div class="dw-steps">
        <div class="dw-step ${step1}">
          <span class="dw-dot">${step1 === 'ok' ? '✓' : '1'}</span>
          <div class="dw-body">
            <strong>配置 DNS 验证渠道</strong>
            <span>${hasToken ? '已配置 Cloudflare：域名解析、签发、续期都能自动完成。' : '配好 Cloudflare token 后，下面几步都能自动做；也可以先跳过（手动 DNS，只是不能一键建解析和自动续期）。'}</span>
            <div class="dw-inline-form">
              <select class="select" id="cert-dns-provider">
                <option value="" ${!provider ? 'selected' : ''}>未配置</option>
                <option value="cloudflare" ${provider === 'cloudflare' ? 'selected' : ''}>Cloudflare</option>
              </select>
              <input class="input" id="cert-dns-token" type="password" placeholder="${hasToken ? '已保存（留空不改动）' : 'Cloudflare API Token'}" autocomplete="new-password" />
              <button class="btn icon" type="button" data-act="certs.dns.eye" title="显示 / 隐藏">${icon('eye')}</button>
              <button class="btn primary" type="button" data-act="certs.dns.save">${icon('check')}<span>保存</span></button>
              <button class="btn" type="button" data-act="certs.dns.verify">${icon('shield')}<span>验证</span></button>
              ${hasToken ? `<button class="btn danger-text" type="button" data-act="certs.dns.clear">${icon('trash')}<span>清除</span></button>` : ''}
            </div>
            <span style="font-size:11px">权限至少需要 <code>Zone.Zone:Read</code> + <code>Zone.DNS:Edit</code>，范围限定到你自己的域名；token 用 Windows DPAPI 加密存在本机，绝不出现在配置或日志里。</span>
          </div>
        </div>

        <div class="dw-step ${step2}">
          <span class="dw-dot">${step2 === 'ok' ? '✓' : (step2 === 'warn' ? '!' : '2')}</span>
          <div class="dw-body">
            <strong>域名解析到服务器</strong>
            <span>${dns
              ? (dnsOk ? `已解析到服务器（${esc((dns.resolved || []).join(', '))}），公网能访问。`
                : dnsResolvedOther ? `已解析到 ${esc((dns.resolved || []).join(', '))}，但没指向当前服务器。`
                : `还没解析${dns.error ? `（${esc(dns.error)}）` : ''}，公网访问不到。`)
              : '输入上面的域名，点「检测」。'}</span>
            ${dns && !dnsOk
              ? `<div class="dw-inline-form">
                  <button class="btn small" type="button" data-act="dw.set-a" ${hasToken ? '' : 'disabled'} title="${hasToken ? '' : '需要先配置 Cloudflare token'}">${icon('globe')}<span>${w.setA ? '处理中…' : '一键建解析'}</span></button>
                  <button class="btn small" type="button" data-act="dw.check">${icon('reload')}<span>重新检测</span></button>
                </div>`
              : ''}
          </div>
        </div>

        <div class="dw-step ${step3}">
          <span class="dw-dot">${step3 === 'ok' ? '✓' : (step3 === 'warn' ? '!' : '3')}</span>
          <div class="dw-body">
            <strong>签发证书</strong>
            <span>${domain
              ? (certCovers
                  ? (certNginxPending
                      ? `已有证书覆盖 ${esc(domain)}，但还没部署到服务器 nginx —— 到下方证书列表点「部署到 nginx」，之后 https://${esc(domain)} 才能访问。`
                      : `已有证书覆盖 ${esc(domain)}（见下方列表，可直接填进代理）。`)
                  : `还没有覆盖 ${esc(domain)} 的证书，在下面签发一张。`)
              : 'DNS 就绪后，在这里签发。'}</span>
            <div class="dw-inline-form">
              <input class="input" id="cert-domains" placeholder="example.com, *.example.com（逗号分隔）" value="${esc(w.domain || '')}" />
              <input class="input" id="cert-email" value="${esc(dnsCfg.acmeEmail || '')}" placeholder="联系邮箱（用于到期提醒）" />
              <button class="btn primary" type="button" data-act="certs.issue" ${S.certs.issuing ? 'disabled' : ''}>${S.certs.issuing ? '<span class="spinner-sm"></span>' : icon('shield')}<span>${S.certs.issuing ? '签发中，请稍候…' : '签发证书'}</span></button>
            </div>
            <span style="font-size:11px">第一项作为主域名；通配符填 <code>*.example.com</code>。签发的是 Let's Encrypt 正式证书（有效期 90 天，到期前会自动续期）。</span>
          </div>
        </div>

        <div class="dw-step ${step4}">
          <span class="dw-dot">4</span>
          <div class="dw-body">
            <strong>填进代理</strong>
            <span>新建 / 编辑 http、https 代理，插件选 https2http / https2https，填好自定义域名后「证书快捷填入」会自动列出匹配的证书并写入路径。</span>
            <div class="dw-inline-form">
              <button class="btn small" type="button" data-act="nav" data-view="proxies">${icon('link')}<span>去代理映射</span></button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}


async function refreshDomainWizard() {
  const w = S.certs.wizard;
  const domain = String($('#dw-domain') ? $('#dw-domain').value : (w.domain || '')).trim();
  if (!domain) { w.dns = null; w.domain = ''; if (S.view === 'certs') renderCerts(true); return; }
  w.domain = domain;
  w.checking = true;
  if (S.view === 'certs') renderCerts(true);
  const res = await FRP.dnsResolve(domain);
  w.checking = false;
  if (res && res.ok) {
    w.dns = res.data;
  } else {
    w.dns = { resolved: [], pointsToServer: false, error: (res && res.error) || '解析失败' };
  }
  if (S.view === 'certs') renderCerts(true);
}

function renderCerts(force = false) {
  if (!force && S.lastKeys.certs === 'rendered') return;
  S.lastKeys.certs = 'rendered';
  const certs = S.certs.list || [];
  const dns = S.certs.dns || {};
  const hasToken = !!dns.hasToken;
  const w = S.certs.wizard || {};
  const coveredDomains = Array.from(new Set((certs || []).flatMap((c) => c.domains || []).map((d) => String(d).trim()).filter(Boolean)));
  const coveredText = coveredDomains.join('、');
  // 自动折叠：没手动点过「展开/收起」时，token 与证书都齐了就默认收起向导
  const expanded = w.expanded === undefined ? !(hasToken && certs.length) : w.expanded;
  // 证书按服务器显示：顶部标注当前连接的服务器，每张证书的部署徽标带服务器名。
  const serverHost = S.server.connected ? String(S.server.host || '') : '';
  const connName = (activeConnectionInfo() || {}).name || '';
  const serverCtx = serverHost
    ? `<span class="badge">当前服务器 ${esc(serverHost)}${connName ? ` · ${esc(connName)}` : ''}</span>`
    : '<span class="badge amber">未连接服务器</span>';

  /* 30 天内到期的那张证书 —— 自动续期只有配了 DNS 渠道才跑得动，没配就得明说。 */
  const expiring = (certs || [])
    .filter((c) => c.exists && typeof c.daysLeft === 'number' && c.daysLeft <= 30)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const soonest = expiring[0] || null;
  const renewBanner = !soonest ? '' : `
      <section class="card section">
        <div class="note ${hasToken ? 'warn' : 'bad'}">
          <strong>${esc(soonest.domain)} 还有 ${soonest.daysLeft} 天到期</strong>
          <div>${hasToken
            ? '已配置 DNS 验证渠道：自动续期每 12 小时检查一次，剩余不足 30 天时会自动签新证书（续完记得重新「部署到 nginx」，浏览器才会拿到新证书）。'
            : '没有配置 DNS 验证渠道，自动续期不会运行 —— 证书到期后 https://域名 会直接打不开。下面的「续期」按钮也要先配好渠道才能用。'}</div>
          ${hasToken
            ? ''
            : `<button class="btn small" type="button" data-act="certs.godns">${icon('key')}<span>去配置 Cloudflare token</span></button>`}
        </div>
      </section>`;

  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>HTTPS 证书</h1>
          <p>给域名上 HTTPS：签证书 → 部署到服务器 → 浏览器就能 <code>https://</code> 访问、不带端口。不配置也能正常使用隧道。</p>
        </div>
      </div>

      ${renewBanner}

      <section class="card section">
        <div class="section-head">
          <div class="section-title"><strong>域名就绪向导</strong><span>从上到下一条流水线：填 token → 建解析 → 签证书 → 填进代理。只想用隧道、不要域名，可跳过本页。</span></div>
          <button class="btn small" type="button" data-act="dw.toggle">${expanded ? icon('up') : icon('down')}<span>${expanded ? '收起' : '展开'}</span></button>
        </div>
        ${expanded ? domainWizardHtml() : `<div class="field-hint" style="padding:0 16px 12px">${hasToken && certs.length ? '✓ DNS 验证渠道已配置，且已有证书。需要时点「展开」按步骤操作。' : '点「展开」按步骤配置域名、签发证书。'}</div>`}
      </section>

      <section class="card section">
        <div class="section-head">
          <div class="section-title"><strong>证书总览</strong><span>${coveredDomains.length ? `已覆盖域名：${esc(coveredText)} · ` : ''}按父域名分组；本机证书存在 userData\\certs，服务器上的证书（宝塔 / certbot / nginx）只读扫描后可一键导入。</span></div>
          <div class="page-actions">
            ${serverCtx}
            ${S.server.connected ? `<button class="btn small" type="button" data-act="certs.server.scan" ${S.certs.server.loading ? 'disabled' : ''}>${icon('reload')}<span>${S.certs.server.loading ? '扫描中…' : '扫描服务器'}</span></button>` : ''}
            <button class="btn small" type="button" data-act="certs.refresh">${icon('reload')}<span>刷新</span></button>
          </div>
        </div>
        ${certOverviewHtml()}
      </section>
    </div>`;

  // 连上服务器才扫描；进页面自动扫一次（60 秒内主进程有缓存，不会反复 SSH）。
  const srvSt = S.certs.server;
  if (S.server.connected && !srvSt.loaded && !srvSt.loading) loadServerCerts();
}

/* ----------------------------- 设置 ------------------------------ */

/* 设置页「已知服务器指纹」区块：把 userData/known-hosts.json 摊开，
 * 让用户能看到都信任过谁、也能把某台删掉（下次连接会重新记录）。 */
function knownHostsMarkup() {
  const k = S.knownHosts || {};
  if (k.loading && !k.loaded) return '<div class="field-hint">正在读取…</div>';
  if (k.error) return `<div class="note warn">${icon('alert')}<div>${esc(k.error)}</div></div>`;
  const hosts = k.hosts || [];
  if (!hosts.length) {
    return '<div class="field-hint">还没有记录。连过一次服务器之后，这里会出现它的主机指纹；换机器、重装 sshd 或怀疑被劫持时，删掉对应那条再连一次即可重新记录。</div>';
  }
  return `<div class="field-hint" style="margin-bottom:8px">核对方法：在服务器本机跑 <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>（或 <code>ssh_host_rsa_key.pub</code>），输出的 <code>SHA256:…</code> 必须和这里一字不差；对不上就先别连。</div>
  <div class="known-list">${hosts
    .map(
      (h) => `<div class="known-row">
        <span class="kr-host mono-text">${esc(String(h.host))}:${esc(String(h.port))}</span>
        <span class="kr-fp mono-text" title="${esc(String(h.fingerprint || ''))}">${esc(String(h.fingerprint || ''))}</span>
        <button class="btn small ghost" type="button" data-act="known.forget" data-host="${esc(String(h.host))}" data-port="${esc(String(h.port))}">${icon('trash')}<span>删除</span></button>
      </div>`,
    )
    .join('')}</div>`;
}

async function loadKnownHosts(silent = false) {
  if (!silent) {
    S.knownHosts = { ...(S.knownHosts || {}), loading: true };
    const box = $('#known-hosts-box');
    if (box) box.innerHTML = knownHostsMarkup();
  }
  const res = await FRP.serverKnownHosts().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (res && res.ok) S.knownHosts = { loaded: true, loading: false, hosts: (res.data && res.data.hosts) || [], error: '' };
  else S.knownHosts = { loaded: true, loading: false, hosts: [], error: (res && res.error) || '读不到已知指纹列表' };
  const box2 = $('#known-hosts-box');
  if (box2) box2.innerHTML = knownHostsMarkup();
}

function renderSettings(force = false) {
  if (!force && S.lastKeys.settings === 'rendered') return;
  S.lastKeys.settings = 'rendered';
  const state = S.state || {};
  const config = state.config || {};
  const settings = state.settings || {};
  const paths = state.paths || {};
  const app = state.app || {};
  const log = config.log || {};

  $('#view').innerHTML = `
    <div class="view">
      <div class="page-head">
        <div class="page-title">
          <h1>设置</h1>
          <p>本机程序行为、可执行文件路径与版本更新。服务器地址、端口与 Token 全部在「服务器」页管理。</p>
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
                <span class="p-value mono" title="${esc(state.dashboardUrl || (config.serverAddr ? `${config.serverAddr}:7500` : '配置服务器后可用'))}">${esc(state.dashboardUrl || (config.serverAddr ? `${config.serverAddr}:7500` : '配置服务器后可用'))}</span>
                ${S.server && S.server.connected && S.server.host ? `<span class="tag ok" title="端口来自当前服务器 frps 配置里的 webServer.port">跟随 ${esc(S.server.host)}</span>` : ''}
              </div>
            </div>
            <div class="path-row">
              <div class="path-display grow">
                <span class="p-label">日志文件</span>
                <span class="p-value mono" title="${esc(paths.logPath || '')}">${esc(paths.logPath || '')}</span>
                <span class="tag ${paths.logExists ? 'ok' : 'bad'}">${paths.logExists ? '存在' : '不存在'}</span>
              </div>
              <button class="btn small" type="button" data-act="reveal.log">${icon('folder')}</button>
            </div>
          </div>
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
                <option value="auto" ${settings.runMode !== 'managed' ? 'selected' : ''}>自动（本机有 frpc 系统服务就用它，否则由控制台托管）</option>
                <option value="managed" ${settings.runMode === 'managed' ? 'selected' : ''}>应用托管进程</option>
              </select>
              <div class="field-hint">${settings.runMode === 'managed'
                ? '托管模式下隧道是控制台的子进程：控制台退出即断开，不建议用于无人值守。'
                : '「自动」会先看本机是否已把 frpc 装成系统服务（那种能开机自启、不依赖控制台）；没有就由控制台直接拉起 frpc.exe。'}</div>
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
                ${switchRow('断线自动重连', 'frpc 进程被杀、管理接口卡死或睡眠唤醒后连接假死时自动重连；第 10 次之后每 5 分钟试一次', 'autoReconnect', settings.autoReconnect !== false)}
                ${switchRow('关闭窗口时最小化到托盘', '退出请使用托盘菜单中的“退出”', 'closeToTray', settings.closeToTray !== false)}
                ${switchRow('启动时自动启动隧道', '控制台启动后立即建立 frpc 连接', 'launchTunnelOnStart', !!settings.launchTunnelOnStart)}
                ${switchRow('开机自动启动', '登录 Windows 后自动运行控制台（写当前用户的启动项，不需要管理员权限）', 'launchAtLogin', !!settings.launchAtLogin)}
                <div class="field-hint">
                  <button class="btn sm" type="button" data-act="settings.openstartup">${icon('folder')}<span>打开启动文件夹</span></button>
                  <span style="margin-left:8px">系统不让程序写启动项时，把程序快捷方式拖进这个文件夹，效果一样</span>
                </div>
                ${app.launchAtLoginBlocked ? `<div class="note warn" style="margin:2px 0 10px">${icon('alert')}<div>启动项已被系统「任务管理器 → 启动」禁用，重启后不会运行。要恢复请到那里把「FRP 控制台」设为「已启用」；或者换个办法：把快捷方式放进 <code>shell:startup</code>。</div></div>` : ''}
                ${settings.launchAtLogin && settings.runMode === 'managed' ? `<div class="note warn" style="margin:2px 0 10px">${icon('alert')}<div>当前是「应用托管进程」模式：开机只会自动打开控制台，隧道要等控制台把 frpc 拉起来才算通；控制台一退隧道就断。</div></div>` : ''}
                ${switchRow('以最小化状态启动', '仅显示托盘图标', 'startMinimized', !!settings.startMinimized)}
              </div>
            </div>
            <div class="field span-2">
              <div class="section-title" style="margin:4px 0 0"><strong>客户端管理 API</strong><span>frpc 只在本机 127.0.0.1 上开的管理接口，控制台用它读状态、做热重载；口令保护的是 <code>/api/config</code>（里面有 frps 的 auth.token）。</span></div>
            </div>
            <div class="field">
              <label>管理端口</label>
              <input class="input" name="adminPort" type="number" min="1024" max="65535" step="1" value="${esc(String(settings.adminPort || 7400))}" />
              <div class="field-hint">如果 7400 被别的程序占了，控制台会自动顺延；也可以在这里固定一个</div>
            </div>
            <div class="field">
              <label>管理用户名</label>
              <input class="input" name="adminUser" type="text" autocomplete="off" value="${esc(settings.adminUser || 'admin')}" />
              <div class="field-hint">写进 frpc.toml 的 <code>[webServer]</code> 段</div>
            </div>
            <div class="field span-2">
              <label>管理口令</label>
              <div class="input-group">
                <input class="input" name="adminPassword" id="in-adminpass" type="password" autocomplete="off" value="${esc(settings.adminPassword || '')}" />
                <button class="btn small" type="button" data-act="settings.eye.adminpass" title="显示 / 隐藏">${icon('eye')}</button>
                <button class="btn small" type="button" data-act="settings.gen.adminpass" title="生成 20 位随机口令">${icon('reload')}<span>随机生成</span></button>
              </div>
              <div id="adminpass-note">${adminWeakNote(settings)}</div>
              <div class="field-hint">改完点右上角「保存行为设置」；隧道在跑时会带着新口令重启 frpc</div>
            </div>
          </form>
        </section>

        <section class="card section">
          <div class="section-head">
            <div class="section-title"><strong>已知服务器指纹</strong><span>第一次连接某台服务器时会记下它的 SSH 主机指纹，之后每次连接都比对；对不上就拒绝连接并让你确认。</span></div>
            <button class="btn small" type="button" data-act="known.refresh">${icon('reload')}<span>刷新</span></button>
          </div>
          <div id="known-hosts-box">${knownHostsMarkup()}</div>
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
  /* 指纹列表很短，顺手拉一次；失败也只是那一段显示错误文案 */
  loadKnownHosts().catch(() => {});
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

/* 连接类操作改的是 settings.connections：拉一次最新状态并重绘当前视图。
 * 原来这里写的是不存在的 loadStateAndRender()，一点「＋」就抛 ReferenceError，
 * IPC 明明成功了却既没提示也不刷新（只能等 3 秒一次的 state:update）。 */
async function reloadAfterConnectionChange() {
  const res = await FRP.refresh().catch(() => null);
  if (res && res.ok && res.data) S.state = res.data;
  updateChrome();
  renderCurrent({ force: true });
}

async function handleAction(act, dataset, btn) {
  try {
    switch (act) {
      case 'nav':
        setView(dataset.view);
        break;
  
    case 'conn.add': {
      const name = await promptDialog({
        title: '再连一台 frps',
        label: '给这条连接起个名字',
        placeholder: '例如：广州 frp / 家里的 frps',
        confirmText: '创建',
        hint: '新连接会得到一份空的 frpc.toml（不会复制当前连接的服务器地址和 Token），建好后到服务器页或配置文件页把它填上。',
      });
      if (!name || !String(name).trim()) return;
      const res = await FRP.connectionAdd({ name: String(name).trim() }).catch(() => null);
      if (!res || !res.ok) { toast('error', '创建失败', (res && res.error) || '请稍后再试'); return; }
      await reloadAfterConnectionChange();
      toast('success', '已创建连接', `${String(name).trim()} · 用左下角的连接切换器选它`);
      return;
    }
    case 'conn.toggle': {
      const id = dataset && dataset.id ? dataset.id : '';
      const conn = connList().find((c) => c.id === id);
      if (!conn) return;
      const isRunning = !!(conn.runtime && conn.runtime.connected);
      /* withBusy 的第一个参数必须是按钮元素且会吞掉返回值，这里直接用 IPC 结果。 */
      const res = isRunning
        ? await FRP.connectionStop(id).catch(() => null)
        : await FRP.connectionStart(id).catch(() => null);
      if (!res || !res.ok) { toast('error', isRunning ? '停止失败' : '启动失败', (res && res.error) || '请稍后再试'); return; }
      await reloadAfterConnectionChange();
      toast('success', isRunning ? '已停止' : '已启动', conn.name || id);
      return;
    }
    case 'conn.edit':
      openConnectionEditor();
      return;
    case 'conn.switch': {
      const id = (dataset && dataset.id) || '';
      const target = connList().find((c) => c.id === id);
      if (!target) return;
      const anyRunning = connList().some((c) => c.runtime && c.runtime.connected);
      if (anyRunning) {
        const yes = await confirmDialog({
          title: '切换连接会停掉正在跑的隧道',
          body: '每条连接用的是自己那份 frpc.toml，切换时旧隧道必须先停（否则改配置、健康检查、日志会错位）。切过去之后点「启动」重新连。',
          confirmText: '切换并停止',
          danger: true,
        });
        if (!yes) return;
      }
      const res = await FRP.connectionActive(id).catch(() => null);
      if (!res || !res.ok) { toast('error', '切换失败', (res && res.error) || '请稍后再试'); return; }
      await reloadAfterConnectionChange();
      toast('success', '已切换当前连接', target.name || id);
      return;
    }
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
        confirmDeleteProxy(dataset.name, dataset.conn || '');
        break;
      case 'proxy.filter.conn':
        S.proxyConnFilter = dataset.conn || '';
        S.lastKeys.proxies = '';
        renderProxies(true);
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
      case 'listeners.scope':
        S.discoveryScope = dataset.scope || '';
        renderDiscovery(true);
        break;
      case 'listener.publish': {
        const proc = String(dataset.process || '').replace(/\.exe$/i, '').replace(/[^A-Za-z0-9._-]/g, '');
        /* 高危端口（SMB / 远程桌面 / 数据库 / Redis 之类）一键发布到公网前先拦一下：
         * 这类服务要么没有认证，要么被爆破就等于交出整台机器。确认框不阻止用户，
         * 只是把后果写在按钮前面。 */
        if (dataset.risk === 'danger') {
          const go = await confirmDialog({
            title: `把 ${dataset.port}（${dataset.risklabel || '高危服务'}）发布到公网？`,
            body: `<p>这个端口后面通常是文件共享、远程桌面或数据库这类服务：要么本身没有认证（Redis、Memcached），要么一旦被暴力破解就等于把整台机器交出去。</p>
              <p style="margin-top:8px">如果只是自己临时用，建议先在代理上设一个足够长的访问口令，用完就停；确认要发布就继续。</p>`,
            confirmText: '我确认，继续发布',
            danger: true,
          });
          if (!go) break;
        }
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
      case 'server.profiles.dedupe': {
        await withBusy(btn, async () => {
          const res = await FRP.serverProfilesDedupe();
          if (!res || !res.ok) return toastResult(res);
          applyServerState(res.data.state, serverSeq());
          renderServer(true);
          const d = res.data;
          if (!d.changed) return toast('info', '没有重复档案', '每台机器（IP + SSH 端口）都只有一条。');
          toast('success', '已合并重复档案', `${d.before} 条 → ${d.after} 条：${d.summary || ''}`);
          if (d.backupError) toast('warn', '合并完成，但备份失败', d.backupError);
        });
        break;
      }
      case 'server.profile.modal.save':
        await saveServerProfileModal(btn);
        break;
      case 'server.conn.switch': {
        const id = dataset.conn || '';
        const cur = (S.state && S.state.activeConnectionId) || '';
        if (!id || id === cur) break;
        const list = connList();
        const target = list.find((c) => c.id === id);
        const agg = (S.state && S.state.connectionsAgg) || {};
        if (Number(agg.running) > 0) {
          const okGo = await confirmDialog({
            title: '切换查看的服务器',
            body: `切换会先把正在跑的 ${Number(agg.running)} 条隧道停掉（每条连接各自一个 frpc），然后切到「${esc(target ? target.name || target.id : id)}」。想保持两条都跑就别切换。`,
            confirmText: '切换',
          });
          if (!okGo) break;
        }
        const res = await FRP.connectionActive(id).catch(() => null);
        if (!res || !res.ok) { toast('error', '切换失败', (res && res.error) || '请稍后再试'); break; }
        /* 先刷全量状态：chips 高亮读的是 S.state.activeConnectionId，只拉 serverState 不会更新它。 */
        await reloadAfterConnectionChange();
        /* 换了当前连接，SSH 会话与服务器快照都属于上一台的，先清干净再读。 */
        S.server = { ...S.server, connected: false, info: null, summary: null, configPath: '', config: '', nginx: null, firewall: null, selftest: null, nginxHealth: null };
        S.lastKeys.server = '';
        await loadServerState();
        renderServer(true);
        break;
      }
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
          await loadServerNginx(true);
        });
        break;
      }
      case 'server.nginx.refresh':
        await withBusy(btn, async () => {
          await loadServerNginx(false);
          await loadServerNginxHealth({ force: true, silent: false });
        });
        break;
      case 'server.nginx.health':
        await withBusy(btn, () => loadServerNginxHealth({ force: true, silent: false }));
        break;
      case 'server.nginx.view': {
        const file = dataset.file || '';
        const path = dataset.path || '';
        await withBusy(btn, async () => {
          const res = await FRP.serverNginxConfView({ file, paths: [path] });
          if (res && res.ok) {
            S.server.confView = res.data;
            renderServer(true);
          } else {
            toastResult(res);
          }
        });
        break;
      }
      case 'server.nginx.commentref': {
        const file = dataset.file || '';
        const path = dataset.path || '';
        const okGo = await confirmDialog({
          title: '注释掉这条引用',
          body: `将在 <code>${esc(file)}</code> 里把引用 <code>${esc(path)}</code> 的那几行注释掉（不删文件、不删站点），先备份成 <code>.bak-frpconsole-*</code>，再 <code>nginx -t</code> 校验并 reload；失败会自动还原。<br><br>之后这个站点就没有可用证书了——如果它还要用 https，请到证书页签发或选择另一张证书。`,
          confirmText: '注释并重载',
        });
        if (!okGo) break;
        await withBusy(btn, async () => {
          const res = await FRP.serverNginxCommentRef({ file, paths: [path] });
          if (res && res.ok) {
            if (res.data && res.data.health) S.server.nginxHealth = res.data.health;
            S.server.confView = null;
            toast('success', '已注释掉悬空引用', res.data.backup ? `备份：${res.data.backup}` : '');
            await loadServerNginx(true);
          } else {
            toastResult(res);
          }
          renderServer(true);
        });
        break;
      }
      case 'server.nginx.repair': {
        if (S.server.nginxRepairBusy) break;
        const health = S.server.nginxHealth || {};
        const paths = (health.missing || []).filter((m) => m.ours).map((m) => m.path);
        if (!paths.length) {
          toast('warn', '没有需要修复的项', '我们自己的 frp-console.conf 里没有引用失效证书');
          break;
        }
        const okGo = await confirmDialog({
          title: '修复 nginx 配置',
          body: `将从 <code>frp-console.conf</code> 里摘掉 ${paths.length} 个引用已失效证书的 server 块（先备份成 .bak-frpconsole-*），然后 nginx -t 校验并 reload。其它站点的配置不会动。`,
          confirmText: '修复并重载',
        });
        if (!okGo) break;
        S.server.nginxRepairBusy = true;
        renderServer(true);
        try {
          const res = await FRP.serverNginxRepair({ paths });
          if (res && res.ok) {
            if (res.data && res.data.health) S.server.nginxHealth = res.data.health;
            toast('success', '已修复 nginx 配置', res.data.note || '');
            await loadServerNginx(true);
          } else {
            toastResult(res);
          }
        } finally {
          S.server.nginxRepairBusy = false;
          renderServer(true);
        }
        break;
      }
      case 'server.nginx.setup': {
        if (S.server.nginxBusy) break;
        S.server.nginxBusy = true;
        renderServer(true);
        try {
          await runNginxSetup();
        } finally {
          S.server.nginxBusy = false;
          renderServer(true);
        }
        break;
      }
      case 'server.shell.open':
        await openShellTerm();
        break;
      case 'server.shell.close':
        closeShellTerm();
        break;
      case 'server.firewall.refresh':
        await withBusy(btn, () => loadServerFirewall(false));
        break;
      case 'server.firewall.openone': {
        const port = Number(dataset.port);
        const proto = dataset.proto === 'udp' ? 'udp' : 'tcp';
        if (!port) break;
        if (S.server.firewallBusy) break;
        S.server.firewallBusy = true;
        renderServer(true);
        try {
          const res = await FRP.serverFirewallOpenPorts({ text: String(port), proto });
          await loadServerFirewall(true);
          if (res && res.ok) {
            toast('success', `已放行 ${port}/${proto}`, '正在复检……');
            await loadServerFirewall(true);
          } else {
            toast('error', `放行 ${port}/${proto} 失败`, (res && res.error) || '未知错误');
          }
        } finally {
          S.server.firewallBusy = false;
          renderServer(true);
        }
        break;
      }
      case 'server.ports.copy': {
        const texts = (S.server.firewall && S.server.firewall.ruleTexts) || null;
        if (!texts || !texts.exact) {
          toast('warn', '还没有检测结果', '先点「重新检测」，拿到端口清单再复制');
          break;
        }
        await FRP.copy(texts.exact);
        toast('success', '已复制端口规则清单', '粘到云控制台的「安全组 / 防火墙 → 入方向」里逐条添加');
        break;
      }
      case 'server.ports.showall': {
        S.server.portShowAll = !S.server.portShowAll;
        renderServer(true);
        break;
      }
      case 'server.firewall.open': {
        if (S.server.firewallBusy) break;
        S.server.firewallBusy = true;
        renderServer(true);
        try {
          const res = await FRP.serverFirewallOpen();
          await loadServerFirewall(true);
          if (res && res.ok) {
            const now = (res.data && res.data.opened) || [];
            const prev = (S.server.firewall && S.server.firewall.opened) || [];
            const merged = [...new Set([...prev, ...now])];
            S.server.firewall = { ...(S.server.firewall || {}), opened: merged, notes: (res.data && res.data.notes) || [] };
            toast(`已放行端口${now.length ? `：${now.join('、')}` : ''}`);
          } else {
            toast((res && res.error) || '放行失败', 'error');
          }
        } finally {
          S.server.firewallBusy = false;
          renderServer(true);
        }
        break;
      }
      case 'proxyform.vhost.enable': {
        if (!S.server.connected) {
          toast('warn', '先连服务器', '开启 vhost 端口需要先在「服务器」页连上这台服务器。');
          break;
        }
        const kind = (dataset && dataset.kind) === 'https' ? 'https' : 'http';
        const keyName = kind === 'https' ? 'vhostHTTPSPort' : 'vhostHTTPPort';
        /* 这里刻意不用模态框确认：整个应用只有一个模态根节点，弹确认框会把正在填写的
         * 代理表单顶掉（用户辛苦填的端口/域名全丢）。改成按钮上的二次点击确认。 */
        if (!(dataset && dataset.confirm)) {
          const fixBtn = btn || ($('#pf-domain-readiness')
            ? $('#pf-domain-readiness').querySelector('button[data-act="proxyform.vhost.enable"]')
            : null);
          if (fixBtn) {
            fixBtn.dataset.confirm = '1';
            fixBtn.textContent = `确认开启 ${keyName}（会重启 frps）`;
            fixBtn.classList.remove('small');
            fixBtn.classList.add('primary');
          }
          toast('warn', '再点一次确认', `会在服务器 frps.toml 里补上 ${keyName} 并重启 frps，隧道会断开几秒再自动重连。`);
          break;
        }
        if (btn) btn.disabled = true;
        try {
          const res = await FRP.serverVhostEnable({ kind });
          if (!res || !res.ok) {
            toast('error', '开启 vhost 端口失败', (res && res.error) || '未知原因');
            break;
          }
          toast('success', `${keyName} 已开启`, `端口 ${res.data && res.data.port}，frps 已重启；nginx 反代的上游现在有响应了。`);
          // 只把服务器摘要补回来，不要走 loadServerState（那会整页重渲染，把正在填写的代理表单冲掉）
          const st = await FRP.serverState();
          if (st && st.ok && st.data) {
            S.server.summary = st.data.summary || S.server.summary;
            S.server.config = st.data.config || S.server.config;
          }
          refreshDomainReadiness();
        } finally {
          if (btn) btn.disabled = false;
        }
        break;
      }
      case 'server.firewall.install': {
        if (S.server.firewallBusy) break;
        const okConfirm = await confirmDialog({
          title: '安装并启用防火墙',
          body: '服务器当前没有防火墙。将按发行版安装 ufw（Debian/Ubuntu）或 firewalld（RHEL/CentOS），先放行 SSH 端口避免断开连接，再放行 frps 与代理映射端口，最后启用。启用防火墙有极小概率因规则问题导致 SSH 断开，确定继续吗？',
          confirmText: '安装并启用',
          cancelText: '取消',
          danger: true,
        });
        if (!okConfirm) break;
        S.server.firewallBusy = true;
        renderServer(true);
        try {
          const res = await FRP.serverFirewallInstall();
          await loadServerFirewall(true);
          if (res && res.ok) {
            const now = (res.data && res.data.opened) || [];
            const prev = (S.server.firewall && S.server.firewall.opened) || [];
            const merged = [...new Set([...prev, ...now])];
            S.server.firewall = { ...(S.server.firewall || {}), opened: merged, notes: (res.data && res.data.notes) || [] };
            toast(`已安装并启用防火墙${now.length ? `，已放行：${now.join('、')}` : ''}`);
          } else {
            toast((res && res.error) || '安装防火墙失败', 'error');
          }
        } finally {
          S.server.firewallBusy = false;
          renderServer(true);
        }
        break;
      }
      case 'server.firewall.openports': {
        const input = $('#fw-manual-port');
        const protoSel = $('#fw-manual-proto');
        const text = (input && input.value || '').trim();
        const proto = (protoSel && protoSel.value) || 'both';
        if (!text) {
          toast('请输入要放行的端口', 'error');
          if (input) input.focus();
          break;
        }
        if (S.server.firewallBusy) break;
        S.server.firewallBusy = true;
        renderServer(true);
        try {
          const res = await FRP.serverFirewallOpenPorts({ text, proto });
          if (res && res.ok) {
            /* 放行后重新读防火墙真实规则，列表立即出现刚放行的端口。 */
            await loadServerFirewall(true);
            const now = (res.data && res.data.opened) || [];
            toast(`已放行：${now.join('、')}`);
          } else {
            toast((res && res.error) || '放行失败', 'error');
          }
        } finally {
          S.server.firewallBusy = false;
          renderServer(true);
          const again = $('#fw-manual-port');
          if (again) again.focus();
        }
        break;
      }
      case 'server.firewall.close': {
        const checked = [...document.querySelectorAll('.fw-rule-del:checked')];
        if (!checked.length) { toast('请先勾选要删除的规则', 'error'); break; }
        const specs = checked.map((c) => c.value);
        if (S.server.firewallBusy) break;
        const okConfirm = await confirmDialog({
          title: '删除防火墙规则',
          body: `将从防火墙删除以下 ${specs.length} 条规则：${specs.map((s) => s).join('、')}。删除后这些端口将不再被放行，可能影响 frps 或代理的公网访问。确定继续吗？`,
          confirmText: '删除规则',
          cancelText: '取消',
          danger: true,
        });
        if (!okConfirm) break;
        S.server.firewallBusy = true;
        renderServer(true);
        try {
          const res = await FRP.serverFirewallClose({ specs });
          await loadServerFirewall(true);
          if (res && res.ok) {
            const removed = (res.data && res.data.removed) || [];
            const notes = (res.data && res.data.notes) || [];
            toast(removed.length ? `已删除规则：${removed.join('、')}` : '没有规则被删除（规则可能已不存在）', removed.length ? undefined : 'error');
            if (notes.length) toast(notes.join('；'), 'error');
          } else {
            toast((res && res.error) || '删除规则失败', 'error');
          }
        } finally {
          S.server.firewallBusy = false;
          renderServer(true);
        }
        break;
      }
      case 'server.control':
        await controlServer(btn, dataset.op);
        break;
      case 'server.bootstrap':
        await runServerBootstrap(btn);
        break;
      case 'server.bootstrap.cancel':
        await FRP.serverBootstrapCancel();
        toast('warn', '正在取消初始化…', '将在当前步骤完成后停止并清理已安装内容');
        break;
      case 'server.uninstall':
        await runServerUninstall(btn);
        break;
      case 'server.selftest':
        await runServerSelfTest();
        break;
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
      case 'server.frpc.verify':
        await verifyFrpcConfig(btn);
        break;
      case 'server.frpc.reload':
        await loadFrpcRaw();
        break;
      case 'server.frpc.save':
        await saveFrpcConfig(false, btn);
        break;
      case 'server.frpc.save.restart':
        await saveFrpcConfig(true, btn);
        break;
      case 'server.openlogs':
      case 'goto.logs.server': {
        S.logSource = 'server';
        setView('logs');
        S.lastKeys.logs = '';
        renderLogs(true);
        if (S.server.connected) await loadServerLogs();
        break;
      }
      case 'goto.server':
        setView('server');
        break;
      case 'logs.source': {
        const src = btn.dataset.source === 'server' ? 'server' : 'local';
        if (src === 'server' && !S.server.connected) {
          toast('warn', '先连上服务器', '服务器还没连上，读不到它的 frps 日志；连上之后这里会自动出现。');
          break;
        }
        if (src === S.logSource) break;
        S.logSource = src;
        S.lastKeys.logs = '';
        renderLogs(true);
        if (src === 'server' && S.server.connected && !S.server.logs) await loadServerLogs();
        break;
      }
      case 'logs.server.refresh':
        await loadServerLogs();
        break;
      case 'logs.server.errors': {
        S.server.logErrorsOnly = !S.server.logErrorsOnly;
        renderLogs(true);
        break;
      }
      case 'logs.server.expand': {
        S.server.logExpanded = !S.server.logExpanded;
        renderLogs(true);
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
        /* 打开之前先探一次：面板端口被云安全组拦着时，浏览器只会给一个空白页/超时，
         * 用户根本猜不到原因。这里直接告诉他拦在哪一层。 */
        try {
          const probe = await FRP.serverProbePort({ host, port: Number(summary.webPort), proto: 'tcp', timeout: 2000 });
          const data = (probe && probe.data) || null;
          if (probe && probe.ok && data && data.ok === false) {
            toast('error', `面板端口 ${summary.webPort} 从本机连不上`, '如果 SSH 正常但面板打不开，多半是云安全组没放行这个端口；也可能是 frps 没监听它。');
            break;
          }
        } catch { /* 探测失败不阻塞打开 */ }
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
      case 'known.refresh': {
        await loadKnownHosts(true);
        break;
      }
      case 'known.forget': {
        const host = btn && btn.dataset ? btn.dataset.host : '';
        const port = Number((btn && btn.dataset && btn.dataset.port) || 22);
        if (!host) break;
        const okForget = await confirmDialog({
          title: `忘掉 ${host}:${port} 的指纹？`,
          body: '删掉之后，下次连这台服务器会重新记录它出示的指纹——如果现在这台机器的密钥确实换过（重装系统、换 sshd），这么做是对的；如果没换过，先别急着删，那可能是有人在中间冒充它。',
          confirmText: '删掉',
          cancelText: '取消',
          danger: true,
        });
        if (!okForget) break;
        const res = await FRP.serverForgetHost({ host, port }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (!res || !res.ok) { toast('error', '没删掉', (res && res.error) || ''); break; }
        S.knownHosts = { loaded: true, loading: false, hosts: (res.data && res.data.hosts) || [], error: '' };
        const box = $('#known-hosts-box');
        if (box) box.innerHTML = knownHostsMarkup();
        toast('ok', `已忘掉 ${host}:${port} 的指纹`);
        break;
      }
      case 'settings.reveal':
        FRP.revealPath('config');
        break;
      case 'reveal.log':
        FRP.revealPath('log');
        break;
      case 'settings.gen.adminpass': {
        const input = $('#in-adminpass');
        if (!input) break;
        input.value = randomAdminPassword();
        input.type = 'text';
        const note = $('#adminpass-note');
        if (note) note.innerHTML = '';
        toast('success', '已生成 20 位随机口令', '记得点「保存行为设置」才会写进 frpc.toml');
        break;
      }
      case 'settings.eye.adminpass': {
        const input = $('#in-adminpass');
        if (!input) break;
        input.type = input.type === 'password' ? 'text' : 'password';
        break;
      }
      case 'settings.openstartup': {
        const res = await FRP.openStartupFolder();
        if (!res || !res.ok) toastResult(res);
        break;
      }
      case 'settings.save.behavior':
        await saveBehavior(btn);
        break;
      case 'toggle': {
        const target = btn.classList.toggle('on');
        btn.setAttribute('aria-pressed', String(target));
        break;
      }
      case 'proxyform.suggest': {
        const res = await FRP.suggestPort($('#pf-type') ? $('#pf-type').value : 'tcp');
        const input = $('#pf-remote');
        if (res && res.ok && res.data.port) {
          if (input) input.value = res.data.port;
          const st = $('#pf-remote-status');
          if (st) { st.textContent = `已填入 ${res.data.port}，建议点「检测」确认可用`; st.className = 'field-hint'; }
        } else {
          toast('warn', '没找到可用端口', (res && res.data && res.data.reason) || '');
        }
        break;
      }
      case 'dash.rotate': {
        const srv = S.server || {};
        if (!srv.connected || !srv.config) { toast('warn', '先连上服务器再换面板口令'); break; }
        const okIdea = await confirmDialog({
          title: '换成随机口令？',
          body: '会改服务器上 frps.toml 里 [webServer] 的 password，然后重启一次 frps——隧道会短暂中断几秒，之后自动恢复。',
          confirmText: '换',
          cancelText: '取消',
          danger: true,
        });
        if (!okIdea) break;
        await withBusy(btn, async () => {
          /* 口令生成与 TOML 改写放在主进程（frpsconfig.rotateWebPassword），
           * 保存仍走「保存并重启 frps」这条既有路径，校验/备份/冲突确认都在那儿。 */
          const rot = await FRP.serverRotateWebPassword()
            .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
          if (!rot || !rot.ok) {
            toast('error', '口令没换成', (rot && rot.error) || '没找到 [webServer] 段');
            return;
          }
          const newConf = rot.data.content;
          const dashPass = rot.data.password;
          const res = await FRP.serverSaveConfig(newConf, true)
            .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
          if (!res || !res.ok) { toast('error', '口令没换成', (res && res.error) || ''); return; }
          await confirmDialog({
            title: '面板口令已更换',
            body: `新口令（现在抄下来，之后不再显示）：<br><br><code style="font-size:13px">${esc(dashPass)}</code><br><br>面板用户名不变。frps 已重启，稍等几秒隧道会自己连回来。`,
            confirmText: '知道了',
            cancelText: '关闭',
          });
          await loadServerState({ silent: true }).catch(() => {});
        });
        break;
      }
      case 'admin.rotate': {
        const okRotate = await confirmDialog({
          title: '换成随机口令？',
          body: '会把本机 frpc 的「管理 API」口令换成一个 20 位随机串（用户名不变）。它只影响本机回环上的管理接口，不影响隧道；如果隧道正在跑，会重启一次 frpc 让新口令生效。新口令之后能在「设置 → 客户端管理 API」里查看。',
          confirmText: '换',
          cancelText: '取消',
        });
        if (!okRotate) break;
        const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
        let newPass = '';
        for (let i = 0; i < 20; i += 1) newPass += alphabet[Math.floor(Math.random() * alphabet.length)];
        const savedRes = await FRP.saveSettings({ adminPassword: newPass })
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (!savedRes || !savedRes.ok) { toast('error', '口令没保存成功', (savedRes && savedRes.error) || ''); break; }
        const rtNow = (S.state && S.state.runtime) || {};
        if (rtNow.mode === 'managed' || rtNow.childAlive) {
          await FRP.restartTunnel().catch(() => {});
        }
        toast('ok', '管理 API 口令已换成随机口令', '在「设置 → 客户端管理 API」里可以查看');
        const refreshed = await FRP.refresh().catch(() => null);
        if (refreshed && refreshed.ok) { S.state = refreshed.data; updateChrome(); renderCurrent({ force: true }); }
        break;
      }
      case 'proxyform.random': {
        const res = await FRP.randomPort($('#pf-type') ? $('#pf-type').value : 'tcp');
        const input = $('#pf-remote');
        if (res && res.ok && res.data.port) {
          if (input) input.value = res.data.port;
          const st = $('#pf-remote-status');
          if (st) { st.textContent = `已填入随机端口 ${res.data.port}，建议点「检测」确认可用`; st.className = 'field-hint'; }
        } else {
          toast('warn', '没找到可用端口', (res && res.data && res.data.reason) || '');
        }
        break;
      }
      case 'proxyform.checkport': {
        await checkRemotePortUI();
        break;
      }
      case 'proxyform.openfw': {
        const input = $('#pf-remote');
        const port = input ? Number(input.value) : 0;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          toast('warn', '先填一个端口', '填好公网端口再放行');
          break;
        }
        const proto = proxyFormProto();
        await withBusy(btn, async () => {
          const res = await FRP.serverFirewallOpenPorts(String(port), proto);
          if (!res || !res.ok) return toastResult(res);
          const opened = (res.data && res.data.opened) || [];
          toast('success', `已放行 ${port}/${proto}`, opened.length ? opened.join('、') : '规则已存在');
          await checkRemotePortUI();
        });
        break;
      }
      case 'proxyform.type': {
        setProxyFormType(dataset.type);
        // 切到 http 时，https2http/https2https 插件不适用（只在 https 下有效），清掉。
        if (dataset.type === 'http') setProxyPluginFields('');
        refreshDomainReadiness();
        break;
      }
      case 'proxyform.plugin': {
        setProxyPluginFields(dataset.plugin || '');
        // https2http/https2https 需要 type=https，选插件时把类型一并切到 https。
        if (dataset.plugin) setProxyFormType('https');
        refreshDomainReadiness();
        break;
      }
      case 'proxyform.goto.server': {
        closeModal();
        setView('server');
        break;
      }
      case 'proxyform.cert.fill': {
        const domain = $('#pf-plugin-cert-fill') ? $('#pf-plugin-cert-fill').value : '';
        if (!domain) break;
        const cert = (S.certs.list || []).find((c) => c.domain === domain);
        if (cert) {
          const crt = $('#pf-plugin-crt');
          const key = $('#pf-plugin-key');
          if (crt) crt.value = cert.crtPath;
          if (key) key.value = cert.keyPath;
          toast('success', '已填入证书路径', cert.domain);
        }
        break;
      }
      case 'certs.godns': {
        S.certs.wizard = { ...(S.certs.wizard || {}), expanded: true };
        renderCerts(true);
        const input = $('#cert-dns-token');
        if (input) {
          input.scrollIntoView({ block: 'center' });
          input.focus();
        }
        break;
      }
      case 'certs.refresh':
        await loadCerts();
        break;
      case 'certs.server.scan': {
        if (!S.server.connected) { toast('warn', '还没连服务器', '到「服务器」页连上服务器后再扫描'); break; }
        await loadServerCerts({ force: true });
        const st = S.certs.server;
        if (st.error) toast('error', '扫描失败', st.error);
        else toast('ok', '扫描完成', `服务器上有 ${st.certs.length} 张证书`);
        break;
      }
      case 'cert.import': {
        const domain = dataset.domain || '';
        const certPath = dataset.certPath || '';
        const keyPath = dataset.keyPath || '';
        if (!certPath) { toast('warn', '缺少证书路径', '重新扫描服务器后再试'); break; }
        const okImport = await confirmDialog({
          title: `把 ${domain || certPath} 导入本机？`,
          body: `会把服务器上的证书与私钥复制到本机证书库（userData\\certs）。不改动服务器上的任何文件。\n\n证书：${certPath}\n私钥：${keyPath || '（无）'}`,
          confirmText: '导入',
        });
        if (!okImport) break;
        const res = await withBusy(btn, () => FRP.certImport({ domain, certPath, keyPath }));
        if (!res || !res.ok) { toast('error', '导入失败', (res && res.error) || '未知错误'); break; }
        toast('ok', '已导入到本机', `${res.data.domain} · ${(res.data.domains || []).join(', ')}`);
        // 重新拉列表并强制重画：只靠 loadCerts 内部的重画在某些时序下（弹窗关闭后）会被跳过
        try { await loadCerts({ silent: true }); } catch { /* ignore */ }
        if (S.view === 'certs') renderCerts(true);
        break;
      }
      case 'cert.reissue': {
        const domain = dataset.domain || '';
        if (!domain) break;
        const okIssue = await confirmDialog({
          title: `用 ACME 重新签发 ${domain}？`,
          body: `会用本机已配置的 DNS 验证渠道（Cloudflare Token）走 Let's Encrypt DNS-01 重新签一张 ${domain} 的证书，并保存到本机证书库。如果这张证书是宝塔/certbot 在用的，签完还需要点「部署到 nginx」才会替换线上证书。`,
          confirmText: '签发',
        });
        if (!okIssue) break;
        const res = await withBusy(btn, () => FRP.certIssue({ domains: [domain] }));
        if (!res || !res.ok) { toast('error', '签发失败', (res && res.error) || '未知错误'); break; }
        toast('ok', '签发成功', `${res.data.domain} · 剩余 ${res.data.daysLeft} 天`);
        try { await loadCerts({ silent: true }); } catch { /* ignore */ }
        if (S.view === 'certs') renderCerts(true);
        break;
      }
      case 'cert.server.remove': {
        const domain = dataset.domain || '';
        const certPath = dataset.certPath || '';
        const keyPath = dataset.keyPath || '';
        if (!certPath) { toast('warn', '缺少证书路径', '重新扫描服务器后再试'); break; }
        const files = [certPath, keyPath].filter(Boolean);
        const okDel = await confirmDialog({
          title: `从服务器删除 ${domain || certPath}？`,
          danger: true,
          body: `将从服务器删除下面这些文件（删除前会自动检查有没有站点还在引用）：\n\n${files.map((f) => `· ${f}`).join('\n')}\n\n文件会先移进服务器 /tmp 下的回收目录，nginx 校验通过后重载；如果弄错了可以从那里搬回来。`,
          confirmText: '删除',
        });
        if (!okDel) break;
        await withBusy(btn, async () => {
          const res = await FRP.certServerRemove({ domain, certPath, keyPath });
          if (!res || !res.ok) {
            const refs = (res && res.references) || [];
            /* 有站点引用：不硬拒，交给三选一弹窗（换证书 / 停用站点 / 强制删除）。 */
            if (refs.length) {
              openCertRefsModal({ domain, certPath, keyPath, refs, sites: (res && res.sites) || [] });
              return;
            }
            return toastResult(res);
          }
          const moved = (res.data && res.data.deleted) || [];
          const trash = (res.data && res.data.trash) || '';
          toast('success', '已从服务器删除证书', `${domain || certPath}${trash ? ` · 已移入 ${trash}` : ''}`);
          try { await loadServerCerts({ force: true }); } catch { /* ignore */ }
          if (moved.length && S.view === 'certs') renderCerts(true);
        });
        break;
      }

      case 'dw.check':
        await refreshDomainWizard();
        break;
      case 'dw.toggle': {
        const w = S.certs.wizard;
        const hasToken = !!((S.certs.dns || {}).hasToken);
        const certsLen = (S.certs.list || []).length;
        const cur = w.expanded === undefined ? !(hasToken && certsLen) : w.expanded;
        w.expanded = !cur;
        renderCerts(true);
        break;
      }
      case 'dw.set-a': {
        const domain = String(S.certs.wizard.domain || '').trim();
        if (!domain) { toast('error', '请先输入域名'); break; }
        await withBusy(btn, async () => {
          S.certs.wizard.setA = true;
          renderCerts(true);
          const res = await FRP.dnsSetA({ domain });
          S.certs.wizard.setA = false;
          if (res && res.ok) {
            // 乐观更新：A 记录刚建/改完，公共 DNS 传播需要几分钟，立刻 dnsResolve 会拿到旧值，
            // 让向导显示「没指向服务器」。这里直接用刚写入的 IP 作为结果，不等传播。
            S.certs.wizard.dns = { resolved: [res.data.content], pointsToServer: true, error: '' };
            toast('success', '解析记录已就绪', `${res.data.name} → ${res.data.content}${res.data.updated ? '' : '（已存在，无需改动；公共 DNS 传播可能需要几分钟）'}`);
          } else toastResult(res);
          renderCerts(true);
        });
        break;
      }
      case 'certs.issue': {
        const domainsInput = $('#cert-domains') ? $('#cert-domains').value.trim() : '';
        if (!domainsInput) { toast('error', '请填写要签发的域名'); break; }
        const domains = domainsInput.split(/[,，\s]+/).map((d) => d.trim()).filter(Boolean);
        const email = $('#cert-email') ? $('#cert-email').value.trim() : '';
        // 记住邮箱（供下次进入与自动续期使用）
        try { await FRP.saveSettings({ acmeEmail: email }); } catch (_) { /* 不影响签发 */ }
        S.certs.issuing = true;
        renderCerts(true);
        showCertProgress('正在签发正式证书');
        const offProgress = FRP.on('cert:progress', updateCertProgress);
        try {
          const res = await FRP.certIssue({ domains, email });
          if (res && res.ok) {
            const nginx = res.data && res.data.nginx;
            if (nginx && nginx.ok) {
              toast('success', '证书已签发并部署到 nginx', `${res.data.domain} · 剩余 ${res.data.daysLeft} 天 · ${nginx.serverNames} → 80/443`);
            } else {
              toast('success', '证书已签发', `${res.data.domain} · 剩余 ${res.data.daysLeft} 天${nginx ? `（未上传 nginx：${nginx.error}）` : ''}`);
            }
            S.certs.wizard.expanded = true; // 签发后保持展开，让用户接着看「填进代理」
            await loadCerts({ silent: true });
          } else toastResult(res);
        } catch (e) {
          toast('error', '签发失败', e && e.message ? e.message : String(e));
        } finally {
          offProgress();
          closeModal();
          S.certs.issuing = false;
          renderCerts(true);
        }
        break;
      }
      case 'certs.renew': {
        showCertProgress('正在续期证书');
        const offProgress = FRP.on('cert:progress', updateCertProgress);
        try {
          const res = await FRP.certRenew(dataset.domain);
          if (res && res.ok) {
            const nginx = res.data && res.data.nginx;
            toast('success', '证书已续期', `${res.data.domain} · 剩余 ${res.data.daysLeft} 天${nginx && nginx.ok ? ' · 已同步到 nginx' : ''}`);
            await loadCerts({ silent: true });
          } else toastResult(res);
        } finally {
          offProgress();
          closeModal();
        }
        break;
      }
      case 'cert.dns':
      case 'certs.dns': {
        openDnsPanel(dataset.domain || dataset.name || '');
        break;
      }
      case 'dns.refresh': {
        loadDnsPanel();
        break;
      }
      case 'dns.add': {
        if (!S.dns || S.dns.busy) break;
        const type = ($('#dns-add-type') || {}).value || 'A';
        const nameEl = $('#dns-add-name');
        const contentEl = $('#dns-add-content');
        const ttlEl = $('#dns-add-ttl');
        const proxEl = $('#dns-add-proxied');
        const content = contentEl ? contentEl.value.trim() : '';
        if (!content) { toast('warn', '请填写记录内容', 'A 记录填服务器 IP，CNAME 填目标域名'); break; }
        S.dns.busy = true;
        S.dns.addError = '';
        renderDnsPanel();
        try {
          const res = await FRP.dnsAddRecord({
            domain: S.dns.name,
            type,
            name: (nameEl && nameEl.value.trim()) || S.dns.name,
            content,
            ttl: Number(ttlEl && ttlEl.value) || 120,
            proxied: !!(proxEl && proxEl.checked),
          });
          S.dns.busy = false;
          if (res && res.ok) {
            toast('success', '记录已添加', `${res.data.type} ${res.data.name} → ${res.data.content}`);
          } else {
            S.dns.addError = (res && res.error) || '添加失败';
            toastResult(res);
          }
        } catch (e) {
          S.dns.busy = false;
          S.dns.addError = String((e && e.message) || e);
        }
        renderDnsPanel();
        if (!S.dns.addError) await loadDnsPanel();
        break;
      }
      case 'dns.del': {
        if (!S.dns || S.dns.busy) break;
        const id = dataset.id || '';
        const label = `${dataset.type || ''} ${dataset.content || ''}`.trim();
        const okDel = await confirmDialog({
          title: '删除 DNS 记录',
          body: `确定要删除 Cloudflare 里的这条记录吗？<div class="mono" style="margin-top:8px">${esc(label)}</div><div class="field-hint">删除后公网立刻解析不到这个域名（按 TTL 生效），如需恢复要重新添加。</div>`,
          confirmText: '删除',
          danger: true,
        });
        /* confirmDialog 会复用同一个 #modal-root 并 closeModal，确认/取消都会把 DNS 面板顶掉，
         * 所以这里先把面板放回去，用户取消也能继续看。 */
        openModal(dnsPanelMarkup());
        if (!okDel) break;
        S.dns.busy = true;
        renderDnsPanel();
        let res = null;
        try { res = await FRP.dnsDelRecord({ domain: S.dns.name, id }); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
        S.dns.busy = false;
        if (res && res.ok) toast('success', '记录已删除', label);
        else toastResult(res);
        await loadDnsPanel();
        break;
      }
      case 'certs.nginx': {
        await withBusy(btn, async () => {
          const res = await FRP.certNginxSync({ domain: dataset.domain });
          if (res && res.ok) {
            toast('success', '已部署到 nginx', `${res.data.serverNames} → 80/443 → frps ${res.data.frpsHttpPort}`);
          } else toastResult(res);
          // 刷新证书列表，让「已部署到 nginx / 未部署到 nginx」徽标反映最新结果。
          await loadCerts({ silent: true });
        });
        break;
      }
      case 'certs.remove': {
        const domain = dataset.domain;
        /* 先问主进程「有没有代理在用这张证书」：https2http/https2https 的 crtPath 指向它，
         * 删了之后 frpc 会拒绝加载整份配置（所有代理一起起不来），必须在确认框里说清楚。 */
        const probe = await FRP.certRemove(domain, { dryRun: true }).catch(() => null);
        const usedBy = (probe && probe.usedBy) || [];
        openModal(`
          <div class="modal" style="width:460px">
            <div class="modal-head">
              <div class="mh-icon" style="color:var(--red)">${icon('trash')}</div>
              <div class="grow"><h3>删除证书</h3><p>只删除本机保存的证书与私钥，不会吊销 CA 侧已签发的证书。</p></div>
              <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
            </div>
            <div class="modal-body">
              ${usedBy.length
                ? `<div class="note error">${icon('alert')}<div><strong>有 ${usedBy.length} 条代理正在用这张证书</strong><br>${esc(usedBy.join('、'))}<br>删掉后 frpc 会拒绝加载整份配置，<b>所有代理一起起不来</b>。建议先把这些代理改成别的证书（或删掉它们），再删这张。</div></div>`
                : `<div class="note warn">${icon('alert')}<div>删除后，引用 <strong>${esc(domain)}</strong> 证书的 https2http / https2https 代理会失去证书，公网访问会失败，直到重新签发并填回路径。</div></div>`}
            </div>
            <div class="modal-foot">
              <span class="mf-left"></span>
              <button class="btn" type="button" data-act="modal.close">取消</button>
              <button class="btn danger" type="button" id="cert-del-confirm">${icon('trash')}<span>${usedBy.length ? '仍然删除' : '删除'}</span></button>
            </div>
          </div>`);
        const delBtn = $('#cert-del-confirm');
        if (delBtn) delBtn.addEventListener('click', async () => {
          delBtn.disabled = true;
          const res = await FRP.certRemove(domain, { force: true });
          if (res && res.ok) {
            closeModal();
            toast('success', '已删除证书', domain);
            await loadCerts({ silent: true });
          } else {
            delBtn.disabled = false;
            toastResult(res);
          }
        });
        break;
      }
      case 'certs.dns.save': {
        await withBusy(btn, async () => {
          const provider = $('#cert-dns-provider') ? $('#cert-dns-provider').value : '';
          const token = $('#cert-dns-token') ? $('#cert-dns-token').value.trim() : '';
          const res = await FRP.dnsSave({ provider, token: token || undefined });
          if (res && res.ok) {
            if (res.data && res.data.state) S.state = res.data.state;
            toast('success', 'DNS 设置已保存');
            await loadCerts({ silent: true });
          } else toastResult(res);
        });
        break;
      }
      case 'certs.dns.verify': {
        const token = $('#cert-dns-token') ? $('#cert-dns-token').value.trim() : '';
        await withBusy(btn, async () => {
          const res = await FRP.dnsVerify({ token });
          if (res && res.ok && res.data && res.data.active) {
            const note = (res.data && res.data.note) ? `（${res.data.note}）` : '';
            toast('success', 'Token 有效', `Cloudflare 校验通过${note}，可以保存并继续下一步。`);
          } else if (res && res.ok) {
            toast('warn', 'Token 校验未通过', `状态：${(res.data && res.data.status) || '未知'}`);
          } else {
            toastResult(res);
          }
        });
        break;
      }
      case 'certs.dns.clear': {
        const res = await FRP.dnsSave({ provider: '', clearToken: true });
        if (res && res.ok) {
          if (res.data && res.data.state) S.state = res.data.state;
          toast('success', '已清除 Cloudflare token');
          await loadCerts({ silent: true });
        } else toastResult(res);
        break;
      }
      case 'certs.dns.eye': {
        const input = $('#cert-dns-token');
        if (input) input.type = input.type === 'password' ? 'text' : 'password';
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

/* 「目标服务器」= 这条代理要写进哪一条连接的 frpc.toml。数据源是**全部连接**
 * （含已停止、未配置），未配置的选项置灰并说明先去配置；一条连接都没有时给引导。
 * 编辑时锁定：代理存在某条连接的配置文件里，换服务器等于搬走它，先不做。 */
function targetServerFieldHtml(selectedId, locked) {
  const list = S.state && Array.isArray(S.state.connections) ? S.state.connections : [];
  if (!list.length) {
    return [
      '<div class="field-hint warn">还没有连接任何服务器：先到「服务器」页连上一台（或新建一条连接），再回来加代理。</div>',
      '<div class="page-actions"><button class="btn" type="button" data-act="proxyform.goto.server">' + icon('server') + '<span>前往连接服务器</span></button></div>',
    ].join('');
  }
  const pick = String(selectedId || '');
  const opts = list.map((c) => {
    const configured = !!String(c.serverAddr || '').trim();
    const rt = c.runtime || {};
    const status = !configured ? '未配置' : (rt.connected ? '在线' : (rt.running ? '已启动 · 未连上' : '已停止'));
    const label = (c.name || c.id) + ' · ' + (configured ? c.serverAddr : '还没有服务器地址') + ' · ' + status + (c.active ? '（当前）' : '');
    return '<option value="' + esc(c.id) + '"' + (c.id === pick ? ' selected' : '') + (configured ? '' : ' disabled') + '>' + esc(label) + '</option>';
  }).join('');
  const chosen = list.find((c) => c.id === pick) || null;
  const chosenConfigured = !!(chosen && String(chosen.serverAddr || '').trim());
  const hint = chosenConfigured
    ? '代理会写进这条连接的 frpc.toml；同一台服务器上不能重名。'
    : '这条连接还没有服务器地址：先在「服务器」页把它连上并配好 frps，再回来加代理。';
  const ctrl = locked
    ? '<select class="input" id="pf-target" disabled>' + opts + '</select><input type="hidden" id="pf-target-locked" value="' + esc(pick) + '" />'
    : '<select class="input" id="pf-target">' + opts + '</select>';
  const guide = list.some((c) => String(c.serverAddr || '').trim())
    ? ''
    : '<div class="page-actions"><button class="btn" type="button" data-act="proxyform.goto.server">' + icon('server') + '<span>前往连接服务器</span></button></div>';
  const lockNote = locked ? '<div class="field-hint">编辑时不能换服务器；要换请在目标服务器上重新创建这条代理。</div>' : '';
  return '<div class="input-group">' + ctrl + '</div><div class="field-hint" id="pf-target-hint">' + esc(hint) + '</div>' + lockNote + guide;
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
    pluginType: current.plugin ? current.plugin.type || '' : '',
    pluginCrtPath: current.plugin ? current.plugin.crtPath || '' : '',
    pluginKeyPath: current.plugin ? current.plugin.keyPath || '' : '',
    pluginHostHeaderRewrite: current.plugin ? current.plugin.hostHeaderRewrite || '' : '',
    openPath: current.openPath || '',
    target: (S.state && S.state.activeConnectionId) || '',
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
            <div class="field-hint">名称不能和「同一台服务器」上已有的代理重复（不同服务器可以同名）。</div>
          </div>
          <div class="field span-2" id="pf-target-field">
            <label>目标服务器</label>
            ${targetServerFieldHtml(initial.target, mode === 'edit')}
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
              <button class="btn icon" type="button" data-act="proxyform.suggest" title="按顺序找一个空闲端口">${icon('reload')}</button>
              <button class="btn icon" type="button" data-act="proxyform.random" title="随机一个端口">${icon('shuffle')}</button>
              <button class="btn" type="button" data-act="proxyform.checkport" title="连服务器检查端口占用">${icon('activity')}<span>检测</span></button>
            </div>
            <div class="field-hint" id="pf-remote-status">服务器上对外开放的端口，注意不要与已有服务冲突。</div>
            <div class="field-hint" id="pf-fw-status" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center"></div>
          </div>
          <div class="field span-2" id="pf-openpath-field">
            <label>访问路径（可选）</label>
            <input class="input" id="pf-openpath" name="openPath" value="${esc(initial.openPath)}" placeholder="例如 /panel/（留空 = 根路径 /）" spellcheck="false" />
            <div class="field-hint">不少服务根路径直接 404、真正的入口在子路径（如 <code>/panel/</code>）。填了之后：<b>复制/打开的链接</b>和<b>公网连通性探测</b>都会走这条路径；配了 nginx 域名反代时还会给根路径加一条 302 跳过来。</div>
          </div>
          <div class="field span-2 hidden" id="pf-domain-field">
            <label>自定义域名（逗号分隔）</label>
            <input class="input" id="pf-domains" name="customDomains" value="${esc(initial.customDomains)}" placeholder="example.com, sub.example.com" />
            <div class="field-hint">HTTP/HTTPS 类型必填；使用 frps 的 vhost 域名转发。</div>
            <div class="field-hint" id="pf-domain-readiness" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px"></div>
          </div>
          <div class="field span-2 hidden" id="pf-plugin-field">
            <label>HTTPS 证书 / TLS 终止</label>
            <div class="seg" id="pf-plugin-types">
              <button type="button" data-act="proxyform.plugin" data-plugin="" class="${!initial.pluginType ? 'active' : ''}">透传（本地服务自己配证书）</button>
              <button type="button" data-act="proxyform.plugin" data-plugin="https2http" class="${initial.pluginType === 'https2http' ? 'active' : ''}">https2http（frps 终止 TLS，后端是 HTTP）</button>
              <button type="button" data-act="proxyform.plugin" data-plugin="https2https" class="${initial.pluginType === 'https2https' ? 'active' : ''}">https2https（frps 终止 TLS，后端仍是 HTTPS）</button>
            </div>
            <div class="field-hint">“透传”= frps 只按域名把加密流量原样转给本地服务，证书由本地服务自己持有；“https2http / https2https”= frps 替你解 TLS，需要把证书交给 frpc。</div>
          </div>
          <div class="field span-2 hidden" id="pf-plugin-fields">
            <div class="stack" style="gap:10px">
              <div class="field hidden" id="pf-plugin-cert-match-field">
                <label>证书快捷填入</label>
                <div id="pf-plugin-cert-match"></div>
                <div class="field-hint">已按上方「自定义域名」自动匹配，选一张即写入下方 crtPath / keyPath。</div>
              </div>
              <div class="field">
                <label>证书文件（crtPath）<span class="req">*</span></label>
                <input class="input" id="pf-plugin-crt" value="${esc(initial.pluginCrtPath)}" placeholder="C:\path\to\server.crt（绝对路径）" />
              </div>
              <div class="field">
                <label>私钥文件（keyPath）<span class="req">*</span></label>
                <input class="input" id="pf-plugin-key" value="${esc(initial.pluginKeyPath)}" placeholder="C:\path\to\server.key（绝对路径）" />
              </div>
              <div class="field">
                <label>Host 重写（hostHeaderRewrite，可选）</label>
                <input class="input" id="pf-plugin-host" value="${esc(initial.pluginHostHeaderRewrite)}" placeholder="例如 127.0.0.1（把 Host 头改写后发给后端）" />
              </div>
            </div>
            <div class="field-hint">证书和私钥由 Let's Encrypt 或你自己的证书源签发，路径必须是 frpc 这台机器上的绝对路径。证书绑定的域名要和上面的自定义域名一致。</div>
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
  refreshDomainReadiness();
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
  const domainsInput = $('#pf-domains');
  if (domainsInput) {
    let readyTimer = null;
    domainsInput.addEventListener('input', () => {
      clearTimeout(readyTimer);
      readyTimer = setTimeout(() => refreshDomainReadiness(), 350);
    });
  }
  setTimeout(() => { const name = $('#pf-name'); if (name) name.focus(); }, 30);
  refreshServerSummarySilently();
}

/* 代理表单里的 vhost 徽标是按「服务器真实配置」判断的，而 S.server.summary 可能是早先
 * 在别的页面缓存下来的旧值（服务器被改过、或在服务器页之外改了 frps.toml）。
 * 打开表单时静默补一次最新快照，避免把已经开好的端口报成「没开」。 */
async function refreshServerSummarySilently() {
  if (!(S.server && S.server.connected)) return;
  const res = await FRP.serverState();
  if (!res || !res.ok || !res.data) return;
  if (!document.querySelector('#pf-domains')) return;
  S.server.summary = res.data.summary || S.server.summary;
  S.server.config = res.data.config || S.server.config;
  refreshDomainReadiness();
}

async function suggestRemotePort(type) {
  const res = await FRP.suggestPort(type);
  const input = $('#pf-remote');
  if (res && res.ok && res.data.port) {
    if (input && !input.value) input.value = res.data.port;
  } else if (res && res.ok && !res.data.port) {
    toast('warn', '没找到可用端口', res.data.reason || '');
  }
}

function currentProxyPlugin() {
  const active = $('#pf-plugin-types [data-plugin].active');
  return active ? active.dataset.plugin : '';
}

function setProxyPluginFields(type) {
  const fields = $('#pf-plugin-fields');
  if (fields) fields.classList.toggle('hidden', !type);
  $$('#pf-plugin-types [data-plugin]').forEach((b) => b.classList.toggle('active', b.dataset.plugin === type));
}

function refreshProxyPluginFields() {
  setProxyPluginFields(currentProxyPlugin());
  renderPluginCertMatch();
}

function setProxyFormType(type) {
  const hidden = $('#pf-type');
  if (hidden) hidden.value = type;
  $$('#pf-types [data-type]').forEach((btn) => btn.classList.toggle('active', btn.dataset.type === type));
  const needsRemote = type === 'tcp' || type === 'udp' || type === 'tcpmux';
  const domainType = type === 'http' || type === 'https';
  const remoteField = $('#pf-remote-field');
  const domainField = $('#pf-domain-field');
  const pluginField = $('#pf-plugin-field');
  const openPathField = $('#pf-openpath-field');
  if (remoteField) remoteField.classList.toggle('hidden', !needsRemote);
  if (domainField) domainField.classList.toggle('hidden', !domainType);
  if (pluginField) pluginField.classList.toggle('hidden', !domainType);
  /* 访问路径只对能被浏览器打开的类型有意义：udp/sudp/stcp/xtcp 没有可访问的 URL。 */
  if (openPathField) openPathField.classList.toggle('hidden', ['udp', 'sudp', 'stcp', 'xtcp'].includes(type));
  // 切到 tcp/udp 时，插件字段一起收起；再切回 http/https 时按当前插件类型恢复显示
  if (!domainType) setProxyPluginFields('');
  else refreshProxyPluginFields();
  const remoteInput = $('#pf-remote');
  if (needsRemote && remoteInput && !remoteInput.value) suggestRemotePort(type);
}

/* ---------- 域名就绪提示（A/C） ----------
 * 在代理表单里，输入域名时实时给出「证书覆盖 / vhost 端口 / DNS 解析」三个软提示，
 * 全部只是提醒，不拦截保存。这样用户不会把没签证书、没解析的域名填进去后
 * 等隧道跑起来才发现公网访问不了。 */

function domainBadge(label, text, tone) {
  const cls = tone === 'ok' ? 'tag ok' : tone === 'bad' ? 'tag bad' : tone === 'amber' ? 'tag amber' : 'tag';
  return `<span class="${cls}">${esc(label)} · ${esc(text)}</span>`;
}

/* 带「一键开启」按钮的徽标：用于 frps 没开 vhost 端口这种「能就地修好」的情况。
 * nginx 反代的上游就是 frps 的 vhost 端口，没开时访问一定是 502，所以给个直接修好的入口。 */
function domainBadgeFix(label, text, tone, kind) {
  const cls = tone === 'ok' ? 'tag ok' : tone === 'bad' ? 'tag bad' : tone === 'amber' ? 'tag amber' : 'tag';
  const canFix = !!(S.server && S.server.connected);
  const fix = canFix
    ? `<button class="btn small" type="button" data-act="proxyform.vhost.enable" data-kind="${esc(kind)}">开启 vhost 端口</button>`
    : '';
  return `<span class="${cls}">${esc(label)} · ${esc(text)}</span>${fix}`;
}

function vhostBadgeFor(type) {
  const settings = (S.state && S.state.settings) || {};
  const serverSummary = S.server && S.server.summary;
  if (type === 'http') {
    if (serverSummary && typeof serverSummary.vhostHTTPPort === 'number') {
      return serverSummary.vhostHTTPPort
        ? domainBadge('vhost', `服务器已开 HTTP 端口 ${serverSummary.vhostHTTPPort}`, 'ok')
        : domainBadgeFix('vhost', 'frps 没开 vhostHTTPPort（nginx 反代的上游），http 代理会 502', 'bad', 'http');
    }
    return domainBadge('vhost', `按客户端设定 HTTP 端口 ${Number(settings.vhostHttpPort) || 80}`, '');
  }
  if (type === 'https') {
    if (serverSummary && typeof serverSummary.vhostHTTPSPort === 'number') {
      return serverSummary.vhostHTTPSPort
        ? domainBadge('vhost', `服务器已开 HTTPS 端口 ${serverSummary.vhostHTTPSPort}`, 'ok')
        : domainBadgeFix('vhost', 'frps 没开 vhostHTTPSPort，https 代理会失败', 'bad', 'https');
    }
    return domainBadge('vhost', `按客户端设定 HTTPS 端口 ${Number(settings.vhostHttpsPort) || 443}`, '');
  }
  return '';
}

function certBadgeFor(primary, pluginType) {
  if (!pluginType) return '';
  if (!primary) return domainBadge('证书', '填好域名后校验', '');
  const certs = S.certs.list || [];
  const covering = certs.filter((c) => (c.domains || []).some((pattern) => coversDomain(pattern, primary)));
  if (covering.length) return domainBadge('证书', `已覆盖：${covering.map((c) => c.domain).join('、')}`, 'ok');
  return domainBadge('证书', '未签发匹配证书', 'bad');
}

function renderDomainReadiness(badges) {
  const box = $('#pf-domain-readiness');
  if (box) box.innerHTML = badges.filter(Boolean).join('');
}

function renderPluginCertMatch() {
  const field = $('#pf-plugin-cert-match-field');
  const box = $('#pf-plugin-cert-match');
  if (!field || !box) return;
  const pluginType = currentProxyPlugin();
  const domainsInput = $('#pf-domains');
  const domainsText = domainsInput ? domainsInput.value.trim() : '';
  const primary = (domainsText.split(/[,，\s]+/)[0] || '').trim();
  const matching = (pluginType && primary)
    ? (S.certs.list || []).filter((c) => (c.domains || []).some((p) => coversDomain(p, primary)))
    : [];
  if (!matching.length) {
    field.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  field.classList.remove('hidden');
  box.innerHTML = `
    <select class="select" id="pf-plugin-cert-fill">
      <option value="">选择已签发证书…</option>
      ${matching.map((c) => `<option value="${esc(c.domain)}">${esc(c.domain)}（剩余 ${c.daysLeft} 天）</option>`).join('')}
    </select>`;
}

function refreshDomainReadiness() {
  const box = $('#pf-domain-readiness');
  if (!box) return;
  const typeEl = $('#pf-type');
  const type = typeEl ? typeEl.value : '';
  if (type !== 'http' && type !== 'https') { renderDomainReadiness([]); return; }
  const domainsInput = $('#pf-domains');
  const domainsText = domainsInput ? domainsInput.value.trim() : '';
  const domains = domainsText.split(/[,，\s]+/).map((d) => d.trim()).filter(Boolean);
  const primary = domains[0] || '';
  const pluginType = currentProxyPlugin();
  renderPluginCertMatch();

  const syncBadges = [primary ? vhostBadgeFor(type) : '', certBadgeFor(primary, pluginType)];
  if (!primary) { renderDomainReadiness(syncBadges); return; }

  syncBadges.push(domainBadge('DNS', '解析中…', ''));
  renderDomainReadiness(syncBadges);

  /* DNS 检查走和「DNS 记录」面板同一个数据源（FRP.dnsInspect）：
   * 同时问本机解析器 + 1.1.1.1 + 8.8.8.8 + 权威 NS，所以不会出现
   * 「面板说已解析、检测说未解析」这种自相矛盾，也不会因为本机 DNS 卡住
   * 20 秒而只显示一句「未解析」把用户引到错方向。 */
  dnsBadgeInfo(primary).then((info) => {
    const cur = $('#pf-domain-readiness');
    if (!cur) return;
    const nowType = $('#pf-type') ? $('#pf-type').value : '';
    if (nowType !== 'http' && nowType !== 'https') { renderDomainReadiness([]); return; }
    const nowText = ($('#pf-domains') ? $('#pf-domains').value.trim() : '');
    const nowDomains = nowText.split(/[,，\s]+/).map((d) => d.trim()).filter(Boolean);
    if (nowDomains[0] !== primary) return;
    const judge = (info && info.judge) || { tone: 'warn', title: '查询失败', detail: '' };
    const tone = judge.tone === 'ok' ? 'ok' : (judge.tone === 'bad' ? 'bad' : 'amber');
    const text = (() => {
      switch (judge.verdict) {
        case 'ok': return `已解析到 ${(judge.addrs || []).slice(0, 3).join('、') || '（见详情）'}`;
        case 'proxied': return `已解析（橙云代理，返回 CF IP ${(judge.addrs || [])[0] || ''}）`;
        case 'public-only': return '公共 DNS 已解析，本机解析器还没更新';
        case 'elsewhere': return `解析到 ${(judge.addrs || []).slice(0, 2).join('、')}，未指向服务器`;
        case 'missing': return '未解析（没有这条记录）';
        case 'stale': return '记录已删除（本机还缓存着旧值）';
        case 'cf-only': return 'Cloudflare 里有记录，本机解析没答上来';
        case 'unreachable': return 'DNS 查询失败（本机出网可能受限）';
        default: return judge.title || '解析结果不确定';
      }
    })();
    const viewBtn = `<button class="btn tiny" type="button" data-act="cert.dns" data-domain="${esc(primary)}" title="查看各 DNS 来源的实际情况，或直接增删记录">查看 DNS</button>`;
    renderDomainReadiness([
      vhostBadgeFor(nowType),
      certBadgeFor(primary, currentProxyPlugin()),
      `${domainBadge('DNS', text, tone)}${viewBtn}`,
    ]);
  });
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
  const pluginType = currentProxyPlugin();
  const pluginCrtPath = ($('#pf-plugin-crt') ? $('#pf-plugin-crt').value : '').trim();
  const pluginKeyPath = ($('#pf-plugin-key') ? $('#pf-plugin-key').value : '').trim();
  const pluginHostHeaderRewrite = ($('#pf-plugin-host') ? $('#pf-plugin-host').value : '').trim();
  const openPathRaw = ($('#pf-openpath') ? $('#pf-openpath').value : '').trim();
  /* 目标连接：编辑时用锁定值（隐藏域），新增时读下拉。空串 = 当前连接。 */
  const targetLockedEl = $('#pf-target-locked');
  const connectionId = targetLockedEl ? targetLockedEl.value : ($('#pf-target') ? $('#pf-target').value : '');

  if (!name) return showError('请填写代理名称');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return showError('名称建议只包含字母、数字、点、下划线或短横线');
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) return showError('本地端口必须是 1 - 65535 的整数');
  const needsRemote = type === 'tcp' || type === 'udp' || type === 'tcpmux';
  const domainType = type === 'http' || type === 'https';
  if (needsRemote && (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)) return showError('公网端口必须是 1 - 65535 的整数');
  if (domainType && !domains.trim()) return showError('HTTP/HTTPS 类型需要填写自定义域名');
  if (pluginType && !pluginCrtPath) return showError('使用 https2http / https2https 需要填写证书文件（crtPath）');
  if (pluginType && !pluginKeyPath) return showError('使用 https2http / https2https 需要填写私钥文件（keyPath）');

  const input = {
    name, type, localIP, localPort,
    remotePort: needsRemote ? remotePort : null,
    customDomains: domains,
    useCompression,
    useEncryption,
    /* 访问路径只存在我们这边（frpc.toml 不认），主进程按代理名记进 settings。
     * udp/stcp/xtcp 没有可访问的 URL，填了也没意义，直接丢掉。 */
    openPath: ['udp', 'sudp', 'stcp', 'xtcp'].includes(type) ? '' : openPathRaw,
  };
  if (pluginType) {
    input.plugin = {
      type: pluginType,
      localAddr: `${localIP || '127.0.0.1'}:${localPort}`,
      crtPath: pluginCrtPath,
      keyPath: pluginKeyPath,
    };
    if (pluginHostHeaderRewrite) input.plugin.hostHeaderRewrite = pluginHostHeaderRewrite;
  }
  if (errorEl) errorEl.classList.add('hidden');
  const submit = $('#pf-submit');
  if (submit) {
    submit.disabled = true;
    submit.innerHTML = `<span class="spinner-sm"></span><span>保存中…</span>`;
  }
  let res;
  try {
    res = await FRP.saveProxy(mode, mode === 'edit' ? S.proxyEdit.originalName : '', input, connectionId);
  } catch (error) {
    /* IPC 直接把异常抛过来时（比如写盘失败、主进程崩溃），
     * 以前这里会静默 reject：按钮一直转、界面毫无反应。 */
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = `${icon('check')}<span>${mode === 'edit' ? '保存修改' : '创建代理'}</span>`;
    }
    showError(String((error && error.message) || error));
    return;
  }
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
    `${name} · 配置已写入${res.data && res.data.connectionName ? '「' + res.data.connectionName + '」' : ''}${reloaded ? '并已热重载' : '，隧道启动后生效'}`,
  );
  const warnings = (res.data && res.data.warnings) || [];
  if (warnings.length) toast('warn', '代理已保存，但请注意', warnings[0]);
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


/* Electron 不支持 window.prompt（会抛 "prompt() is and will not be supported"）。
 * 需要用户填一个短文本时用它，返回字符串或 null。 */
function promptDialog({ title = '请输入', label = '', value = '', placeholder = '', confirmText = '确定', hint = '' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (data) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(data);
    };
    openModal(`
      <div class="modal" style="width:460px">
        <div class="modal-head">
          <div class="mh-icon" style="color:var(--accent)">${icon('edit')}</div>
          <div class="grow"><h3>${esc(title)}</h3></div>
          <button class="icon-btn modal-close" type="button" id="pd-x">${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${label ? `<div class="field"><label>${esc(label)}</label><input class="input" id="pd-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" /></div>` : ''}
          ${hint ? `<div class="field-hint">${esc(hint)}</div>` : ''}
        </div>
        <div class="modal-foot">
          <span class="mf-left"></span>
          <button class="btn" type="button" id="pd-cancel">取消</button>
          <button class="btn primary" type="button" id="pd-ok">${esc(confirmText)}</button>
        </div>
      </div>`);
    const input = $('#pd-input');
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(String(input.value || '')); }
      });
    }
    const ok = $('#pd-ok');
    if (ok) ok.addEventListener('click', () => finish(String((input && input.value) || '')));
    const cancel = $('#pd-cancel');
    if (cancel) cancel.addEventListener('click', () => finish(null));
    const x = $('#pd-x');
    if (x) x.addEventListener('click', () => finish(null));
  });
}

function confirmNginxPortConflict(conflicts = []) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; closeModal(); resolve(value); };
    const rows = conflicts.map((c) => `<div style="margin:6px 0">端口 <code>${esc(String(c.port))}</code> 被 <strong>${esc(c.by || '未知进程')}</strong> 占用</div>`).join('');
    openModal(`
      <div class="modal" style="width:500px">
        <div class="modal-head">
          <div class="mh-icon" style="color:var(--red)">${icon('alert')}</div>
          <div class="grow"><h3>80 / 443 端口被占用</h3><p>要用「域名不带端口访问」，nginx 必须占用 80 和 443。</p></div>
          <button class="icon-btn modal-close" type="button" id="pc-x">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="note warn">${icon('alert')}<div>
            ${rows || '<div>以下端口被 nginx 之外的程序占用。</div>'}
            <div style="margin-top:8px">终止这些进程会停掉它们提供的服务（可能是别的网站），请确认后再操作。也可以先手动停掉，再点「取消」后重新检测。</div>
          </div></div>
        </div>
        <div class="modal-foot">
          <span class="mf-left"></span>
          <button class="btn" type="button" id="pc-cancel">取消</button>
          <button class="btn danger" type="button" id="pc-kill">${icon('alert')}<span>终止占用进程并继续</span></button>
        </div>
      </div>`);
    const on = (id, value) => { const el = $(`#${id}`); if (el) el.addEventListener('click', () => finish(value)); };
    on('pc-kill', 'kill');
    on('pc-cancel', 'cancel');
    on('pc-x', 'cancel');
  });
}

function confirmFrpsPortConflict(details = []) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; closeModal(); resolve(value); };
    const rows = details.map((d) => `<div style="margin:6px 0"><code>${esc(d.label)}（${esc(String(d.port))}）</code> 被 <strong>${esc(d.process || '未知进程')}</strong> 占用</div>`).join('');
    openModal(`
      <div class="modal" style="width:540px">
        <div class="modal-head">
          <div class="mh-icon" style="color:var(--red)">${icon('alert')}</div>
          <div class="grow"><h3>配置端口与现有服务冲突</h3><p>这些端口已被占用，frps 启动会失败。</p></div>
          <button class="icon-btn modal-close" type="button" id="fc-x">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="note warn">${icon('alert')}<div>
            ${rows || '<div>检测到端口冲突。</div>'}
            <div style="margin-top:8px">「自动换端口」会挑空闲端口继续，并同步改 nginx 反代与本机隧道；「终止占用进程」会停掉占用这些端口的服务（可能影响它们）。</div>
          </div></div>
        </div>
        <div class="modal-foot">
          <span class="mf-left"></span>
          <button class="btn" type="button" id="fc-cancel">取消</button>
          <button class="btn danger" type="button" id="fc-kill">${icon('alert')}<span>终止占用进程</span></button>
          <button class="btn primary" type="button" id="fc-remap">${icon('reload')}<span>自动换端口并保存</span></button>
        </div>
      </div>`);
    const on = (id, value) => { const el = $(`#${id}`); if (el) el.addEventListener('click', () => finish(value)); };
    on('fc-remap', 'remap');
    on('fc-kill', 'kill');
    on('fc-cancel', 'cancel');
    on('fc-x', 'cancel');
  });
}

function confirmDeleteProxy(name, connId = '') {
  const conn = (S.state && Array.isArray(S.state.connections)) ? S.state.connections.find((c) => c.id === connId) : null;
  const whereText = conn ? `（属于「${conn.name || conn.id}」这条连接）` : '';
  openModal(`
    <div class="modal" style="width:440px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--red)">${icon('trash')}</div>
        <div class="grow"><h3>删除代理</h3><p>此操作会从 frpc.toml 中移除该映射（隧道运行时会一并热重载）。</p></div>
        <button class="icon-btn modal-close" type="button" data-act="modal.close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="note warn">${icon('alert')}<div>确定要删除代理 <strong>${esc(name)}</strong>${esc(whereText)} 吗？删除后公网地址会立即失效。</div></div>
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
      const res = await FRP.deleteProxy(name, connId);
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

/* 证书签发 / 续期的进度条弹窗：签发 DNS-01 要等权威 DNS 传播 + LE 验证，
 * 通常几十秒，给用户一个实时进度，而不是干等按钮转圈。 */
function showCertProgress(title) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal" style="width:420px">
      <div class="modal-head">
        <div class="mh-icon" style="color:var(--blue)">${icon('shield')}</div>
        <div class="grow"><h3>${esc(title)}</h3><p class="cert-progress-label" id="cert-progress-label">准备中…</p></div>
      </div>
      <div class="modal-body">
        <div class="cert-progress-track"><div class="cert-progress-fill" id="cert-progress-fill" style="width:0%"></div></div>
        <div class="cert-progress-pct" id="cert-progress-pct">0%</div>
      </div>
    </div>`;
  root.classList.add('open');
  S.modalOpen = true;
}

function updateCertProgress(data) {
  const percent = Math.max(0, Math.min(100, Number((data && data.percent) || 0)));
  const label = $('#cert-progress-label');
  const fill = $('#cert-progress-fill');
  const pct = $('#cert-progress-pct');
  if (label) label.textContent = (data && data.label) || '';
  if (fill) fill.style.width = `${percent}%`;
  if (pct) pct.textContent = `${Math.round(percent)}%`;
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
  /* 连接参数变了而隧道在跑时主进程会自动重启一次；把结果告诉用户，
   * 否则改了服务器地址却不知道隧道到底换没换。 */
  if (res && res.ok && res.data && res.data.restarted) {
    toast('info', '已按新服务器重启隧道', 'frpc 原来连的是旧地址，已经替你重启到新配置。');
  } else if (res && res.ok && res.data && res.data.restartError) {
    toast('warn', '隧道没能自动重启', String(res.data.restartError).slice(0, 160));
  }
  return res;
}

/* 跑着的 frpc 用的不是当前配置（改了服务器但没重启、或外部改文件没重载成功）。 */
function staleConfigNote() {
  const rt = (S.state && S.state.runtime) || {};
  const model = (S.state && S.state.config) || {};
  if (!rt.staleConfig) return '';
  const target = `${model.serverAddr || '?'}:${model.serverPort || '?'}`;
  return `<div class="note warn">${icon('alert')}<div><strong>隧道还在用旧配置运行</strong><br>界面里的 ${esc(target)} 还没生效——正在跑的 frpc 是用改之前的参数连的。点右边按钮按当前配置重启一次。</div><button class="btn small" data-act="tunnel.restart">${icon('reload')}重启隧道</button></div>`;
}

/* 管理 API 口令的强度提示：空 / 老默认 admin / 太短，都值得说一句。 */
function adminWeakNote(settings) {
  const pw = String((settings && settings.adminPassword) || '');
  if (!pw) {
    return `<div class="note bad">${icon('alert')}<div><strong>当前没有管理口令</strong><br>本机任何进程都能直接读 <code>/api/config</code>，里面带着 frps 的 <code>auth.token</code>。点「随机生成」或自己填一个。</div></div>`;
  }
  if (pw === 'admin') {
    return `<div class="note bad">${icon('alert')}<div><strong>口令还是老版本的默认值 admin</strong><br>知道这个默认值的人（或本机的任何程序）就能读到你的 frps <code>auth.token</code>。换成「随机生成」的 20 位口令。</div></div>`;
  }
  if (pw.length < 10) {
    return `<div class="note warn">${icon('alert')}<div>口令只有 ${pw.length} 位，建议 10 位以上（「随机生成」会给你 20 位）。</div></div>`;
  }
  return '';
}

/* 20 位随机口令：字母表去掉容易看错的 l/o/0/1，和控制台生成 frps 口令时一致。 */
function randomAdminPassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(20);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i += 1) buf[i] = Math.floor(Math.random() * 4294967296);
  let out = '';
  for (let i = 0; i < 20; i += 1) out += alphabet[buf[i] % alphabet.length];
  return out;
}

async function saveBehavior(btn) {
  const form = $('#form-behavior');
  if (!form) return;
  const patch = {
    runMode: form.querySelector('[name="runMode"]').value,
    pollIntervalMs: Number(form.querySelector('[name="pollIntervalMs"]').value),
    autoReload: isOn('autoReload'),
    autoReconnect: isOn('autoReconnect'),
    closeToTray: isOn('closeToTray'),
    launchTunnelOnStart: isOn('launchTunnelOnStart'),
    launchAtLogin: isOn('launchAtLogin'),
    startMinimized: isOn('startMinimized'),
  };
  const adminPortEl = form.querySelector('[name="adminPort"]');
  const adminUserEl = form.querySelector('[name="adminUser"]');
  const adminPassEl = form.querySelector('[name="adminPassword"]');
  if (adminPortEl) {
    const port = Number(adminPortEl.value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      toast('error', '管理端口不合法', '填 1024 - 65535 之间的端口');
      adminPortEl.focus();
      return;
    }
    patch.adminPort = port;
  }
  if (adminUserEl) patch.adminUser = String(adminUserEl.value || '').trim() || 'admin';
  if (adminPassEl) patch.adminPassword = String(adminPassEl.value || '');
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
    /* warnings 现在不只来自管理 API：开机自启写不进注册表、退到「启动」文件夹快捷方式时
     * 也会走这里。标题别再写死「没落到配置文件」，否则文案对不上。 */
    const saveWarnings = (res.data && Array.isArray(res.data.warnings) ? res.data.warnings : []).filter(Boolean);
    if (saveWarnings.length) toast('warn', '设置已保存，但有 1 项没完全生效', saveWarnings[0]);
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
    /* 连接表单填地址/端口时，实时提示「这台机器已有档案」。 */
    if (e.target.closest('#server-form')) {
      if (e.target.name === 'host' || e.target.name === 'port') updateConnectHostNote();
      return;
    }
  });
  document.addEventListener('change', (e) => {
    const profileSelect = e.target.closest('#server-profile-select');
    if (profileSelect) {
      selectServerProfile(profileSelect.value).catch((error) => toast('error', '切换档案失败', String(error && error.message || error)));
      return;
    }
    const certFill = e.target.closest('#pf-plugin-cert-fill');
    if (certFill) {
      handleAction('proxyform.cert.fill', {}, certFill);
      return;
    }
    const ruleAll = e.target.closest('#fw-rule-all');
    if (ruleAll) {
      /* 全选/清空「已放行规则」的勾选，不重渲染，保留用户已滚动的位置。 */
      [...document.querySelectorAll('.fw-rule-del')].forEach((c) => { c.checked = ruleAll.checked; });
      return;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.modalOpen) closeModal();
    // 弹窗里的表单按回车 = 点主按钮（否则只能去点鼠标，键盘用户会觉得“按了没反应”）。
    // 排除 textarea（多行输入要换行）、按钮自身（避免二次触发）、危险按钮（防止误确认删除）。
    if (e.key === 'Enter' && S.modalOpen && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const el = e.target;
      const tag = el && el.tagName;
      const typing = tag === 'INPUT' && !/^(checkbox|radio|button|submit)$/i.test(el.type || '');
      if (typing) {
        const primary = document.querySelector('#modal-root .modal .btn.primary');
        if (primary && !primary.disabled && !/danger/.test(primary.className)) {
          e.preventDefault();
          primary.click();
        }
      }
    }
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


/* 侧栏连接下拉：change 不走 data-act（select 不是按钮） */
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (!el || el.id !== 'conn-select') return;
  const id = String(el.value || '');
  if (!id) return;
  const target = connList().find((c) => c.id === id);
  if (!target || target.id === activeConnId()) return;
  handleAction('conn.switch', { dataset: { id } }).catch(() => {});
});

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
    // 后台把已签发证书与 DNS 设置拉回来，供「证书」页与代理表单的证书下拉使用。
    loadCerts({ silent: true }).catch(() => {});

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
          const body = $('#server-proxies');
          if (body) body.innerHTML = serverProxyRows();
          // 数量徽标跟着映射条数走。
          const countChip = document.querySelector('.srv-monitor-grid .count-chip');
          if (countChip) countChip.textContent = String((st.proxies || []).length);
        }
      }
      // 本机隧道目标被别处改动（设置页保存、外部编辑 frpc.toml）时，
      // 服务器页的档案栏必须跟着重算，否则会一直显示旧的绑定关系。
      const boundId = st.settings ? st.settings.clientServerId : undefined;
      if (boundId !== undefined && S.server.loaded && boundId !== S.server.clientServerId) {
        loadServerState().catch(() => {});
      }
      /* 每 3 次刷新（约 9 秒）跟主进程对一次会话状态：
       * 万一自动连接的结果被竞态吞掉、或主进程那头断开了而界面还停在旧状态，
       * 这里会自动纠正，用户不必再去切一次服务器档案。 */
      S.server.syncTick = (S.server.syncTick || 0) + 1;
      if (S.server.syncTick % 3 === 0) syncServerSession().catch(() => {});
    });

    /* 主进程连上/断开 SSH 后主动推一条：走 IPC、自动连接、托盘进来的会话，
     * 不用等「会话同步」节拍（最多 9 秒）也不会停在连接表单上。 */
    FRP.on('server:session-changed', () => {
      loadServerState().catch(() => {});
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

