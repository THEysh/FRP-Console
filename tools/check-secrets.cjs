'use strict';
/* L0 机密泄漏检查。
 *
 * 背景：这个项目长期在真实服务器上做端到端验证，命令行、测试脚本、临时注释里
 * 很容易顺手粘上「root 密码 / frps token / 面板口令」。`.e2e/` 已被 .gitignore
 * 排除，但 src/、build/、README 一旦带进去就会随 Release 一起公开发布
 * （仓库是公开的，安装包也会被下载）。
 *
 * 检查三类东西：
 *   1. 已知的真实凭据 —— **只存 sha256，不存明文**。这个脚本本身也在公开仓库里，
 *      写明文等于把密码换个地方再泄露一次（1.2.91 第一次提交就踩过这个坑）。
 *   2. 私钥块
 *   3. 源码里写死的高熵 token / 密码字面量（≥12 字符）
 *
 * 换密码后怎么更新：`node -e "console.log(require('crypto').createHash('sha256').update('<新密码>').digest('hex'))"`
 * 把结果加进 DENY_HASHES 即可。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/* 已知真实凭据的 sha256（日本/广州 root 密码、两边 frps token、面板口令）。 */
const DENY_HASHES = new Set([
  '0a2e27c83c9524069f2552e5a7af2bc394711ad3459d122f4e0f9fa2d2ffe43e',
  '39421a1070186a42b47f633b9a28be65e292587c6d96f0ab782818195160187b',
  '647d17eb4e3a7fb82b4322b17d10ea2d77bddf1caa2283b6338e200087b570d5',
  '4498b87cda547aee309bc2f887924cdcf052b22965cb3b414f1dcdad45d7c7fa',
  'ff041368ed9018950bcd2fb3a259f022cba2fa0bbe8a9cc0362fce8dae317189',
  'd8447d5ac06dcadcfb5178f598f18bf69f98c328f54484aab608551d7f782758',
]);

const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
/* 测试夹具目录里的自签证书私钥是刻意提交的（假服务器用，CN=e2e-cert.lab，10 年期），
 * 不算泄漏；只放行这一个目录，其它位置照旧报。 */
const TEST_KEY_DIR = /^tests\/e2e\/fixtures\/tls\//;
/* src/ 与 build/ 里不该出现「token = "abc…"」这种写死的值；README 的示例不受此限。 */
const HARDCODED = /(?:\btoken|\bpassword|\bsecret|\bpasswd)\s*[:=]\s*['"]([A-Za-z0-9!@#$%^&*_+\-]{12,})['"]/i;
/* 候选凭据片段：密码/token 常见的字符集，按空白与引号切出来逐个比对哈希。 */
const CANDIDATE = /[A-Za-z0-9!@#$%^&*._+\-]{8,}/g;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
  } catch {
    /* 没有 git（例如拷贝出去的单目录）就退化成遍历 */
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(path.relative(ROOT, full));
      }
    };
    walk(ROOT);
    return out;
  }
}

const files = trackedFiles().filter(
  (f) => !/\.(png|jpe?g|gif|ico|icns|zip|exe|dll|node|asar|woff2?|pdf)$/i.test(f),
);

const findings = [];
for (const rel of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    if (PRIVATE_KEY.test(line) && !TEST_KEY_DIR.test(String(rel).replace(/\\/g, '/'))) {
      findings.push({ file: rel, line: i + 1, kind: '私钥', detail: '-----BEGIN … PRIVATE KEY-----' });
    }
    for (const token of line.match(CANDIDATE) || []) {
      if (DENY_HASHES.has(sha256(token))) {
        findings.push({ file: rel, line: i + 1, kind: '真实凭据', detail: `${token.slice(0, 4)}…（长度 ${token.length}）` });
      }
    }
    if (/^(src|build|tools)\//.test(rel) && !/^\s*(\/\/|\*|#)/.test(line)) {
      const m = HARDCODED.exec(line);
      /* 占位符与明显的假值放过，避免天天误报。 */
      /* 明显的占位符/测试夹具放过：changeme、dummy…、test…、fixture…、orphan… */
      if (m && !/^(changeme|placeholder|example|dummy|test|fixture|orphan|your[-_]?token|xxx+)/i.test(m[1]) && !/^[a-z]+$/.test(m[1])) {
        findings.push({ file: rel, line: i + 1, kind: '写死的口令', detail: line.trim().slice(0, 80) });
      }
    }
  });
}

if (findings.length) {
  console.error(`✗ 发现 ${findings.length} 处疑似机密：`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.kind}]  ${f.detail}`);
  console.error('\n如果这是测试用的假值，请改成明显的占位符（如 "changeme"）或移进 .e2e/（已被 gitignore）。');
  process.exit(1);
}
console.log(`✓ 机密检查通过（扫描 ${files.length} 个受版本控制的文件，比对 ${DENY_HASHES.size} 个已知凭据的哈希）`);
