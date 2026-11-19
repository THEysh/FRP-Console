'use strict';
/* 服务器页：连上（假）服务器后，识别 / 自检 / nginx / 防火墙 / 日志都得对。
 * 假 sshd 里同时放了 frpc.service 与 frps.service，且 frpc 排在前面——
 * 这正是 1.2.5 修过的「把客户端 unit 当成服务端」那个坑。 */
module.exports = {
  id: 'server-page',
  title: '服务器页：服务识别、四层自检、nginx/防火墙/日志',
  /* bindPort 自检要「服务器说在听」且「客户端真能连上」两条同时成立，
   * 所以本场景需要 runner 把真 frps 起在 17000（假 sshd 的 frps.toml 也报这个端口）。 */
  needs: ['app', 'sshd', 'frps'],
  async run(ctx) {
    const { check, waitFor } = ctx;

    const conn = await ctx.eval(`(async () => {
      const res = await FRP.serverConnect({ host: '127.0.0.1', port: ${ctx.sshPort}, username: 'root', password: 'labpass', adoptProfile: false });
      return { ok: !!(res && res.ok), err: (res && res.error) || '', data: res && res.data ? { connected: res.data.connected, serviceName: res.data.info && res.data.info.serviceName } : null };
    })()`);
    check('能连上服务器', conn.ok && conn.data && conn.data.connected === true, JSON.stringify(conn).slice(0, 240));

    const state = await ctx.eval(`(async () => { const r = await FRP.serverState(); return r.data; })()`);
    check('识别出 os', /Debian/i.test((state.info && state.info.os) || ''), JSON.stringify(state.info && state.info.os));
    check('服务名是 frps 而不是 frpc', state.info && state.info.serviceName === 'frps', state.info && state.info.serviceName);
    check('识别出 frps 版本', state.info && String(state.info.version || '').startsWith('0.61'), state.info && state.info.version);
    check('读到 frps.toml 摘要', !!(state.summary && state.summary.bindPort), JSON.stringify(state.summary && state.summary.bindPort));

    const selftest = await ctx.eval(`(async () => {
      const out = {};
      for (const layer of ['ssh', 'service', 'bindPort', 'token']) {
        const r = await FRP.serverSelfTest(layer);
        out[layer] = { ok: !!(r && r.ok && r.data && r.data.ok), text: (r && r.data && (r.data.detail || r.data.text)) || (r && r.error) || '' };
      }
      return out;
    })()`);
    for (const layer of ['ssh', 'service', 'bindPort', 'token']) {
      if (layer === 'bindPort' && !ctx.frps) {
        check('自检 bindPort 通过', true, '没找到 frps 二进制，本机这侧没人监听，跳过客户端可达性判定');
        continue;
      }
      check(`自检 ${layer} 通过`, !!(selftest[layer] && selftest[layer].ok), selftest[layer] && selftest[layer].text);
    }
    check('Token 层能比对出「一致」', /一致/.test((selftest.token && selftest.token.text) || ''), selftest.token && selftest.token.text);

    const nginx = await ctx.eval(`(async () => { const r = await FRP.serverNginxState(); return r.data; })()`);
    check('nginx 卡片拿到状态', nginx && typeof nginx.installed === 'boolean', JSON.stringify(nginx).slice(0, 200));
    check('识别出 nginx 版本号（已去掉 nginx/ 前缀）', !/^nginx\//.test(String(nginx.version || '')), nginx.version);

    const fw = await ctx.eval(`(async () => { const r = await FRP.serverFirewallState(); return r.data; })()`);
    check('防火墙卡片拿到状态', fw && typeof fw.manager === 'string', JSON.stringify(fw).slice(0, 200));
    check('防火墙端口清单非空', Array.isArray(fw.ports) && fw.ports.length > 0, `ports=${(fw.ports || []).length}`);

    const logs = await ctx.eval(`(async () => { const r = await FRP.serverLogs(50); return { ok: !!(r && r.ok), len: (r && r.data && (r.data.len || (r.data.content || '').length)) || 0, source: (r && r.data && r.data.source) || '' }; })()`);
    check('能拉到 frps 日志', logs.ok && logs.len > 0, JSON.stringify(logs));
    check('日志来源标注 journalctl', /journalctl/.test(logs.source), logs.source);

    /* DOM：卡片顺序与关键块都在（v1.2.65 之后的分区结构）。 */
    await ctx.waitUi('.nav-item[data-view="server"]', '导航渲染完成');
    const dom = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="server"]').click();
      await new Promise((r) => setTimeout(r, 500));
      const text = document.getElementById('view').textContent;
      return {
        sections: [...document.querySelectorAll('.srv-section-title')].map((n) => n.textContent.trim()),
        hasNginx: /nginx/i.test(text),
        hasFirewall: /防火墙/.test(text),
        hasSelftest: /就绪|自检/.test(text),
        headings: [...document.querySelectorAll('#view h3, #view h2')].map((n) => n.textContent.trim()).slice(0, 12),
      };
    })()`);
    check('分区标题存在（配置管理 / 运行监控）', dom.sections.length >= 2, dom.sections.join(','));
    check('nginx 卡片渲染', dom.hasNginx);
    check('防火墙卡片渲染', dom.hasFirewall);

    const waiting = await waitFor(
      () => ctx.eval(`(async () => { const r = await FRP.serverState(); return !!(r.data && r.data.connected); })()`),
      Boolean,
      { timeout: 15000, label: '会话保持连接' },
    );
    check('连接保持稳定', waiting === true);
  },
};
