'use strict';
/* 多连接阶段 5：界面入口。
 *
 * 钉住：
 *   ① 单连接用户看不到切换器（hidden），界面与以前一致；
 *   ② 多出一条后，侧栏出现切换器（选项带名字）、概览出现「隧道连接」卡片、代理页表格有「服务器」列（1.2.190 起是全量视图，不再只列当前连接）；
 *   ③ 「＋」弹的是自绘输入框（Electron 没有 window.prompt），输入并确认后连接真的建出来；
 *   ④ 切当前连接后，下拉与「当前」标记跟着变（状态里必须带 activeConnectionId）。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '57-connection-ui',
  title: '多连接：界面入口（切换器 / 概览连接卡 / 代理页提示）',
  needs: ['app'],
  async run(ctx) {
    const { check, sleep } = ctx;
    const inst = await ctx.startApp();
    check('实例启动', !!inst && inst.ready === true);
    if (!inst || !inst.ready) return;
    const ev = inst.eval;
    try {
      /* waitReady 只看 CDP 端口通不通，页面可能还在解析 index.html：先等静态节点出现 */
      await ev(`(async () => {
        for (let i = 0; i < 60; i += 1) {
          if (document.getElementById('conn-switch')) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      })()`);

      const single = await ev(`(() => {
        const box = document.getElementById('conn-switch');
        return { present: !!box, hidden: box ? box.hidden : null };
      })()`);
      check('单连接时切换器不可见', single.present === true && single.hidden === true, JSON.stringify(single));

      const added = await ev(`(async () => {
        const r = await FRP.connectionAdd({ name: '第二台' });
        return { ok: r.ok, err: r.error || '' };
      })()`);
      check('新增连接成功', added.ok === true, added.err);
      await sleep(1200);

      const multi = await ev(`(() => {
        const box = document.getElementById('conn-switch');
        const sel = document.getElementById('conn-select');
        const rows = [...document.querySelectorAll('.conn-row')];
        const titles = [...document.querySelectorAll('.section-title')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim());
        return {
          hidden: box ? box.hidden : null,
          options: sel ? [...sel.options].map((o) => o.textContent) : [],
          rows: rows.length,
          agg: titles.find((t) => t.includes('隧道连接')) || '',
        };
      })()`);
      check('切换器出现且列出两条', multi.hidden === false && multi.options.length === 2, JSON.stringify(multi.options));
      check('概览出现「隧道连接」卡片', multi.rows === 2 && /隧道连接/.test(multi.agg), multi.agg);

      /* 非当前连接也必须能直接启动：否则「一个客户端同时连两台 frps」在界面上无路可走
       * （切换会把所有在跑的隧道停掉）。 */
      const otherRow = await ev(`(() => {
        const row = [...document.querySelectorAll('.conn-row')].find((r) => !r.classList.contains('active'));
        if (!row) return { missing: true };
        const acts = [...row.querySelectorAll('button')].map((b) => ({ act: b.dataset.act, label: (b.textContent || '').trim(), id: b.dataset.id }));
        return { acts };
      })()`);
      check(
        '非当前连接可以直接启动（conn.toggle）',
        !!otherRow && Array.isArray(otherRow.acts) && otherRow.acts.some((a) => a.act === 'conn.toggle' && a.id),
        JSON.stringify(otherRow).slice(0, 200),
      );
      check(
        '同时仍能「切到它」（切换是独立动作）',
        !!otherRow && Array.isArray(otherRow.acts) && otherRow.acts.some((a) => a.act === 'conn.switch'),
        JSON.stringify(otherRow).slice(0, 200),
      );

      const proxies = await ev(`(async () => {
        document.querySelector('.nav-item[data-view="proxies"]').click();
        await new Promise((r) => setTimeout(r, 600));
        const h1 = (document.querySelector('#view h1') || {}).textContent || '';
        const stale = [...document.querySelectorAll('.note')].some((n) => n.textContent.includes('另有') && n.textContent.includes('条连接'));
        return { h1, stale };
      })()`);
      check('代理页能正常渲染（全量视图）', /代理映射/.test(proxies.h1), JSON.stringify(proxies));
      check('旧的「只列当前连接」提示已移除', proxies.stale === false, JSON.stringify(proxies));

      /* 「＋」→ 自绘输入框 → 创建第三条 */
      const viaDialog = await ev(`(async () => {
        document.querySelector('.nav-item[data-view="overview"]').click();
        await new Promise((r) => setTimeout(r, 400));
        const btn = document.querySelector('#conn-switch [data-act="conn.add"]');
        if (!btn) return { missing: true };
        btn.click();
        await new Promise((r) => setTimeout(r, 400));
        const input = document.getElementById('pd-input');
        const title = (document.querySelector('.modal h3') || {}).textContent || '';
        if (input) { input.value = '第三台'; }
        const ok = document.getElementById('pd-ok');
        if (ok) ok.click();
        await new Promise((r) => setTimeout(r, 1500));
        const list = (await FRP.connections()).data;
        return { title, names: list.connections.map((c) => c.name) };
      })()`);
      check('「＋」弹出自绘输入框', /再连一台/.test(viaDialog.title || ''), viaDialog.title);
      check('通过界面创建出第三条连接', (viaDialog.names || []).includes('第三台'), JSON.stringify(viaDialog.names));

      /* 切当前连接：下拉与「当前」标记都要跟上（靠状态里的 activeConnectionId） */
      const switched = await ev(`(async () => {
        const list = (await FRP.connections()).data;
        const target = list.connections.find((c) => c.name === '第二台');
        const r = await FRP.connectionActive(target.id);
        let sel = document.getElementById('conn-select');
        for (let i = 0; i < 20; i += 1) {
          await new Promise((res) => setTimeout(res, 400));
          sel = document.getElementById('conn-select');
          if (sel && sel.value === target.id) break;
        }
        const rows = [...document.querySelectorAll('.conn-row')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim());
        /* 「设为当前」按钮文字里也有「当前」，先排除掉，只找真正被标成当前的那一行 */
        return { ok: r.ok, selected: sel ? sel.value : '', expect: target.id, activeRow: rows.filter((t) => !t.includes('设为当前')).find((t) => t.includes('当前')) || '' };
      })()`);
      check('切换后下拉选中新连接', switched.ok === true && switched.selected === switched.expect, JSON.stringify(switched.selected));
      check('切换后概览「当前」标记跟着走', /第二台/.test(switched.activeRow || ''), switched.activeRow);
    } finally {
      try { await inst.stop(); } catch { /* ignore */ }
    }
  },
};
