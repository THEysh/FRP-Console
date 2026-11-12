# frps 二进制（不再随安装包分发）

安装包里**不再包含** linux 版 `frps`。只有在你对一台**还没装 frps** 的服务器点「一键初始化」时，
控制台才会按服务器架构（amd64 / arm64）从 GitHub Releases 下载 `frp_0.61.0_linux_<arch>.tar.gz`，
解压出 `frps` 后上传，并缓存在：

```
%LOCALAPPDATA%\frp-console\frps-cache\frp_0.61.0_linux_<arch>\frps
```

第二次初始化直接走缓存，不再下载。

## 网络连不上 GitHub 时

1. 手动下载 `https://github.com/fatedier/frp/releases/download/v0.61.0/frp_0.61.0_linux_amd64.tar.gz`
2. 解压出 `frps`，放到上面那个缓存路径；
3. 或者放在程序目录的 `resources/frps/linux-amd64/frps`（便携版、开发模式会优先读这里）。

也可以给控制台设环境变量 `FRP_DOWNLOAD_MIRROR`（例如 `https://ghproxy.net/`），
程序会把官方 GitHub 地址拼在它后面。

## 为什么不打包了

两份 frps 未压缩合计 36 MB（NSIS 用 LZMA 压过之后约 14 MB），而绝大多数人只用其中一份、甚至不用。
剥离后安装包从 **94.7 MB → 80.9 MB**，安装解压阶段也明显变快；需要时再按架构下 18 MB，只下一次。
