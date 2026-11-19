'use strict';
/* 「访问路径」与「路径 404」（v1.2.71）：
 * 隧道通但根路径 404 时，必须说成「路径 404」而不是「公网不可达」，
 * 并且复制/打开的链接要带上用户填的路径。 */
module.exports = {
  id: 'open-path',
  title: '访问路径：404 单独成档 + 链接带路径',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor } = ctx;
    const { ensureConfig } = require('../helpers/seed.cjs');
    const seeded = await ensureConfig(ctx);
    check('准备：隧道目标指向测试 frps', seeded.ok, seeded.err || '');

    const added = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-path', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: 24280, openPath: '/nope/' });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('新增带访问路径的代理', added.ok, added.err);

    const wrong = await waitFor(
      () => ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'e2e-path');
        return { health: p && p.health, openPath: p && p.openPath, openUrl: p && p.openUrl, counts: r.data.counts };
      })()`),
      (s) => s && s.health && s.health.ok === false,
      { timeout: 45000, label: '错误路径被判定为 404' },
    );
    check('判定失败而不是通过', wrong.health.ok === false, JSON.stringify(wrong.health && wrong.health.reason));
    check('原因是「路径 404」', /路径 404/.test(wrong.health.reason || ''), wrong.health.reason);
    check('带上 pathMissing 标记', wrong.health.pathMissing === true, JSON.stringify(wrong.health.pathMissing));
    check('openUrl 带上路径', /\/nope\/$/.test(wrong.openUrl || ''), wrong.openUrl);
    check('计入 counts.path404', Number(wrong.counts.path404) >= 1, `path404=${wrong.counts.path404}`);

    /* 改成真实存在的子路径：应该转绿，并且公网层记录 status=200。 */
    const fixed = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('edit', 'e2e-path', { name: 'e2e-path', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: 24280, openPath: '/panel/' });
      return { ok: !!(res && res.ok) };
    })()`);
    check('改成正确的访问路径', fixed.ok);

    const ok = await waitFor(
      () => ctx.eval(`(async () => {
        const r = await FRP.refresh();
        const p = (r.data.proxies || []).find((x) => x.name === 'e2e-path');
        return { ok: p && p.health ? p.health.ok : null, status: p && p.health && p.health.layers && p.health.layers.public ? p.health.layers.public.status : null, counts: r.data.counts };
      })()`),
      (s) => s && s.ok === true,
      { timeout: 45000, label: '正确路径恢复为通' },
    );
    check('正确路径判定为通', ok.ok === true, JSON.stringify(ok).slice(0, 200));
    check('公网层状态 200', Number(ok.status) === 200, `status=${ok.status}`);
    check('path404 计数回落', Number(ok.counts.path404) === 0, `path404=${ok.counts.path404}`);

    /* DOM：复制按钮带的是带路径的地址。 */
    await ctx.waitUi('.nav-item[data-view="server"]', '导航渲染完成');
    const dom = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="proxies"]').click();
      await new Promise((r) => setTimeout(r, 500));
      const row = [...document.querySelectorAll('tbody tr')].find((tr) => /e2e-path/.test(tr.textContent));
      if (!row) return { ok: false };
      const copy = row.querySelector('[data-act="copy"]');
      return { ok: !!copy, text: copy ? copy.dataset.text : '' };
    })()`);
    check('代理表复制按钮带上路径', dom.ok && /\/panel\/$/.test(dom.text || ''), dom.text);

    const cleaned = await ctx.eval(`(async () => { await FRP.deleteProxy('e2e-path'); return 1; })()`);
    check('清理测试代理', cleaned === 1);
  },
};
