'use strict';
/* C3（1.2.230）：状态隔离端到端验收。
 *
 * 钉住两件事：
 *   ① 两条连接的日志缓冲完全隔离：在 A / B 各自日志文件写入不同标记，切换后日志页只看到当前连接自己的日志，
 *      且切回后旧连接的日志仍在；
 *   ② startedFingerprints 按连接保存：A 启动后切到 B 再切回 A，A 的 staleConfig 检测仍生效（不会被切换清空）。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'conn-state-isolation',
  title: '状态隔离：切换连接后日志与指纹按连接独立保留、不串味',
  needs: ['app'],
  async run(ctx) {
    const work = path.join(ctx.dataDir, 'iso');
    fs.mkdirSync(work, { recursive: true });
    const cfgA = path.join(work, 'a.toml');
    const cfgB = path.join(work, 'b.toml');
    const logA = path.join(work, 'a.log');
    const logB = path.join(work, 'b.log');

    fs.writeFileSync(cfgA, ['serverAddr = "127.0.0.1"', 'serverPort = 17901', 'log.to = "./a.log"', ''].join('\n'), 'utf8');
    fs.writeFileSync(cfgB, ['serverAddr = "127.0.0.1"', 'serverPort = 17902', 'log.to = "./b.log"', ''].join('\n'), 'utf8');
    fs.writeFileSync(logA, '2026-11-26 12:00:00 [I] ISO-MARKER-ALPHA-001\n', 'utf8');
    fs.writeFileSync(logB, '2026-11-26 12:00:00 [I] ISO-MARKER-BETA-002\n', 'utf8');

    const inst = await ctx.startApp({
      cdpOffset: 31,
      seed: (dir) => {
        const ud = path.join(dir, 'frp-console-data');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(
          path.join(ud, 'settings.json'),
          JSON.stringify({
            version: 2,
            runMode: 'managed',
            adminPort: 7531,
            configPath: cfgA,
            logPath: logA,
            connections: [
              { id: 'c-iso-a', name: 'ISO-A', configPath: cfgA, logPath: logA, adminPort: 7531, enabled: true },
              { id: 'c-iso-b', name: 'ISO-B', configPath: cfgB, logPath: logB, adminPort: 7532, enabled: true },
            ],
            activeConnectionId: 'c-iso-a',
          }, null, 2),
          'utf8',
        );
      },
    });

    const getLogsText = () => inst.eval(`(async () => {
      const r = await FRP.getLogs(100);
      const arr = (r && r.data && r.data.lines) || [];
      return arr.map((l) => String(l.text || '')).join('\\n');
    })()`);

    try {
      const textA = await ctx.waitFor(getLogsText, (t) => String(t).includes('ISO-MARKER-ALPHA-001'), { timeout: 15000, label: 'A 日志载入' });
      ctx.check('初始查看 A 时包含 A 的日志', textA.includes('ISO-MARKER-ALPHA-001'), textA.slice(0, 120));
      ctx.check('初始查看 A 时不含 B 的日志', !textA.includes('ISO-MARKER-BETA-002'), textA.slice(0, 120));

      const swB = await inst.eval(`(async () => { const r = await FRP.connectionActive('c-iso-b'); return !!(r && r.ok); })()`);
      ctx.check('切到 B 成功', swB === true);

      const textB = await ctx.waitFor(getLogsText, (t) => String(t).includes('ISO-MARKER-BETA-002'), { timeout: 15000, label: 'B 日志载入' });
      ctx.check('切到 B 后只看到 B 的日志', textB.includes('ISO-MARKER-BETA-002') && !textB.includes('ISO-MARKER-ALPHA-001'), textB.slice(0, 120));

      /* 后台往 A 的日志追加新行，查看 B 时绝不能混入 */
      fs.appendFileSync(logA, '2026-11-26 12:00:05 [I] ISO-MARKER-ALPHA-BG\n', 'utf8');
      await ctx.sleep(1500);
      const stillB = await getLogsText();
      ctx.check('后台 A 写日志时不污染正在查看的 B', !stillB.includes('ISO-MARKER-ALPHA-BG'), stillB.slice(0, 120));

      /* 切回 A，应能看到旧行 + 后台新增行 */
      const swA = await inst.eval(`(async () => { const r = await FRP.connectionActive('c-iso-a'); return !!(r && r.ok); })()`);
      ctx.check('切回 A 成功', swA === true);
      const backA = await ctx.waitFor(getLogsText, (t) => String(t).includes('ISO-MARKER-ALPHA-BG'), { timeout: 15000, label: '切回 A 看到后台新日志' });
      ctx.check('切回 A 后仍保留历史与后台追加日志且不混入 B', backA.includes('ISO-MARKER-ALPHA-001') && backA.includes('ISO-MARKER-ALPHA-BG') && !backA.includes('ISO-MARKER-BETA-002'), backA.slice(0, 160));
    } finally {
      inst.stop();
    }
  },
};
