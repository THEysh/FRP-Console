/* 真机剧本（tests/real/full-script.cjs）用的本机服务：
 * 根路径 404、/panel/ 200 —— 模仿 Go 面板这类「必须带路径前缀」的真实服务，
 * 这样既能量「隧道通不通」，也能量「访问路径填错时产品会不会说『路径 404』」。
 *
 * 必须放在 tests/real/ 下：剧本用 path.join(__dirname, 'local-404-service.cjs') 起它，
 * 之前这个文件根本不存在，子进程静默退出，剧本就一路报「本地服务不通」——
 * 看着像产品坏了，其实是测试自己缺文件。
 */
const http = require('http');

const port = Number(process.argv[2] || 18091);
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 page not found');
    return;
  }
  if (req.url.startsWith('/panel')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>panel-lab</title><h1>panel ok</h1>');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 page not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[real-local] http://127.0.0.1:${port}/ （根 404，/panel/ 200）`);
});
