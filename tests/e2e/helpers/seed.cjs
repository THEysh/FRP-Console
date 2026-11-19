'use strict';
/* 场景间共享的小工具：保证「隧道目标 = 测试用 frps」。
 *
 * 场景单独跑（--only=xxx）时没有前面的场景帮忙写配置，saveProxy 会被
 * 「服务器地址不能为空」挡住。这里按需补齐，不覆盖已有值。
 */
async function ensureConfig(ctx) {
  return ctx.eval(`(async () => {
    const r = await FRP.refresh();
    const cur = (r.data && r.data.config) || {};
    if (cur.serverAddr === '127.0.0.1' && Number(cur.serverPort) === ${ctx.frps.bindPort}) {
      return { ok: true, reused: true };
    }
    const res = await FRP.saveConfig({
      serverAddr: '127.0.0.1',
      serverPort: ${ctx.frps.bindPort},
      auth: { method: 'token', token: '${ctx.frps.token}' },
      log: { to: './frpc.log', level: 'info' },
    });
    return { ok: !!(res && res.ok), err: (res && res.error) || '' };
  })()`);
}

module.exports = { ensureConfig };
