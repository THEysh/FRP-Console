'use strict';
/* 81 首次启动：引导要看得见、主按钮要指对地方。
 *
 * 背景（1.2.201 巡检，用全新数据目录截图 + 量 DOM 坐标）：
 *  ① 「欢迎！三步把你的服务放到公网」引导卡确实渲染了，但它被塞在右下角那一列，
 *     实测 top = 1002px —— 900px 高的窗口里根本看不见，新用户只看到「隧道未运行」；
 *  ② 还没配服务器时，hero 的主按钮仍是「启动隧道」，点下去必然报「服务器地址不能为空」。
 *
 * 这个场景用独立实例（自己的数据目录 + starter 配置）复现首跑状态，验证：
 *  - 引导卡在首屏可见（top < 视口高度）；
 *  - hero 主按钮是「连接服务器」（跳服务器页），且没有「启动隧道」按钮；
 *  - 「公网地址」空态里有「新建一条代理」入口。 */
const fs = require('node:fs');
const path = require('node:path');

function seedFirstRun(dir) {
  const ud = path.join(dir, 'frp-console-data');
  fs.mkdirSync(ud, { recursive: true });
  const cfg = path.join(ud, 'frpc.toml');
  fs.writeFileSync(
    cfg,
    ['serverAddr = ""', 'serverPort = 7000', '', '[log]', 'to = "./frpc.log"', 'level = "info"', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ud, 'settings.json'),
    JSON.stringify(
      {
        version: 2,
        frpcPath: path.join(require('../../e2e/helpers/app.cjs').ROOT, 'vendor', 'frpc', 'frpc.exe'),
        configPath: cfg,
        logPath: path.join(ud, 'frpc.log'),
        runMode: 'managed',
        adminPort: 7463,
        adminUser: 'admin',
        adminPassword: 'firstrun-e2e-pass-1234',
        starterConfigCreated: true,
      },
      null,
      2,
    ),
    'utf8',
  );
}

module.exports = {
  id: 'firstrun',
  title: '首次启动：引导首屏可见 + 主按钮指向「连接服务器」',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ seed: seedFirstRun, cdpOffset: 2 });
    try {
      if (!inst.ready) throw new Error(`独立实例没起来：${inst.log().slice(-400)}`);
      await ctx.waitFor(
        async () => (await inst.eval('!!document.querySelector(".nav-item[data-view=\\"overview\\"]")')),
        (v) => v === true,
        { timeout: 30000, label: '界面就绪' },
      );
      await ctx.sleep(1200);

      const view = JSON.parse(await inst.eval(`(function(){
        const el = document.querySelector('.welcome-guide');
        const hero = document.querySelector('.hero');
        const btns = hero ? [...hero.querySelectorAll('button')].map(b => ({ act: b.dataset.act || '', view: b.dataset.view || '', text: b.textContent.trim() })) : [];
        const empty = document.querySelector('.empty-hint');
        return JSON.stringify({
          hasGuide: !!el,
          guideTop: el ? Math.round(el.getBoundingClientRect().top) : -1,
          vh: window.innerHeight,
          heroBtns: btns,
          emptyHint: empty ? empty.textContent.replace(/\\s+/g, ' ').trim() : '',
          serverAddr: (window.__lastState && '') || '',
        });
      })()`));

      ctx.check('首跑能看到「欢迎！三步」引导卡', view.hasGuide === true, JSON.stringify(view).slice(0, 200));
      ctx.check(
        '引导卡在首屏可见（不用滚动就能看到）',
        view.hasGuide && view.guideTop >= 0 && view.guideTop < view.vh,
        `top=${view.guideTop} 视口高=${view.vh}`,
      );

      const primary = (view.heroBtns || []).find((b) => b.text === '连接服务器');
      ctx.check('未配置服务器时 hero 主按钮是「连接服务器」', !!primary, JSON.stringify(view.heroBtns));
      ctx.check('这个按钮跳到服务器页', !!primary && primary.view === 'server', JSON.stringify(primary));
      ctx.check(
        '未配置服务器时不摆「启动隧道」（点了只会报地址为空）',
        !(view.heroBtns || []).some((b) => b.act === 'tunnel.start'),
        JSON.stringify(view.heroBtns),
      );

      ctx.check('「公网地址」空态给出新建代理入口', /新建一条代理/.test(view.emptyHint), view.emptyHint.slice(0, 80));
    } finally {
      try { inst.stop(); } catch { /* 忽略 */ }
    }
  },
};
