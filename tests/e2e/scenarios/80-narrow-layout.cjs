'use strict';
/* 80 最小窗口布局：1040×680（等于应用 minWidth/minHeight）下七个视图都不能横向溢出。
 *
 * 背景（1.2.200 巡检）：
 *  ① 侧栏在 ≤1180px 会从 238 缩到 206，品牌副标题「内网穿透 · 本地服务发布」因此按字断行成
 *     「…发 / 布」，看着像渲染出错 → 缩短文案 + nowrap/ellipsis；
 *  ② 代理表最后一列「操作」被 `.table-card { overflow: hidden }` 裁掉，编辑/删除按钮点不到
 *     → ≤1180px 收紧单元格内边距与行内图标，并给表格卡加横向滚动兜底。
 * 判据：①#view 自身不横向溢出；②视图内没有「内容超出自身盒宽且不自带滚动」的元素
 * （`.term` 的 tooltip 是绝对定位 ::after，会把 scrollWidth 撑大，按类名排除）；
 * ③代理表行内操作按钮右边界不超过视图右边界。 */
module.exports = {
  id: 'narrow-layout',
  title: '最小窗口（1040×680）：七个视图没有横向溢出',
  needs: ['app'],
  async run(ctx) {
    const views = ['overview', 'proxies', 'discovery', 'server', 'certs', 'logs', 'settings'];
    const sizes = [[1040, 680], [1120, 720], [1440, 900]];
    try {
      for (const [w, h] of sizes) {
        await ctx.emulate(w, h);
        for (const v of views) {
          await ctx.eval(`(async()=>{const b=document.querySelector('.nav-item[data-view="${v}"]'); if(b) b.click(); await new Promise(r=>setTimeout(r,600)); return 1;})()`);
          await ctx.sleep(400);
          const r = await ctx.eval(`(function(){
            const view = document.querySelector('#view');
            if (!view) return { cw: 0, sw: 0, over: [] };
            const over = [];
            for (const el of view.querySelectorAll('*')) {
              if (!el.clientWidth || el.clientHeight < 4) continue;
              if (el.scrollWidth <= el.clientWidth + 2) continue;
              const cs = getComputedStyle(el);
              if (cs.overflowX !== 'visible') continue;
              /* .term 的 tooltip 是绝对定位的 ::after，会把外层 scrollWidth 撑大；含 .term 的元素一律跳过 */
              if (el.classList.contains('term') || el.closest('.term') || el.querySelector('.term')) continue;
              over.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 30), cw: el.clientWidth, sw: el.scrollWidth });
            }
            return { cw: view.clientWidth, sw: view.scrollWidth, over: over.slice(0, 5) };
          })()`);
          ctx.check(`${w}×${h} ${v} 视图没有横向溢出`, r.sw <= r.cw + 2 && r.over.length === 0, `view ${r.cw}→${r.sw} ${JSON.stringify(r.over)}`);
        }
      }

      /* 代理表的「操作」列在窄屏曾被裁掉：行内按钮只在有行时渲染，先造一条代理，测完删掉。 */
      /* saveProxy 需要先有服务器地址：全新数据目录里配一份（本场景不启动隧道，只为了渲染一行） */
      const saved = await ctx.eval(`(async()=>{
        await FRP.saveConfig({ serverAddr: '127.0.0.1', serverPort: 7000, auth: { method: 'token', token: 'narrow-layout-token' } });
        const r = await FRP.saveProxy('add', '', { name: 'narrow-act', type: 'tcp', localIP: '127.0.0.1', localPort: 18080, remotePort: 28901 });
        return JSON.stringify(r);
      })()`);
      ctx.check('造一条代理用于裁切断言', /"ok":true/.test(String(saved)), String(saved).slice(0, 200));
      /* 三个宽度都量一遍：1120 时曾只露出 3 个图标（1.2.200 截图），1040 才算真正的下限。 */
      for (const [w, h] of [[1040, 680], [1120, 720], [1440, 900]]) {
        await ctx.emulate(w, h);
        await ctx.sleep(300);
        await ctx.eval(`(async()=>{const b=document.querySelector('.nav-item[data-view="proxies"]'); if(b) b.click(); await new Promise(r=>setTimeout(r,600)); return 1;})()`);
        await ctx.sleep(500);
        const acts = await ctx.eval(`(function(){
          const v = document.querySelector('#view');
          if (!v) return null;
          const btns = [...v.querySelectorAll('.trow-actions .icon-btn')];
          if (!btns.length) return { n: 0 };
          const vr = v.getBoundingClientRect();
          const worst = btns.reduce((m, b) => Math.max(m, b.getBoundingClientRect().right - vr.right), -Infinity);
          return { n: btns.length, overflowPx: Math.round(worst) };
        })()`);
        if (!acts || !acts.n) {
          ctx.skip(`代理表没有行内操作按钮（${w}×${h}），跳过裁切断言`);
        } else {
          ctx.check(`${w}×${h} 代理表行内操作按钮完整可见（没有被卡片裁掉）`, acts.overflowPx <= 0, JSON.stringify(acts));
        }
      }
      /* 上面那条「按钮没越界」对布局变化不够敏感（table 会自己缩列），所以再钉一次窄屏规则本身：
       * ≤1180px 时单元格内边距必须收到 10px、表格卡必须能横向滚动 —— 撤掉规则时这里会红。 */
      await ctx.emulate(1040, 680);
      await ctx.sleep(300);
      const css1040 = await ctx.eval(`(function(){
        const td = document.querySelector('.proxy-table tbody td');
        const card = document.querySelector('.table-card');
        if (!td || !card) return null;
        return {
          pad: getComputedStyle(td).paddingLeft,
          overflowX: getComputedStyle(card).overflowX,
          iconW: getComputedStyle(document.querySelector('.trow-actions .icon-btn')).width,
        };
      })()`);
      ctx.check('1040 宽下代理表单元格内边距收到 10px', !!css1040 && css1040.pad === '10px', JSON.stringify(css1040));
      ctx.check('1040 宽下表格卡可横向滚动（挤不下时可以滚，而不是被裁掉）', !!css1040 && css1040.overflowX === 'auto', JSON.stringify(css1040));
      ctx.check('1040 宽下行内图标缩到 22px', !!css1040 && css1040.iconW === '22px', JSON.stringify(css1040));

      /* 侧栏品牌副标题：窄屏不该折成两行 */
      await ctx.emulate(1040, 680);
      await ctx.sleep(500);
      const brand = await ctx.eval(`(function(){
        const el = document.querySelector('.brand-text span');
        if (!el) return null;
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || 14;
        return { text: el.textContent.trim(), h: el.clientHeight, lh, nowrap: cs.whiteSpace, clip: cs.overflow };
      })()`);
      ctx.check('侧栏品牌副标题在窄屏不折行', !!brand && brand.h <= Math.ceil(brand.lh * 1.6), JSON.stringify(brand));
      ctx.check('品牌副标题禁止折行并自带省略兜底', !!brand && /nowrap/.test(brand.nowrap) && /hidden/.test(brand.clip), JSON.stringify(brand));
    } finally {
      await ctx.eval(`(async()=>{ try { await FRP.deleteProxy('narrow-act'); } catch (e) {} return 1; })()`);
      await ctx.emulate(0, 0);
    }
  },
};
