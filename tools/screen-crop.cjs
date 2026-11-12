'use strict';
/*
 * 通用屏幕裁剪放大（从右下角定位），用于核对任务栏/通知区细节。
 * 用法：npx electron tools/screen-crop.cjs --no-sandbox --right=700 --bottom=60 --scale=4 --out=tray-zoom
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, desktopCapturer, screen } = require('electron');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

app.whenReady().then(async () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  const w = Math.min(Number(arg('right', 700)), width);
  const h = Math.min(Number(arg('bottom', 60)), height);
  const scale = Number(arg('scale', 4));
  const out = path.join(__dirname, '..', '.shots');
  fs.mkdirSync(out, { recursive: true });
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  const area = sources[0].thumbnail.crop({ x: width - w, y: height - h, width: w, height: h });
  const file = path.join(out, `${arg('out', 'crop')}.png`);
  fs.writeFileSync(file, area.resize({ width: Math.round(w * scale) }).toPNG());
  console.log(`saved ${file} (${w}x${h} @${scale}x)`);
  app.exit(0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
