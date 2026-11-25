'use strict';
/* 82 连接设置弹窗：SSH 地址要从这条连接的 frpc.toml 带出来。
 *
 * 背景（1.2.204 巡检）：服务器页连接卡已经显示「SSH root@154.36.178.154:22（来自配置文件）」，
 * 但点「编辑连接」打开弹窗，服务器 IP 那一格是空的 —— 用户会以为地址丢了、重新输一遍。
 *
 * 场景造一条「连接里没存 host、但 frpc.toml 里有 serverAddr」的老数据，断言：
 * 弹窗里 host 被预填成那个 serverAddr，并且给出「来自 frpc.toml」的说明。 */
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..', '..', '..');

function seedNoHost(dir) {
  const ud = path.join(dir, 'frp-console-data');
  fs.mkdirSync(ud, { recursive: true });
  const cfg = path.join(ud, 'conn.toml');
  fs.writeFileSync(
    cfg,
    ['serverAddr = "10.9.9.9"', 'serverPort = 17000', 'loginFailExit = false', '', '[auth]', 'method = "token"', 'token = "editor-token-123456"', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ud, 'settings.json'),
    JSON.stringify(
      {
        version: 2,
        frpcPath: path.join(APP_ROOT, 'vendor', 'frpc', 'frpc.exe'),
        configPath: cfg,
        logPath: path.join(ud, 'frpc.log'),
        runMode: 'managed',
        adminPort: 7465,
        adminUser: 'admin',
        adminPassword: 'editor-e2e-pass-1234',
        connections: [{ id: 'c-default', name: '只有配置的连接', enabled: true, configPath: cfg, adminPort: 7465, createdAt: Date.now() }],
        activeConnectionId: 'c-default',
      },
      null,
      2,
    ),
    'utf8',
  );
}

module.exports = {
  id: 'conn-editor',
  title: '连接设置弹窗：SSH 地址从 frpc.toml 预填',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ seed: seedNoHost, cdpOffset: 3 });
    try {
      if (!inst.ready) throw new Error(`独立实例没起来：${inst.log().slice(-300)}`);
      await ctx.waitFor(
        () => inst.eval('!!document.querySelector(".nav-item[data-view=\\"server\\"]")'),
        (v) => v === true,
        { timeout: 30000, label: '界面就绪' },
      );
      await inst.eval(`(async()=>{ document.querySelector('.nav-item[data-view="server"]').click(); await new Promise(r=>setTimeout(r,1200)); return 1; })()`);
      await ctx.sleep(500);
      const opened = await inst.eval(`(function(){
        const b = [...document.querySelectorAll('[data-act="conn.edit"]')].find(x => x.offsetParent);
        if (!b) return 'no edit button';
        b.click();
        return 'clicked';
      })()`);
      ctx.check('服务器页有「编辑连接」按钮', opened === 'clicked', String(opened));
      await ctx.sleep(700);

      const view = JSON.parse(await inst.eval(`(function(){
        const m = document.querySelector('.modal');
        if (!m) return JSON.stringify({ ok: false });
        const byName = (n) => { const el = m.querySelector('input[name="' + n + '"]'); return el ? el.value : null; };
        return JSON.stringify({ ok: true, host: byName('host'), port: byName('port'), username: byName('username'), text: m.innerText.replace(/\\s+/g, ' ') });
      })()`));

      ctx.check('弹窗打开了', view.ok === true, JSON.stringify(view).slice(0, 120));
      ctx.check('服务器 IP 被预填成 frpc.toml 里的 serverAddr', view.host === '10.9.9.9', `host=${JSON.stringify(view.host)}`);
      ctx.check('说明这个地址是从配置文件带出来的', /frpc\.toml/.test(view.text) && /带出来/.test(view.text), String(view.text).slice(0, 200));
    } finally {
      try { inst.stop(); } catch { /* ignore */ }
    }
  },
};
