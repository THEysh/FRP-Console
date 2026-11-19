'use strict';
/* 代理类型：udp / http / https / stcp 各自的必填项、写进 frpc.toml 的字段、
 * 以及「缺必填项」时能不能被挡住。stcp 不需要公网端口，只能被 visitor 访问。 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'proxy-types',
  title: '代理类型：udp/http/https/stcp 的校验与落盘',
  needs: ['app', 'local', 'frps'],
  async run(ctx) {
    const { check } = ctx;
    const seed = require('../helpers/seed.cjs');
    const seeded = await seed.ensureConfig(ctx);
    check('隧道目标指向测试 frps', seeded.ok, seeded.err || '');

    const configPath = path.join(ctx.dataDir, 'frp-console-data', 'frpc.toml');
    const readConfig = () => fs.readFileSync(configPath, 'utf8');
    const name = (n) => `t-${n}-${process.pid}`;

    /* 1) udp：必须有公网端口，落盘时带 remotePort。 */
    const udp = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: '${name('udp')}', type: 'udp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: 24501 });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('udp 代理保存成功', udp.ok, udp.err);

    const udpNoPort = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: '${name('udp-noport')}', type: 'udp', localIP: '127.0.0.1', localPort: ${ctx.local.port} });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('udp 缺公网端口被拒', udpNoPort.ok === false && /端口/.test(udpNoPort.err || ''), udpNoPort.err);

    /* 2) http：必须给域名（customDomains），落盘时是数组。 */
    const http = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: '${name('http')}', type: 'http', localIP: '127.0.0.1', localPort: ${ctx.local.port}, customDomains: ['e2e-http.local'] });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('http 代理保存成功', http.ok, http.err);

    const httpNoDomain = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: '${name('http-nodomain')}', type: 'http', localIP: '127.0.0.1', localPort: ${ctx.local.port} });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('http 缺域名被拒', httpNoDomain.ok === false, httpNoDomain.err);

    /* 3) https：同 http，但走 vhost 的 443 侧。 */
    const https = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: '${name('https')}', type: 'https', localIP: '127.0.0.1', localPort: ${ctx.local.port}, customDomains: ['e2e-https.local'] });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('https 代理保存成功', https.ok, https.err);

    /* 4) stcp：不需要公网端口，靠 secretKey 配对 visitor。 */
    const stcp = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: '${name('stcp')}', type: 'stcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, secretKey: 'e2e-sk-123456' });
      return { ok: !!(res && res.ok), err: (res && res.error) || '', warnings: (res && res.data && res.data.warnings) || [] };
    })()`);
    check('stcp 代理保存成功（无需公网端口）', stcp.ok, stcp.err);

    /* 落盘检查：字段必须真的写进 frpc.toml。 */
    const text = readConfig();
    check('udp 段存在且带 remotePort', new RegExp(`name = "${name('udp')}"`).test(text) && /remotePort = 24501/.test(text), '');
    check('udp 段类型正确', /type = "udp"/.test(text));
    check('http 段带域名列表', text.includes('e2e-http.local'));
    check('https 段带域名列表', text.includes('e2e-https.local'));
    check('stcp 段写出 secretKey', /secretKey = "e2e-sk-123456"/.test(text));
    check('stcp 段没有 remotePort', !new RegExp(`name = "${name('stcp')}"[\\s\\S]{0,200}remotePort`).test(text));

    /* 运行态：四条都出现在 state.proxies 里，且 stcp 不会被算成「公网不可达」。 */
    const state = await ctx.eval(`(async () => {
      const st = await FRP.refresh();
      const want = ['${name('udp')}', '${name('http')}', '${name('https')}', '${name('stcp')}'];
      const rows = (st.data.proxies || []).filter((p) => want.includes(p.name)).map((p) => ({ name: p.name, type: p.type, publicAddress: p.publicAddress, status: p.status }));
      return { count: rows.length, rows };
    })()`);
    check('四条代理都进入状态列表', state.count === 4, JSON.stringify(state.rows).slice(0, 300));
    const stcpRow = (state.rows || []).find((r) => r.name === name('stcp')) || {};
    check('stcp 没有公网地址', !stcpRow.publicAddress, String(stcpRow.publicAddress));

    /* 清理。 */
    const removed = await ctx.eval(`(async () => {
      const want = ['${name('udp')}', '${name('http')}', '${name('https')}', '${name('stcp')}'];
      let ok = 0;
      for (const n of want) { const r = await FRP.deleteProxy(n); if (r && r.ok) ok += 1; }
      return { ok };
    })()`);
    check('清理四条测试代理', removed.ok === 4, String(removed.ok));

    const left = readConfig();
    check('清理后 frpc.toml 不再含测试代理', !left.includes(name('udp')) && !left.includes(name('stcp')));
  },
};
