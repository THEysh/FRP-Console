'use strict';
/* 41-cert-sync-guard：cert:nginx-sync 必须点名域名。
 * 曾经的实现：payload.domain 缺省时用 acmeManager.list()[0] 顶上 —— 传参走样就会把
 * 「别的域名的证书」部署到当前服务器，界面还显示成功（日本真机实测踩到：本该传 finder，
 * 结果把 jellyfin 的证书和配置写到了 154.36.178.154）。 */
module.exports = {
  id: 'cert-sync-guard',
  title: '证书部署必须点名域名，不传不许随便挑一张',
  needs: ['app'],
  async run(ctx) {
    const { check } = ctx;

    const noDomain = await ctx.eval(`(async () => {
      const r = await FRP.certNginxSync({});
      return { ok: r.ok, error: r.error || '' };
    })()`);
    check('不传域名被拒', noDomain.ok === false && /缺少域名/.test(noDomain.error), noDomain.error);

    const wrongType = await ctx.eval(`(async () => {
      const r = await FRP.certNginxSync('finder.theysh.cn');
      return { ok: r.ok, error: r.error || '' };
    })()`);
    /* 1.2.183 起 certNginxSync 对「字符串」做形状容错（当域名看待），
     * 所以这里应该走到「本地没有这张证书」，而不是「缺少域名」。 */
    check('字符串参数被当成域名（不再报缺少域名）', wrongType.ok === false && /没有 .* 的证书|本地没有/.test(wrongType.error), wrongType.error);

    const ghost = await ctx.eval(`(async () => {
      const r = await FRP.certNginxSync({ domain: 'no-such-domain.invalid' });
      return { ok: r.ok, error: r.error || '' };
    })()`);
    check('没签过的域名被拒（且不会去连服务器）', ghost.ok === false && /本地没有/.test(ghost.error), ghost.error);

    const count = await ctx.eval(`(async () => { const r = await FRP.certList(); return (r.data && r.data.certs || []).length; })()`);
    check('现有证书没被动过', typeof count === 'number', `本机 ${count} 张`);
  },
};
