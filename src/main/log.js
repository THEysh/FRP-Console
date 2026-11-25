'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { logLevelOf, parseTimestamp } = require('./util');

/* 控制台每 3 秒查一次 /api/status，frpc 就以 info 级别把每次请求和响应各写一行。
 * 实测隧道跑 31 秒 42 行日志里有 36 行是这种东西（86%），
 * 600 行的缓冲只够存 9 分钟，真正的报错转眼被冲走。
 * 这类“自己轮询出来的”行在日志页里没有任何信息量，直接不收集。
 *
 * 注意 frp 0.61 的措辞是 `api request/response [/api/status]`（早先版本是
 * `Http request/response …`），只匹配旧写法会让噪声全部漏进来 —— 两种都要认。
 * `/api/config` 是控制台自己每分钟做一次「这个 frpc 是不是在用我的配置」的核对
 * （frpc.js probeForeignOwner），同样是我们自己刷出来的，一并丢掉。 */
const ADMIN_POLL_NOISE = /\[client\/admin_api\.go:\d+\]\s*(?:Http(?:\s+(?:get|post))?\s+|api\s+)(?:request|response)\s+\[\/api\/(?:status|config)\]/i;

/* frpc 往控制台（log.to = "console"）输出时会给每行加 ANSI 颜色，
 * 例如 `\u001b[0m\u001b[1;34m2026-11-18 …`。这些转义序列在日志页里就是
 * 一串 `[0m[1;34m` 垃圾，必须在解析前剥掉（文件日志没有颜色，两种来源都能过一遍）。 */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;

function stripAnsi(text) {
  const raw = String(text == null ? '' : text);
  return raw.includes('\u001b') ? raw.replace(ANSI_ESCAPE, '') : raw;
}

/* 单行上限。frpc 偶尔会把整份 JSON / 证书 / 请求体打进一行，
 * 那种行既看不懂又拖慢 IPC 与渲染（实测 200 KB 一行会让刷新从 130ms 涨到 520ms）。 */
const MAX_LINE_CHARS = 2000;

function clampLine(text) {
  if (text.length <= MAX_LINE_CHARS) return text;
  const rest = text.length - MAX_LINE_CHARS;
  return text.slice(0, MAX_LINE_CHARS) + `…（这一行共 ${text.length} 字符，已截断后面 ${rest} 个）`;
}

/* 行首的时间戳与级别标记：界面上已经单独占了两列，正文里再带一遍纯属噪音（1.2.206）。
 * frp 的两种写法都要认：`2026-11-26 00:17:24.612 [I] …`（文件）与带 ANSI 的 console 版本（已被 stripAnsi 处理）。 */
const LEADING_META = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*/;
const LEADING_LEVEL = /^\[[DIWETF]\]\s*/;

function stripLeadingMeta(text) {
  let out = String(text == null ? '' : text);
  const before = out;
  out = out.replace(LEADING_META, '');
  out = out.replace(LEADING_LEVEL, '');
  /* 全是前缀（比如只有时间戳的行）时保留原文，别把整行变空。 */
  return out.trim() ? out : before;
}

function parseLine(raw, id) {
  let text = stripAnsi(raw).replace(/\r$/, '');
  if (!text.trim()) return null;
  if (ADMIN_POLL_NOISE.test(text)) return null;
  text = clampLine(text);
  const ts = parseTimestamp(text);
  const level = logLevelOf(text);
  const time = ts
    ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  return {
    id,
    ts,
    time,
    level,
    /* body 只给界面显示用；text 是原文，导出/复制/悬停都用它 */
    body: stripLeadingMeta(text),
    text,
  };
}

class LogFollower extends EventEmitter {
  constructor(file, { maxLines = 600, interval = 900 } = {}) {
    super();
    this.file = file || '';
    this.maxLines = maxLines;
    this.interval = interval;
    this.timer = null;
    this.offset = 0;
    this.pending = '';
    this.lines = [];
    this.seq = 0;
    this.started = false;
  }

  setFile(file) {
    if (!file || file === this.file) return;
    const wasStarted = this.started;
    this.stop();
    this.file = file;
    /* 换文件必须清空旧内容：否则日志页会一直显示上一份配置的日志，
     * 概览页判定“连不上服务器”时也会拿过期错误当现状。 */
    this.lines = [];
    this.seq = 0;
    if (wasStarted) this.start(); // start() 内部会 bootstrap 新文件的尾部
    // 放在 bootstrap 之后发，监听方才能拿到新文件的日志而不是空数组。
    this.emit('reset');
  }

  start() {
    if (this.timer) return;
    this.started = true;
    this.reset(true);
    this.timer = setInterval(() => this.poll(), this.interval);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset(initialRead = false) {
    this.offset = 0;
    this.pending = '';
    if (initialRead) this.bootstrap();
  }

  bootstrap() {
    if (!this.file) return;
    try {
      const stat = fs.statSync(this.file);
      const size = stat.size;
      const readSize = Math.min(size, 512 * 1024);
      const start = Math.max(0, size - readSize);
      const data = this.readRange(start, size);
      this.offset = size;
      const text = data.toString('utf8');
      const parts = text.split('\n');
      const wanted = parts.slice(Math.max(0, parts.length - this.maxLines));
      for (const part of wanted) {
        const line = parseLine(part, ++this.seq);
        if (line) this.pushLine(line);
      }
      if (text.endsWith('\n')) this.pending = '';
      else this.pending = parts[parts.length - 1] || '';
    } catch {
      this.offset = 0;
    }
  }

  readRange(start, end) {
    const fd = fs.openSync(this.file, 'r');
    try {
      const buffer = Buffer.alloc(end - start);
      let read = 0;
      while (read < buffer.length) {
        const n = fs.readSync(fd, buffer, read, buffer.length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      return buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  }

  pushLine(line) {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }

  poll() {
    if (!this.file) return;
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return;
    }
    if (stat.size <= this.offset) {
      if (stat.size < this.offset) {
        this.offset = 0;
        this.pending = '';
        this.emit('reset');
      }
      return;
    }
    let data;
    try {
      data = this.readRange(this.offset, stat.size);
    } catch {
      return;
    }
    this.offset = stat.size;
    const chunk = this.pending + data.toString('utf8');
    const parts = chunk.split('\n');
    this.pending = parts.pop() || '';
    const added = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      const line = parseLine(part, ++this.seq);
      if (!line) continue;
      this.pushLine(line);
      added.push(line);
    }
    if (added.length) this.emit('lines', added);
  }

  recent(limit = this.maxLines) {
    return this.lines.slice(-limit);
  }

  /* 追加外部来源的行（frpc 子进程的 stdout/stderr）。
   * log.to = "console" 时 frpc 只往标准输出写、不落文件，只跟随文件的话
   * 日志页会一直停在上一次的内容；这里让进程输出也进同一个缓冲。
   * console 输出的行常常没有时间戳前缀，补上接收时间，界面上才不会显示空白时间。 */
  appendLines(text) {
    const added = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line = parseLine(raw, ++this.seq);
      if (!line) continue;
      if (!line.ts) {
        line.ts = Date.now();
        line.time = new Date(line.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      this.pushLine(line);
      added.push(line);
    }
    if (added.length) this.emit('lines', added);
    return added.length;
  }

  clear() {
    this.lines = [];
  }
}

module.exports = { clampLine, MAX_LINE_CHARS, LogFollower, parseLine, stripLeadingMeta };
