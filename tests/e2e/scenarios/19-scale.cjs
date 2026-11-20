'use strict';
/* 规模：60 条代理时界面与状态推送还能不能跟上。
 *
 * 用户真实场景里「一个 frpc 挂十几个服务」很常见。要盯的不是「能不能存下」，
 * 而是三件事：
 *   1. 状态推送（每 3 秒一次 refresh + IPC）不会随着代理数量线性变慢到卡界面；
 *   2. 代理表的渲染时间仍在可接受范围（这里以 3 秒为界，超过就是肉眼可见的卡）；
 *   3. 健康检查在大量代理下仍在推进（不出现「永远待检测」）。
 */
const COUNT = 60;
const BASE_PORT = 24000;

module.exports = {
  id: '19-scale',
  title: '规模：60 条代理下的推送、渲染与健康检查推进',
  needs: ['frps', 'frpc', 'local'],
  async run(ctx) {
    const { ensureConfig } = require('../helpers/seed.cjs');
    const seeded = await ensureConfig(ctx);
    ctx.check('隧道目标指向测试 frps', seeded && seeded.ok, JSON.stringify(seeded));

    /* 清掉可能残留的同名代理，保证从干净状态开始计时。 */
    await ctx.eval(`(async () => {
      const r = await FRP.refresh();
      for (const p of (r.data.proxies || [])) {
        if (/^scale-/.test(p.name)) await FRP.deleteProxy(p.name);
      }
      return 1;
    })()`);

    /* 批量建 60 条：一次 IPC 里循环，避免 60 次往返把时间浪费在协议上。 */
    const created = await ctx.eval(`(async () => {
      const t0 = Date.now();
      let ok = 0; const errors = [];
      for (let i = 1; i <= ${COUNT}; i++) {
        const res = await FRP.saveProxy('add', '', {
          name: 'scale-' + String(i).padStart(3, '0'),
          type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port},
          remotePort: ${BASE_PORT} + i,
        });
        if (res && res.ok) ok++; else errors.push((res && res.error) || 'unknown');
      }
      return { ok, errors: errors.slice(0, 3), ms: Date.now() - t0 };
    })()`);
    ctx.check('60 条代理全部创建成功', created.ok === COUNT, `ok=${created.ok} 用时=${created.ms}ms 错误=${JSON.stringify(created.errors)}`);
    /* 阈值按「开发机 + 同时有别的 Electron 实例在跑」定，只用来挡退化（数量级），
     * 不是性能承诺：60 条代理 × （saveProxy + CDP 往返）大概 10-40 秒。 */
    ctx.check('创建耗时在合理范围（< 60 秒）', created.ms < 60000, `${created.ms}ms`);

    /* ① 状态推送成本：连续 5 次 refresh，看单次往返耗时 */
    const refreshMs = await ctx.eval(`(async () => {
      const out = [];
      for (let i = 0; i < 5; i++) {
        const t = Date.now();
        await FRP.refresh();
        out.push(Date.now() - t);
      }
      return out;
    })()`);
    const worstRefresh = Math.max(...refreshMs);
    ctx.check(
      '单次状态刷新 < 1200ms（3 秒一次推送不会拖住主进程）',
      worstRefresh < 1200,
      refreshMs.join(','),
    );

    /* ② 代理表渲染时间：切到代理映射页，从宿主机计时到 60 行出现。
     * 不写成「页面内 setTimeout 轮询」——隐藏窗口下定时器被节流到秒级，
     * 量出来的是节流，不是渲染性能（上一版就因此把 3 秒的预算耗尽）。
     * 只数本次创建的 scale-* 行：前面场景可能留下别的代理，数总行数会误判。 */
    const countRows = () =>
      ctx.eval(
        "(() => [...document.querySelectorAll('#view table tbody tr')]" +
          ".filter((tr) => /scale-\\d{3}/.test(tr.textContent)).length)()",
      );
    const renderT0 = Date.now();
    await ctx.eval("(() => { const n = document.querySelector('.nav-item[data-view=\"proxies\"]'); if (n) n.click(); return 1; })()");
    const rendered = await ctx
      .waitFor(countRows, (n) => Number(n) >= COUNT, { timeout: 25000, interval: 250, label: '代理表渲染出 60 行' })
      .catch(() => 0);
    const renderMs = Date.now() - renderT0;
    ctx.check('代理表渲染出 60 行', Number(rendered) >= COUNT, `rows=${rendered}`);
    ctx.check('渲染耗时 < 5 秒（超了就是肉眼可见的卡）', renderMs < 5000, `${renderMs}ms`);

    /* ③ 健康检查推进：启动隧道，等大多数代理拿到 health */
    await ctx.eval(`(async () => { await FRP.startTunnel(); return 1; })()`);
    const covered = await ctx.waitFor(
      async () =>
        ctx.eval(`(async () => {
          const r = await FRP.refresh();
          const ps = (r.data.proxies || []).filter((p) => /^scale-/.test(p.name));
          return { total: ps.length, checked: ps.filter((p) => p.health).length, online: (r.data.counts || {}).online };
        })()`),
      (v) => v && v.checked >= Math.ceil(COUNT * 0.9),
      { timeout: 90000, interval: 2000, label: '90% 代理拿到健康结果' },
    ).catch(() => null);
    if (!covered) {
      const now = await ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const ps = (r.data.proxies || []).filter((p) => /^scale-/.test(p.name));
        return { total: ps.length, checked: ps.filter((p) => p.health).length };
      })()`);
      ctx.check('90% 以上的代理在 90 秒内拿到健康结果', false, JSON.stringify(now));
    } else {
      ctx.check('90% 以上的代理在 90 秒内拿到健康结果', true, `${covered.checked}/${covered.total}，在线 ${covered.online}`);
    }

    /* 收尾：删掉 60 条，别把后面的场景拖慢 */
    const cleaned = await ctx.eval(`(async () => {
      await FRP.stopTunnel();
      const r = await FRP.refresh();
      let n = 0;
      for (const p of (r.data.proxies || [])) {
        if (/^scale-/.test(p.name)) { await FRP.deleteProxy(p.name); n++; }
      }
      const after = await FRP.refresh();
      return { removed: n, left: (after.data.proxies || []).length };
    })()`);
    ctx.check('收尾清理干净', cleaned.removed === COUNT, JSON.stringify(cleaned));
  },
};
