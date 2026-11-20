'use strict';
/* 管理 API 的设置入口：端口 / 用户名 / 口令在界面里能改，
 * 改完必须落进 frpc.toml 的 [webServer]，否则控制台问新端口、frpc 还听旧的。 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'admin-api',
  title: '设置页能改管理 API 端口/用户名/口令，并同步写进 frpc.toml',
  needs: ['app'],
  async run(ctx) {
    /* 独立实例：启动前把配置摆成「口令还是 admin」的老形态 */
    const inst = await ctx.startApp({
      cdpOffset: 3,
      seed: (dir) => {
        /* 助手把数据放在 <dir>/frp-console-data 下，且「文件已存在就不覆盖」，
         * 所以这里必须直接写进那个目录，才能让实例以老形态启动。 */
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const cfg = path.join(ud, 'frpc.toml');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify(
            {
              version: 2,
              frpcPath: path.join(dir, 'frpc.exe'),
              configPath: cfg,
              logPath: path.join(ud, 'frpc.log'),
              runMode: 'managed',
              adminPort: 7480,
              adminUser: 'admin',
              adminPassword: 'admin',
              pollIntervalMs: 3000,
            },
            null,
            2,
          ),
          'utf8',
        );
        fs.writeFileSync(
          cfg,
          [
            'serverAddr = ""',
            'serverPort = 7000',
            'webServer.addr = "127.0.0.1"',
            'webServer.port = 7480',
            'webServer.user = "admin"',
            'webServer.password = "admin"',
            '',
          ].join('\n'),
          'utf8',
        );
      },
    });
    try {
      const ui = await inst.eval(`(async () => {
        for (let i = 0; i < 40 && !document.querySelector('.nav-item[data-view="settings"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
        document.querySelector('.nav-item[data-view="settings"]').click();
        await new Promise((r) => setTimeout(r, 500));
        const form = document.getElementById('form-behavior');
        const note = document.getElementById('adminpass-note');
        return {
          hasPort: !!form.querySelector('[name="adminPort"]'),
          hasUser: !!form.querySelector('[name="adminUser"]'),
          hasPass: !!form.querySelector('[name="adminPassword"]'),
          hasGen: [...form.querySelectorAll('button')].some((b) => b.dataset.act === 'settings.gen.adminpass'),
          port: form.querySelector('[name="adminPort"]').value,
          note: note ? note.textContent.trim() : '',
        };
      })()`);
      ctx.check('设置页有管理端口/用户名/口令三个输入', ui.hasPort && ui.hasUser && ui.hasPass, JSON.stringify(ui));
      ctx.check('端口预填当前值 7480', String(ui.port) === '7480', ui.port);
      ctx.check('有「随机生成」按钮', ui.hasGen === true);
      ctx.check('口令还是 admin 时给出红字提示', /默认值 admin/.test(ui.note), ui.note.slice(0, 60));

      const gen = await inst.eval(`(async () => {
        [...document.querySelectorAll('button')].find((b) => b.dataset.act === 'settings.gen.adminpass').click();
        await new Promise((r) => setTimeout(r, 150));
        const input = document.getElementById('in-adminpass');
        const note = document.getElementById('adminpass-note');
        const out = { len: input.value.length, cleared: !note || note.textContent.trim() === '', want: input.value };
        [...document.querySelectorAll('button')].find((b) => b.dataset.act === 'settings.save.behavior').click();
        await new Promise((r) => setTimeout(r, 2600));
        return out;
      })()`);
      ctx.check('随机口令是 20 位', gen.len === 20, String(gen.len));
      ctx.check('生成后弱口令提示就地消失', gen.cleared === true);

      /* 配置本身还不可用（starter 的 serverAddr 为空）时：设置要保存成功，
       * 但要如实告诉用户「没写进 frpc.toml」，而不是报一个跟口令无关的错。 */
      const partial = await inst.eval(`(async () => { const r = await FRP.refresh(); return { password: r.data.settings.adminPassword, configPath: r.data.paths.configPath }; })()`);
      const tomlNow = fs.readFileSync(partial.configPath, 'utf8');
      ctx.check('配置还不可用时，口令没被写进 frpc.toml（且没有把设置回滚）', !tomlNow.includes(partial.password), 'webServer.password=' + ((tomlNow.match(/webServer\.password\s*=\s*"([^"]*)"/) || [])[1]));

      /* 把服务器地址补上（配置变成合法），再保存一次 → 这次必须写进 frpc.toml */
      await inst.eval(`(async () => { await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'x' } }); return 1; })()`);
      await inst.eval(`(async () => { [...document.querySelectorAll('button')].find((b) => b.dataset.act === 'settings.save.behavior').click(); await new Promise((r) => setTimeout(r, 2200)); return 1; })()`);

      const after = await inst.eval(`(async () => { const r = await FRP.refresh(); return { password: r.data.settings.adminPassword, user: r.data.settings.adminUser, port: r.data.settings.adminPort, configPath: r.data.paths.configPath }; })()`);
      ctx.check('保存后 settings 里是新口令', after.password === gen.want, String(after.password));

      const tomlBody = fs.readFileSync(after.configPath, 'utf8');
      const pick = (key) => (tomlBody.match(new RegExp(`${key}\\s*=\\s*"?([^"\\n]*)`)) || [])[1];
      ctx.check('frpc.toml 的 webServer.password 同步', pick('webServer.password') === after.password, pick('webServer.password'));
      ctx.check('frpc.toml 的 webServer.port 同步', Number(pick('webServer.port')) === Number(after.port), pick('webServer.port'));
      ctx.check('frpc.toml 的 webServer.user 同步', pick('webServer.user') === after.user, pick('webServer.user'));

      const bad = await inst.eval(`(async () => {
        const input = document.querySelector('[name="adminPort"]');
        input.value = '99';
        [...document.querySelectorAll('button')].find((b) => b.dataset.act === 'settings.save.behavior').click();
        await new Promise((r) => setTimeout(r, 1400));
        const r = await FRP.refresh();
        return { port: r.data.settings.adminPort };
      })()`);
      ctx.check('管理端口填 99 被拦下（仍是原值）', Number(bad.port) !== 99, `port=${bad.port}`);
    } finally {
      await inst.stop();
    }
  },
};
