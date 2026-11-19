'use strict';
/* 设置项的边界值：
 *  - 可收敛的（轮询间隔、日志缓冲、运行模式）必须在落盘前夹到合法范围；
 *  - 不可收敛的（管理 API 端口写成 70000）必须**整次拒绝**并给出中文原因，
 *    而不是悄悄改成一个别的端口——端口是用户要写进 frpc.toml 的事实。
 * 1.2.3 的报告里 `pollIntervalMs: 0` 被原样存下来（真值判断漏了 0），
 * 主进程于是按 0 毫秒轮询，这里把边界固定住。 */
module.exports = {
  id: 'settings-bounds',
  title: '设置边界值收敛 / 非法值整次拒绝',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;

    const clamped = await ctx.eval(`(async () => {
      const res = await FRP.saveSettings({ pollIntervalMs: 0, logBuffer: 99999, runMode: 'bogus', stripProxyEnv: false });
      const st = await FRP.refresh();
      const s = st.data.settings;
      return { ok: !!(res && res.ok), err: (res && res.error) || '', poll: s.pollIntervalMs, logBuffer: s.logBuffer, runMode: s.runMode, strip: s.stripProxyEnv };
    })()`);
    check('可收敛字段保存成功', clamped.ok, clamped.err);
    check('pollIntervalMs=0 被抬到下限', Number(clamped.poll) >= 1000, `poll=${clamped.poll}`);
    check('logBuffer 超上限被收敛', Number(clamped.logBuffer) <= 2000, `logBuffer=${clamped.logBuffer}`);
    check('非法 runMode 回落 auto', clamped.runMode === 'auto', clamped.runMode);
    check('布尔项正常写入', clamped.strip === false, String(clamped.strip));

    const rejected = await ctx.eval(`(async () => {
      const before = (await FRP.refresh()).data.settings.adminPort;
      const res = await FRP.saveSettings({ adminPort: 70000 });
      const after = (await FRP.refresh()).data.settings.adminPort;
      return { ok: !!(res && res.ok), err: (res && res.error) || '', before, after };
    })()`);
    check('非法管理端口被拒绝', rejected.ok === false, `ok=${rejected.ok}`);
    check('拒绝时给出中文原因', /端口|65535/.test(rejected.err || ''), rejected.err);
    check('拒绝后原有端口没被改掉', Number(rejected.before) === Number(rejected.after), `${rejected.before} → ${rejected.after}`);

    const restored = await ctx.eval(`(async () => {
      const res = await FRP.saveSettings({ pollIntervalMs: 3000, logBuffer: 600, runMode: 'auto', stripProxyEnv: true });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('恢复默认设置', restored.ok, restored.err);
  },
};
