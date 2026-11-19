'use strict';
/* 外部改配置自动热重载（设置里的「自动热重载」默认开）：
 * 用户用别的编辑器改了 frpc.toml，界面应该在几秒内跟上，而不是等重启。 */
module.exports = {
  id: 'external-reload',
  title: '外部改 frpc.toml 会自动重载',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor } = ctx;
    const fs = require('node:fs');
    const path = require('node:path');

    const paths = await ctx.eval(`(async () => { const r = await FRP.refresh(); return r.data.paths; })()`);
    check('拿到 configPath', !!paths.configPath, JSON.stringify(paths).slice(0, 160));

    const original = fs.readFileSync(paths.configPath, 'utf8');
    try {
      const addition = [
        '',
        '[[proxies]]',
        'name = "external-added"',
        'type = "tcp"',
        'localIP = "127.0.0.1"',
        `localPort = ${ctx.local.port}`,
        'remotePort = 24380',
        '',
      ].join('\n');
      fs.writeFileSync(paths.configPath, `${original}${addition}`, 'utf8');

      const seen = await waitFor(
        () => ctx.eval(`(async () => { const r = await FRP.refresh(); return (r.data.proxies || []).map((p) => p.name); })()`),
        (names) => Array.isArray(names) && names.includes('external-added'),
        { timeout: 25000, label: '界面跟上了外部修改' },
      );
      check('外部新增的代理出现在界面', seen.includes('external-added'), seen.join(','));
    } finally {
      fs.writeFileSync(paths.configPath, original, 'utf8');
    }

    const gone = await waitFor(
      () => ctx.eval(`(async () => { const r = await FRP.refresh(); return (r.data.proxies || []).map((p) => p.name); })()`),
      (names) => Array.isArray(names) && !names.includes('external-added'),
      { timeout: 25000, label: '界面跟上了外部还原' },
    );
    check('还原后代理消失', !gone.includes('external-added'), gone.join(','));
  },
};
