'use strict';
/* 83 证书联动：代理表单里「未签发匹配证书」要能一键去签发。
 *
 * 背景（1.2.205）：https 代理选了 https2http/https2https 后，如果域名没有对应证书，
 * 表单只显示一个红徽标「证书 · 未签发匹配证书」——用户得自己想到去「HTTPS 证书」页，
 * 再把域名重新敲一遍。现在徽标后面跟一个「去签发」按钮：点了关弹窗、切到证书页、
 * 把域名填进向导并自动检测一次。 */
module.exports = {
  id: 'cert-goto-issue',
  title: '代理表单缺证书时可一键去签发（域名带过去）',
  needs: ['app'],
  async run(ctx) {
    await ctx.waitUi('.nav-item[data-view="proxies"]');

    const form = await ctx.eval(`(async()=>{
      document.querySelector('.nav-item[data-view="proxies"]').click();
      await new Promise(r=>setTimeout(r,700));
      const add=[...document.querySelectorAll('[data-act="proxy.add"]')].find(x=>x.offsetParent);
      if(!add) return JSON.stringify({ ok:false, why:'没有新增代理按钮' });
      add.click();
      await new Promise(r=>setTimeout(r,600));
      const type=document.querySelector('#pf-type');
      if(!type) return JSON.stringify({ ok:false, why:'表单没打开' });
      type.value='https'; type.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,300));
      const seg=[...document.querySelectorAll('#pf-plugin-types [data-plugin]')].find(x=>x.dataset.plugin==='https2http');
      if(seg) seg.click();
      await new Promise(r=>setTimeout(r,300));
      const d=document.querySelector('#pf-domains');
      d.value='no-cert-goto.example.com'; d.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,1200));
      const box=document.querySelector('#pf-domain-readiness');
      return JSON.stringify({
        ok:true,
        readiness:(box?box.innerText.replace(/\\s+/g,' '):''),
        hasBadge:/未签发匹配证书/.test(box?box.innerText:''),
        hasBtn: !!document.querySelector('[data-act="cert.goto.issue"]'),
      });
    })()`);
    const f = JSON.parse(form);
    ctx.check('表单能打开并选中 https2http', f.ok === true, form.slice(0, 160));
    if (!f.ok) return;
    ctx.check('没有匹配证书时给出「未签发匹配证书」', f.hasBadge === true, String(f.readiness).slice(0, 160));
    ctx.check('徽标旁边有「去签发」按钮', f.hasBtn === true, String(f.readiness).slice(0, 160));

    const after = JSON.parse(await ctx.eval(`(async()=>{
      const b=document.querySelector('[data-act="cert.goto.issue"]');
      if(!b) return JSON.stringify({ ok:false });
      b.click();
      await new Promise(r=>setTimeout(r,2400));
      const nav=document.querySelector('.nav-item.active');
      return JSON.stringify({
        ok:true,
        view: nav&&nav.dataset ? nav.dataset.view : '',
        title: ((document.querySelector('.page-title h1')||{}).textContent||'').trim(),
        dwDomain: (document.querySelector('#dw-domain')||{}).value||'',
        modalOpen: !!document.querySelector('.modal'),
      });
    })()`));
    ctx.check('点「去签发」会切到 HTTPS 证书页', after.ok === true && after.view === 'certs', JSON.stringify(after).slice(0, 160));
    ctx.check('域名被带过去填进向导', after.dwDomain === 'no-cert-goto.example.com', `dwDomain=${JSON.stringify(after.dwDomain)}`);
    ctx.check('代理表单已关闭（不会盖在证书页上）', after.modalOpen === false, String(after.modalOpen));

    /* 收尾：把向导状态清掉，避免影响后面的场景 */
    await ctx.eval(`(async()=>{ const w=(S&&S.certs)?S.certs.wizard:null; return 1; })()`).catch(() => {});
    await ctx.eval(`(async()=>{ document.querySelector('.nav-item[data-view="overview"]').click(); await new Promise(r=>setTimeout(r,400)); return 1; })()`);
  },
};
