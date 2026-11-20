'use strict';
/* 配置文件里没有 webServer 段时（用户手写、从别处拷来的 frpc.toml、或老工具生成的），
 * frpc 会用默认的 127.0.0.1:7400 + admin/admin；而控制台是按设置里的端口/口令去连。
 * 两者对不上就报「frpc 已启动但管理 API 不可用：管理 API 未启动」，隧道永远起不来，
 * 而用户从这句话里根本看不出「配置文件缺了一段」。
 *
 * 启动前必须先按**磁盘上的真实内容**对齐并补写 webServer —— 不能拿内存里的旧模型判断，
 * 否则「文件里没有、内存里有」的情况会被当成“已经配好了”，什么也不写。
 */
const fs = require('node:fs');

module.exports = {
  id: 'admin-sync',
  title: '配置文件缺少 webServer 段时，启动前自动补上并跑起来',
  needs: ['app', 'frps', 'frpc'],
  async run(ctx) {
    const { check } = ctx;
    /* 先确保实例真的指向本次 runner 起的 frps（单独跑这个场景时，配置里可能还是空的） */
    await ctx.eval(`(async () => { await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: '${ctx.frps.token}' } }); return 1; })()`);
    const info = await ctx.eval(`(async () => { const d = (await FRP.refresh()).data; return { cfg: d.paths.configPath, port: d.settings.adminPort, addr: d.config.serverAddr, sport: d.config.serverPort, token: (d.config.auth || {}).token || '' }; })()`);
    check('拿到配置路径与当前连接参数', !!(info.cfg && info.addr && info.sport), JSON.stringify({ ...info, token: info.token ? '***' : '' }));
    if (!info.cfg) return;

    const original = fs.readFileSync(info.cfg, 'utf8');
    try {
      /* 前面的场景可能留着正在跑的隧道；先停干净，否则 startTunnel 会看到
       * 一个「已经起着、但口令是旧的」frpc，直接报认证失败。 */
      await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`);
      await ctx.waitFor(
        () => ctx.eval(`(async () => { const d = (await FRP.refresh()).data; return d.runtime.mode; })()`),
        (m) => m === 'stopped' || m === 'external',
        { timeout: 20000, label: '旧隧道停干净' },
      );
      /* 手写一份「结构完全正确、但没有 webServer」的配置：
       * 全部用点号键，避免表头把后面的键吞掉。 */
      const minimal = [
        `serverAddr = "${info.addr}"`,
        `serverPort = ${info.sport}`,
        'loginFailExit = false',
        '',
        'auth.method = "token"',
        `auth.token = "${info.token}"`,
        '',
        'log.to = "./frpc.log"',
        'log.level = "info"',
        '',
      ].join('\n');
      check('手写的配置里没有 webServer', !/webServer/i.test(minimal), '');
      fs.writeFileSync(info.cfg, minimal, 'utf8');

      const started = await ctx.eval(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: String(r.error || '').slice(0, 160) }; })()`);
      check('启动隧道成功（不再报「管理 API 未启动 / 认证失败」）', started.ok === true, JSON.stringify(started));

      const dumpOnFail = async () => {
        const file = fs.readFileSync(info.cfg, 'utf8');
        const d = await ctx.eval('(async () => { const x = (await FRP.refresh()).data; return { mode: x.runtime.mode, apiError: String(x.runtime.apiError || ""), port: x.settings.adminPort, pwLen: String(x.settings.adminPassword || "").length }; })()').catch(() => ({}));
        console.log('    [调试] 运行态：', JSON.stringify(d));
        console.log('    [调试] 配置全文：\n' + file);
      };
      const st = await ctx.waitFor(
        () => ctx.eval(`(async () => { const d = (await FRP.refresh()).data; return { mode: d.runtime.mode, apiError: String(d.runtime.apiError || '') }; })()`),
        (v) => v && v.mode === 'managed',
        { timeout: 25000, label: '隧道进入 managed' },
      ).catch(async (e) => { await dumpOnFail(); throw e; });
      check('隧道真的跑起来了', !!(st && st.mode === 'managed' && !st.apiError), JSON.stringify(st));

      const after = fs.readFileSync(info.cfg, 'utf8');
      const nowPort = await ctx.eval('(async () => { const x = (await FRP.refresh()).data; return x.settings.adminPort; })()');
      check('配置里被补回了 webServer，且端口与设置一致', /webServer/i.test(after) && after.includes(String(nowPort)), `adminPort=${nowPort}（启动前 ${info.port}，端口被占时会自动换）`);
      check('补写没有冲掉原有的连接参数', after.includes(info.addr) && after.includes(String(info.sport)), '');
    } finally {
      await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`).catch(() => {});
      fs.writeFileSync(info.cfg, original, 'utf8');
    }
  },
};
