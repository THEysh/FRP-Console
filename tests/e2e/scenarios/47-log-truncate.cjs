'use strict';
/* 破坏与恢复：日志文件被「截断」（Windows 上最常见的轮转方式）后，跟随要回到开头继续读。 */
const fs = require('node:fs');

module.exports = {
  id: 'log-truncate',
  title: '日志文件被截断后仍能继续跟随新内容',
  needs: ['app'],
  async run(ctx) {
    const { check, sleep, eval: ev } = ctx;
    await ev(`(async () => { const st = await FRP.refresh(); return 1; })()`);
    const paths = await ev(`(async () => { const st = await FRP.refresh(); const d = st.data || st; return d.paths; })()`);
    const log = paths.logPath;
    check('拿到日志文件路径', !!log, String(log));

    const mark = `probe-${Date.now().toString(36)}`;
    const text = () => ev(`(async () => { const res = await FRP.getLogs(400); const lines = (res.data && res.data.lines) || []; return lines.map((l) => l.text || '').join('\\n'); })()`);

    const backup = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    try {
      fs.appendFileSync(log, `2026-11-21 03:00:00.000 [I] [${mark}] append-before-truncate\n`);
      await sleep(2500);
      const first = String(await text());
      check('追加的行能被读到', first.includes(`${mark}] append-before-truncate`), first.split('\n').filter(Boolean).slice(-1)[0]);

      /* 截断（清空同一个文件）：跟随器必须把偏移量归零，否则读到的是 0 字节之后的位置 */
      fs.writeFileSync(log, `2026-11-21 03:01:00.000 [W] [${mark}] after-truncate\n`, 'utf8');
      await sleep(3000);
      const second = String(await text());
      check('截断后新内容能读到（偏移量回到 0）', second.includes(`${mark}] after-truncate`), second.split('\n').filter(Boolean).slice(-1)[0]);
    } finally {
      fs.writeFileSync(log, backup, 'utf8');
      await sleep(1200);
    }
  },
};
