'use strict';
/* 44-huge-log：日志里出现超长单行（frpc 打整份 JSON/证书时才这样）必须被截断，
 * 否则它会整行穿过 IPC 进到日志页 DOM（修复前实测：单行 204831 字符 → DOM 204860 字符）。 */
const fs = require('node:fs');

module.exports = {
  id: 'huge-log',
  title: '超长日志行会被截断，不会整行灌进界面',
  needs: ['app'],
  async run(ctx) {
    const { check, sleep } = ctx;

    await ctx.waitUi('.nav-item[data-view="logs"]', '导航渲染完成');
    const paths = await ctx.eval(`(async () => { const r = await FRP.refresh(); const d = r.data || r; return { logPath: (d.paths && d.paths.logPath) || '' }; })()`);
    check('拿到日志路径', !!paths.logPath, paths.logPath);
    if (!paths.logPath) return;

    /* 先打开日志页量一次基线：全量跑时日志里已经有前序场景产生的行，
     * 所以只能比「追加这一行前后的增量」，不能用一个固定阈值。 */
    const before = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="logs"]').click();
      await new Promise((r) => setTimeout(r, 1200));
      const el = document.querySelector('#log-body');
      return { len: el ? el.textContent.length : 0 };
    })()`);

    const huge = 'X'.repeat(200 * 1024);
    fs.appendFileSync(paths.logPath, `2026-11-21 01:00:00 [I] [huge] ${huge}\n`, 'utf8');
    await sleep(3000);

    const got = await ctx.eval(`(async () => {
      const r = await FRP.getLogs(600);
      const lines = (r.data && (r.data.lines || r.data)) || [];
      const arr = Array.isArray(lines) ? lines : [];
      const lens = arr.map((l) => String(typeof l === 'string' ? l : l.text || '').length);
      return { ok: !!r.ok, count: arr.length, max: Math.max(0, ...lens) };
    })()`);
    check('IPC 返回的单行被截断到 4000 字符以内', got.ok && got.max > 0 && got.max < 4000, JSON.stringify(got));

    await ctx.eval(`(async () => { const el = document.querySelector('#log-body'); if (el) el.scrollTop = el.scrollHeight; return 1; })()`);
    await sleep(800);
    const after = await ctx.eval(`(async () => { const el = document.querySelector('#log-body'); return { len: el ? el.textContent.length : 0 }; })()`);
    const delta = (after.len || 0) - (before.len || 0);
    check('这一行给界面带来的增量很小（没有被整行灌进来）', delta >= 0 && delta < 12000, `基线 ${before.len} → ${after.len}，增量 ${delta}`);
  },
};
