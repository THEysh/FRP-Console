'use strict';
/* 设置页「可执行文件与路径」在多连接时要标出这些文件属于哪条连接（1.2.222）。
 * 以前 frpc.toml 指向某条连接的 a.toml，卡片里没有任何提示，容易被当成全局配置。 */
const fs = require('fs');
const path = require('path');

function seedConn(dir, names) {
  const ud = path.join(dir, 'frp-console-data');
  fs.mkdirSync(ud, { recursive: true });
  const conns = names.map((name, i) => {
    const cfg = path.join(ud, `${name}.toml`);
    fs.writeFileSync(cfg, `serverAddr = ""\nserverPort = 7000\n# ${name}\n`, 'utf8');
    return { id: `c-${name}`, name, configPath: cfg, adminPort: 7490 + i, host: '127.0.0.1', port: 22, username: 'root' };
  });
  fs.writeFileSync(
    path.join(ud, 'settings.json'),
    JSON.stringify(
      { version: 2, frpcPath: path.join(dir, 'frpc.exe'), configPath: conns[0].configPath, connections: conns, activeConnectionId: conns[0].id },
      null,
      2,
    ),
    'utf8',
  );
}

module.exports = {
  id: 'settings-conn',
  title: '设置页路径卡：多连接时标出文件属于哪条连接',
  needs: ['app'],
  async run(ctx) {
    const readCard = (inst) =>
      inst.eval(`(function(){
        const card = [...document.querySelectorAll('section.card')].find((s) => /可执行文件与路径/.test(s.textContent));
        if (!card) return JSON.stringify({ missing: true });
        const sub = (card.querySelector('.section-title span') || {}).textContent || '';
        const rows = [...card.querySelectorAll('.path-row')].map((r) => ({
          label: (r.querySelector('.p-label') || {}).textContent || '',
          tags: [...r.querySelectorAll('.tag')].map((t) => t.textContent.trim()),
        }));
        return JSON.stringify({ sub: sub.trim(), rows });
      })()`);

    /* ① 两条连接：卡片要说明「当前连接」，并给 frpc.toml / 日志文件挂连接名 */
    const multi = await ctx.startApp({ cdpOffset: 16, seed: (dir) => seedConn(dir, ['日本', '广州']) });
    try {
      await ctx.waitFor(
        () => multi.eval(`!!document.querySelector('.nav-item[data-view="settings"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪' },
      );
      await multi.eval(`(function(){ document.querySelector('.nav-item[data-view="settings"]').click(); return true; })()`);
      await ctx.waitFor(
        () => multi.eval(`!!document.querySelector('section.card')`),
        (v) => v === true,
        { timeout: 20000, label: '设置页渲染' },
      );

      const m = JSON.parse(await readCard(multi));
      ctx.check('设置页找到路径卡', !m.missing, JSON.stringify(m.missing || false));
      ctx.check('副标题说明「当前连接」', /当前连接「日本」/.test(m.sub), m.sub);
      const toml = (m.rows || []).find((r) => r.label === 'frpc.toml') || { tags: [] };
      const log = (m.rows || []).find((r) => r.label === '日志文件') || { tags: [] };
      ctx.check('frpc.toml 行有连接名徽标', toml.tags.includes('日本'), JSON.stringify(toml.tags));
      ctx.check('日志文件行有连接名徽标', log.tags.includes('日本'), JSON.stringify(log.tags));
    } finally {
      multi.stop();
    }

    /* ② 单连接：界面保持原样，不出现「当前连接」这种说法 */
    const single = await ctx.startApp({ cdpOffset: 17 });
    try {
      await ctx.waitFor(
        () => single.eval(`!!document.querySelector('.nav-item[data-view="settings"]')`),
        (v) => v === true,
        { timeout: 30000, label: '侧栏就绪（单连接）' },
      );
      await single.eval(`(function(){ document.querySelector('.nav-item[data-view="settings"]').click(); return true; })()`);
      await ctx.waitFor(
        () => single.eval(`!!document.querySelector('section.card')`),
        (v) => v === true,
        { timeout: 20000, label: '设置页渲染（单连接）' },
      );

      const s = JSON.parse(await readCard(single));
      ctx.check('单连接副标题不提「当前连接」', !/当前连接/.test(s.sub), s.sub);
      const toml = (s.rows || []).find((r) => r.label === 'frpc.toml') || { tags: [] };
      ctx.check('单连接 frpc.toml 行只有状态徽标', toml.tags.length === 1, JSON.stringify(toml.tags));
    } finally {
      single.stop();
    }
  },
};
