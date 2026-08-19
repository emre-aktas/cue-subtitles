'use strict';

/**
 * Renders the Cue app icon straight to PNG and ICO — no image libraries, no toolchain.
 *
 *   node tools/make-icon.js
 *
 * The mark is the same caption-bar glyph the sidebar uses: two rows of subtitle bars
 * on a rounded indigo-to-violet square. Small sizes get a simplified two-bar version,
 * because four hairlines turn to mush below 32 px.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4;

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return rgb.map((v) => Math.round((v + m) * 255));
}

// Matches --primary and the sidebar mark's gradient end.
const GRAD_FROM = hslToRgb(252, 0.78, 0.56);
const GRAD_TO = hslToRgb(272, 0.74, 0.52);

/* ------------------------------------------------------------------ *
 * Geometry (all in the 24x24 space the sidebar SVG uses)
 * ------------------------------------------------------------------ */

/**
 * Two layouts, each drawn directly in the 24-unit space rather than scaled from the
 * other. Scaling the four-bar glyph down for a 16 px icon squeezes the gap between
 * rows as much as the bars themselves, and the rows merge into a blob.
 */
const LAYOUT_FULL = {
  bars: [
    [4, 8.5, 13, 8.5],
    [16.5, 8.5, 20, 8.5],
    [4, 15.5, 7.5, 15.5],
    [11, 15.5, 20, 15.5],
  ],
  thickness: 2.6,
  scale: 0.72, // inset the glyph from the tile edge
};

// Fewer, fatter, wider bars with a real gap between the rows.
const LAYOUT_SMALL = {
  bars: [
    [5.2, 9, 18.8, 9],
    [5.2, 15, 12.6, 15],
  ],
  thickness: 2.8,
  scale: 1,
};

/** Below this the four-bar glyph stops resolving into separate bars. */
const SMALL_BELOW = 32;

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a capsule (a thick line segment with round caps). */
function sdCapsule(px, py, x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) - r;
}

/**
 * Render one square RGBA bitmap. Coverage comes from supersampling rather than
 * analytic anti-aliasing — simpler, and at 4x4 per pixel the edges are clean.
 */
function renderIcon(size) {
  const layout = size < SMALL_BELOW ? LAYOUT_SMALL : LAYOUT_FULL;
  const { bars, scale: glyphScale } = layout;
  const barRadius = layout.thickness / 2;

  const cornerRadius = 24 * 0.215;

  const pixels = Buffer.alloc(size * size * 4);
  const sub = 1 / SUPERSAMPLE;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          // Normalised 0..24 coordinates of this subsample.
          const u = ((x + (sx + 0.5) * sub) / size) * 24;
          const v = ((y + (sy + 0.5) * sub) / size) * 24;

          if (sdRoundRect(u, v, 12, 12, 12, 12, cornerRadius) > 0) continue;

          // Diagonal gradient, roughly the 155deg of the CSS version.
          const t = Math.max(0, Math.min(1, (u * 0.42 + v * 0.58) / 24));
          let sr = GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t;
          let sg = GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t;
          let sb = GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t;

          // Glyph space: scale about the centre.
          const gu = 12 + (u - 12) / glyphScale;
          const gv = 12 + (v - 12) / glyphScale;
          const onBar = bars.some(([x1, y1, x2, y2]) => sdCapsule(gu, gv, x1, y1, x2, y2, barRadius) <= 0);
          if (onBar) {
            sr = 255;
            sg = 255;
            sb = 255;
          }

          r += sr;
          g += sg;
          b += sb;
          a += 255;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const i = (y * size + x) * 4;
      const alpha = a / samples;
      if (alpha > 0) {
        // Average only over covered samples so edge pixels keep their true hue.
        const covered = a / 255;
        pixels[i] = Math.round(r / covered);
        pixels[i + 1] = Math.round(g / covered);
        pixels[i + 2] = Math.round(b / covered);
      }
      pixels[i + 3] = Math.round(alpha);
    }
  }

  return pixels;
}

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * ICO packing (PNG-compressed entries, supported since Windows Vista)
 * ------------------------------------------------------------------ */

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    dir[at] = entry.size >= 256 ? 0 : entry.size; // 0 means 256
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 2] = 0; // palette size
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(entry.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const entries = ICO_SIZES.map((size) => ({ size, png: encodePng(size, renderIcon(size)) }));
  const ico = encodeIco(entries);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`icon.ico   ${ICO_SIZES.join(', ')} px  ${(ico.length / 1024).toFixed(1)} KB`);

  // 1024 px master, used for Linux/macOS packaging and documentation.
  const master = encodePng(1024, renderIcon(1024));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), master);
  console.log(`icon.png   1024 px  ${(master.length / 1024).toFixed(1)} KB`);

  // 512 px for the readme.
  const preview = encodePng(512, renderIcon(512));
  fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), preview);
  console.log(`icon-512.png  512 px  ${(preview.length / 1024).toFixed(1)} KB`);
}

main();
