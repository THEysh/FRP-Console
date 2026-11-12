'use strict';
/*
 * 生成托盘状态图标：assets/tray-{online,idle,error}.png
 *
 * 为什么手写 PNG：项目不引图形库，Windows 上 Add-Type/System.Drawing 又常被安全策略拦。
 * 这里只用 node:zlib + 手算 CRC，画一个 32x32 的圆角方块 + 字母 F + 右下角状态点。
 *
 * 用法：npm run tray-icons   （只在图标要改时才需要跑，产物已随仓库跟踪）
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 32;
const RADIUS = 7;

const COLORS = {
  bg: [13, 19, 28, 255], // #0d131c 深色底
  bgEdge: [32, 44, 60, 255], // 描边，避免在浅色任务栏上糊成一团
  fg: [34, 211, 238, 255], // #22d3ee 主色
  online: [34, 197, 94, 255], // #22c55e
  idle: [120, 133, 150, 255], // #788596
  error: [239, 68, 68, 255], // #ef4444
  ring: [13, 19, 28, 255], // 状态点外圈的“挖空”色，和底色一致
};

/* ------------------------------- PNG 编码 ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------- 绘制 -------------------------------- */

function makeCanvas(size) {
  return Buffer.alloc(size * size * 4, 0);
}

function put(buf, size, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  if (alpha >= 1) {
    buf[i] = color[0];
    buf[i + 1] = color[1];
    buf[i + 2] = color[2];
    buf[i + 3] = color[3] === undefined ? 255 : color[3];
    return;
  }
  // 简单 source-over 混合，只处理不透明底图
  const a = alpha;
  buf[i] = Math.round(color[0] * a + buf[i] * (1 - a));
  buf[i + 1] = Math.round(color[1] * a + buf[i + 1] * (1 - a));
  buf[i + 2] = Math.round(color[2] * a + buf[i + 2] * (1 - a));
  const srcA = (color[3] === undefined ? 255 : color[3]) * a;
  buf[i + 3] = Math.min(255, Math.round(srcA + buf[i + 3] * (1 - a)));
}

/* 圆角矩形：4x 超采样描边，边缘不发毛 */
function roundRect(buf, size, x0, y0, w, h, r, color) {
  const SS = 4;
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const dx = Math.max(x0 + r - px, px - (x0 + w - r), 0);
          const dy = Math.max(y0 + r - py, py - (y0 + h - r), 0);
          if (dx * dx + dy * dy <= r * r) hits += 1;
        }
      }
      if (hits) put(buf, size, x, y, color, hits / (SS * SS));
    }
  }
}

function disc(buf, size, cx, cy, r, color) {
  const SS = 4;
  const x0 = Math.floor(cx - r - 1);
  const x1 = Math.ceil(cx + r + 1);
  const y0 = Math.floor(cy - r - 1);
  const y1 = Math.ceil(cy + r + 1);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) hits += 1;
        }
      }
      if (hits) put(buf, size, x, y, color, hits / (SS * SS));
    }
  }
}

/* 字母 F：竖笔 + 上横 + 中横，按 32 网格取整，缩放时用比例算 */
function drawF(buf, size) {
  const s = size / 32;
  const rect = (x, y, w, h) => roundRect(buf, size, Math.round(x * s), Math.round(y * s), Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)), Math.max(0.6, 1.2 * s), COLORS.fg);
  rect(9.5, 7.5, 4.2, 17); // 竖笔
  rect(9.5, 7.5, 12.5, 4.2); // 上横
  rect(9.5, 14.6, 9, 3.6); // 中横
}

function makeIcon(state, size = SIZE) {
  const buf = makeCanvas(size);
  const s = size / SIZE;
  // 底：稍大一圈的深色描边 + 主体
  roundRect(buf, size, Math.round(1 * s), Math.round(1 * s), Math.round((SIZE - 2) * s), Math.round((SIZE - 2) * s), Math.max(1, Math.round(RADIUS * s)), COLORS.bgEdge);
  roundRect(buf, size, Math.round(2 * s), Math.round(2 * s), Math.round((SIZE - 4) * s), Math.round((SIZE - 4) * s), Math.max(1, Math.round((RADIUS - 1) * s)), COLORS.bg);
  drawF(buf, size);
  // 右下角状态点：先挖一圈底色当描边，再画实心
  disc(buf, size, 24 * s, 24 * s, 7.2 * s, COLORS.ring);
  disc(buf, size, 24 * s, 24 * s, 5.2 * s, COLORS[state]);
  return encodePng(size, size, buf);
}

const outDir = path.join(__dirname, '..', 'assets');
for (const state of ['online', 'idle', 'error']) {
  const file = path.join(outDir, `tray-${state}.png`);
  fs.writeFileSync(file, makeIcon(state));
  console.log(`[tray] ${path.relative(path.join(__dirname, '..'), file)} ${fs.statSync(file).size}B`);
}

// 16px 版只看不进包：托盘在 100% DPI 下就是 16×16，
// 改图标后跑 `node tools/make-tray-icons.cjs 16` 生成到 .shots/ 里肉眼确认可读性。
if (process.argv[2] === '16') {
  const shotDir = path.join(__dirname, '..', '.shots');
  fs.mkdirSync(shotDir, { recursive: true });
  for (const state of ['online', 'idle', 'error']) {
    const file = path.join(shotDir, `tray16-${state}.png`);
    fs.writeFileSync(file, makeIcon(state, 16));
    console.log(`[tray] ${path.relative(path.join(__dirname, '..'), file)} (16px 预览)`);
  }
}
