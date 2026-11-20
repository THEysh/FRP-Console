'use strict';
/* 边界输入：外部把 frpc.toml 改坏（写进 frp 不认识的字段）。
 * 关键点：不能「悄悄把隧道弄停、界面什么都不说」，也不能让坏配置直接生效。 */
const fs = require('node:fs');

module.exports = {
  id: 'external-invalid',
  title: '外部改坏 frpc.toml 时报出真实原因且不影响在跑的隧道',
  needs: ['app', 'frps'],
  async run(ctx) {
    await ctx.eval(`(async () => {
      await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: ${JSON.stringify(ctx.frps.token)} } });
      return 1;
    })()`);
    const started = await ctx.eval(`(async () => { const r = await FRP.startTunnel(); return { ok: r.ok, err: String(r.error || '').slice(0, 120) }; })()`);
    ctx.check('隧道先起来', started.ok === true, `ok=${started.ok} ${started.err}`);

    const confPath = await ctx.eval(`(async () => { const r = await FRP.init(); return String(r.data.state.paths.configPath || ''); })()`);
    const original = fs.readFileSync(confPath, 'utf8');
    try {
      /* A) 合法但无害的外部改动：注释一行 —— 应当被正常接收 */
      fs.writeFileSync(confPath, original + '\n# external-touch\n', 'utf8');
      const afterOk = await ctx.waitFor(
        async () => ctx.eval(`(async () => { const r = await FRP.refresh(); return { verify: r.data.configVerifyError, mode: r.data.runtime.mode }; })()`),
        (v) => v && v.verify === null,
        { timeout: 20000, label: '合法改动被接收' },
      ).catch(() => null);
      ctx.check('合法改动不报错', !!afterOk, afterOk ? '' : '一直报错或超时');

      /* B) 坏字段：frpc 会 \`json: unknown field\` 拒绝整份配置 */
      fs.writeFileSync(confPath, original.replace(/^serverPort = \d+$/m, (m) => `${m}\nbogusTopLevel = "x"`), 'utf8');
      const bad = await ctx.waitFor(
        async () => ctx.eval(`(async () => { const r = await FRP.refresh(); return { verify: String(r.data.configVerifyError || ''), mode: r.data.runtime.mode, cfgErr: r.data.configError }; })()`),
        (v) => v && v.verify.length > 0,
        { timeout: 25000, label: '坏配置被发现' },
      );
      ctx.check('报出 frpc 的判断', /frpc 不认这份配置/.test(bad.verify), bad.verify);
      ctx.check('说出了具体字段', /unknown field/.test(bad.verify), bad.verify);
      ctx.check('隧道没被这份坏配置停掉', bad.mode === 'managed', String(bad.mode));

      /* C) 改回原样：错误要消失 */
      fs.writeFileSync(confPath, original, 'utf8');
      const cleared = await ctx.waitFor(
        async () => ctx.eval(`(async () => { const r = await FRP.refresh(); return { verify: r.data.configVerifyError, mode: r.data.runtime.mode }; })()`),
        (v) => v && v.verify === null,
        { timeout: 25000, label: '改回后错误清除' },
      );
      ctx.check('改回后错误自动消失', cleared.verify === null, String(cleared.verify));
      ctx.check('整个过程隧道仍在 managed', cleared.mode === 'managed', String(cleared.mode));
    } finally {
      fs.writeFileSync(confPath, original, 'utf8');
      await ctx.eval(`(async () => { await FRP.stopTunnel(); return 1; })()`).catch(() => {});
    }
  },
};
