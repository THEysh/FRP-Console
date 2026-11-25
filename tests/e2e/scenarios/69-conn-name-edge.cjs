'use strict';
/* 连接名与配置路径的边界输入：
 * 名字允许中文/emoji/长名字，但不能重名（大小写不敏感）；配置路径允许中文和空格目录。 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'conn-name-edge',
  title: '连接名与配置路径的边界输入',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 23 });
    try {
      const add = (name) => inst.eval(`(async () => { const r = await FRP.connectionAdd({ name: ${JSON.stringify(name)} }); return { ok: !!(r && r.ok), err: (r && r.error) || '', id: r && r.data && r.data.connection && r.data.connection.id }; })()`);
      const list = () => inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; return (d.connections || d || []).map((c) => ({ name: c.name, configPath: c.configPath })); })()`);

      /* 1) 中文 + emoji + 空格 */
      const cn = await add('测试 连接 🚀');
      ctx.check('可以创建中文/emoji/带空格的连接名', cn.ok === true, JSON.stringify(cn));
      const hasCn = (await list()).some((c) => c.name === '测试 连接 🚀');
      ctx.check('列表里能读到这个中文名', hasCn === true, 'missing');

      /* 2) 重名（大小写不同也算重名） */
      const dup1 = await add('测试 连接 🚀');
      ctx.check('完全同名被拒', dup1.ok === false, JSON.stringify(dup1));
      const mixed = await add('测试 连接 🚀'.toUpperCase());
      ctx.check('大小写不同也算重名', mixed.ok === false, JSON.stringify(mixed));

      /* 3) 空名字 / 纯空格 */
      const empty = await add('');
      ctx.check('空名字被拒', empty.ok === false, JSON.stringify(empty));
      const blank = await add('   ');
      ctx.check('纯空格名字被拒', blank.ok === false, JSON.stringify(blank));

      /* 4) 很长的名字：要么接受并完整保存，要么明确拒绝，不能静默截断 */
      const longName = `长名字-${'x'.repeat(120)}`;
      const long = await add(longName);
      if (long.ok) {
        const got = (await list()).find((c) => c.name.startsWith('长名字-')) || {};
        ctx.check('超长名字没有被静默截断', got.name === longName, `${String(got.name).length} 字符`);
      } else {
        ctx.check('超长名字被明确拒绝（可接受）', /长|字符|限制/.test(long.err), long.err);
      }

      /* 5) 配置路径放在中文 + 空格 + 括号的目录里 */
      const oddDir = path.join(inst.dir, '中文 目录 (conn)');
      fs.mkdirSync(oddDir, { recursive: true });
      const oddCfg = path.join(oddDir, 'frpc.toml');
      fs.writeFileSync(oddCfg, ['serverAddr = "127.0.0.1"', 'serverPort = 1', ''].join('\n'), 'utf8');
      const moved = await inst.eval(`(async () => { const r = await FRP.connectionUpdate({ id: ${JSON.stringify(cn.id)}, configPath: ${JSON.stringify(oddCfg)} }); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('配置路径可以是中文/空格/括号目录', moved.ok === true, JSON.stringify(moved));
      const after = (await list()).find((c) => c.name === '测试 连接 🚀') || {};
      ctx.check('路径确实存成了那份中文路径', String(after.configPath || '') === oddCfg, after.configPath);

      /* 6) 收尾：删掉临时连接 */
      await inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; const arr = d.connections || d || []; for (const c of arr) { if (!/默认|default/i.test(c.name) && c.id !== (d.activeConnectionId || '')) { try { await FRP.connectionRemove(c.id); } catch (e) {} } } return 1; })()`);
    } finally {
      inst.stop();
    }
  },
};
