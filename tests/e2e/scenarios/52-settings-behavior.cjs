'use strict';
/* 本机写不进开机启动项（注册表 ACL / 安全软件 / 组策略都可能拦）时，
 * 「保存行为设置」不能整次失败 —— 否则用户改的轮询间隔、自动重载全被丢掉，
 * 界面按磁盘重绘，看起来就是「所有设置都恢复默认」。 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'settings-behavior',
  title: '行为设置里有一项写不进系统时，其它字段仍然保存成功',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 7,
      seed: (dir) => {
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
              adminPort: 7482,
              adminUser: 'admin',
              adminPassword: 'admin',
              pollIntervalMs: 3000,
              autoReload: true,
            },
            null,
            2,
          ),
          'utf8',
        );
        fs.writeFileSync(cfg, ['serverAddr = ""', 'serverPort = 7000', ''].join('\n'), 'utf8');
      },
    });

    try {
      /* 1) 同时改三项：开机自启（本沙箱必然写不进）+ 两个普通字段 */
      const saved = await inst.eval(`(async () => {
        const r = await FRP.saveSettings({ launchAtLogin: true, pollIntervalMs: 6500, autoReload: false });
        const warn = (r.data && r.data.warnings) || [];
        return { ok: !!r.ok, error: String(r.error || ''), warnings: warn, firstWarning: warn[0] || '' };
      })()`);
      ctx.check('保存整体成功（不被开机自启拖垮）', saved.ok === true, String(saved.error || '').slice(0, 160));

      /* 2) 普通字段确实落了盘（不是只改了内存） */
      const state = await inst.eval(`(async () => {
        const r = await FRP.refresh();
        const s = (r.data && r.data.settings) || {};
        return { poll: s.pollIntervalMs, autoReload: s.autoReload };
      })()`);
      ctx.check('轮询间隔已生效', Number(state.poll) === 6500, `poll=${state.poll}`);
      ctx.check('自动重载已生效', state.autoReload === false, `autoReload=${state.autoReload}`);

      /* 3) 失败原因讲人话（不能是 CLIXML 乱码） */
      if (saved.warnings.length > 0) {
        ctx.check('失败原因可读（没有 XML 转义）', !/_x000D_|&lt;|<Objs/.test(saved.firstWarning), String(saved.firstWarning).slice(0, 160));
      }

      /* 4) 重复保存仍成功（第二次不应因为「值没变」而报错） */
      const again = await inst.eval(`(async () => {
        const r = await FRP.saveSettings({ launchAtLogin: true, pollIntervalMs: 6500, autoReload: false });
        return { ok: !!r.ok, error: String(r.error || '') };
      })()`);
      ctx.check('重复保存仍成功', again.ok === true, String(again.error || '').slice(0, 120));

      /* 5) 界面切走再切回，值不退回默认 */
      const ui = await inst.eval(`(async () => {
        for (let i = 0; i < 40 && !document.querySelector('.nav-item[data-view="settings"]'); i += 1) await new Promise((r) => setTimeout(r, 250));
        document.querySelector('.nav-item[data-view="settings"]').click();
        await new Promise((r) => setTimeout(r, 800));
        document.querySelector('.nav-item[data-view="overview"]').click();
        await new Promise((r) => setTimeout(r, 400));
        document.querySelector('.nav-item[data-view="settings"]').click();
        await new Promise((r) => setTimeout(r, 800));
        const f = document.querySelector('#form-behavior');
        const sw = document.querySelector('.switch[data-field="autoReload"]');
        return { poll: f ? f.querySelector('[name="pollIntervalMs"]').value : null, autoReload: sw ? sw.classList.contains('on') : null };
      })()`);
      ctx.check('切视图后设置不退回默认', String(ui.poll) === '6500' && ui.autoReload === false, JSON.stringify(ui));

      /* 6) 设置页有「打开启动文件夹」出口 */
      const exit = await inst.eval(`(async () => {
        const btn = document.querySelector('[data-act="settings.openstartup"]');
        return { has: !!btn, label: btn ? btn.textContent.replace(/\\s+/g, ' ').trim() : '' };
      })()`);
      ctx.check('提供「打开启动文件夹」出口', exit.has === true, exit.label);
    } finally {
      await inst.eval(`(async () => { await FRP.saveSettings({ launchAtLogin: false, pollIntervalMs: 3000, autoReload: true }); return 1; })()`).catch(() => {});
      inst.stop();
    }
  },
};
