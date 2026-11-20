'use strict';
/* 边界输入：外部改配置删掉一条带访问路径的代理，再同名新建时不能「凭空继承」旧路径。 */
const fs = require('node:fs');

function dropProxyBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[\[proxies\]\]\s*$/.test(line)) {
      /* 新的一段开始：先判断上一段要不要保留（由 name 行决定，见下） */
      skipping = false;
      out.push({ kind: 'head', line });
      continue;
    }
    if (/^\s*\[/.test(line) && !/^\s*\[\[proxies\]\]\s*$/.test(line)) {
      skipping = false;
    }
    if (/^\s*name\s*=\s*"([^"]*)"/.test(line)) {
      const m = /^\s*name\s*=\s*"([^"]*)"/.exec(line);
      if (m && m[1] === name) {
        /* 找到目标：把这段的头也去掉，并跳过后面直到下一段为止的行 */
        let i = out.length - 1;
        while (i >= 0 && out[i].kind !== 'head') i -= 1;
        if (i >= 0) out.splice(i, 1);
        skipping = true;
        continue;
      }
    }
    if (!skipping) out.push({ kind: 'body', line });
  }
  return out.map((x) => x.line).join('\n');
}

module.exports = {
  id: 'openpath-prune',
  title: '外部删掉代理后，同名新建不会继承旧的访问路径',
  needs: ['app', 'frps', 'local', 'frpc'],
  async run(ctx) {
    const { check, waitFor, sleep } = ctx;

    const saved = await ctx.eval(`(async () => {
      const res = await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: ${ctx.frps.bindPort}, auth: { method: 'token', token: '${ctx.frps.token}' } });
      return { ok: !!(res && res.ok) };
    })()`);
    check('写入 frpc 配置', saved.ok);

    const paths = await ctx.eval(`(async () => { const st = await FRP.refresh(); const d = st.data || st; return d.paths; })()`);
    const backup = fs.readFileSync(paths.configPath, 'utf8');
    try {
      const added = await ctx.eval(`(async () => {
        const res = await FRP.saveProxy('add', '', { name: 'stale-path', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: 24577, openPath: '/panel/' });
        const st = await FRP.refresh(); const d = st.data || st;
        const p = (d.proxies || []).find((x) => x.name === 'stale-path');
        return { ok: !!(res && res.ok), openPath: p && p.openPath };
      })()`);
      check('建一条带访问路径的代理', added.ok && added.openPath === '/panel/', JSON.stringify(added));

      /* 外部把这条代理从配置里删掉 */
      const text = fs.readFileSync(paths.configPath, 'utf8');
      fs.writeFileSync(paths.configPath, dropProxyBlock(text, 'stale-path'), 'utf8');
      const gone = await waitFor(
        () => ctx.eval(`(async () => { const st = await FRP.refresh(); const d = st.data || st; return !(d.proxies || []).some((p) => p.name === 'stale-path'); })()`),
        (v) => v === true,
        { timeout: 30000, label: '外部删除被自动重载' },
      );
      check('外部删除后界面里也没有了', gone === true);

      await sleep(1200);
      const readd = await ctx.eval(`(async () => {
        const res = await FRP.saveProxy('add', '', { name: 'stale-path', type: 'tcp', localIP: '127.0.0.1', localPort: ${ctx.local.port}, remotePort: 24577 });
        const st = await FRP.refresh(); const d = st.data || st;
        const p = (d.proxies || []).find((x) => x.name === 'stale-path');
        return { ok: !!(res && res.ok), openPath: (p && p.openPath) || '', err: (res && res.error) || '' };
      })()`);
      check('同名新建成功', readd.ok === true, readd.err);
      check('没有凭空继承旧的 /panel/', readd.openPath === '', `openPath=${JSON.stringify(readd.openPath)}`);
    } finally {
      fs.writeFileSync(paths.configPath, backup, 'utf8');
      await sleep(3000);
      await ctx.eval(`(async () => { const st = await FRP.refresh(); const d = st.data || st; if ((d.proxies || []).some((p) => p.name === 'stale-path')) await FRP.deleteProxy('stale-path'); return 1; })()`).catch(() => {});
    }
  },
};
