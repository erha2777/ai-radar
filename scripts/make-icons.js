'use strict';

/**
 * 应用图标生成器（零依赖）。
 *
 * 手工拼接 PNG：Chunk 结构 + zlib 压缩的扫描线。
 * 图案为「深色圆角方块 + 品牌色雷达同心圆 + 中心亮点」，36px 与 256px 各生成一份。
 *
 * 用法：node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 把 RGBA 像素数组编码为 PNG Buffer。 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  // 每行前置一个 filter 字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 绘制图标。
 * 坐标系归一化到 [0,1]，用 4x4 超采样做抗锯齿。
 */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const SS = 4; // 超采样倍数

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.5;
  const cornerRadius = size * 0.24;

  // 品牌色
  const bgTop = [0x12, 0x16, 0x2b];
  const bgBottom = [0x0a, 0x1a, 0x2e];
  const ringColor = [0x38, 0xbd, 0xf8];
  const ringColor2 = [0x81, 0x8c, 0xf8];
  const coreColor = [0x7d, 0xf9, 0xff];

  const inRoundedSquare = (x, y) => {
    const dx = Math.max(cornerRadius - x, 0, x - (size - cornerRadius));
    const dy = Math.max(cornerRadius - y, 0, y - (size - cornerRadius));
    if (dx === 0 && dy === 0) return x >= 0 && y >= 0 && x <= size && y <= size;
    return dx * dx + dy * dy <= cornerRadius * cornerRadius;
  };

  // 同心圆环：归一化半径与粗细
  const rings = [
    { r: 0.34, w: 0.035, color: ringColor },
    { r: 0.24, w: 0.028, color: ringColor2 }
  ];
  const coreR = 0.095;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          if (!inRoundedSquare(px, py)) continue;

          // 背景竖直渐变
          const t = py / size;
          let r = Math.round(bgTop[0] + (bgBottom[0] - bgTop[0]) * t);
          let g = Math.round(bgTop[1] + (bgBottom[1] - bgTop[1]) * t);
          let b = Math.round(bgTop[2] + (bgBottom[2] - bgTop[2]) * t);
          let a = 255;

          const dx = px - cx;
          const dy = py - cy;
          const dist = Math.sqrt(dx * dx + dy * dy) / radius;

          // 由外到内叠加圆环
          for (const ring of rings) {
            if (dist <= ring.r + ring.w / 2 && dist >= ring.r - ring.w / 2) {
              // 环边缘做一点羽化，避免锯齿
              const edge = Math.min(
                ring.r + ring.w / 2 - dist,
                dist - (ring.r - ring.w / 2)
              );
              const alpha = Math.min(1, edge / (ring.w * 0.35));
              r = Math.round(r * (1 - alpha) + ring.color[0] * alpha);
              g = Math.round(g * (1 - alpha) + ring.color[1] * alpha);
              b = Math.round(b * (1 - alpha) + ring.color[2] * alpha);
            }
          }

          // 中心亮点（带柔和外发光）
          if (dist <= coreR) {
            const edge = coreR - dist;
            const alpha = Math.min(1, edge / (coreR * 0.3));
            r = Math.round(r * (1 - alpha) + coreColor[0] * alpha);
            g = Math.round(g * (1 - alpha) + coreColor[1] * alpha);
            b = Math.round(b * (1 - alpha) + coreColor[2] * alpha);
          } else if (dist <= coreR * 1.5) {
            const glow = 1 - (dist - coreR) / (coreR * 0.5);
            const alpha = glow * 0.35;
            r = Math.round(r * (1 - alpha) + coreColor[0] * alpha);
            g = Math.round(g * (1 - alpha) + coreColor[1] * alpha);
            b = Math.round(b * (1 - alpha) + coreColor[2] * alpha);
          }

          accR += r;
          accG += g;
          accB += b;
          accA += a;
        }
      }

      const n = SS * SS;
      const idx = (y * size + x) * 4;
      if (accA === 0) continue;
      const cover = accA / (n * 255);
      rgba[idx] = Math.round(accR / (accA / 255));
      rgba[idx + 1] = Math.round(accG / (accA / 255));
      rgba[idx + 2] = Math.round(accB / (accA / 255));
      rgba[idx + 3] = Math.round(cover * 255);
    }
  }

  return encodePng(size, size, rgba);
}

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const assetsDir = path.join(root, 'src', 'renderer', 'assets');
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

const targets = [
  { file: path.join(buildDir, 'icon.png'), size: 256 },
  { file: path.join(assetsDir, 'icon.png'), size: 256 },
  { file: path.join(assetsDir, 'tray.png'), size: 32 },
  { file: path.join(assetsDir, 'tray@2x.png'), size: 64 }
];

for (const t of targets) {
  fs.writeFileSync(t.file, drawIcon(t.size));
  console.log(`生成 ${path.relative(root, t.file)}  (${t.size}x${t.size}, ${fs.statSync(t.file).size} 字节)`);
}
console.log('图标生成完成 ✔');
