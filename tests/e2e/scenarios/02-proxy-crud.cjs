'use strict';
/* 代理增删改 + 表单校验：能加、能改、能删，非法输入必须被挡住且给中文提示。
 * 这些校验在 1.2.4 修过一轮（remotePort 范围/重名/重端口），用 E2E 钉住行为。 */
module.exports = {
  id: 'proxy-crud',
  title: '代理增删改与校验',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;

    /* 先给一个服务器地址：保存代理要过 validate，全新配置里 serverAddr 是空的，
     * 不先填会被「服务器地址不能为空」挡住（这条行为本身是对的）。 */
    const seed = await ctx.eval(`(async () => {
      const res = await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'crud-token-1234567890' } });
      return { ok: !!(res && res.ok) };
    })()`);
    check('准备：写入服务器地址', seed.ok);

    const added = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-web', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 23180 });
      const st = await FRP.refresh();
      return { ok: !!(res && res.ok), err: (res && res.error) || '', names: (st.data.proxies || []).map((p) => p.name) };
    })()`);
    check('能新增 tcp 代理', added.ok && added.names.includes('e2e-web'), JSON.stringify(added).slice(0, 200));

    const dupName = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-web', type: 'tcp', localIP: '127.0.0.1', localPort: 18081, remotePort: 23181 });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('重名被拒并给出提示', !dupName.ok && !!dupName.err, dupName.err);

    const badPort = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-badport', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 70000 });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('公网端口越界被拒', !badPort.ok && /65535/.test(badPort.err), badPort.err);

    const dupPort = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-dupport', type: 'tcp', localIP: '127.0.0.1', localPort: 18082, remotePort: 23180 });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('公网端口重复被拒', !dupPort.ok && /23180/.test(dupPort.err), dupPort.err);

    const httpNoDomain = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('add', '', { name: 'e2e-http', type: 'http', localIP: '127.0.0.1', localPort: 18080 });
      return { ok: !!(res && res.ok), err: (res && res.error) || '' };
    })()`);
    check('http 代理缺域名被拒', !httpNoDomain.ok && !!httpNoDomain.err, httpNoDomain.err);

    const edited = await ctx.eval(`(async () => {
      const res = await FRP.saveProxy('edit', 'e2e-web', { name: 'e2e-web', type: 'tcp', localIP: '127.0.0.1', localPort: 18090, remotePort: 23180 });
      const st = await FRP.refresh();
      const p = (st.data.proxies || []).find((x) => x.name === 'e2e-web');
      return { ok: !!(res && res.ok), localPort: p ? p.localPort : null, publicAddress: p ? p.publicAddress : '' };
    })()`);
    check('能改本地端口', edited.ok && edited.localPort === 18090, JSON.stringify(edited));
    check('公网地址按服务器地址拼', /:23180$/.test(edited.publicAddress || ''), edited.publicAddress);

    /* 表单层面：清空名称提交必须留在表单并给内联提示（不能静默关窗）。 */
    await ctx.waitUi('.nav-item[data-view="server"]', '导航渲染完成');
    const formGuard = await ctx.eval(`(async () => {
      document.querySelector('.nav-item[data-view="proxies"]').click();
      await new Promise((r) => setTimeout(r, 250));
      const openBtn = [...document.querySelectorAll('[data-act="proxy.add"]')].find((b) => b.offsetParent);
      if (openBtn) openBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const name = document.getElementById('pf-name');
      const submit = [...document.querySelectorAll('button')].find((b) => /创建代理|保存|确定/.test(b.textContent || '') && b.offsetParent);
      if (!name || !submit) return { ok: false, reason: 'no form' };
      name.value = '';
      submit.click();
      await new Promise((r) => setTimeout(r, 350));
      return {
        ok: true,
        stillOpen: !!document.getElementById('pf-name'),
        hint: (document.querySelector('#pf-name ~ .field-error, .field-error, .form-error') || {}).textContent || '',
      };
    })()`);
    check('空名称提交不会静默通过', formGuard.ok && formGuard.stillOpen && /名称/.test(formGuard.hint || ''), JSON.stringify(formGuard).slice(0, 200));

    /* 协议类型胶囊的副标题别再重复一遍小写类型名（1.2.203：原来是「TCP tcp」）。 */
    const chipHints = await ctx.eval(`(function(){
      const chips = [...document.querySelectorAll('#pf-types [data-type]')];
      return chips.map((c) => ({ type: c.dataset.type, sub: (c.querySelector('small') || {}).textContent || '' }));
    })()`);
    const dup = (chipHints || []).filter((c) => c.sub.trim().toLowerCase() === c.type);
    check('类型胶囊副标题是说明而不是重复类型名', (chipHints || []).length >= 4 && dup.length === 0, JSON.stringify(chipHints));

    const removed = await ctx.eval(`(async () => {
      const esc = document.querySelector('[data-act="proxy.close"], .modal-close, [data-act="dialog.cancel"]');
      if (esc) esc.click();
      await new Promise((r) => setTimeout(r, 200));
      const res = await FRP.deleteProxy('e2e-web');
      const st = await FRP.refresh();
      return { ok: !!(res && res.ok), names: (st.data.proxies || []).map((p) => p.name) };
    })()`);
    check('能删除代理', removed.ok && !removed.names.includes('e2e-web'), JSON.stringify(removed));
  },
};
