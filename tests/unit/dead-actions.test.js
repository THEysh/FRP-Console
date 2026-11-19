'use strict';
/* 死按钮体检：界面上每一个 data-act="x" 都必须在 app.js 里被处理到，
 * 否则用户点下去毫无反应——这类问题在 1.2.83（confirmStopService 死开关）
 * 和 1.2.11（日志卡按钮 handler 被删）都出现过，靠人工点很难覆盖全。
 *
 * 判定方式：把源码里所有 data-act="…" 的取值收集起来，再看 handleAction
 * 的 case 分支、以及 document 级委托里出现的同一字符串。不强求解析 AST，
 * 只要求「字符串在某个处理位置出现过」。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js');
const source = fs.readFileSync(SRC, 'utf8');

/* 这些 act 由别处处理，不在 handleAction 里：
 *  - copy：渲染层直接写剪贴板（handleAction 里也有分支，留着不影响）
 *  - nav：导航由 nav 点击委托处理
 *  - 视觉/无操作标记：sepHint 之类仅用于分组占位 */
const ALLOW = new Set(['sepHint']);

function collectActs(text) {
  const out = new Set();
  const re = /data-act="([a-zA-Z0-9_.:-]+)"/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  /* 也有拼接写法：data-act="${'x'}"，粗抓引号里的 act 名 */
  const re2 = /data-act=[`']?\$\{['"]([a-zA-Z0-9_.:-]+)['"]\}/g;
  while ((m = re2.exec(text))) out.add(m[1]);
  return out;
}

function isHandled(act) {
  /* handleAction 的 case 'x': / case "x": */
  if (new RegExp(`case\\s+['"]${act.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(source)) return true;
  /* 前缀匹配：`case 'server.firewall.openports'` 之外还有 `act.startsWith('server.')` 之类 */
  if (source.includes(`'${act}'`) || source.includes(`"${act}"`)) {
    /* 至少出现过：排除只出现在模板里的 data-act 本身 */
    const inTemplate = new RegExp(`data-act="${act.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(source);
    const occurrences = source.split(`'${act}'`).length - 1 + (source.split(`"${act}"`).length - 1);
    if (occurrences > (inTemplate ? 1 : 0)) return true;
  }
  return false;
}

test('每个 data-act 都有处理分支', () => {
  const acts = collectActs(source);
  assert.ok(acts.size > 40, `收集到的 act 太少（${acts.size}），正则可能失效`);
  const dead = [...acts].filter((a) => !ALLOW.has(a) && !isHandled(a)).sort();
  assert.deepEqual(dead, [], `以下按钮没有处理逻辑：${dead.join(', ')}`);
});

test('handleAction 的 case 都能被点到（含别名共用的写法）', () => {
  /* 一段连续的 case 会共用同一个分支体（`case 'a': case 'b': {`），
   * 只要其中有一个名字出现在界面上就算可达；另外还有代码里直接
   * `handleAction('x', ...)` 主动调用的，也算可达。 */
  const acts = collectActs(source);
  /* 只看 handleAction 这一个 switch：文件里还有别的 switch（更新状态机等），
   * 它们的 case 是内部状态名，不是界面动作。 */
  const from = source.indexOf('async function handleAction(act, dataset, btn)');
  const to = source.indexOf("    toast('error', '操作异常'", from);
  const body = from >= 0 && to > from ? source.slice(from, to) : source;
  const lines = body.split('\n');
  const runs = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s*case\s+['"]([a-zA-Z0-9_.:-]+)['"]\s*:/);
    if (m) {
      if (!current) runs.push((current = []));
      current.push(m[1]);
    } else if (current && line.trim() && !line.trim().startsWith('//')) {
      current = null;
    }
  }
  const dispatched = new Set();
  const dispatchRe = /handleAction\(\s*['"]([a-zA-Z0-9_.:-]+)['"]/g;
  let d;
  while ((d = dispatchRe.exec(source))) dispatched.add(d[1]);

  /* 1.2.93 把「配置向导」的渲染层整块删掉了（那些按钮本来就点不到），
   * 所以这里不再需要豁免清单：任何点不到的分支都应该算失败。 */
  const KNOWN_UNREACHABLE = new Set();
  const dead = runs
    .filter((run) => !run.some((a) => acts.has(a) || dispatched.has(a) || KNOWN_UNREACHABLE.has(a)))
    .map((run) => run.join('|'));
  assert.deepEqual(dead, [], `这些分支既没渲染也没人调用：${dead.join(', ')}`);
});
