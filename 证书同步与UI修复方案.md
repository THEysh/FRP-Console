# 云端证书同步 + 防火墙卡片 UI 修复方案

> 针对用户 2026-11-17 反馈的 4 个问题。先给定位（含证据），再给改造方案与分期。

---

## 一、问题定位

### 1. 「1-65535 全放行」按钮不起作用

- 代码侧两个按钮都绑定了 handler（`src/renderer/app.js:1725-1726` 渲染，`app.js:4315-4335` 处理），`FRP.copy()` 走主进程 `clipboard.writeText`。
- **实测**（CDP 真点按钮，`v1.2.60` 源码版）：两个按钮都能把内容写进剪贴板并弹 toast——

  ```
  server.ports.copywide → clip="入方向（允许）：\nTCP  1-65535 ..."  toasts=["已复制「1-65535 全放行」..."]
  server.ports.copy     → clip="入方向（允许）：\nTCP  7000 ... bindPort ..."
  ```
- 所以不是剪贴板/逻辑坏了，而是**按钮点不到**：紧邻上方的黄色感叹号 SVG 没有尺寸约束（见问题 2），被撑到整张卡片大小，**盖住了下方的按钮**（SVG 默认 `pointer-events: auto`），点击落到 SVG 上，看起来就是"没反应"。
- 结论：**修好图标尺寸，按钮自动恢复**；同时按你的要求删掉「复制全部端口规则」。

### 2. 黄色感叹号图标巨大

- 全站只有 `.note svg { width:15px; height:15px }`（`src/renderer/styles.css:777`）给 SVG 定了尺寸；`.cloud-hint-head` 里直接 `icon('alert')`，**没有任何尺寸规则**，SVG 的默认尺寸是「撑满容器」→ 撑满整张卡片。
- 证据：`styles.css` 里 `.cloud-hint*` 的五条规则都只设了 margin/padding/border/color，没有 `svg` 尺寸。

### 3. HTTPS 证书页「不同步」：安装版部署的证书，源码版看不到

- 证书文件与元数据都写在**当前进程的 userData** 下：`<userData>/certs/<域名>/{fullchain.pem,cert.pem,chain.pem,key.pem,metadata.json}`（`src/main/acme.js:certFolder`）。
- 安装版 userData = `%LOCALAPPDATA%\frp-console`，源码版 = `<项目>\.frp-console-data\frp-console-data`（1.2.32 起的隔离设计，你我都确认过要保留）。
- 所以源码版证书页读到的是**另一个空目录**，自然看不到 `jellyfin.theysh.cn` 与"已部署到 8.148.198.61"这条记录。**不是同步失败，是两份独立数据。**

### 4. 想按「*.theysh.cn」把服务器上所有证书一起看

- 已确认可发现性（真实服务器实测）：
  - **日本 154.36.178.154（宝塔）**：`/www/server/panel/vhost/cert/{alist,focuslock,ja,www}.theysh.cn/fullchain.pem`，`openssl 3.0.20` 可用，`openssl x509 -noout -subject -issuer -enddate` 能直接解析（样例：`subject=CN=alist.theysh.cn`、`issuer=Let's Encrypt`、`notAfter=Feb 11 2027`）。另有我们自己的 `/etc/nginx/ssl/finder.theysh.cn/fullchain.pem`。
  - **广州 8.148.198.61（非宝塔）**：只有 `/etc/nginx/ssl/mytest.theysh.cn/fullchain.pem`，`openssl 3.0.15` 可用。
  - nginx 配置里的引用可以直接抓：`grep -rhoE 'ssl_certificate[[:space:]]+[^;]+;' /etc/nginx /www/server/panel/vhost/nginx`。
- 结论：**完全可行**，且不需要改服务器任何东西（纯只读）。

---

## 二、改造方案

### 期一 · v1.2.61（纯前端，约 30 分钟，先解决"看着坏"的问题）

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 删「复制全部端口规则」按钮 | `src/renderer/app.js:1725` | 保留「复制 1-65535 全放行」，文案改为「复制全端口放行（1-65535）」 |
| 修图标尺寸 | `src/renderer/styles.css` | `.cloud-hint-head svg, .cloud-hint svg { width:15px; height:15px; flex:0 0 15px; }`；同时给 `.guide svg`、`.tag svg`、`.cert-row svg` 加同样的兜底，避免其它地方重演 |
| 防回归 | 新增 `.e2e/lab/verify-svg-size.cjs` | 断言 `.cloud-hint-head svg` 计算宽高 ≤ 20px；点两个按钮断言剪贴板内容非空 |

### 期二 · v1.2.62（服务器证书扫描，只读展示）

1. **`src/main/ssh.js` 新增 `scanCertificates()`**：一次 SSH 批量脚本
   - 检测 `openssl`；收集候选路径：nginx 配置里的 `ssl_certificate`（`/etc/nginx`、`/www/server/panel/vhost/nginx`）、宝塔证书目录 `/www/server/panel/vhost/cert/*/fullchain.pem`、`/etc/letsencrypt/live/*/fullchain.pem`、我们自己的 `<confDir>` 反代证书；
   - 对每个文件跑 `openssl x509 -noout -subject -issuer -enddate -ext subjectAltName`；
   - 返回 `[{path, keyPath?, domains[], issuer, notAfter, daysLeft, source:'panel'|'system'|'frp-console'}]`；
   - 约束：最多 40 条、总超时 15 秒、按路径去重；`openssl` 缺失时只回路径 + `unparsed:true`。
2. **`src/main/index.js`**：新增 IPC `cert:server-scan`（未连服务器直接返回空 + 原因）；结果缓存 60 秒；`cert:list` 的返回体里加 `serverCerts`。
3. **`src/renderer/app.js`**：证书页新增「服务器上的证书」卡片——按父域名分组，每行：域名、来源徽标（宝塔 / 系统 / FRP控制台）、到期（≤30 天橙色 / 已过期红色）、证书路径（可复制）、「重新扫描」按钮。

### 期三 · v1.2.63（统一同步 + 按 `*.theysh.cn` 分组）

1. **设置新增 `certDirs: []`（额外证书目录）**：默认自动把 `%LOCALAPPDATA%\frp-console\certs` 加进来（仅当它与当前 userData 不同），解决"源码版看不到安装版证书"。
2. **证书页改造成「按域名分组的证书总览」**：

   ```
   *.theysh.cn 已签发证书                     [本机 1 · 宝塔 4 · 系统 1]
     jellyfin.theysh.cn   本机 · 已部署到 8.148.198.61   剩 89 天   [续期][部署]
     alist.theysh.cn      宝塔(154.36.178.154)           剩 85 天   [导入到本机]
     focuslock.theysh.cn  宝塔(154.36.178.154)           剩 85 天   [导入到本机]
     www.theysh.cn        宝塔(154.36.178.154)           剩 36 天   [导入到本机]
     ja.theysh.cn         宝塔(154.36.178.154)           剩 32 天   [导入到本机]
   ```

   - 分组规则：`apexOf(域名)` 相同即同组；组内若存在通配符证书，标题写成 `*.theysh.cn`，否则写 `theysh.cn`。
   - 来源徽标：`本机` / `服务器 IP · 宝塔` / `服务器 IP · 系统` / `服务器 IP · FRP控制台`。
   - 状态：`已部署到 nginx`（服务器配置里 `ssl_certificate` 指向它）、`仅服务器`、`仅本机`。
3. **「导入到本机」**：把服务器上的 `fullchain.pem`/`privkey.pem` 下载到当前 userData 的 `certs/<域名>/`，写 `metadata.json`（`source:'imported'`, `serverHost`），导入后即可用现有「部署到 nginx」「查看 DNS」功能；到期续期仍走 ACME（DNS-01），导入的证书只做到期提醒。
4. **部署状态以事实为准**：用"服务器 nginx 里该域名的 `ssl_certificate` 路径"判断，替代现在仅靠 `markNginx` 记录的做法（那条记录仍在，作为补充）。

---

## 三、风险与取舍

| 风险 | 处理 |
| --- | --- |
| `openssl` 缺失 / 非标准目录 | 只显示路径 + 「无法解析」，不报错；宝塔路径按官方默认再加一层 `ls` 兜底 |
| 宝塔证书目录权限（`700 root`） | 复用现有 `detectSudo()`（root 直连或 `sudo -n`） |
| 扫描太慢 | 单次 SSH 批量脚本 + 15 秒硬超时 + 60 秒缓存 + 最多 40 条 |
| 误改宝塔站点 | **只读**：不自动写入宝塔管理的 `vhost/nginx/*.conf`，只给「复制路径」；要部署只在我们的 `frp-console.conf` 里做 |
| 通配符分组把不相关域名并进来 | 按 `apexOf()` 精确分组（`finder.theysh.cn`、`*.theysh.cn`、`theysh.cn` 同组，`other.com` 不同组） |
| 两套数据目录长期并存 | `certDirs` 只是**读**；写入永远落在当前 userData，避免互相污染 |

---

## 四、验收用例

| 编号 | 用例 | 期望 |
| --- | --- | --- |
| T1 | 打开服务器页 | 云提示区感叹号图标 ≈15px，不再撑满卡片 |
| T2 | 点「复制全端口放行（1-65535）」 | 剪贴板得到 TCP/UDP 1-65535 两行 + toast |
| T3 | 点「复制全部端口规则」 | 按钮已不存在 |
| T4 | 连日本服务器 → 证书页 | 出现「*.theysh.cn 已签发证书」分组，含宝塔 4 条 + 系统 1 条，到期天数正确 |
| T5 | 连广州服务器 → 证书页 | 分组内出现 `mytest.theysh.cn`（FRP 控制台）1 条 |
| T6 | 源码版证书页 | 通过 `certDirs` 能看到安装版部署的 `jellyfin.theysh.cn`（标注"本机 · 另一数据目录"） |
| T7 | 点「导入到本机」 | 证书落到当前 userData，列表出现并可「部署到 nginx」 |
| T8 | 未连服务器时打开证书页 | 服务器区块显示「连接服务器后可扫描」，不报错 |

---

## 五、建议顺序

先做 **v1.2.61**（图标 + 按钮，5 分钟见效，风险极低），再做 **v1.2.62**（只读扫描，能立刻看到宝塔那 4 张证书），最后 **v1.2.63**（分组总览 + 导入/同步）。
