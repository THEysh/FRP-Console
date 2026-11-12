/* 单进程内验证密码库的按档案隔离与 v1 迁移（跨进程 DPAPI 在受控环境里不可用，
   所以这里用同一进程完成写入与读取，语义与真实运行一致）。 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.setName('frp-console');
const dir = path.join(__dirname, '..', 'tmp-test-data', 'secret-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', dir);

app.whenReady().then(() => {
  const settings = require('../src/main/settings');
  const file = path.join(dir, 'server-secret.json');
  const results = {};

  // 1) v1 单密码 → 迁移到指定档案，并销毁 legacy
  fs.writeFileSync(file, JSON.stringify({ v: 1, enc: safeStorage.encryptString('legacy-pass').toString('base64'), at: Date.now() }));
  const id = settings.newServerId();
  results.hasLegacyBefore = settings.hasLegacySecret();
  results.migrated = settings.migrateLegacySecret(id);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  results.legacyRemoved = !raw.enc && !raw.legacy;
  results.migratedValue = settings.readServerSecret(id) === 'legacy-pass';

  // 2) 两个档案互不串台
  settings.saveServerSecret('srv-A', 'pass-a');
  settings.saveServerSecret('srv-B', 'pass-b');
  results.isolated = settings.readServerSecret('srv-A') === 'pass-a' && settings.readServerSecret('srv-B') === 'pass-b';
  results.noCrossFallback = settings.readServerSecret('srv-C') === '';

  // 3) 删除 A 不影响 B
  settings.clearServerSecret('srv-A');
  results.clearOnlyTarget = !settings.hasServerSecret('srv-A') && settings.readServerSecret('srv-B') === 'pass-b';

  // 4) 空密码 = 清除
  settings.saveServerSecret('srv-B', '');
  results.emptyClears = !settings.hasServerSecret('srv-B');

  console.log(JSON.stringify(results, null, 2));
  app.quit();
});
