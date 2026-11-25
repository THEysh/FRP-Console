'use strict';
/* 77 概念统一：界面上不该再出现「档案」。
 *
 * 1.2.189 起「服务器档案」在界面上被「连接」取代（服务器页连接卡、代理页按连接分组、
 * 1.2.196 把提示条/Token 说明/表单提示也统一了）。两套叫法并存时，用户没法判断
 * 它们是不是同一个东西，所以把「七个视图的可见文本里不出现『档案』」变成回归。 */
const path = require('path');

module.exports = {
  id: 'wording',
  title: '文案统一：界面里不再出现「档案」',
  needs: ['app'],
  async run(ctx) {
    const views = ['overview', 'proxies', 'discovery', 'server', 'certs', 'logs', 'settings'];
    for (const v of views) {
      await ctx.eval(`(function(){const b=document.querySelector('.nav-item[data-view="${v}"]'); if(b) b.click(); return true;})()`);
      await ctx.sleep(700);
      const text = await ctx.eval('document.body.innerText || ""');
      const n = (String(text).match(/档案/g) || []).length;
      ctx.check(`${v} 视图没有「档案」字样`, n === 0, n ? `出现 ${n} 次：${String(text).slice(Math.max(0, String(text).indexOf('档案') - 30), String(text).indexOf('档案') + 20).replace(/\s+/g, ' ')}` : '');
    }

    /* 「服务器」页必须还能看见连接相关的关键信息，别把文案改没了。 */
    await ctx.eval(`(function(){const b=document.querySelector('.nav-item[data-view="server"]'); if(b) b.click(); return true;})()`);
    await ctx.sleep(700);
    const serverText = String(await ctx.eval('document.body.innerText || ""'));
    ctx.check('服务器页仍说明连接与隧道的关系', /连接/.test(serverText), serverText.slice(0, 120).replace(/\s+/g, ' '));
  },
};
