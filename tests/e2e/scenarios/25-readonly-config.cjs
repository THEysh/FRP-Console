'use strict';
/* 边界输入：配置文件被设成只读（或被杀毒软件/同步盘占用）时，
 * 保存代理必须给出能行动的中文原因，而不是抛英文异常、也不能看起来保存成功。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = {
  id: 'readonly-config',
  title: '配置文件只读时保存代理给出明确原因',
  needs: ['app'],
  async run(ctx) {
    const dir = path.join(ctx.dataDir, 'ro-config');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'frpc-ro.toml');
    /* 先写一个合法的隧道目标，否则会先被「服务器地址不能为空」挡住，测不到写盘失败 */
    await ctx.eval(`(async () => { await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'ro-token-1234567890' } }); return 1; })()`);
    const src = await ctx.eval(`(async () => { const r = await FRP.init(); return String(r.data.state.paths.configPath || ''); })()`);
    ctx.check('拿到了当前配置路径', !!src, src);

    let switched = false;
    try {
      fs.copyFileSync(src, target);
      const set = await ctx.eval(`(async () => { const r = await FRP.saveSettings({ configPath: ${JSON.stringify(target)} }); return { ok: r.ok, err: String(r.error || '') }; })()`);
      ctx.check('切到只读候选路径', set.ok === true, set.err);
      switched = set.ok === true;

      execFileSync('attrib', ['+R', target]);
      const before = fs.readFileSync(target, 'utf8');

      const res = await ctx.eval(`(async () => {
        const r = await FRP.saveProxy('add', '', { name: 'ro-e2e', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 46401 });
        return { ok: r.ok, err: String(r.error || '').slice(0, 200) };
      })()`).catch((e) => ({ ok: 'threw', err: String(e.message).slice(0, 200) }));

      ctx.check('没有把英文异常直接抛给界面', res.ok !== 'threw', String(res.err));
      ctx.check('保存返回失败而不是假成功', res.ok !== true, `ok=${res.ok}`);
      ctx.check('失败原因说清是「不可写/占用」', /不可写|占用|写入失败/.test(res.err), res.err);

      const after = fs.readFileSync(target, 'utf8');
      ctx.check('磁盘上的配置没有被改坏', after === before, `长度 ${before.length} → ${after.length}`);
      ctx.check('没有留下 .tmp- 临时文件', fs.readdirSync(dir).filter((n) => n.includes('.tmp-')).length === 0, fs.readdirSync(dir).join(','));
    } finally {
      try { execFileSync('attrib', ['-R', target]); } catch {}
      if (switched) {
        await ctx.eval(`(async () => { await FRP.saveSettings({ configPath: ${JSON.stringify(src)} }); return 1; })()`).catch(() => {});
      }
      await ctx.eval(`(async () => { await FRP.deleteProxy('ro-e2e'); return 1; })()`).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};
