'use strict';
/* 多连接的「生命周期边界」：加满上限、改名、把配置路径指到文件夹、
 * 删掉一条正在跑的连接（必须先停）、不能删当前连接、每条连接的日志路径互不相同。 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

module.exports = {
  id: 'multi-lifecycle',
  title: '多连接：数量上限、改名、坏路径、删除在跑的连接',
  needs: ['app'],
  async run(ctx) {
    const inst = await ctx.startApp({ cdpOffset: 11 });
    try {
      const list = () => inst.eval(`(async () => { const r = await FRP.connections(); const d = r.data || r; return d.connections || d || []; })()`);

      const base = await list();
      ctx.check('起步至少有 1 条连接', Array.isArray(base) && base.length >= 1, `len=${(base || []).length}`);

      /* 1) 一直加到被拒，确认上限是 8 且错误可读 */
      const addUntilFail = await inst.eval(`(async () => {
        const added = [];
        let last = null;
        for (let i = 0; i < 12; i += 1) {
          const r = await FRP.connectionAdd({ name: 'edge-' + i });
          if (r && r.ok) added.push(i); else { last = { i, error: (r && r.error) || '' }; break; }
        }
        const all = await FRP.connections();
        const arr = (all.data && all.data.connections) || all.data || [];
        return { addedCount: added.length, failed: last, total: arr.length };
      })()`);
      ctx.check('加满后拒绝第 9 条', addUntilFail.failed !== null, JSON.stringify(addUntilFail.failed || {}));
      ctx.check('连接总数不超过 8', Number(addUntilFail.total) <= 8, `total=${addUntilFail.total}`);
      ctx.check('上限错误有中文说明', /最多|上限|8/.test((addUntilFail.failed || {}).error || ''), (addUntilFail.failed || {}).error);

      const all = await list();
      const ids = (all || []).map((c) => c.id);
      const logs = (all || []).map((c) => c.logPath);
      ctx.check('每条连接都有自己的日志路径', logs.every((p) => typeof p === 'string' && p.length > 0), JSON.stringify(logs));
      ctx.check('每条连接的日志路径互不相同', new Set(logs).size === logs.length, JSON.stringify(logs));

      /* 2) 改名 */
      const target = (all || []).find((c) => /edge-0/.test(c.name || '')) || (all || [])[1] || (all || [])[0];
      const renamed = await inst.eval(`(async () => { const r = await FRP.connectionUpdate({ id: ${JSON.stringify(target.id)}, name: 'edge-renamed' }); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('可以给连接改名', renamed.ok === true, JSON.stringify(renamed));
      const afterRename = (await list()).find((c) => c.id === target.id) || {};
      ctx.check('改名后列表里是新名字', afterRename.name === 'edge-renamed', afterRename.name);

      /* 3) 配置路径指到文件夹必须被拒 */
      const badPath = await inst.eval(`(async () => {
        const dir = ${JSON.stringify(path.join(ROOT, '.e2e-tmp'))};
        const r = await FRP.connectionUpdate({ id: ${JSON.stringify(target.id)}, configPath: dir });
        return { ok: !!(r && r.ok), err: (r && r.error) || '' };
      })()`);
      ctx.check('配置路径是文件夹时被拒绝', badPath.ok === false, JSON.stringify(badPath));
      const afterBad = (await list()).find((c) => c.id === target.id) || {};
      ctx.check('被拒后原配置路径没被改掉', afterBad.configPath === target.configPath, `${afterBad.configPath}`);

      /* 4) 删掉一条「正在跑」的连接：必须先停再删，删完列表里没有它 */
      const other = (await list()).find((c) => c.id !== target.id && /edge-/.test(c.name || ''));
      if (other) {
        const started = await inst.eval(`(async () => { const r = await FRP.connectionStart(${JSON.stringify(other.id)}); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
        ctx.check('可以启动一条非当前连接', started.ok === true, JSON.stringify(started));
        const removed = await inst.eval(`(async () => { const r = await FRP.connectionRemove(${JSON.stringify(other.id)}); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
        ctx.check('可以删掉一条正在跑的连接', removed.ok === true, JSON.stringify(removed));
        const gone = (await list()).every((c) => c.id !== other.id);
        ctx.check('删除后列表里没有它', gone === true, gone);
      } else {
        ctx.check('找到可删除的临时连接', false, 'no candidate');
      }

      /* 5) 当前连接不能删 */
      const activeId = (await inst.eval(`(async () => { const r = await FRP.refresh(); const d = r.data || r; return d.activeConnectionId || ''; })()`)) || '';
      const delActive = await inst.eval(`(async () => { const r = await FRP.connectionRemove(${JSON.stringify(activeId)}); return { ok: !!(r && r.ok), err: (r && r.error) || '' }; })()`);
      ctx.check('不能删当前连接', delActive.ok === false, JSON.stringify(delActive));
      ctx.check('拒绝原因说明「当前」', /当前/.test(delActive.err), delActive.err);

      /* 6) 收尾：把临时连接全部删掉（停掉再删），别给后续场景留垃圾 */
      const cleanup = await inst.eval(`(async () => {
        const all = await FRP.connections();
        const arr = (all.data && all.data.connections) || all.data || [];
        let removed = 0;
        for (const c of arr) {
          if (!/edge-/.test(c.name || '')) continue;
          try { await FRP.connectionStop(c.id); } catch (e) {}
          const r = await FRP.connectionRemove(c.id);
          if (r && r.ok) removed += 1;
        }
        const left = await FRP.connections();
        const rest = (left.data && left.data.connections) || left.data || [];
        return { removed, left: rest.length };
      })()`);
      ctx.check('临时连接可以清理干净', cleanup.left <= 1, JSON.stringify(cleanup));
    } finally {
      inst.stop();
    }
  },
};
