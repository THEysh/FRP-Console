'use strict';
/* 边界输入：两条容易被「静默处理」的规则
 *   ① 访问路径超过 200 字符 —— 以前会悄悄截断，存下来的路径和用户填的不一样
 *   ② 公网端口 < 1024（特权端口）—— 以前一个字都不提示，配完只会 start error */
module.exports = {
  id: 'input-limits',
  title: '超长访问路径会被拒绝而不是悄悄截断；特权端口会给警告',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;
    /* 先给一份合法配置：否则任何保存都会先被「服务器地址不能为空」拦住 */
    const cfg = await ctx.eval(`FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: 17000, auth: { method: 'token', token: 'e2e-token-1234567890' }, log: { to: './frpc.log', level: 'info' } })`);
    check('基础配置写入成功', cfg.ok === true, cfg.error || '');

    const longPath = '/' + 'a'.repeat(2000);

    const tooLong = await ctx.eval(`FRP.saveProxy('add', '', { name: 'limit-path', type: 'tcp', localIP: '127.0.0.1', localPort: 18090, remotePort: 24120, openPath: ${JSON.stringify(longPath)} })`);
    check('超长访问路径被拒绝', tooLong.ok === false, JSON.stringify(tooLong));
    check('错误里写明上限', /200/.test(String(tooLong.error || '')) && /太长/.test(String(tooLong.error || '')), String(tooLong.error || ''));

    const okPath = await ctx.eval(`FRP.saveProxy('add', '', { name: 'limit-ok', type: 'tcp', localIP: '127.0.0.1', localPort: 18090, remotePort: 24121, openPath: '/panel/' })`);
    check('正常路径照常保存', okPath.ok === true, okPath.error || '');

    const priv = await ctx.eval(`FRP.saveProxy('add', '', { name: 'limit-priv', type: 'tcp', localIP: '127.0.0.1', localPort: 18090, remotePort: 80 })`);
    const warns = (priv.data && priv.data.warnings) || [];
    check('特权端口能保存但带警告', priv.ok === true && warns.some((w) => /特权端口/.test(w)), JSON.stringify(warns));

    await ctx.eval(`(async () => { await FRP.deleteProxy('limit-ok').catch(() => {}); await FRP.deleteProxy('limit-priv').catch(() => {}); return 1; })()`);
    const left = await ctx.eval(`(async () => { const r = await FRP.refresh(); return r.data.proxies.filter((p) => /^limit-/.test(p.name)).length; })()`);
    check('收尾把测试代理清干净', left === 0, `left=${left}`);
  },
};
