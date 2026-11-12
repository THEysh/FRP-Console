'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { logLevelOf, parseTimestamp } = require('./util');

function parseLine(raw, id) {
  const text = raw.replace(/\r$/, '');
  if (!text.trim()) return null;
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

  clear() {
    this.lines = [];
  }
}

module.exports = { LogFollower, parseLine };
