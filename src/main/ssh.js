'use strict';

const fs = require('node:fs');
const { Client } = require('ssh2');
const { parseConfig: frpsParseConfig, summary: frpsSummary } = require('./frpsconfig');
const { stringify: tomlStringify } = require('smol-toml');

function friendlyError(err) {
  const message = String((err && err.message) || err || '');
  if (/authentication methods failed|authentication failure/i.test(message)) return '用户名或密码错误';
  /* 连接层的三种失败要能区分「端口没开」「被防火墙丢包」「被中间设备掐断」，
   * 否则用户只能看到一句笼统的“无法连接”，不知道该去云控制台还是改 sshd。 */
  if (/ECONNREFUSED|cannot connect/i.test(message)) {
    return 'SSH 端口拒绝连接：对方主机在线，但这个端口没有 sshd 在听（SSH 端口填错，或 sshd 没启动）';
  }
  if (/connection lost before handshake|handshake/i.test(message)) {
    return '连接在握手前被断开：该端口可能不是 SSH 服务，或被防火墙/堡垒机拦截（云厂商安全组代答就是这种表现）';
  }
  if (/ETIMEDOUT|timed out|timeout/i.test(message)) {
    return 'SSH 连接超时：端口不可达，多半是云安全组/防火墙没放行这个端口，或本机 VPN/代理拦了出站';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '找不到该主机，请检查 IP 或本机 DNS';
  if (/Permission denied/i.test(message)) return '权限不足，请使用有权限的账户';
  return message || '连接失败';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || '';
}

function normalizeArch(value) {
  const arch = String(value || '').trim().toLowerCase();
  if (arch === 'x86_64' || arch === 'amd64' || arch === 'x64') return 'amd64';
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64';
  return arch;
}

// 进程参数里可能混入 `sh -c "echo ... frps ..."` 之类的包装命令，
// 只接受绝对路径的 .toml/.ini，避免把 `echo` 当成配置路径。
function validConfigPath(value) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '');
  return /^\/[^\s]+\.(toml|ini)$/i.test(raw) ? raw : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STATUS_TEXT = { running: '运行中', stopped: '已停止', abnormal: '异常' };

/* systemctl list-units --no-legend 的每一行：
 *   frps.service   loaded active running frp server
 *   ● frpc.service loaded failed failed  frp client
 * 取第一行当“就是它”是不安全的：同一台机器同时装了 frpc 与 frps 时，
 * 按名字排序 frpc 在 frps 前面，于是会把客户端的 unit 当成服务端，
 * 后面 systemctl cat / 重写 unit 就会动错对象。这里按名字排序取“最像 frps”的。
 */
function parseServiceUnits(text) {
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[●*·\s]+/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const unit = (parts[0] || '').replace(/\.service$/i, '');
    if (!unit) continue;
    items.push({
      unit,
      load: parts[1] || '',
      active: parts[2] || '',
      sub: parts[3] || '',
      description: parts.slice(4).join(' '),
    });
  }
  return items;
}

/* 给候选 unit 打分：名字直接叫 frps / frps-2 / frps@inst 的最可信；
 * 沾 frpc 的一律排除（那是客户端，重写它会打断用户自己的隧道）；
 * 只写 frp 的属于“名字看不出客户端还是服务端”，要再用 ExecStart 确认。 */
function rankServiceUnits(items) {
  const scored = [];
  for (const item of items) {
    const name = String(item.unit || '').toLowerCase();
    if (/frpc/.test(name)) continue;
    let score = -1;
    if (/^frps/.test(name)) score = 100;
    else if (/frps/.test(name)) score = 80;
    else if (/^frp$|^frp-(server|service)$|^frp-?server$/.test(name)) score = 40;
    else if (/frp/.test(name)) score = 20;
    if (score < 0) continue;
    scored.push({ ...item, score, sure: score >= 80 });
  }
  scored.sort((a, b) => b.score - a.score || a.unit.localeCompare(b.unit));
  return scored;
}


class ServerSession {
  constructor() {
    this.client = null;
    this.connected = false;
    this.host = '';
    this.port = 22;
    this.username = '';
    this.info = null;
    this.configPath = '';
    this.shell = null;
    // 连接代数：每次 connect 自增。旧连接的 close/error/ready 事件可能在新连接
    // 建立后才异步到达，用代数判断「这事件还属于当前连接吗」，避免旧连接的
    // close 把新连接的 connected 误清成 false（进而让新会话无法开 PTY）。
    this._connGen = 0;
  }

  async connect({ host, port = 22, username, password, timeout = 15000 }) {
    this.disconnect();
    const gen = ++this._connGen;
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const client = new Client();
      this.client = client;
      this.host = host;
      this.port = port;
      this.username = username;

      client.on('ready', () => {
        if (gen !== this._connGen) return; // 旧连接的迟到事件，忽略
        this.connected = true;
        done({ ok: true });
      });
      client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        finish(prompts.map(() => password));
      });
      client.on('error', (err) => {
        if (gen !== this._connGen) return;
        this.connected = false;
        done({ ok: false, error: friendlyError(err) });
      });
      client.on('close', () => {
        if (gen !== this._connGen) return; // 旧连接的 close 不能清新连接的状态
        this.connected = false;
      });

      try {
        client.connect({
          host,
          port,
          username,
          password,
          tryKeyboard: true,
          readyTimeout: timeout,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
        });
      } catch (err) {
        done({ ok: false, error: friendlyError(err) });
      }
    });
  }

  disconnect() {
    this.closeShell();
    if (this.client) {
      try { this.client.end(); } catch { /* ignore */ }
    }
    this.client = null;
    this.connected = false;
    this.info = null;
    // 配置路径属于“这台服务器”，断开后必须清掉：
    // 否则换一台没有 frps.toml 的机器时，会拿上一台服务器的路径去读 / 写。
    this.configPath = '';
  }

  /* ---------------- 交互式终端（真 PTY）----------------
   * exec 是「一问一答」：跑完收集 stdout 一次性返回；
   * shell 是持续双向流：远端开一个真实的登录 shell（bash/zsh 由服务器决定），
   * 终端仿真交给渲染层的 xterm.js，这里只搬运字节和窗口尺寸。
   * 换服务器 / 断开连接时 disconnect() 会把 shell 一起关掉。 */
  openShell({ rows = 30, cols = 100, onData, onClose } = {}) {
    if (!this.connected || !this.client) {
      return Promise.resolve({ ok: false, error: '尚未连接服务器' });
    }
    if (this.shell) {
      return Promise.resolve({ ok: false, error: '终端已经打开' });
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        this.client.shell({ term: 'xterm-256color', rows: Number(rows) || 30, cols: Number(cols) || 100 }, (err, stream) => {
          if (err) return done({ ok: false, error: friendlyError(err) });
          this.shell = stream;
          const cleanup = () => {
            if (this.shell === stream) this.shell = null;
            if (onClose) onClose();
          };
          stream.on('data', (chunk) => {
            if (onData) onData(chunk.toString('utf8'));
          });
          // 关闭顺序不定（服务器断 / 用户关 / 网络断），都走同一个 cleanup。
          stream.on('close', cleanup);
          stream.on('exit', cleanup);
          stream.on('error', cleanup);
          done({ ok: true });
        });
      } catch (err) {
        done({ ok: false, error: friendlyError(err) });
      }
    });
  }

  shellWrite(text) {
    if (!this.shell) return false;
    try {
      this.shell.write(String(text));
      return true;
    } catch {
      return false;
    }
  }

  /* vim / htop 的全屏排版依赖 PTY 尺寸，窗口 resize 时同步过去。 */
  shellResize(rows, cols) {
    if (!this.shell) return false;
    try {
      this.shell.setWindow(Number(rows) || 30, Number(cols) || 100, 0, 0);
      return true;
    } catch {
      return false;
    }
  }

  closeShell() {
    const stream = this.shell;
    this.shell = null;
    if (!stream) return false;
    try { stream.close(); } catch { /* ignore */ }
    try { if (typeof stream.end === 'function') stream.end(); } catch { /* ignore */ }
    return true;
  }

  exec(command, timeout = 15000) {
    if (!this.connected || !this.client) {
      return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: '尚未连接服务器' });
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, code: -1, stdout: '', stderr: '命令执行超时' }), timeout);
      this.client.exec(command, { pty: false }, (err, stream) => {
        if (err) return done({ ok: false, code: -1, stdout: '', stderr: friendlyError(err) });
        let stdout = '';
        let stderr = '';
        stream.on('data', (data) => { stdout += data.toString('utf8'); });
        stream.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
        stream.on('close', (code) => done({ ok: code === 0, code, stdout, stderr }));
        stream.on('error', (streamErr) => done({ ok: false, code: -1, stdout, stderr: String(streamErr) }));
      });
    });
  }

  async sudoSystemctl(action, unit) {
    let result = await this.exec(`systemctl ${action} ${unit}`, 20000);
    if (!result.ok && /Interactive authentication|permission denied|access denied|must be root/i.test(result.stderr || '')) {
      result = await this.exec(`sudo -n systemctl ${action} ${unit}`, 20000);
    }
    return result;
  }

  async dockerCommand(action, name) {
    let result = await this.exec(`docker ${action} ${shellQuote(name)}`, 25000);
    if (!result.ok && /permission denied/i.test(result.stderr || '')) {
      result = await this.exec(`sudo -n docker ${action} ${shellQuote(name)}`, 25000);
    }
    return result;
  }

  async inspect() {
    const script = [
      "echo @@HOSTNAME; hostname 2>/dev/null",
      "echo @@OS; (sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '\"') || true",
      "echo @@KERNEL; uname -r 2>/dev/null",
      "echo @@ARCH; uname -m 2>/dev/null",
      "echo @@UPTIME; uptime -p 2>/dev/null || uptime 2>/dev/null",
      // head 从 2 放宽到 20：一台机器上 frpc.service / frps.service / frps@a.service 可能同时存在，
      // 只取两行会漏掉真正要的那一个。
      "echo @@SERVICE; systemctl list-units --type=service --all --no-legend 2>/dev/null | grep -i frp | head -n 20",
      "echo @@PROCESS; for d in /proc/[0-9]*; do [ \"$(cat $d/comm 2>/dev/null)\" = frps ] && echo \"${d##*/} $(tr '\\0' ' ' < $d/cmdline 2>/dev/null)\"; done | head -n 4",
      "echo @@BIN; command -v frps 2>/dev/null || true",
      "echo @@LISTEN; ss -lntp 2>/dev/null | head -n 80",
      "echo @@DOCKER; docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | grep -i frp | head -n 2",
      "echo @@CONFIG; for p in /etc/frp/frps.toml /etc/frp/frps.ini /usr/local/frp/frps.toml /opt/frp/frps.toml /root/frp/frps.toml /etc/frps.toml /etc/frps/frps.toml /docker/frp/frps.toml; do [ -f \"$p\" ] && { echo \"$p\"; break; }; done",
    ].join('; ');

    const result = await this.exec(script, 20000);
    if (!result.ok && !result.stdout) return { ok: false, error: result.stderr || '读取服务器信息失败' };

    const sections = {};
    let current = '';
    for (const line of (result.stdout || '').split(/\r?\n/)) {
      const match = /^@@(\w+)$/.exec(line.trim());
      if (match) {
        current = match[1];
        sections[current] = [];
        continue;
      }
      if (current) sections[current].push(line);
    }
    const lines = (key) => (sections[key] || []).map((line) => line.trim()).filter(Boolean);
    const text = (key) => lines(key).join(' ').trim();

    let configPath = validConfigPath(text('CONFIG'));
    const processLines = lines('PROCESS');
    const pids = [];
    let binaryPath = '';
    for (const line of processLines) {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const args = match[2].trim();
      const argv0 = args.split(/\s+/)[0] || '';
      const base = argv0.split('/').pop().toLowerCase();
      if (!/^frps(?:-|$)/.test(base)) continue;
      pids.push(Number(match[1]));
      if (!binaryPath) binaryPath = argv0;
      if (!configPath) {
        const argMatch = /(?:^|\s)(?:-c|--config)(?:=|\s+)("[^"]+"|'[^']+'|\S+)/.exec(args);
        if (argMatch) configPath = validConfigPath(argMatch[1]);
      }
    }
    const processAlive = pids.length > 0;
    let configExists = false;

    /* 以前直接取第一行，机器上同时有 frpc.service 时会把它当成 frps。
     * 现在按“名字最像 frps”排序，名字看不出客户端/服务端的（比如 frp.service）
     * 再用 ExecStart 确认一眼；实在认不出来就当作“没有 systemd unit”，
     * 让界面走“进程在跑但不受服务管理”的分支，而不是去重写一个猜来的 unit。 */
    const candidates = rankServiceUnits(parseServiceUnits(lines('SERVICE').join('\n')));
    let serviceName = '';
    let serviceSub = '';
    let unitActive = '';
    for (const candidate of candidates) {
      let execLine = '';
      if (!candidate.sure) {
        const cat = await this.exec(`systemctl cat ${shellQuote(candidate.unit)} 2>/dev/null | grep -m1 '^ExecStart=' || true`, 8000);
        execLine = firstLine(cat.stdout);
        if (/frpc/i.test(execLine) && !/frps/i.test(execLine)) continue;
        if (execLine && !/frps/i.test(execLine)) continue;
      }
      serviceName = candidate.unit;
      serviceSub = candidate.sub || '';
      const activeResult = await this.exec(`systemctl is-active -- ${shellQuote(candidate.unit)} 2>/dev/null || true`, 8000);
      unitActive = firstLine(activeResult.stdout) || candidate.active || '';
      if (!configPath) {
        if (!execLine) {
          const cat = await this.exec(`systemctl cat ${shellQuote(candidate.unit)} 2>/dev/null | grep -m1 '^ExecStart=' || true`, 8000);
          execLine = firstLine(cat.stdout);
        }
        const argMatch = /(?:-c|--config)(?:=|\s+)("[^"]+"|'[^']+'|\S+)/.exec(execLine);
        if (argMatch) configPath = validConfigPath(argMatch[1]);
      }
      break;
    }
    const hasUnit = !!serviceName;
    if (configPath) {
      const exists = await this.exec(`[ -f ${shellQuote(configPath)} ] && echo yes || true`, 6000);
      configExists = firstLine(exists.stdout) === 'yes';
    }

    const dockerLine = lines('DOCKER')[0] || '';
    let docker = null;
    if (dockerLine) {
      const parts = dockerLine.split('\t');
      docker = { name: parts[0] || '', image: parts[1] || '', status: parts[2] || '' };
    }
    const dockerRunning = !!(docker && /up|healthy|running/i.test(docker.status) && !/unhealthy|restarting|dead/i.test(docker.status));

    const installedPath = lines('BIN')[0] || binaryPath || '';
    const arch = normalizeArch(text('ARCH'));

    let version = '';
    let versionSource = '';
    const direct = await this.exec('(command -v frps >/dev/null 2>&1 && frps -v 2>/dev/null) || true', 8000);
    if (firstLine(direct.stdout)) {
      version = firstLine(direct.stdout);
      versionSource = 'frps -v';
    }
    if (!version && binaryPath && binaryPath !== 'frps') {
      const viaProcess = await this.exec(`${shellQuote(binaryPath)} -v 2>/dev/null || true`, 8000);
      if (firstLine(viaProcess.stdout)) {
        version = firstLine(viaProcess.stdout);
        versionSource = binaryPath;
      }
    }
    if (!version && docker) {
      const viaDocker = await this.exec(`docker exec ${shellQuote(docker.name)} frps -v 2>/dev/null || true`, 10000);
      if (firstLine(viaDocker.stdout)) {
        version = firstLine(viaDocker.stdout);
        versionSource = `docker:${docker.name}`;
      } else if (docker.image) {
        const tag = docker.image.split(':')[1];
        if (tag && tag !== 'latest') {
          version = tag;
          versionSource = '镜像标签';
        }
      }
    }
    if (!version) version = 'unknown';

    // systemd 的 `activating (auto-restart)` 表示服务反复崩溃重启（例如端口被占用），
    // unitActive="activating"、serviceSub="auto-restart" 都不匹配 failed/error，
    // 不单独识别会把「起不来的服务」误报成 stopped。
    const unitFailed = /failed|error/.test(unitActive) || /failed|error/.test(serviceSub) || /auto-restart/.test(serviceSub);
    const running = processAlive || dockerRunning || unitActive === 'active';
    const abnormal = unitFailed || (docker && /restarting|unhealthy|dead/i.test(docker.status));
    const status = abnormal ? 'abnormal' : running ? 'running' : 'stopped';
    const source = processAlive ? 'process' : dockerRunning ? 'docker' : unitActive === 'active' ? 'systemd' : 'none';

    /* 「现在在跑」和「重启后还会自己跑」是两件事。前者看 is-active，后者看：
     *   systemd  → is-enabled（enabled / disabled / masked / static …）
     *   docker   → 容器的 RestartPolicy（no 的话重启后不会起来）
     *   裸进程    → 没有任何守护，重启即丢 */
    let unitEnabled = '';
    if (hasUnit) {
      const enabledResult = await this.exec(`systemctl is-enabled -- ${shellQuote(serviceName)} 2>/dev/null || true`, 8000);
      unitEnabled = firstLine(enabledResult.stdout);
    }
    let dockerRestart = '';
    if (docker && docker.name) {
      const policy = await this.exec(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${shellQuote(docker.name)} 2>/dev/null || true`, 8000);
      dockerRestart = firstLine(policy.stdout);
    }
    const boot = (() => {
      if (hasUnit) {
        if (!unitEnabled) return { boot: 'unknown', bootText: '无法读取 systemd 开机自启状态' };
        if (unitEnabled === 'enabled') return { boot: 'enabled', bootText: '已设为开机自启（systemd）' };
        return { boot: 'disabled', bootText: `未设为开机自启（${unitEnabled}）` };
      }
      if (docker && docker.name) {
        const policy = String(dockerRestart || 'no').toLowerCase();
        return ['always', 'unless-stopped'].includes(policy)
          ? { boot: 'enabled', bootText: `容器会自动重启（${policy}）` }
          : { boot: 'disabled', bootText: `容器重启后不会自动运行（RestartPolicy=${policy}）` };
      }
      if (processAlive) return { boot: 'ephemeral', bootText: '临时进程，服务器重启后不会自动运行' };
      return { boot: 'unknown', bootText: '未检测到持久化方式' };
    })();

    this.configPath = configPath;
    this.info = {
      hostname: text('HOSTNAME'),
      os: text('OS'),
      kernel: text('KERNEL'),
      uptime: text('UPTIME'),
      serviceName: serviceName || 'frps',
      hasUnit,
      unitActive,
      unitEnabled,
      dockerRestart,
      boot: boot.boot,
      bootText: boot.bootText,
      processAlive,
      pids,
      binaryPath,
      docker,
      dockerRunning,
      version,
      versionSource,
      arch,
      installedPath,
      frpsInstalled: !!(installedPath || (docker && docker.name)),
      listeners: lines('LISTEN').join('\n'),
      ports: lines('LISTEN').filter((line) => /frps|:7000|:4096/.test(line)).slice(0, 8).join('\n'),
      configPath,
      configExists,
      status,
      statusText: STATUS_TEXT[status],
      statusSource: source,
    };
    return { ok: true, info: this.info, configPath };
  }

  async uploadFile(localPath, remotePath, onProgress) {
    if (!this.connected || !this.client) return { ok: false, error: '尚未连接服务器' };
    if (!fs.existsSync(localPath)) return { ok: false, error: '本机安装包不存在' };
    return new Promise((resolve) => {
      this.client.sftp((err, sftp) => {
        if (err) return resolve({ ok: false, error: friendlyError(err) });
        sftp.fastPut(localPath, remotePath, {
          step: (transferred, chunk, total) => {
            if (onProgress) onProgress(transferred, total);
          },
        }, (putErr) => {
          try { sftp.end(); } catch { /* ignore */ }
          if (putErr) return resolve({ ok: false, error: `上传 frps 失败：${friendlyError(putErr)}` });
          resolve({ ok: true });
        });
      });
    });
  }

  async detectSudo() {
    const uid = firstLine((await this.exec('id -u 2>/dev/null || true', 6000)).stdout);
    if (uid === '0') return { ok: true, prefix: '' };
    const test = await this.exec('sudo -n true', 6000);
    if (test.ok) return { ok: true, prefix: 'sudo -n ' };
    return {
      ok: false,
      error: '当前 SSH 账户不是 root，且没有配置免密 sudo。请使用 root，或为该账户配置 NOPASSWD sudo 后再初始化。',
    };
  }

  async bootstrap({ content, localBinary, configPath = '/etc/frp/frps.toml', unitName = 'frps', onProgress, shouldCancel }) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器', steps: [] };
    configPath = validConfigPath(configPath) || '/etc/frp/frps.toml';
    const steps = [];
    const report = (stage, text, percent) => {
      const step = { stage, text, percent };
      steps.push(step);
      if (onProgress) { try { onProgress(step); } catch { /* ignore */ } }
    };

    const sudo = await this.detectSudo();
    if (!sudo.ok) return { ok: false, error: sudo.error, steps };
    const prefix = sudo.prefix;
    // 取消支持：shouldCancel 由上层（server:bootstrap）通过取消令牌提供。
    // 每个关键步骤之间检查一次，取消即回滚已做的部分。
    const cancel = () => !!(shouldCancel && shouldCancel());
    const rollback = { prefix, remoteTmp: '', installedBinary: false, wroteConfig: false, backup: '', configPath, serviceName: unitName, unitInstalled: false };
    const abort = async () => {
      report('cancel', '已取消，正在清理已安装的内容…', 0);
      await this._rollbackBootstrap(rollback);
      return { ok: false, cancelled: true, error: '初始化已取消', steps };
    };
    if (cancel()) return abort();
    // 进度条区间：下载 1-8（在 server:bootstrap 里）→ 检查 10 → 上传 12-60 →
    // 安装 62 → 配置 72 → 服务 80-84 → 启动 90 → 验证 95 → 100。
    report('check', '检查服务器权限与架构', 10);

    const arch = normalizeArch((this.info && this.info.arch) || '');
    let binary = firstLine((await this.exec('command -v frps 2>/dev/null || true', 6000)).stdout);
    if (!binary && this.info && this.info.binaryPath && this.info.binaryPath !== 'frps') binary = this.info.binaryPath;

    if (!binary) {
      if (!arch || !['amd64', 'arm64'].includes(arch)) {
        return { ok: false, error: `暂不支持服务器架构 ${arch || 'unknown'}，仅支持 amd64 / arm64`, steps };
      }
      if (!localBinary || !fs.existsSync(localBinary)) {
        return { ok: false, error: `本机没有可用的 ${arch} 版 frps 二进制，无法自动上传`, steps };
      }
      const remoteTmp = `/tmp/frps-console-frps-${Date.now()}`;
      rollback.remoteTmp = remoteTmp;
      if (cancel()) return abort();
      report('upload', `上传 frps（${arch}，约 ${Math.max(1, Math.round(fs.statSync(localBinary).size / 1048576))} MB）`, 12);
      let lastPercent = -1;
      let lastMb = -1;
      const upload = await this.uploadFile(localBinary, remoteTmp, (transferred, total) => {
        const percent = total ? 12 + Math.round((transferred / total) * 48) : 12;
        const mb = Math.round(transferred / 1048576);
        if (percent === lastPercent && mb === lastMb) return;
        lastPercent = percent;
        lastMb = mb;
        if (onProgress) { try { onProgress({ stage: 'upload', text: `上传 frps ${mb} / ${Math.max(1, Math.round(total / 1048576))} MB`, percent }); } catch { /* ignore */ } }
      });
      if (cancel()) return abort();
      if (!upload.ok) return { ok: false, error: upload.error, steps };

      report('install', '安装 frps 到 /usr/local/bin/frps', 62);
      let install = await this.exec(`${prefix}install -m 755 ${shellQuote(remoteTmp)} /usr/local/bin/frps`, 20000);
      if (!install.ok) {
        install = await this.exec(`${prefix}mkdir -p /usr/local/bin && ${prefix}install -m 755 ${shellQuote(remoteTmp)} /usr/local/bin/frps`, 20000);
      }
      await this.exec(`rm -f ${shellQuote(remoteTmp)} 2>/dev/null || true`, 6000);
      rollback.remoteTmp = '';
      if (!install.ok) {
        return { ok: false, error: `安装 frps 失败：${(install.stderr || install.stdout || '未知错误').trim()}`, steps };
      }
      rollback.installedBinary = true;
      binary = '/usr/local/bin/frps';
      if (cancel()) return abort();
    } else {
      report('check', `检测到已安装 frps：${binary}`, 10);
    }

    const configDir = configPath.replace(/\/[^/]+$/, '') || '/etc/frp';
    if (cancel()) return abort();
    report('config', `写入配置 ${configPath}`, 72);
    let result = await this.exec(`${prefix}mkdir -p ${shellQuote(configDir)}`, 10000);
    if (!result.ok) return { ok: false, error: `创建配置目录失败：${(result.stderr || '权限不足').trim()}`, steps };

    const tmpConfig = '/tmp/frps-console-frps.toml';
    const base64 = Buffer.from(content, 'utf8').toString('base64');
    result = await this.exec(`printf %s ${base64} | base64 -d > ${tmpConfig}`, 15000);
    if (!result.ok) return { ok: false, error: `写入临时配置失败：${(result.stderr || '未知错误').trim()}`, steps };

    const verify = await this.exec(`${shellQuote(binary)} verify -c ${tmpConfig}`, 15000);
    const verifyText = `${verify.stdout}\n${verify.stderr}`;
    if (!verify.ok && !/unknown command|not supported|no such file/i.test(verifyText)) {
      return { ok: false, error: `配置校验未通过：${(verify.stderr || verify.stdout || 'frps verify 失败').trim()}`, steps };
    }

    const existing = await this.exec(`test -f ${shellQuote(configPath)} && echo yes || true`, 6000);
    let backup = '';
    if (firstLine(existing.stdout) === 'yes') {
      const stamp = firstLine((await this.exec('date +%Y%m%d-%H%M%S', 6000)).stdout);
      backup = `${configPath}.bak-${stamp || 'manual'}`;
      result = await this.exec(`${prefix}cp -p ${shellQuote(configPath)} ${shellQuote(backup)}`, 10000);
      if (!result.ok) return { ok: false, error: `备份原配置失败：${(result.stderr || '未知错误').trim()}`, steps };
    }
    result = await this.exec(`${prefix}install -m 644 ${tmpConfig} ${shellQuote(configPath)}`, 10000);
    await this.exec(`rm -f ${tmpConfig} 2>/dev/null || true`, 6000);
    if (!result.ok) return { ok: false, error: `写入配置失败：${(result.stderr || '权限不足').trim()}`, steps };
    this.configPath = configPath;
    rollback.wroteConfig = true;
    rollback.backup = backup;
    if (cancel()) return abort();

    const systemdOk = firstLine((await this.exec('[ -d /run/systemd/system ] && echo yes || true', 6000)).stdout) === 'yes';
    let serviceName = (this.info && this.info.hasUnit && this.info.serviceName) || unitName;

    if (systemdOk && this.info && this.info.hasUnit) {
      report('service', `停止旧的 ${serviceName}.service`, 80);
      await this.sudoSystemctl('stop', shellQuote(serviceName));
      await sleep(600);
    }

    if (this.info && this.info.processAlive && !this.info.docker && this.info.pids && this.info.pids.length) {
      report('service', '停止旧的 frps 进程，避免端口冲突', 81);
      const killList = this.info.pids.join(' ');
      await this.exec(`${prefix}kill ${killList} 2>/dev/null || true`, 8000);
      await sleep(900);
      const stillAlive = firstLine((await this.exec(`for pid in ${killList}; do [ -d /proc/$pid ] && echo $pid; done`, 6000)).stdout);
      if (stillAlive) {
        await this.exec(`${prefix}kill -9 ${killList} 2>/dev/null || true`, 8000);
        await sleep(500);
      }
    }

    report('service', '配置 frps 系统服务', 84);
    /* 「启动成功」不等于「重启后还在」。enable 的返回值以前被 `|| true` 吞掉，
     * 结果是装完一切正常、直到某天服务器重启才发现 7000 不通。 */
    let bootWarning = '';
    let enabledState = '';
    if (systemdOk) {
      // 始终重写 unit，修正历史上错误的 ExecStart（例如把 echo 当成配置路径）
      const unit = [
        '[Unit]',
        'Description=frp server',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'Restart=on-failure',
        'RestartSec=5s',
        `ExecStart=${binary} -c ${configPath}`,
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
      ].join('\n');
      const unitB64 = Buffer.from(unit, 'utf8').toString('base64');
      const tmpUnit = '/tmp/frps-console-frps.service';
      result = await this.exec(`printf %s ${unitB64} | base64 -d > ${tmpUnit} && ${prefix}install -m 644 ${tmpUnit} /etc/systemd/system/${serviceName}.service && rm -f ${tmpUnit}`, 15000);
      if (!result.ok) return { ok: false, error: `创建 systemd 服务失败：${(result.stderr || '权限不足').trim()}`, steps };
      rollback.unitInstalled = true;
      rollback.serviceName = serviceName;
      await this.exec(`${prefix}systemctl daemon-reload`, 15000);
      const enable = await this.exec(`${prefix}systemctl enable -- ${shellQuote(serviceName)} 2>&1`, 15000);
      enabledState = firstLine((await this.exec(`${prefix}systemctl is-enabled -- ${shellQuote(serviceName)} 2>/dev/null || true`, 8000)).stdout);
      if (enabledState !== 'enabled') {
        const why = (enable.stderr || enable.stdout || '').trim().split(/\r?\n/).filter(Boolean)[0] || '';
        bootWarning = `frps 已在运行，但没能设成开机自启（systemctl is-enabled = ${enabledState || 'unknown'}）${why ? `：${why}` : ''}。服务器重启后需要手动执行 systemctl start ${serviceName}`;
      }

      if (cancel()) return abort();
      report('start', `启动 ${serviceName}.service`, 90);
      const start = await this.sudoSystemctl('restart', shellQuote(serviceName));
      if (!start.ok) {
        return { ok: false, error: `启动 frps 失败：${(start.stderr || start.stdout || 'systemctl 执行失败').trim()}`, steps };
      }
    } else {
      bootWarning = '当前系统没有 systemd，frps 以 nohup 方式临时运行——服务器重启后不会自动启动。建议改用 systemd 或用 docker --restart=always 托管。';
      report('start', '以 nohup 方式启动 frps', 90);
      const command = `setsid nohup ${shellQuote(binary)} -c ${shellQuote(configPath)} >> /var/log/frps.log 2>&1 < /dev/null & echo started`;
      const start = await this.exec(command, 12000);
      if (!start.ok) {
        return { ok: false, error: `启动 frps 失败：${(start.stderr || start.stdout || '未知错误').trim()}`, steps };
      }
    }

    report('verify', '检查 frps 运行状态', 95);
    let after = null;
    let unitState = '';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(1200);
      if (cancel()) return abort();
      after = await this.inspect();
      if (systemdOk) {
        unitState = firstLine((await this.exec(`systemctl is-active -- ${shellQuote(serviceName)} 2>/dev/null || true`, 6000)).stdout);
        if (unitState === 'active' && after.ok && after.info && after.info.status === 'running') break;
      } else if (after.ok && after.info && after.info.status === 'running' && after.info.binaryPath === binary) {
        break;
      }
    }
    if (!after || !after.ok || !after.info || after.info.status !== 'running') {
      const logs = firstLine((await this.exec(`journalctl -u ${shellQuote(serviceName)} -n 20 --no-pager 2>/dev/null || tail -n 20 /var/log/frps.log 2>/dev/null || true`, 8000)).stdout);
      return { ok: false, error: `frps 已安装但未确认运行，请展开实时日志排查${logs ? `：${logs}` : ''}`, steps, configPath, logs };
    }
    if (systemdOk && unitState !== 'active') {
      const logs = (await this.exec(`journalctl -u ${shellQuote(serviceName)} -n 20 --no-pager 2>/dev/null || true`, 8000)).stdout.trim();
      return { ok: false, error: `frps.service 未处于 active 状态（${unitState || 'unknown'}）${logs ? `：${logs.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ')}` : ''}`, steps, configPath, logs };
    }
    if (!systemdOk && after.info.binaryPath !== binary) {
      return { ok: false, error: `frps 未按新配置启动（当前进程 ${after.info.binaryPath || 'unknown'}）`, steps, configPath };
    }
    report('done', '初始化完成，frps 已运行', 100);
    // 自动放开 frps 监听端口（ufw / firewalld / iptables），防止被防火墙拦截。
    const firewall = await this.openFirewallPorts(this.configPorts(content));
    return {
      ok: true,
      arch,
      binary,
      configPath,
      backup,
      serviceName,
      via: systemdOk ? 'systemd' : 'nohup',
      // 开机自启是否真的设上了：true 才算「重启后隧道会自己回来」
      bootEnabled: systemdOk ? enabledState === 'enabled' : false,
      bootWarning,
      steps,
      info: after.info,
      firewall,
    };
  }

  // 取消初始化时回滚：删临时文件/已装二进制/已建 unit，恢复或删除已写的配置。
  // state 由 bootstrap 在推进过程中逐步填充（见 bootstrap 内 rollback 对象）。
  async _rollbackBootstrap(state) {
    const prefix = state.prefix || '';
    const cmds = [];
    if (state.remoteTmp) cmds.push(`rm -f ${shellQuote(state.remoteTmp)} 2>/dev/null || true`);
    if (state.installedBinary) cmds.push(`rm -f /usr/local/bin/frps 2>/dev/null || true`);
    if (state.unitInstalled && state.serviceName) {
      cmds.push(`${prefix}systemctl stop ${shellQuote(state.serviceName)} 2>/dev/null || true`);
      cmds.push(`${prefix}systemctl disable ${shellQuote(state.serviceName)} 2>/dev/null || true`);
      cmds.push(`rm -f /etc/systemd/system/${state.serviceName}.service 2>/dev/null || true`);
      cmds.push(`${prefix}systemctl daemon-reload 2>/dev/null || true`);
    }
    if (state.wroteConfig && state.configPath) {
      if (state.backup) cmds.push(`${prefix}cp -p ${shellQuote(state.backup)} ${shellQuote(state.configPath)} 2>/dev/null || true`);
      else cmds.push(`rm -f ${shellQuote(state.configPath)} 2>/dev/null || true`);
    }
    for (const cmd of cmds) { try { await this.exec(cmd, 8000); } catch { /* ignore */ } }
    return { rolledBack: cmds.length > 0 };
  }

  // 卸载 frps：停止并禁用服务、删 unit、删二进制；配置默认备份后删除（可恢复）。
  async uninstall({ removeConfig = true } = {}) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const sudo = await this.detectSudo();
    if (!sudo.ok) return { ok: false, error: sudo.error };
    const prefix = sudo.prefix;
    const steps = [];
    const report = (text) => steps.push(text);
    const bin = firstLine((await this.exec('command -v frps 2>/dev/null || true', 6000)).stdout)
      || ((this.info && this.info.binaryPath && this.info.binaryPath !== 'frps') ? this.info.binaryPath : '');
    const serviceName = (this.info && this.info.hasUnit && this.info.serviceName) || 'frps';
    const systemdOk = firstLine((await this.exec('[ -d /run/systemd/system ] && echo yes || true', 6000)).stdout) === 'yes';
    const hasUnit = systemdOk && !!(this.info && this.info.hasUnit);

    if (hasUnit) {
      report(`停止 ${serviceName}.service`);
      await this.sudoSystemctl('stop', shellQuote(serviceName)).catch(() => {});
      report(`禁用并删除 ${serviceName}.service`);
      await this.exec(`${prefix}systemctl disable ${shellQuote(serviceName)} 2>/dev/null || true`, 10000);
      await this.exec(`${prefix}rm -f /etc/systemd/system/${serviceName}.service`, 10000);
      await this.exec(`${prefix}systemctl daemon-reload`, 12000);
    }
    if (this.info && this.info.processAlive && this.info.pids && this.info.pids.length) {
      report('停止 frps 进程');
      await this.exec(`${prefix}kill ${this.info.pids.join(' ')} 2>/dev/null || true`, 8000);
      await sleep(800);
    }

    if (bin) {
      report(`删除二进制 ${bin}`);
      await this.exec(`${prefix}rm -f ${shellQuote(bin)}`, 10000);
    }

    let configBackup = '';
    if (this.configPath) {
      if (removeConfig) {
        const stamp = firstLine((await this.exec('date +%Y%m%d-%H%M%S', 6000)).stdout);
        configBackup = `${this.configPath}.bak-uninstalled-${stamp || 'manual'}`;
        await this.exec(`${prefix}cp -p ${shellQuote(this.configPath)} ${shellQuote(configBackup)} 2>/dev/null || true`, 10000);
        await this.exec(`${prefix}rm -f ${shellQuote(this.configPath)}`, 10000);
        report(`配置已备份到 ${configBackup} 后删除`);
      } else {
        report(`保留配置 ${this.configPath}`);
      }
    }

    await this.inspect().catch(() => {});
    return { ok: true, removedBinary: bin || '', serviceName, configBackup, steps };
  }

  // 安装并启用防火墙（服务器当前没有 ufw/firewalld/iptables 时调用）。
  // 按发行版选 ufw（Debian/Ubuntu）或 firewalld（RHEL/CentOS/Fedora/Rocky/Alma）。
  // 安装后先放行 SSH 端口避免把自己踢下线，再放行传入的 frps/代理端口，最后启用。
  async installFirewall(ports) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const sudo = await this.detectSudo();
    if (!sudo.ok) return { ok: false, error: sudo.error };
    const prefix = sudo.prefix;
    const sshPort = Number(this.port) || 22;
    const all = [{ port: sshPort, proto: 'tcp', label: 'SSH' }, ...(ports || [])];

    const osRelease = await this.exec('cat /etc/os-release 2>/dev/null | grep -E "^ID=" | head -n 1 || true', 6000);
    const id = (osRelease.stdout || '').trim().toLowerCase();
    const isRhel = /rhel|centos|fedora|rocky|almalinux|alma|openeuler/.test(id);

    if (isRhel) {
      const install = await this.exec(`${prefix}command -v firewall-cmd >/dev/null 2>&1 && echo installed || (yum install -y firewalld 2>/dev/null || dnf install -y firewalld 2>/dev/null)`, 120000);
      if (!install.ok) return { ok: false, error: `安装 firewalld 失败：${firstLine(install.stderr || install.stdout)}` };
      await this.exec(`${prefix}systemctl enable --now firewalld 2>/dev/null || service firewalld start 2>/dev/null || true`, 20000);
      await sleep(1500);
      const opened = [];
      const notes = [];
      for (const { port, proto, label } of all) {
        const r = await this.exec(`${prefix}firewall-cmd --permanent --add-port=${port}/${proto} 2>&1`, 15000);
        const msg = `${r.stdout || ''}${r.stderr || ''}`;
        if (r.ok || /ALREADY_ENABLED/i.test(msg)) opened.push(`${label}(${port}/${proto})`);
        else notes.push(`${label}(${port}/${proto}) 开端口失败：${firstLine(r.stderr || r.stdout)}`);
      }
      await this.exec(`${prefix}firewall-cmd --reload 2>/dev/null || true`, 15000);
      return { ok: opened.length > 0, manager: 'firewalld', opened, notes };
    }

    // 默认 ufw（Debian/Ubuntu 系）
    const install = await this.exec(`${prefix}command -v ufw >/dev/null 2>&1 && echo installed || apt-get install -y ufw 2>/dev/null`, 120000);
    if (!install.ok) return { ok: false, error: `安装 ufw 失败：${firstLine(install.stderr || install.stdout)}` };
    const opened = [];
    const notes = [];
    for (const { port, proto, label } of all) {
      const r = await this.exec(`${prefix}ufw allow ${port}/${proto} 2>&1`, 15000);
      const msg = `${r.stdout || ''}${r.stderr || ''}`;
      if (r.ok || /Rule added|Skipping adding existing rule/i.test(msg)) opened.push(`${label}(${port}/${proto})`);
      else notes.push(`${label}(${port}/${proto}) 开端口失败：${firstLine(r.stderr || r.stdout)}`);
    }
    const enable = await this.exec(`${prefix}ufw --force enable 2>&1`, 20000);
    if (!enable.ok) {
      return { ok: false, error: `启用 ufw 失败：${firstLine(enable.stderr || enable.stdout)}（端口已放行，但防火墙未启用）`, manager: 'ufw', opened, notes };
    }
    return { ok: opened.length > 0, manager: 'ufw', opened, notes };
  }

  async readConfig() {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    if (!this.configPath) return { ok: false, error: '未找到 frps 配置文件（支持 /etc/frp/frps.toml 等常见路径）' };
    const result = await this.exec(`cat ${shellQuote(this.configPath)}`, 12000);
    if (!result.ok) return { ok: false, error: result.stderr || '读取配置文件失败' };
    return { ok: true, path: this.configPath, content: result.stdout };
  }

  async verifyCommandFor(remoteFile) {
    const info = this.info || {};
    if (info.dockerRunning && info.docker) {
      return `docker exec ${shellQuote(info.docker.name)} frps verify -c ${shellQuote(remoteFile)}`;
    }
    const binResult = await this.exec('command -v frps 2>/dev/null || true', 6000);
    const bin = firstLine(binResult.stdout) || info.binaryPath;
    if (!bin) return '';
    return `${shellQuote(bin)} verify -c ${shellQuote(remoteFile)}`;
  }

  // 从配置内容里提取需要监听的端口（用于端口冲突预检 + 自动开防火墙）。
  configPorts(content) {
    const parsed = frpsParseConfig(String(content || ''));
    if (!parsed.ok) return [];
    const s = frpsSummary(parsed.data);
    const ports = [];
    if (s.bindPort) ports.push({ port: s.bindPort, proto: 'tcp', label: 'bindPort' });
    /* bindPort 的 UDP 只有配了 kcp / quic 才真的在监听（wss/websocket、tcp 传输都不占 UDP）。
     * 无条件加一条 udp 会让端口矩阵得出「没有程序在这个端口监听」的假告警。 */
    if (s.bindPort && (s.kcpBindPort || s.quicBindPort)) ports.push({ port: s.bindPort, proto: 'udp', label: 'bindPort(UDP)' });
    if (s.webPort && s.webPort !== s.bindPort) ports.push({ port: s.webPort, proto: 'tcp', label: 'Dashboard' });
    if (s.vhostHTTPPort) ports.push({ port: s.vhostHTTPPort, proto: 'tcp', label: 'vhostHTTPPort' });
    if (s.vhostHTTPSPort) ports.push({ port: s.vhostHTTPSPort, proto: 'tcp', label: 'vhostHTTPSPort' });
    if (s.tcpmuxHTTPConnectPort) ports.push({ port: s.tcpmuxHTTPConnectPort, proto: 'tcp', label: 'tcpmuxHTTPConnectPort' });
    return ports;
  }

  /* 读出服务器上正在监听的 TCP / UDP 端口集合。
   * 判定「端口被拦」时必须先分清「程序没监听」和「防火墙拦了」——
   * 这一步提供的就是 S1（监听）信号。 */
  async readListenPorts() {
    const cmd = [
      'echo @@TCP',
      "(ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | awk '{print $4}'",
      'echo @@UDP',
      "(ss -lun 2>/dev/null || netstat -lun 2>/dev/null) | awk '{print $4}'",
    ].join('; ');
    const out = { tcp: new Set(), udp: new Set() };
    const result = await this.exec(cmd, 12000);
    const text = String((result && result.stdout) || '');
    let bucket = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '@@TCP') { bucket = out.tcp; continue; }
      if (line === '@@UDP') { bucket = out.udp; continue; }
      if (!bucket || !line) continue;
      // ss 里是 0.0.0.0:7000 / [::]:7000 / 127.0.0.1%lo:4096；netstat 里是 0.0.0.0:7000
      const m = /[:.](\d{1,5})$/.exec(line);
      if (!m) continue;
      const port = Number(m[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) bucket.add(port);
    }
    return out;
  }

  // 解析 `ss -lntp` / `netstat -ltnp`，取每条监听端口的进程名与 PID（PID 用于 kill 占用者）。
  parseListeners(text) {
    const listeners = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const match = /:(\d{1,5})\s+\S+\s+users:\(\(\"?([^"\),\s]+)/.exec(line);
      if (!match) continue;
      const pids = [];
      for (const pm of line.matchAll(/pid=(\d+)/g)) pids.push(Number(pm[1]));
      listeners.push({ port: Number(match[1]), process: match[2], pid: pids[0] || null, pids });
    }
    return listeners;
  }

  // 检查新配置要监听的 TCP 端口是否已被非 frps 进程占用（结构化结果，含 PID，供 kill / 换端口决策）。
  async portConflictDetails(ports) {
    const tcpPorts = (ports || []).filter((p) => p.proto === 'tcp');
    if (!tcpPorts.length) return [];
    const result = await this.exec('ss -lntp 2>/dev/null || netstat -ltnp 2>/dev/null', 12000);
    const listeners = this.parseListeners(result.stdout || '');
    const out = [];
    for (const { port, label } of tcpPorts) {
      if (!port) continue;
      const hit = listeners.find((l) => l.port === port && l.process && !/^frps/i.test(l.process));
      if (hit) out.push({ port, label, process: hit.process, pids: hit.pids || [] });
    }
    return out;
  }

  // 结构化的文案版本，供「保存配置」时直接报给用户。
  async portConflicts(ports) {
    const details = await this.portConflictDetails(ports);
    return details.map((d) => `${d.label}（${d.port}）已被 ${d.process} 占用`);
  }

  // 检查服务器上某个 TCP 端口是否已被监听（供「公网端口」检测按钮用）。
  async checkPortInUse(port) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: '端口无效' };
    const result = await this.exec('ss -lntp 2>/dev/null || netstat -ltnp 2>/dev/null', 12000);
    const listeners = this.parseListeners(result.stdout || '');
    const hits = listeners.filter((l) => l.port === n);
    const hit = hits.find((l) => l.process) || hits[0] || null;
    return {
      ok: true,
      inUse: !!hit,
      process: hit ? hit.process : null,
      pid: hit ? hit.pid : null,
      pids: hit ? (hit.pids || []) : [],
      listeners: hits,
    };
  }

  // 检测服务器防火墙类型与运行状态（ufw / firewalld / 裸 iptables / 无）。
  // 只做只读探测，不改任何规则；放行端口交给 openFirewallPorts。
  async detectFirewall() {
    if (!this.connected) return { manager: 'none', active: false, statusText: '尚未连接服务器' };
    const ufwActive = /status: active/i.test((await this.exec('command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -n 1 || true', 8000)).stdout || '');
    if (ufwActive) return { manager: 'ufw', active: true, statusText: 'ufw 已启用（active）' };
    const fwRunning = /running/.test((await this.exec('command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null || true', 8000)).stdout || '');
    if (fwRunning) return { manager: 'firewalld', active: true, statusText: 'firewalld 正在运行' };
    const ufwExists = firstLine((await this.exec('command -v ufw 2>/dev/null || true', 6000)).stdout);
    if (ufwExists) return { manager: 'ufw', active: false, statusText: '已安装 ufw 但未启用（inactive），防火墙未拦截' };
    const fwExists = firstLine((await this.exec('command -v firewall-cmd 2>/dev/null || true', 6000)).stdout);
    if (fwExists) return { manager: 'firewalld', active: false, statusText: '已安装 firewalld 但未运行，防火墙未拦截' };
    const ipt = await this.exec('command -v iptables >/dev/null 2>&1 && echo yes || true', 6000);
    if (/yes/.test(ipt.stdout || '')) return { manager: 'iptables', active: true, statusText: '使用 iptables（规则不持久化，重启后丢失）' };
    return { manager: 'none', active: false, statusText: '未检测到 ufw / firewalld / iptables' };
  }

  // 自动放开 frps 需要监听的端口（ufw / firewalld / 裸 iptables），防止被防火墙拦截。
  async openFirewallPorts(ports) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    if (!ports || !ports.length) return { ok: true, manager: 'none', opened: [], notes: ['没有可开的端口'] };
    const sudo = await this.detectSudo();
    if (!sudo.ok) return { ok: false, error: sudo.error };
    const prefix = sudo.prefix;
    const opened = [];
    const notes = [];

    const ufwCheck = await this.exec('command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -n 1 || true', 8000);
    const ufwActive = /status: active/i.test(ufwCheck.stdout || '');
    if (ufwActive) {
      for (const { port, proto, label } of ports) {
        const r = await this.exec(`${prefix}ufw allow ${port}/${proto} 2>&1`, 15000);
        const msg = `${r.stdout || ''}${r.stderr || ''}`;
        if (r.ok || /Rule added|Skipping adding existing rule/i.test(msg)) opened.push(`${label}(${port}/${proto})`);
        else notes.push(`${label}(${port}/${proto}) 开端口失败：${firstLine(r.stderr || r.stdout)}`);
      }
      return { ok: opened.length > 0, manager: 'ufw', opened, notes };
    }

    const fwCheck = await this.exec('command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null || true', 8000);
    const fwRunning = /running/.test(fwCheck.stdout || '');
    if (fwRunning) {
      for (const { port, proto, label } of ports) {
        const r = await this.exec(`${prefix}firewall-cmd --permanent --add-port=${port}/${proto} 2>&1`, 15000);
        const msg = `${r.stdout || ''}${r.stderr || ''}`;
        if (r.ok || /ALREADY_ENABLED/i.test(msg)) opened.push(`${label}(${port}/${proto})`);
        else notes.push(`${label}(${port}/${proto}) 开端口失败：${firstLine(r.stderr || r.stdout)}`);
      }
      await this.exec(`${prefix}firewall-cmd --reload 2>/dev/null || true`, 15000);
      return { ok: opened.length > 0, manager: 'firewalld', opened, notes };
    }

    // 裸 iptables（规则不持久化，重启后丢失；仅兜底）
    for (const { port, proto, label } of ports) {
      const cmd = `iptables -C INPUT -p ${proto} --dport ${port} -j ACCEPT 2>/dev/null || iptables -I INPUT -p ${proto} --dport ${port} -j ACCEPT`;
      const r = await this.exec(`${prefix}${cmd}`, 15000);
      if (r.ok) opened.push(`${label}(${port}/${proto})`);
      else notes.push(`${label}(${port}/${proto}) 开端口失败：${firstLine(r.stderr || r.stdout)}`);
    }
    return { ok: opened.length > 0, manager: 'iptables', opened, notes };
  }

  // 手动放行任意端口/端口范围（用户输入，如 1-65500 / 8080 / 8000-9000,10000）。
  // proto 只支持 tcp/udp（ufw/firewalld/iptables 都按协议分开）。
  async openFirewallPortsManual(text, proto = 'tcp') {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const parsed = parsePortInput(text);
    if (!parsed.ok) return parsed;
    // proto 支持 tcp / udp / both（tcp+udp 同时放行）
    const protos = proto === 'both' ? ['tcp', 'udp'] : [(proto === 'udp' ? 'udp' : 'tcp')];
    const ranges = parsed.ranges;

    // 先探测防火墙状态，给用户明确反馈，而不是默默走到 iptables 兜底。
    const det = await this.detectFirewall();
    if (det.manager === 'none') {
      return { ok: false, manager: 'none', error: '服务器没有检测到防火墙（ufw/firewalld/iptables），请先「安装并启用防火墙」' };
    }
    if (!det.active) {
      return { ok: false, manager: det.manager, error: `防火墙（${det.manager}）未启用，不会拦截端口，无需放行` };
    }

    const sudo = await this.detectSudo();
    if (!sudo.ok) return { ok: false, error: sudo.error };
    const prefix = sudo.prefix;
    const opened = [];
    const notes = [];

    if (det.manager === 'ufw') {
      for (const protoSafe of protos) {
        for (const r of ranges) {
          const spec = r.start === r.end ? `${r.start}/${protoSafe}` : `${r.start}:${r.end}/${protoSafe}`;
          const rr = await this.exec(`${prefix}ufw allow ${spec} 2>&1`, 15000);
          const msg = `${rr.stdout || ''}${rr.stderr || ''}`;
          if (rr.ok || /Rule added|Skipping adding existing rule/i.test(msg)) opened.push(`${r.label}/${protoSafe}`);
          else notes.push(`${r.label}/${protoSafe} 放行失败：${firstLine(rr.stderr || rr.stdout)}`);
        }
      }
      return { ok: opened.length > 0, manager: 'ufw', opened, notes, ranges };
    }

    if (det.manager === 'firewalld') {
      for (const protoSafe of protos) {
        for (const r of ranges) {
          const spec = r.start === r.end ? `${r.start}/${protoSafe}` : `${r.start}-${r.end}/${protoSafe}`;
          const rr = await this.exec(`${prefix}firewall-cmd --permanent --add-port=${spec} 2>&1`, 15000);
          const msg = `${rr.stdout || ''}${rr.stderr || ''}`;
          if (rr.ok || /ALREADY_ENABLED/i.test(msg)) opened.push(`${r.label}/${protoSafe}`);
          else notes.push(`${r.label}/${protoSafe} 放行失败：${firstLine(rr.stderr || rr.stdout)}`);
        }
      }
      await this.exec(`${prefix}firewall-cmd --reload 2>/dev/null || true`, 15000);
      return { ok: opened.length > 0, manager: 'firewalld', opened, notes, ranges };
    }

    // 裸 iptables（规则不持久化，重启后丢失；仅兜底）
    for (const protoSafe of protos) {
      for (const r of ranges) {
        const dport = r.start === r.end ? `${r.start}` : `${r.start}:${r.end}`;
        const cmd = `iptables -C INPUT -p ${protoSafe} --dport ${dport} -j ACCEPT 2>/dev/null || iptables -I INPUT -p ${protoSafe} --dport ${dport} -j ACCEPT`;
        const rr = await this.exec(`${prefix}${cmd}`, 15000);
        if (rr.ok) opened.push(`${r.label}/${protoSafe}`);
        else notes.push(`${r.label}/${protoSafe} 放行失败：${firstLine(rr.stderr || rr.stdout)}`);
      }
    }
    return { ok: opened.length > 0, manager: 'iptables', opened, notes, ranges };
  }

  // 读防火墙「当前实际放行」的端口/范围规则（只读，不改任何规则）。
  // 返回结构化数组 [{ port, proto, spec }]，spec 是展示文本（如 '7000/tcp'、'8000:9000/tcp'）。
  async readFirewallAllowed() {
    if (!this.connected) return [];
    const det = await this.detectFirewall();
    const out = [];
    const seen = new Set();
    const push = (spec, proto, port) => {
      if (seen.has(spec)) return;
      seen.add(spec);
      out.push({ port, proto, spec });
    };

    if (det.manager === 'ufw' && det.active) {
      const r = await this.exec('ufw status 2>/dev/null || true', 8000);
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const m = /^\s*([0-9]+(?::[0-9]+)?)\/(tcp|udp)\b/i.exec(line);
        if (!m) continue;
        const portPart = m[1];
        const port = portPart.includes(':') ? Number(portPart.split(':')[0]) : Number(portPart);
        push(`${portPart}/${m[2].toLowerCase()}`, m[2].toLowerCase(), port);
      }
      return out;
    }

    if (det.manager === 'firewalld' && det.active) {
      const r = await this.exec('firewall-cmd --list-ports 2>/dev/null || true', 8000);
      for (const tok of String(r.stdout || '').trim().split(/\s+/)) {
        const m = /^([0-9]+(?:-[0-9]+)?)\/(tcp|udp)$/i.exec(tok);
        if (!m) continue;
        push(`${m[1]}/${m[2].toLowerCase()}`, m[2].toLowerCase(), Number(m[1].split('-')[0]));
      }
      return out;
    }

    if (det.manager === 'iptables' && det.active) {
      const r = await this.exec('iptables -L INPUT -n --line-numbers 2>/dev/null || true', 8000);
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        if (!/^\s*\d+\s+ACCEPT\s+/i.test(line)) continue;
        const dm = /dpt(s)?:(\d+)(?::(\d+))?/.exec(line);
        if (!dm) continue;
        const pm = /\s(tcp|udp)\s/.exec(line);
        const proto = pm ? pm[1].toLowerCase() : 'tcp';
        push(`${dm[2]}${dm[3] ? `-${dm[3]}` : ''}/${proto}`, proto, Number(dm[2]));
      }
      return out;
    }

    return out;
  }

  // 撤销放行（按「规则 spec」删除，spec 直接来自 readFirewallAllowed 的输出，如 '7000/tcp'、'1:65535/tcp'）。
  // 按规则原文删，范围规则也能精确命中；按单端口删范围规则会报 Could not find，什么都删不掉。
  async closeFirewallRules(specs) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const list = (specs || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (!list.length) return { ok: true, removed: [], notes: ['没有要删除的规则'] };
    // spec 只允许「端口 或 端口范围/协议」两种形式（ufw 用 ':'、firewalld 用 '-'），防注入。
    for (const spec of list) {
      if (!/^[0-9]+(?::[0-9]+)?\/(tcp|udp)$/i.test(spec) && !/^[0-9]+(?:-[0-9]+)?\/(tcp|udp)$/i.test(spec)) {
        return { ok: false, error: `规则格式不正确：${spec}` };
      }
    }
    const det = await this.detectFirewall();
    if (det.manager === 'none') return { ok: false, error: '服务器没有检测到防火墙' };
    if (!det.active) return { ok: false, error: `防火墙（${det.manager}）未启用，没有需要删除的规则` };
    const sudo = await this.detectSudo();
    if (!sudo.ok) return { ok: false, error: sudo.error };
    const prefix = sudo.prefix;
    const removed = [];
    const notes = [];

    if (det.manager === 'ufw') {
      for (const spec of list) {
        // ufw delete 一条命令同时删 v4+v6；再删一次兜底（第二次找不到时忽略）。
        let hit = false;
        for (let i = 0; i < 2; i += 1) {
          const r = await this.exec(`${prefix}ufw delete allow ${spec} 2>&1`, 15000);
          const msg = `${r.stdout || ''}${r.stderr || ''}`;
          if (r.ok && /Rule deleted|Deleting/i.test(msg)) hit = true;
          else if (i === 0 && /Could not find/i.test(msg)) break; // 第一条就找不到，别再试第二次
        }
        if (hit) removed.push(spec);
        else notes.push(`${spec} 删除失败：规则不存在`);
      }
      return { ok: removed.length > 0, manager: 'ufw', removed, notes, error: removed.length ? undefined : (notes.join('；') || '没有规则被删除') };
    }

    if (det.manager === 'firewalld') {
      for (const spec of list) {
        const r = await this.exec(`${prefix}firewall-cmd --permanent --remove-port=${spec} 2>&1`, 15000);
        if (r.ok) removed.push(spec);
        else notes.push(`${spec} 删除失败：${firstLine(r.stderr || r.stdout)}`);
      }
      await this.exec(`${prefix}firewall-cmd --reload 2>/dev/null || true`, 15000);
      return { ok: removed.length > 0, manager: 'firewalld', removed, notes, error: removed.length ? undefined : (notes.join('；') || '没有规则被删除') };
    }

    // 裸 iptables（规则不持久化，重启后丢失；仅兜底）
    for (const spec of list) {
      const m = /^([0-9]+)(?::|-([0-9]+))?\/(tcp|udp)$/i.exec(spec);
      if (!m) { notes.push(`${spec} 删除失败：无法解析`); continue; }
      const dport = m[2] ? `${m[1]}:${m[2]}` : `${m[1]}`;
      const r = await this.exec(`${prefix}iptables -D INPUT -p ${m[3].toLowerCase()} --dport ${dport} -j ACCEPT 2>&1`, 15000);
      if (r.ok) removed.push(spec);
      else notes.push(`${spec} 删除失败：${firstLine(r.stderr || r.stdout)}`);
    }
    return { ok: removed.length > 0, manager: 'iptables', removed, notes, error: removed.length ? undefined : (notes.join('；') || '没有规则被删除') };
  }

  // 读当前配置并放开它要监听的端口（best-effort，出错返回 null，不阻断主流程）。
  async openFirewallForConfig() {
    try {
      const cfg = await this.readConfig();
      if (!cfg.ok) return null;
      const ports = this.configPorts(cfg.content);
      if (!ports.length) return null;
      return await this.openFirewallPorts(ports);
    } catch {
      return null;
    }
  }

  // ---- nginx 反代（方案 Y：nginx 在 80/443 终止 TLS，frps 只做 HTTP vhost）----

  /* 域名 → nginx ssl 目录名。通配符 `*.x` 换成 `wildcard.x`，避免路径歧义。 */
  nginxSslDir(domain) {
    return String(domain || '').replace(/^\*\./, 'wildcard.').replace(/[\\/:*?"<>|]/g, '_');
  }

  /* 探测服务器上的 nginx 状态 + 80/443 被谁占用 + 配置该写进哪个目录。 */
  async detectNginxConfDir() {
    const bt = await this.exec('[ -d /www/server/panel/vhost/nginx ] && echo /www/server/panel/vhost/nginx || true', 6000);
    const btDir = firstLine(bt.stdout);
    if (btDir) return { dir: btDir, managedBy: '宝塔面板' };
    const confd = await this.exec('[ -d /etc/nginx/conf.d ] && echo /etc/nginx/conf.d || true', 6000);
    const confdDir = firstLine(confd.stdout);
    if (confdDir) return { dir: confdDir, managedBy: '' };
    const sites = await this.exec('[ -d /etc/nginx/sites-enabled ] && echo /etc/nginx/sites-enabled || true', 6000);
    const sitesDir = firstLine(sites.stdout);
    if (sitesDir) return { dir: sitesDir, managedBy: '' };
    return { dir: '/etc/nginx/conf.d', managedBy: '' };
  }

  /* 轻量判断：nginx 反代配置 frp-console.conf 是否存在。只跑两次 SSH 命令
   * （找配置目录 + test -f），不跑完整 detectNginx 的 ss/nginx -v。用于连服务器时
   * 快速同步「公网地址要不要带端口」。 */
  async nginxProxyConfigured() {
    if (!this.connected) return false;
    try {
      const confInfo = await this.detectNginxConfDir();
      const proxyConf = await this.exec(`[ -f ${shellQuote(`${confInfo.dir}/frp-console.conf`)} ] && echo yes || true`, 6000);
      return firstLine(proxyConf.stdout) === 'yes';
    } catch { return false; }
  }

  async detectNginx() {
    if (!this.connected) return { installed: false, error: '尚未连接服务器' };
    const which = await this.exec('command -v nginx 2>/dev/null || true', 6000);
    const installed = !!firstLine(which.stdout);
    let version = '';
    if (installed) {
      const v = await this.exec('nginx -v 2>&1 | head -n 1 || true', 6000);
      version = firstLine(`${v.stdout || ''}${v.stderr || ''}`).replace(/^nginx version:\s*/i, '');
    }
    const ss = await this.exec("ss -lntp 2>/dev/null | grep -E ':(80|443)\\s' || true", 10000);
    const listeners = this.parseListeners(ss.stdout || '');
    const p80 = listeners.filter((l) => l.port === 80);
    const p443 = listeners.filter((l) => l.port === 443);
    const confInfo = await this.detectNginxConfDir();
    const confPath = `${confInfo.dir}/frp-console.conf`;
    const proxyConf = await this.exec(`[ -f ${shellQuote(confPath)} ] && echo yes || true`, 6000);
    const proxyConfigured = firstLine(proxyConf.stdout) === 'yes';
    /* 我们的反代配置文件里到底写了哪些域名：健康检查要据此区分
     * 「nginx 压根没为这个域名配 443」和「frps 上没有这个路由」——
     * 前者报成后者会把用户引向排查错方向（1.2.60）。 */
    let serverNames = [];
    let certs = [];
    if (proxyConfigured) {
      const conf = await this.exec(`cat ${shellQuote(confPath)} 2>/dev/null || true`, 8000);
      const text = String(conf.stdout || '');
      for (const line of text.split('\n')) {
        const nameMatch = line.match(/^\s*server_name\s+([^;]+);/);
        if (nameMatch) {
          for (const name of nameMatch[1].split(/\s+/)) {
            const v = name.trim().toLowerCase();
            if (v) serverNames.push(v);
          }
        }
        const certMatch = line.match(/^\s*ssl_certificate\s+([^;]+);/);
        if (certMatch) certs.push(certMatch[1].trim());
      }
    }
    return {
      installed,
      version,
      running: p80.length > 0 || p443.length > 0,
      port80By: p80.map((l) => l.process).filter(Boolean).join(', '),
      port443By: p443.map((l) => l.process).filter(Boolean).join(', '),
      port80Pids: p80.flatMap((l) => l.pids || []),
      port443Pids: p443.flatMap((l) => l.pids || []),
      port80Free: p80.length === 0,
      port443Free: p443.length === 0,
      // 80/443 被「非 nginx」的程序占用时才算冲突（nginx 自己占着是正常共存，可继续写 server_name）。
      port80Conflict: p80.some((l) => l.process && !/nginx/i.test(l.process)),
      port443Conflict: p443.some((l) => l.process && !/nginx/i.test(l.process)),
      confDir: confInfo.dir,
      managedBy: confInfo.managedBy,
      proxyConfigured,
      serverNames: Array.from(new Set(serverNames)),
      certs: Array.from(new Set(certs)),
    };
  }

  /* 按发行版自动装 nginx（apt-get / dnf / yum）。 */
  async installNginx() {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const sudo = await this.detectSudo();
    if (!sudo.ok) return sudo;
    const prefix = sudo.prefix;
    const apt = firstLine((await this.exec('command -v apt-get 2>/dev/null || true', 6000)).stdout);
    if (apt) {
      const r = await this.exec(`${prefix}DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx 2>&1`, 180000);
      if (!r.ok) return { ok: false, error: `安装 nginx 失败：${(r.stderr || r.stdout || '未知错误').trim()}` };
    } else {
      const dnf = firstLine((await this.exec('command -v dnf 2>/dev/null || true', 6000)).stdout);
      const yum = firstLine((await this.exec('command -v yum 2>/dev/null || true', 6000)).stdout);
      if (dnf) {
        const r = await this.exec(`${prefix}dnf install -y -q nginx 2>&1`, 180000);
        if (!r.ok) return { ok: false, error: `安装 nginx 失败：${(r.stderr || r.stdout || '未知错误').trim()}` };
      } else if (yum) {
        const r = await this.exec(`${prefix}yum install -y -q nginx 2>&1`, 180000);
        if (!r.ok) return { ok: false, error: `安装 nginx 失败：${(r.stderr || r.stdout || '未知错误').trim()}` };
      } else {
        return { ok: false, error: '未找到 apt-get / dnf / yum，无法自动安装 nginx。请手动安装后再试。' };
      }
    }
    return { ok: true };
  }

  /* 把本机签好的证书（fullchain + 私钥）上传到服务器 /etc/nginx/ssl/<域名>/。 */
  async uploadCertToNginx(domain, { certPath, keyPath }) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return { ok: false, error: '本机证书文件缺失' };
    const sudo = await this.detectSudo();
    if (!sudo.ok) return sudo;
    const prefix = sudo.prefix;
    const dir = `/etc/nginx/ssl/${this.nginxSslDir(domain)}`;
    const mkdir = await this.exec(`${prefix}mkdir -p ${shellQuote(dir)}`, 10000);
    if (!mkdir.ok) return { ok: false, error: `创建证书目录失败：${mkdir.stderr || '权限不足'}` };
    const certB64 = Buffer.from(fs.readFileSync(certPath, 'utf8'), 'utf8').toString('base64');
    const keyB64 = Buffer.from(fs.readFileSync(keyPath, 'utf8'), 'utf8').toString('base64');
    const tmpCert = '/tmp/frp-console-cert.pem';
    const tmpKey = '/tmp/frp-console-key.pem';
    await this.exec(`printf %s ${certB64} | base64 -d > ${tmpCert}`, 15000);
    await this.exec(`printf %s ${keyB64} | base64 -d > ${tmpKey}`, 15000);
    const c = await this.exec(`${prefix}install -m 644 ${tmpCert} ${shellQuote(dir)}/fullchain.pem`, 10000);
    const k = await this.exec(`${prefix}install -m 600 ${tmpKey} ${shellQuote(dir)}/key.pem`, 10000);
    await this.exec(`rm -f ${tmpCert} ${tmpKey} 2>/dev/null || true`, 6000);
    if (!c.ok) return { ok: false, error: `上传证书失败：${c.stderr || '未知错误'}` };
    if (!k.ok) return { ok: false, error: `上传私钥失败：${k.stderr || '未知错误'}` };
    return { ok: true, dir };
  }

  /* 服务器上已有的证书盘点（只读）。
   * 一次 SSH 批量跑完：① nginx 配置里 ssl_certificate 指向的文件 ② 宝塔面板的 vhost/cert/*
   * ③ letsencrypt/live/* ④ /etc/nginx/ssl/*。每条再用 openssl 读出 subject/issuer/到期/SAN，
   * 让 UI 能列出「这台服务器上有哪些证书、域名是什么、到期还有多久」。
   * 只读、不改任何文件；个别文件读不出就跳过（openssl 缺失时只回路径）。 */
  async scanCertificates({ limit = 40, timeout = 20000 } = {}) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const script = [
      'set +e',
      'for f in \\',
      "  $(grep -rhoE 'ssl_certificate[[:space:]]+[^;]+;' /etc/nginx /www/server/panel/vhost/nginx 2>/dev/null | sed -E 's/ssl_certificate[[:space:]]+//; s/;//'), \\",
      '  $(ls -1 /www/server/panel/vhost/cert/*/fullchain.pem 2>/dev/null), \\',
      '  $(ls -1 /etc/letsencrypt/live/*/fullchain.pem 2>/dev/null), \\',
      '  $(ls -1 /etc/nginx/ssl/*/fullchain.pem 2>/dev/null); do',
      '  [ -f "$f" ] || continue',
      '  echo "@@CERT $f"',
      '  openssl x509 -in "$f" -noout -subject -issuer -enddate -ext subjectAltName 2>/dev/null | head -n 14',
      '  d=$(dirname "$f")',
      '  for k in privkey.pem key.pem; do if [ -f "$d/$k" ]; then echo "@@KEY $d/$k"; break; fi; done',
      '  echo "@@END"',
      'done | head -n ' + String(Math.max(1, limit) * 20),
      'echo "@@DONE"',
    ].join('\n');
    const res = await this.exec(script, timeout);
    if (!res.ok && !/@@DONE/.test(res.stdout || '')) {
      return { ok: false, error: res.stderr || res.error || '扫描失败' };
    }
    return { ok: true, certs: this.parseCertificates(res.stdout || ''), truncated: !/@@DONE/.test(res.stdout || '') };
  }

  /* 解析 scanCertificates 的原始输出。抽成独立方法便于单测。 */
  parseCertificates(text) {
    const out = [];
    const blocks = String(text || '').split(/@@CERT /).slice(1);
    for (const block of blocks) {
      const end = block.indexOf('@@END');
      const body = end >= 0 ? block.slice(0, end) : block;
      const lines = body.split('\n');
      const path = (lines.shift() || '').trim();
      if (!path) continue;
      const detail = lines.join('\n');
      const keyMatch = detail.match(/@@KEY\s+(\S+)/);
      const subject = (detail.match(/subject\s*=.*?(?:CN\s*=\s*)([^,\n\/]+)/i) || [])[1] || '';
      /* issuer 优先取组织名（O = Let's Encrypt），取不到再退到 CN（CN 常是 R10/R11 这种中间证书代号） */
      const issuerLine = (detail.match(/issuer\s*=([^\n]+)/i) || [])[1] || '';
      const issuerOrg = (issuerLine.match(/\bO\s*=\s*([^,\n]+)/i) || [])[1] || '';
      const issuerCn = (issuerLine.match(/\bCN\s*=\s*([^,\n]+)/i) || [])[1] || '';
      const issuer = String(issuerOrg || issuerCn).trim();
      const notAfterRaw = (detail.match(/notAfter\s*=\s*([^\n]+)/i) || [])[1] || '';
      const sanLine = (detail.match(/Subject Alternative Name[\s\S]*?DNS:([^\n]+)/i) || [])[1] || '';
      const altNames = sanLine
        .split(',')
        .map((s) => s.trim().replace(/^DNS:/i, '').trim())
        .filter(Boolean);
      const lower = path.toLowerCase();
      const source = lower.includes('/www/server/panel/')
        ? 'bt'
        : lower.includes('letsencrypt')
          ? 'le'
          : 'nginx';
      out.push({
        certPath: path,
        keyPath: keyMatch ? keyMatch[1].trim() : '',
        domain: String(subject).trim(),
        altNames,
        issuer: String(issuer).trim(),
        notAfterRaw: String(notAfterRaw).trim(),
        source,
      });
    }
    return out;
  }

  /* nginx server_name：多个域名空格分隔，通配符 `*.x` 原样传给 nginx。 */
  nginxServerName(domains) {    const names = (Array.isArray(domains) ? domains : [domains]).map((d) => String(d || '').trim()).filter(Boolean);
    return names.length ? names.join(' ') : 'localhost';
  }

  /* 写 frp-console.conf：80/443 终止 TLS，反代给 frps 的 HTTP vhost。confDir 缺省自动探测（宝塔/标准）。 */
  async writeNginxProxyConfig({ serverNames, certDir, frpsHttpPort = 8080, confDir }) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const sudo = await this.detectSudo();
    if (!sudo.ok) return sudo;
    const prefix = sudo.prefix;
    if (!confDir) {
      const info = await this.detectNginxConfDir();
      confDir = info.dir;
    }
    const confPath = `${confDir}/frp-console.conf`;
    const conf = [
      '# 由 FRP-Console 生成：nginx 在 80/443 终止 TLS，把 frp 域名的流量反代给 frps 的 HTTP vhost。',
      '# 修改后请执行 nginx -t && systemctl reload nginx。',
      'server {',
      '    listen 80;',
      `    server_name ${serverNames};`,
      '    location / {',
      `        proxy_pass http://127.0.0.1:${frpsHttpPort};`,
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      '    }',
      '}',
      '',
      'server {',
      '    listen 443 ssl;',
      `    server_name ${serverNames};`,
      `    ssl_certificate ${certDir}/fullchain.pem;`,
      `    ssl_certificate_key ${certDir}/key.pem;`,
      '    location / {',
      `        proxy_pass http://127.0.0.1:${frpsHttpPort};`,
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      '    }',
      '}',
      '',
    ].join('\n');
    const b64 = Buffer.from(conf, 'utf8').toString('base64');
    const tmp = '/tmp/frp-console-nginx.conf';
    await this.exec(`printf %s ${b64} | base64 -d > ${tmp}`, 15000);
    const install = await this.exec(`${prefix}install -m 644 ${tmp} ${shellQuote(confPath)}`, 10000);
    await this.exec(`rm -f ${tmp} 2>/dev/null || true`, 6000);
    if (!install.ok) return { ok: false, error: `写入 nginx 配置失败：${(install.stderr || install.stdout || '权限不足').trim()}` };
    return { ok: true, confPath, content: conf };
  }

  /* nginx -t 校验 + reload。 */
  async reloadNginx() {
    const sudo = await this.detectSudo();
    if (!sudo.ok) return sudo;
    const prefix = sudo.prefix;
    const test = await this.exec(`${prefix}nginx -t 2>&1`, 15000);
    const testText = `${test.stdout || ''}\n${test.stderr || ''}`;
    if (!test.ok && !/syntax is ok|test is successful/i.test(testText)) {
      return { ok: false, error: `nginx 配置校验失败：${(test.stderr || test.stdout || '未知错误').trim()}` };
    }
    const reload = await this.exec(`${prefix}systemctl reload nginx 2>&1 || ${prefix}service nginx reload 2>&1 || ${prefix}nginx -s reload 2>&1`, 15000);
    if (!reload.ok) return { ok: false, error: `nginx reload 失败：${(reload.stderr || reload.stdout || '未知错误').trim()}` };
    return { ok: true };
  }

  /* 终止指定 PID（kill）。返回被 kill 的 PID 列表与每条结果说明；调用方随后重新探测确认端口是否释放。 */
  async killPids(pids) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const sudo = await this.detectSudo();
    if (!sudo.ok) return sudo;
    const list = [...new Set((pids || []).map(Number).filter((n) => n && n > 1))];
    if (!list.length) return { ok: false, error: '没有可终止的进程' };
    const note = [];
    for (const pid of list) {
      const r = await this.exec(`${sudo.prefix}kill ${pid} 2>&1 || true`, 8000);
      const msg = firstLine(`${r.stdout || ''}${r.stderr || ''}`);
      note.push(msg ? `PID ${pid}：${msg}` : `PID ${pid}`);
    }
    return { ok: true, killed: list, note };
  }

  /* 终止监听指定端口的非 frps 进程（探测 PID → kill）。供「端口冲突」弹窗的「终止占用进程」用。 */
  async killPortOccupants(ports) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const target = (ports || []).map(Number).filter((p) => p && p > 0);
    if (!target.length) return { ok: false, error: '没有要处理的端口' };
    const result = await this.exec('ss -lntp 2>/dev/null || netstat -ltnp 2>/dev/null', 10000);
    const listeners = this.parseListeners(result.stdout || '');
    const pids = [];
    for (const l of listeners) {
      if (target.includes(l.port) && l.process && !/^frps/i.test(l.process)) {
        pids.push(...(l.pids || []));
      }
    }
    if (!pids.length) return { ok: true, killed: [], note: ['这些端口现在没有非 frps 进程占用'] };
    return this.killPids(pids);
  }

  /* 在服务器上找一个 >= start 的空闲 TCP 端口（从当前监听端口里排除）。 */
  async findFreePort(start = 10000) {
    const result = await this.exec('ss -lntp 2>/dev/null || netstat -ltnp 2>/dev/null', 10000);
    const used = new Set(this.parseListeners(result.stdout || '').map((l) => l.port));
    let p = Math.max(1024, Math.floor(Number(start) || 10000));
    while (used.has(p)) p += 1;
    return p;
  }

  /* 把配置内容里的端口按 remap {旧端口: 新端口} 替换（bindPort / vhostHTTPPort / vhostHTTPSPort / Dashboard），
   * 返回新的 TOML 文本。用于「端口冲突」弹窗的「自动换端口」。 */
  remapConfigPorts(content, remap) {
    const parsed = frpsParseConfig(content);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const data = parsed.data;
    for (const [oldPort, newPort] of Object.entries(remap || {})) {
      const o = Number(oldPort);
      const n = Number(newPort);
      if (!o || !n || o === n) continue;
      if (data.bindPort === o) data.bindPort = n;
      if (data.vhostHTTPPort === o) data.vhostHTTPPort = n;
      if (data.vhostHTTPSPort === o) data.vhostHTTPSPort = n;
      if (data.webServer && typeof data.webServer === 'object' && data.webServer.port === o) data.webServer.port = n;
    }
    return { ok: true, content: tomlStringify(data), remap };
  }

  // 从 journalctl / 日志里挑出第一行报错原因，用于「重启后没起来」时告诉用户到底为什么。
  failureReason(logRes) {
    const lines = String((logRes && logRes.content) || '').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!/error|fatal|panic|address already in use|bind:|failed/i.test(line)) continue;
      const msg = line.replace(/^.*?frps(?:\[\d+\])?:\s*/, '').trim();
      if (msg) return msg;
    }
    return '';
  }

  async writeConfig(content, { restart = false } = {}) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    if (!this.configPath) return { ok: false, error: '未找到 frps 配置文件' };

    // 端口冲突预检：配置里要监听的 TCP 端口若已被其它进程（如 nginx 占 80/443）占用，
    // frps 会 bind 失败并陷入 systemd auto-restart 死循环。这里提前拦截，不写坏配置。
    const ports = this.configPorts(content);
    const details = await this.portConflictDetails(ports);
    const conflicts = details.map((d) => `${d.label}（${d.port}）已被 ${d.process} 占用`);
    if (conflicts.length) {
      return { ok: false, error: `配置端口与现有服务冲突，frps 会启动失败：${conflicts.join('；')}。请改用空闲端口，或先停掉占用进程。`, conflicts, conflictDetails: details };
    }

    const ext = /\.ini$/i.test(this.configPath) ? 'ini' : 'toml';
    const remoteTmp = `/tmp/frps-console-new.${ext}`;
    const base64 = Buffer.from(content, 'utf8').toString('base64');
    const writeResult = await this.exec(`printf %s ${base64} | base64 -d > ${remoteTmp}`, 12000);
    if (!writeResult.ok) return { ok: false, error: writeResult.stderr || '写入临时文件失败' };

    const verifyCommand = await this.verifyCommandFor(remoteTmp);
    if (verifyCommand) {
      const verify = await this.exec(verifyCommand, 12000);
      const message = `${verify.stdout}\n${verify.stderr}`;
      if (!verify.ok && !/unknown command|not supported|no such file/i.test(message)) {
        await this.exec(`rm -f ${remoteTmp} 2>/dev/null || true`, 6000);
        return { ok: false, error: `配置校验未通过：${(verify.stderr || verify.stdout || 'frps verify 失败').trim()}` };
      }
    }

    const stamp = await this.exec('date +%Y%m%d-%H%M%S', 8000);
    const backup = `${this.configPath}.bak-${(stamp.stdout || '').trim() || 'manual'}`;
    const backupResult = await this.exec(`cp -p ${shellQuote(this.configPath)} ${shellQuote(backup)}`, 10000);
    if (!backupResult.ok) {
      await this.exec(`rm -f ${remoteTmp} 2>/dev/null || true`, 6000);
      return { ok: false, error: `备份失败：${backupResult.stderr || '未知错误'}` };
    }

    const moveResult = await this.exec(`cp ${remoteTmp} ${shellQuote(this.configPath)}`, 10000);
    await this.exec(`rm -f ${remoteTmp} 2>/dev/null || true`, 6000);
    if (!moveResult.ok) return { ok: false, error: `写入失败：${moveResult.stderr || '未知错误'}` };

    let restarted = null;
    let firewall = null;
    if (restart) {
      restarted = await this.control('restart');
      // systemctl restart 命令成功 ≠ frps 真的起来了（端口冲突会让 systemd 陷入 auto-restart）。
      // 起来后校验状态；没起来就取日志、回滚配置，把服务恢复成原样再报错。
      const runningAfter = !!(restarted && restarted.after && restarted.after.status === 'running');
      if (!runningAfter) {
        const logRes = await this.logs(40);
        const reason = this.failureReason(logRes) || (restarted && restarted.error) || ((restarted && restarted.after && restarted.after.statusText) || '');
        const rollback = await this.exec(`cp -p ${shellQuote(backup)} ${shellQuote(this.configPath)}`, 10000);
        if (rollback.ok) await this.control('restart');
        return {
          ok: false,
          error: `重启后 frps 未运行${reason ? `：${reason}` : ''}。已回滚到修改前的配置。`,
          backup,
          rolledBack: !!rollback.ok,
          restarted,
        };
      }
      // frps 起来了，顺手放开防火墙端口，避免下次被防火墙拦截。
      firewall = await this.openFirewallPorts(ports);
    }
    return { ok: true, backup, restarted, firewall };
  }

  async control(action) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: '未知操作' };
    const info = this.info || {};
    const actionText = { start: '启动', stop: '停止', restart: '重启' }[action];
    const before = { status: info.status, service: info.serviceName, docker: info.docker && info.docker.name };

    if (info.dockerRunning || (info.docker && info.docker.name)) {
      const result = await this.dockerCommand(action, info.docker.name);
      if (!result.ok) return { ok: false, error: `Docker ${actionText}失败：${(result.stderr || result.stdout || '未知错误').trim()}` };
      const after = await this.inspect();
      const afterInfo = after.info || null;
      if ((action === 'start' || action === 'restart') && afterInfo && afterInfo.status && afterInfo.status !== 'running') {
        return { ok: false, error: `Docker ${actionText}后 frps 未运行（${afterInfo.statusText}）`, via: 'docker', container: info.docker.name, before, after: afterInfo };
      }
      return { ok: true, via: 'docker', container: info.docker.name, before, after: afterInfo };
    }

    if (info.hasUnit && info.serviceName) {
      const result = await this.sudoSystemctl(action, info.serviceName);
      if (!result.ok) {
        return { ok: false, error: `${actionText}失败：${(result.stderr || result.stdout || '请确认当前账户有 systemctl 权限').trim()}` };
      }
      const after = await this.inspect();
      const afterInfo = after.info || null;
      if ((action === 'start' || action === 'restart') && afterInfo && afterInfo.status && afterInfo.status !== 'running') {
        return { ok: false, error: `${actionText}后 frps 未运行（${afterInfo.statusText}）`, via: 'systemd', service: info.serviceName, before, after: afterInfo };
      }
      if (action === 'start' || action === 'restart') await this.openFirewallForConfig();
      return { ok: true, via: 'systemd', service: info.serviceName, before, after: afterInfo };
    }

    if (action === 'stop' || action === 'restart') {
      if (!info.processAlive || !info.pids || !info.pids.length) {
        return { ok: false, error: '未检测到 frps 进程或 systemd 服务，无法停止' };
      }
      await this.exec(`kill ${info.pids.join(' ')} 2>/dev/null || true`, 8000);
      if (action === 'stop') {
        const after = await this.inspect();
        // inspect() 失败时 info 为 undefined，不能直接取属性。
        const stopped = !(after.ok && after.info && after.info.processAlive);
        return { ok: true, via: 'process', stopped, after: after.info || null };
      }
      // restart: 等旧进程退出后再拉起
      await new Promise((r) => setTimeout(r, 1200));
    }

    if (action === 'start' || action === 'restart') {
      const bin = info.binaryPath || 'frps';
      const config = this.configPath;
      if (!config) return { ok: false, error: '未找到配置文件，无法启动 frps' };
      const command = `setsid nohup ${shellQuote(bin)} -c ${shellQuote(config)} >> /var/log/frps.log 2>&1 < /dev/null & echo started`;
      let result = await this.exec(command, 10000);
      if (!result.ok) {
        result = await this.exec(`nohup ${shellQuote(bin)} -c ${shellQuote(config)} >> /var/log/frps.log 2>&1 < /dev/null & echo started`, 10000);
      }
      if (!result.ok) return { ok: false, error: `启动失败：${(result.stderr || result.stdout || '请确认 frps 路径与配置').trim()}` };
      await new Promise((r) => setTimeout(r, 1200));
      const after = await this.inspect();
      const afterInfo = after.info || null;
      if (afterInfo && afterInfo.status && afterInfo.status !== 'running') {
        return { ok: false, error: `${actionText}后 frps 未运行（${afterInfo.statusText}）`, via: 'process', pid: afterInfo.pids || [], after: afterInfo };
      }
      await this.openFirewallForConfig();
      return { ok: true, via: 'process', pid: afterInfo.pids || [], after: afterInfo };
    }

    return { ok: false, error: '没有可用的启动方式' };
  }

  async logs(lines = 200) {
    if (!this.connected) return { ok: false, error: '尚未连接服务器' };
    const count = Math.min(1000, Math.max(10, Number(lines) || 200));
    const info = this.info || {};
    const journal = info.hasUnit && info.serviceName
      ? await this.exec(`journalctl -u ${shellQuote(info.serviceName)} -n ${count} --no-pager 2>/dev/null`, 15000)
      : { ok: false, stdout: '' };
    if (journal.ok && journal.stdout.trim()) return { ok: true, source: `journalctl -u ${info.serviceName}`, content: journal.stdout };
    if (info.docker && info.docker.name) {
      const dockerLog = await this.exec(`docker logs --tail ${count} ${shellQuote(info.docker.name)} 2>&1`, 15000);
      if (dockerLog.ok && dockerLog.stdout.trim()) return { ok: true, source: `docker logs ${info.docker.name}`, content: dockerLog.stdout };
    }
    const tail = await this.exec(`tail -n ${count} /var/log/frps.log 2>/dev/null || tail -n ${count} /var/log/frps/frps.log 2>/dev/null`, 12000);
    if (tail.ok && tail.stdout.trim()) return { ok: true, source: 'frps.log', content: tail.stdout };
    return { ok: false, error: '没有读取到日志，可确认 journalctl / docker logs / /var/log/frps.log' };
  }
}

// 解析用户手动输入的端口（支持单端口、范围、逗号/空格分隔），返回 { ok, ranges:[{start,end,label}] } 或 { ok:false, error }。
function parsePortInput(text) {
  const ranges = [];
  const seen = new Set();
  for (const part of String(text || '').split(/[,，;\s]+/)) {
    const p = part.trim();
    if (!p) continue;
    let start;
    let end;
    if (/^\d{1,5}$/.test(p)) {
      start = Number(p);
      end = start;
    } else {
      const m = /^(\d{1,5})\s*[-–—:]\s*(\d{1,5})$/.exec(p);
      if (!m) return { ok: false, error: `无法识别的端口：${p}` };
      start = Number(m[1]);
      end = Number(m[2]);
      if (start > end) [start, end] = [end, start];
    }
    if (start < 1 || end > 65535) return { ok: false, error: `端口超出 1-65535 范围：${p}` };
    const key = `${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push({ start, end, label: start === end ? `${start}` : `${start}-${end}` });
  }
  if (!ranges.length) return { ok: false, error: '请输入要放行的端口' };
  return { ok: true, ranges };
}

module.exports = { ServerSession, parseServiceUnits, rankServiceUnits, parsePortInput };
