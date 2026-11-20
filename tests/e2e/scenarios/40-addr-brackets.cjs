'use strict';
/* 边界输入：serverAddr 写成 [::1]（把 IPv6 当 URL 主机那样加方括号）。
 * frpc 会把它拼成 [[::1]]:7000 → dial tcp: missing port in address，隧道永远连不上，
 * 而界面上只会看到「连不到服务器端口」。1.2.143 起读盘时剥掉括号并把文件写回去。 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'addr-brackets',
  title: '服务器地址写成 [::1] 时自动纠正并写回配置',
  async run(ctx) {
    const own = await ctx.startApp({
      seed: (dir) => {
        const userData = path.join(dir, 'frp-console-data');
        fs.mkdirSync(userData, { recursive: true });
        const configPath = path.join(userData, 'frpc.toml');
        fs.writeFileSync(
          configPath,
          [
            'serverAddr = "[::1]"',
            'serverPort = 7000',
            'auth.method = "token"',
            'auth.token = "bracket-token-1234567890"',
            '',
          ].join('\n'),
          'utf8',
        );
        fs.writeFileSync(
          path.join(userData, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              frpcPath: path.join(dir, 'frpc.exe'),
              configPath,
              logPath: path.join(userData, 'frpc.log'),
              runMode: 'managed',
              adminPort: 7414,
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    });

    try {
      const state = await own.eval(`(async () => { const r = await FRP.refresh(); return { addr: (r.data.config || {}).serverAddr, errs: (r.data.validation && r.data.validation.errors || []).map(e => e.message) }; })()`);
      ctx.check('模型里的地址去掉了方括号', state.addr === '::1', JSON.stringify(state));
      ctx.check('没有任何校验错误', (state.errs || []).length === 0, JSON.stringify(state.errs));

      const onDisk = fs.readFileSync(path.join(own.dir, 'frp-console-data', 'frpc.toml'), 'utf8');
      ctx.check('配置文件也被改回裸地址', /^serverAddr = "::1"$/m.test(onDisk), onDisk.split('\n').slice(0, 3).join(' | '));
      ctx.check('文件里不再出现方括号写法', !/\[::1\]/.test(onDisk), 'has-brackets');
    } finally {
      await own.stop();
    }
  },
};
