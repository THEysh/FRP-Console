'use strict';
/* 脏数据/坏数据的容错。
 *
 * 这些都是「用户机器上真实会发生」的情况：升级途中断电、手工改了 settings.json、
 * 用别的编辑器存坏了 frpc.toml、把路径写成了文件夹。要求只有一条——
 * **应用能起来、能用、坏数据不会连带丢掉好数据**。
 */
const fs = require('node:fs');
const path = require('node:path');

const GOOD_TOML = [
  'serverAddr = "127.0.0.1"',
  'serverPort = 17000',
  'auth.method = "token"',
  'auth.token = "e2e-token-1234567890"',
  '',
  '[[proxies]]',
  'name = "keep-me"',
  'type = "tcp"',
  'localIP = "127.0.0.1"',
  'localPort = 18080',
  'remotePort = 23301',
  '',
].join('\n');

function seedDir(dir, files) {
  const userData = path.join(dir, 'frp-console-data');
  fs.mkdirSync(userData, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(userData, name), content, 'utf8');
  }
  return userData;
}

module.exports = {
  id: '17-corrupt-data',
  title: '脏数据容错：settings.json 半截、类型错乱、frpc.toml 语法坏',
  needs: [],
  async run(ctx) {
    /* ---------- ① settings.json 被截断（升级途中断电/磁盘满） ---------- */
    const a = await ctx.startApp({
      seed: (dir) =>
        seedDir(dir, {
          'frpc.toml': GOOD_TOML,
          'settings.json': '{\n  "version": 2,\n  "servers": [\n    { "id": "srv-cut", "host": "10.9.9',
        }),
    });
    try {
      ctx.check('半截 settings.json 也能启动', a.ready === true);
      const raw = await a.eval('(async () => { const r = await FRP.init(); return r && r.data ? r.data : r; })()');
      const state = (raw && raw.state) || raw;
      ctx.check('回落到默认设置 version=2', Number(state.settings && state.settings.version) === 2, String(state.settings && state.settings.version));
      ctx.check('档案列表是空数组而不是崩溃', Array.isArray(state.settings.servers), JSON.stringify(state.settings && state.settings.servers));
      ctx.check(
        '好数据（frpc.toml 里的代理）没被连带丢掉',
        (state.proxies || []).length === 1 && state.proxies[0].name === 'keep-me',
        (state.proxies || []).map((p) => p.name).join(','),
      );
      /* 坏文件必须被重新写成合法 JSON，否则下次启动还是坏的。 */
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(a.dir, 'frp-console-data', 'settings.json'), 'utf8'));
      } catch {
        parsed = null;
      }
      ctx.check('坏 settings.json 被重写成合法 JSON', !!parsed && Number(parsed.version) === 2, '重写失败');
    } finally {
      a.stop();
    }

    /* ---------- ② 类型全错：servers 不是数组、端口是字符串、负值 ---------- */
    const b = await ctx.startApp({
      seed: (dir) =>
        seedDir(dir, {
          'frpc.toml': GOOD_TOML,
          'settings.json': JSON.stringify({
            version: 2,
            servers: 'not-an-array',
            activeServerId: 123,
            clientServerId: { id: 'x' },
            adminPort: 'abc',
            pollIntervalMs: 'fast',
            logBuffer: -5,
            runMode: 'nonsense',
            acmeEmail: 42,
          }),
        }),
    });
    try {
      ctx.check('类型错乱的 settings 也能启动', b.ready === true);
      const raw = await b.eval('(async () => { const r = await FRP.init(); return r && r.data ? r.data : r; })()');
      const s = ((raw && raw.state) || raw).settings || {};
      ctx.check('servers 被修正成数组', Array.isArray(s.servers), typeof s.servers);
      ctx.check('非法 runMode 归到 auto', s.runMode === 'auto', String(s.runMode));
      ctx.check('adminPort 非数字时回到 7400', Number(s.adminPort) === 7400, String(s.adminPort));
      ctx.check('logBuffer 负值被收敛到合法区间', Number(s.logBuffer) >= 100 && Number(s.logBuffer) <= 2000, String(s.logBuffer));
      ctx.check('activeServerId 非字符串被清空', s.activeServerId === '' || typeof s.activeServerId === 'string', JSON.stringify(s.activeServerId));
      ctx.check('acmeEmail 非字符串不影响启动', typeof s.acmeEmail === 'string', typeof s.acmeEmail);
    } finally {
      b.stop();
    }

    /* ---------- ③ frpc.toml 语法坏：应当报“配置解析失败”并保留可用的空模型 ---------- */
    const c = await ctx.startApp({
      seed: (dir) =>
        seedDir(dir, {
          'frpc.toml': 'serverAddr = "127.0.0.1"\nserverPort = [[[ broken\n',
          'settings.json': JSON.stringify({ version: 2 }),
        }),
    });
    try {
      ctx.check('frpc.toml 语法错也能启动', c.ready === true);
      const raw = await c.eval('(async () => { const r = await FRP.init(); return r && r.data ? r.data : r; })()');
      const state = (raw && raw.state) || raw;
      ctx.check('给出了配置解析失败的提示', !!state.configError, String(state.configError).slice(0, 80));
      ctx.check('代理列表是空的，不是半截数据', Array.isArray(state.proxies) && state.proxies.length === 0, (state.proxies || []).length);
      /* 关键：坏文件不能被程序自作主张覆盖掉 —— 用户还要靠它手工修。 */
      const stillBad = fs.readFileSync(path.join(c.dir, 'frp-console-data', 'frpc.toml'), 'utf8');
      ctx.check('坏配置原样保留（没被自动重写）', stillBad.includes('[[[ broken'), stillBad.slice(0, 40));
    } finally {
      c.stop();
    }
  },
};
