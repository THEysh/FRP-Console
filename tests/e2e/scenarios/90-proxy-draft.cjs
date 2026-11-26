'use strict';
/* 1.2.216：代理表单点「去签发」再回来，填的东西要还在。
 *
 * 1.2.205 加了「缺证书 → 去签发」的直达按钮，但点它会把整个表单关掉；
 * 签完证书回到「新增代理」，名称/类型/域名/插件全要重敲。
 * 这一版把表单存成内存草稿（S.proxyDraft），下次打开新增代理自动填回并提示一句。 */
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'proxy-draft',
  title: '代理表单：去签发证书后回来，填过的内容还在',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({
      cdpOffset: 13,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        const cfg = path.join(ud, 'frpc.toml');
        fs.writeFileSync(cfg, 'serverAddr = ""\nserverPort = 7000\n', 'utf8');
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify({ version: 2, frpcPath: path.join(dir, 'frpc.exe'), configPath: cfg }, null, 2),
          'utf8',
        );
      },
    });
    const ev = (expr) => inst.eval(expr);
    const click = (sel) => ev(`(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
    const setVal = (sel, value) =>
      ev(`(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing';
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok'; })()`);

    try {
      await ctx.waitFor(
        () => ev(`!!document.querySelector('.nav-item[data-view="proxies"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await click('.nav-item[data-view="proxies"]');
      await ctx.waitFor(
        () => ev(`!!document.querySelector('[data-act="proxy.add"]')`),
        (v) => v === true,
        { timeout: 15000, label: '代理页就绪' },
      );
      await click('[data-act="proxy.add"]');
      await ctx.waitFor(
        () => ev(`!!document.querySelector('#pf-name')`),
        (v) => v === true,
        { timeout: 15000, label: '表单打开' },
      );

      await setVal('#pf-name', 'draft-web');
      await click('#pf-types [data-type="http"]');
      await setVal('#pf-domains', 'draft-1216.example.com');
      await click('#pf-plugin-types [data-plugin="https2http"]');
      await setVal('#pf-localport', '18080');

      await ctx.waitFor(
        () => ev(`document.querySelectorAll('[data-act="cert.goto.issue"]').length`),
        (v) => Number(v) > 0,
        { timeout: 15000, label: '出现「去签发」按钮' },
      );
      await click('[data-act="cert.goto.issue"]');

      await ctx.waitFor(
        () => ev(`(document.querySelector('.page-title h1') || {}).textContent || ''`),
        (v) => String(v).includes('证书'),
        { timeout: 15000, label: '跳到证书页' },
      );
      ctx.check('点「去签发」后跳到证书页', true, 'HTTPS 证书');

      await click('.nav-item[data-view="proxies"]');
      await ctx.waitFor(
        () => ev(`!!document.querySelector('[data-act="proxy.add"]')`),
        (v) => v === true,
        { timeout: 15000, label: '回到代理页' },
      );
      await click('[data-act="proxy.add"]');
      await ctx.waitFor(
        () => ev(`!!document.querySelector('#pf-name')`),
        (v) => v === true,
        { timeout: 15000, label: '再次打开表单' },
      );

      const state = JSON.parse(
        await ev(`(function(){
          const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
          const ap = document.querySelector('#pf-plugin-types [data-plugin].active');
          return JSON.stringify({
            name: v('pf-name'),
            type: v('pf-type'),
            domains: v('pf-domains'),
            localPort: v('pf-localport'),
            plugin: ap ? ap.dataset.plugin : '',
            note: !!document.getElementById('pf-draft-note'),
          });
        })()`),
      );

      ctx.check('名称已恢复', state.name === 'draft-web', String(state.name));
      ctx.check('类型已恢复为 https（选了 https2http 插件后会被强制成 https）', state.type === 'https', String(state.type));
      ctx.check('自定义域名已恢复', state.domains === 'draft-1216.example.com', String(state.domains));
      ctx.check('本地端口已恢复', state.localPort === '18080', String(state.localPort));
      ctx.check('插件类型已恢复为 https2http', state.plugin === 'https2http', String(state.plugin));
      ctx.check('弹窗里有「已恢复」提示', state.note === true, String(state.note));
    } finally {
      inst.stop();
    }
  },
};
