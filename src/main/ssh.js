'use strict';

const fs = require('node:fs');
const { Client } = require('ssh2');
const { parseConfig: frpsParseConfig, summary: frpsSummary } = require('./frpsconfig');

function friendlyError(err) {
  const message = String((err && err.message) || err || '');
  if (/authentication methods failed|authentication failure/i.test(message)) return '用户名或密码错误';
  if (/cannot connect|ECONNREFUSED/i.test(message)) return 'SSH 端口无法连接，请检查 IP 与端口';
  if (/ETIMEDOUT|timed out|timeout/i.test(message)) return '连接超时，请检查网络与防火墙';
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '找不到该主机，请检查 IP';
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
  }

  async connect({ host, port = 22, username, password, timeout = 15000 }) {
    this.disconnect();
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
        this.connected = true;
        done({ ok: true });
      });
      client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        finish(prompts.map(() => password));
      });
      client.on('error', (err) => {
        this.connected = false;
        done({ ok: false, error: friendlyError(err) });
      });
      client.on('close', () => {
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

  async bootstrap({ content, localBinary, configPath = '/etc/frp/frps.toml', unitName = 'frps', onProgress }) {
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
      if (!upload.ok) return { ok: false, error: upload.error, steps };

      report('install', '安装 frps 到 /usr/local/bin/frps', 62);
      let install = await this.exec(`${prefix}install -m 755 ${shellQuote(remoteTmp)} /usr/local/bin/frps`, 20000);
      if (!install.ok) {
        install = await this.exec(`${prefix}mkdir -p /usr/local/bin && ${prefix}install -m 755 ${shellQuote(remoteTmp)} /usr/local/bin/frps`, 20000);
      }
      await this.exec(`rm -f ${shellQuote(remoteTmp)} 2>/dev/null || true`, 6000);
      if (!install.ok) {
        return { ok: false, error: `安装 frps 失败：${(install.stderr || install.stdout || '未知错误').trim()}`, steps };
      }
      binary = '/usr/local/bin/frps';
    } else {
      report('check', `检测到已安装 frps：${binary}`, 10);
    }

    const configDir = configPath.replace(/\/[^/]+$/, '') || '/etc/frp';
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
      await this.exec(`${prefix}systemctl daemon-reload`, 15000);
      const enable = await this.exec(`${prefix}systemctl enable -- ${shellQuote(serviceName)} 2>&1`, 15000);
      enabledState = firstLine((await this.exec(`${prefix}systemctl is-enabled -- ${shellQuote(serviceName)} 2>/dev/null || true`, 8000)).stdout);
      if (enabledState !== 'enabled') {
        const why = (enable.stderr || enable.stdout || '').trim().split(/\r?\n/).filter(Boolean)[0] || '';
        bootWarning = `frps 已在运行，但没能设成开机自启（systemctl is-enabled = ${enabledState || 'unknown'}）${why ? `：${why}` : ''}。服务器重启后需要手动执行 systemctl start ${serviceName}`;
      }

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
    if (s.bindPort) { ports.push({ port: s.bindPort, proto: 'tcp', label: 'bindPort' }); ports.push({ port: s.bindPort, proto: 'udp', label: 'bindPort' }); }
    if (s.webPort && s.webPort !== s.bindPort) ports.push({ port: s.webPort, proto: 'tcp', label: 'Dashboard' });
    if (s.vhostHTTPPort) ports.push({ port: s.vhostHTTPPort, proto: 'tcp', label: 'vhostHTTPPort' });
    if (s.vhostHTTPSPort) ports.push({ port: s.vhostHTTPSPort, proto: 'tcp', label: 'vhostHTTPSPort' });
    return ports;
  }

  // 解析 `ss -lntp` / `netstat -ltnp`，取每条监听端口的进程名。
  parseListeners(text) {
    const listeners = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const match = /:(\d{1,5})\s+\S+\s+users:\(\(\"?([^"\),\s]+)/.exec(line);
      if (match) listeners.push({ port: Number(match[1]), process: match[2] });
    }
    return listeners;
  }

  // 检查新配置要监听的 TCP 端口是否已被非 frps 进程占用。
  async portConflicts(ports) {
    const tcpPorts = (ports || []).filter((p) => p.proto === 'tcp');
    if (!tcpPorts.length) return [];
    const result = await this.exec('ss -lntp 2>/dev/null || netstat -ltnp 2>/dev/null', 12000);
    const listeners = this.parseListeners(result.stdout || '');
    const conflicts = [];
    for (const { port, label } of tcpPorts) {
      if (!port) continue;
      const hit = listeners.find((l) => l.port === port && l.process && !/^frps/i.test(l.process));
      if (hit) conflicts.push(`${label}（${port}）已被 ${hit.process} 占用`);
    }
    return conflicts;
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
    const conflicts = await this.portConflicts(ports);
    if (conflicts.length) {
      return { ok: false, error: `配置端口与现有服务冲突，frps 会启动失败：${conflicts.join('；')}。请改用空闲端口，或先停掉占用进程。`, conflicts };
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

module.exports = { ServerSession, parseServiceUnits, rankServiceUnits };
