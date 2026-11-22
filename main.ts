// THE WORLD IN ONE DAY — Sunday 22 November 2026.
// A broadsheet that sums up the day's world news in one 1024x1024 PNG.
// Written fresh for news-image-20261122. Node 22, standard library only,
// no network, deterministic: the same bytes on every run.
//
// The program draws everything itself: a small TrueType reader and glyph
// rasteriser (Liberation Serif, bundled beside this file), a canvas of
// drawing primitives, and a layout for masthead, stats, three heroes,
// ten small panels, a world map, a 23-item wire list, a date check and a
// footer. Every fact on the page was checked against a named source on
// 22 November 2026; the DATE CHECK box names the big pre-day stories
// that were deliberately left out.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// CRC32 and the PNG writer (RGB, 8 bit, one filter choice per row).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function writePng(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = new Uint8Array(h * (1 + w * 3));
  const bpp = 3;
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * w * 3, (y + 1) * w * 3);
    const prev = y > 0 ? rgb.subarray((y - 1) * w * 3, y * w * 3) : null;
    // Try filters 0 (none), 1 (sub), 2 (up) and 4 (Paeth); keep the one
    // whose filtered bytes have the smallest absolute sum. Deterministic.
    let bestF = 0;
    let bestScore = Infinity;
    let best = new Uint8Array(w * 3);
    for (let f = 0; f <= 4; f++) {
      if (f === 3) continue;
      const out = new Uint8Array(w * 3);
      let score = 0;
      for (let x = 0; x < w * 3; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= bpp ? prev[x - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (row[x] - pred) & 0xff;
        out[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestF = f;
        best = out;
      }
    }
    raw[y * (1 + w * 3)] = bestF;
    raw.set(best, y * (1 + w * 3) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

// ---------------------------------------------------------------------------
// A small TrueType reader: cmap format 4, hmtx, loca, glyf. Quadratic
// outlines are flattened and filled with a non-zero scanline fill at 2x
// supersampling, then downsampled for anti-aliasing. Composite glyphs are
// followed through their components (offsets and 2x2 transforms).
// ---------------------------------------------------------------------------

type GlyphOutline = { contours: number[][][] }; // contours of [x, y] points (already flattened)

class TTF {
  upem: number;
  numGlyphs: number;
  private cmap4: DataView | null = null;
  private cmap4Off = 0;
  private hmtx: DataView;
  private numHMetrics: number;
  private loca: DataView;
  private locaShort: boolean;
  private glyf: Buffer;
  private cache = new Map<string, { bmp: Uint8Array; w: number; h: number; ox: number; oy: number; adv: number }>();

  constructor(buf: Buffer) {
    const u16 = (o: number) => buf.readUInt16BE(o);
    const i16 = (o: number) => buf.readInt16BE(o);
    const u32 = (o: number) => buf.readUInt32BE(o);
    const tables = new Map<string, number>();
    const n = u16(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      tables.set(buf.toString("ascii", o, o + 4), u32(o + 8));
    }
    const need = (tag: string) => {
      const v = tables.get(tag);
      if (v === undefined) throw new Error("missing table " + tag);
      return v;
    };
    this.upem = u16(need("head") + 18);
    this.numGlyphs = u16(need("maxp") + 4);
    this.numHMetrics = u16(need("hhea") + 34);
    this.hmtx = new DataView(buf.buffer, buf.byteOffset + need("hmtx"), buf.length - need("hmtx"));
    this.locaShort = i16(need("head") + 50) === 0;
    const locaOff = need("loca");
    this.loca = new DataView(buf.buffer, buf.byteOffset + locaOff, buf.length - locaOff);
    const glyfOff = need("glyf");
    this.glyf = buf.subarray(glyfOff);
    // cmap: prefer platform 3 encoding 1, else platform 0; format 4 only.
    const cmapOff = need("cmap");
    const nSub = u16(cmapOff + 2);
    let chosen = -1;
    for (let i = 0; i < nSub; i++) {
      const p = u16(cmapOff + 4 + i * 8);
      const e = u16(cmapOff + 6 + i * 8);
      const off = u32(cmapOff + 8 + i * 8);
      if (p === 3 && e === 1) {
        chosen = cmapOff + off;
        break;
      }
      if (chosen < 0 && p === 0) chosen = cmapOff + off;
    }
    if (chosen >= 0 && u16(chosen) === 4) {
      this.cmap4 = new DataView(buf.buffer, buf.byteOffset, buf.length);
      this.cmap4Off = chosen;
    }
  }

  glyphIndex(ch: number): number {
    if (!this.cmap4) return 0;
    const dv = this.cmap4;
    const o = this.cmap4Off;
    const segCount = dv.getUint16(o + 6) / 2;
    // Binary search endCode for the first segment whose end >= ch.
    let lo = 0;
    let hi = segCount - 1;
    let seg = -1;
    const endBase = o + 14;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const end = dv.getUint16(endBase + mid * 2);
      if (ch <= end) {
        seg = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    if (seg < 0) return 0;
    const startBase = endBase + segCount * 2 + 2;
    const start = dv.getUint16(startBase + seg * 2);
    if (ch < start) return 0;
    const deltaBase = startBase + segCount * 2;
    const rangeBase = deltaBase + segCount * 2;
    const delta = dv.getInt16(deltaBase + seg * 2);
    const rangeOff = dv.getUint16(rangeBase + seg * 2);
    if (rangeOff === 0) return (ch + delta) & 0xffff;
    const glyphOff = rangeBase + seg * 2 + rangeOff + (ch - start) * 2;
    const g = dv.getUint16(glyphOff);
    return g === 0 ? 0 : (g + delta) & 0xffff;
  }

  advance(gid: number): number {
    const i = Math.min(gid, this.numHMetrics - 1);
    return this.hmtx.getUint16(i * 4);
  }

  private glyphOffset(gid: number): [number, number] {
    if (this.locaShort) {
      return [this.loca.getUint16(gid * 2) * 2, this.loca.getUint16((gid + 1) * 2) * 2];
    }
    return [this.loca.getUint32(gid * 4), this.loca.getUint32((gid + 1) * 4)];
  }

  // Outline of one glyph in font units, as flattened contours.
  outline(gid: number): number[][][] {
    const [start, end] = this.glyphOffset(gid);
    if (end <= start) return [];
    const g = this.glyf.subarray(start, end);
    const nContours = g.readInt16BE(0);
    if (nContours >= 0) return this.simpleOutline(g, nContours);
    // Composite: walk components, apply each 2x2 transform + offset.
    const out: number[][][] = [];
    let p = 10;
    while (true) {
      const flags = g.readUInt16BE(p);
      const comp = g.readUInt16BE(p + 2);
      p += 4;
      let dx = 0;
      let dy = 0;
      if (flags & 0x0001) {
        if (flags & 0x0002) {
          dx = g.readInt16BE(p);
          dy = g.readInt16BE(p + 2);
          p += 4;
        } else {
          dx = g.readInt8(p);
          dy = g.readInt8(p + 1);
          p += 2;
        }
      } else {
        // Anchor-point matching: not used by the fonts we bundle; treat as 0.
        p += flags & 0x0002 ? 4 : 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & 0x0008) {
        const s = g.readInt16BE(p) / 16384;
        a = s;
        d = s;
        p += 2;
      } else if (flags & 0x0080) {
        a = g.readInt16BE(p) / 16384;
        d = g.readInt16BE(p + 2) / 16384;
        p += 4;
      } else if (flags & 0x0100) {
        a = g.readInt16BE(p) / 16384;
        b = g.readInt16BE(p + 2) / 16384;
        c = g.readInt16BE(p + 4) / 16384;
        d = g.readInt16BE(p + 6) / 16384;
        p += 8;
      }
      for (const contour of this.outline(comp)) {
        out.push(contour.map(([x, y]) => [a * x + c * y + dx, b * x + d * y + dy]));
      }
      if (flags & 0x0020) continue;
      break;
    }
    return out;
  }

  private simpleOutline(g: Buffer, nContours: number): number[][][] {
    const endPts: number[] = [];
    for (let i = 0; i < nContours; i++) endPts.push(g.readUInt16BE(10 + i * 2));
    const nPts = endPts.length ? endPts[nContours - 1] + 1 : 0;
    const instrLen = g.readUInt16BE(10 + nContours * 2);
    let p = 10 + nContours * 2 + 2 + instrLen;
    const flags: number[] = [];
    while (flags.length < nPts) {
      const f = g[p++];
      flags.push(f);
      if (f & 0x08) {
        const rep = g[p++];
        for (let i = 0; i < rep; i++) flags.push(f);
      }
    }
    const xs: number[] = [];
    const ys: number[] = [];
    let x = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 0x02) {
        const v = g[p++];
        x += f & 0x10 ? v : -v;
      } else if (!(f & 0x10)) {
        x += g.readInt16BE(p);
        p += 2;
      }
      xs.push(x);
    }
    let y = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 0x04) {
        const v = g[p++];
        y += f & 0x20 ? v : -v;
      } else if (!(f & 0x20)) {
        y += g.readInt16BE(p);
        p += 2;
      }
      ys.push(y);
    }
    const contours: number[][][] = [];
    let start = 0;
    for (let ci = 0; ci < nContours; ci++) {
      const end = endPts[ci];
      const pts: { x: number; y: number; on: boolean }[] = [];
      for (let i = start; i <= end; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) !== 0 });
      contours.push(this.flattenContour(pts));
      start = end + 1;
    }
    return contours;
  }

  // Expand a TrueType contour (on/off-curve points, quadratic splines)
  // into a flat polygon. Implied on-curve points sit between two
  // consecutive off-curve points; a contour of only off-curve points
  // starts at the midpoint of its last and first points.
  private flattenContour(pts: { x: number; y: number; on: boolean }[]): number[][] {
    if (pts.length === 0) return [];
    const n = pts.length;
    // Build an expanded ring that starts on an on-curve point and
    // alternates on/off, with implied midpoints inserted wherever two
    // off-curve points sit side by side.
    const ring: { x: number; y: number; on: boolean }[] = [];
    const startIdx = pts.findIndex((q) => q.on);
    if (startIdx < 0) {
      ring.push({ x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2, on: true });
      for (let i = 0; i < n; i++) ring.push(pts[i]);
    } else {
      for (let i = 0; i < n; i++) ring.push(pts[(startIdx + i) % n]);
    }
    // Insert implied midpoints between consecutive off-curve points.
    const exp: { x: number; y: number; on: boolean }[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      exp.push(a);
      if (!a.on && !b.on) {
        exp.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
      }
    }
    const out: number[][] = [];
    let i = 0;
    while (i < exp.length) {
      const p0 = exp[i];
      out.push([p0.x, p0.y]);
      const p1 = exp[(i + 1) % exp.length];
      if (p1.on) {
        i++;
        continue;
      }
      const p2 = exp[(i + 2) % exp.length];
      // Subdivide the quadratic Bezier; 10 steps is plenty at our sizes.
      for (let s = 1; s <= 10; s++) {
        const t = s / 10;
        const mt = 1 - t;
        out.push([mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x, mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y]);
      }
      i += 2;
    }
    return out;
  }

  // Rasterise one glyph at a pixel size into a greyscale bitmap.
  raster(gid: number, px: number): { bmp: Uint8Array; w: number; h: number; ox: number; oy: number; adv: number } {
    const key = gid + ":" + px;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const scale = px / this.upem;
    const adv = this.advance(gid) * scale;
    const contours = this.outline(gid);
    const SS = 2; // supersample factor
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of contours) {
      for (const [x, y] of c) {
        minX = Math.min(minX, x * scale);
        maxX = Math.max(maxX, x * scale);
        minY = Math.min(minY, -y * scale);
        maxY = Math.max(maxY, -y * scale);
      }
    }
    if (!isFinite(minX)) {
      const empty = { bmp: new Uint8Array(0), w: 0, h: 0, ox: 0, oy: 0, adv };
      this.cache.set(key, empty);
      return empty;
    }
    const ox = Math.floor(minX);
    const oy = Math.floor(minY);
    const w = Math.ceil(maxX) - ox + 1;
    const h = Math.ceil(maxY) - oy + 1;
    const sw = w * SS;
    const sh = h * SS;
    const cover = new Float32Array(sw * sh);
    // Non-zero winding scanline fill at supersampled resolution.
    for (const contour of contours) {
      const pts = contour.map(([x, y]) => [x * scale * SS - ox * SS, -y * scale * SS - oy * SS]);
      const m = pts.length;
      for (let i = 0; i < m; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[(i + 1) % m];
        if (y0 === y1) continue;
        const yTop = Math.min(y0, y1);
        const yBot = Math.max(y0, y1);
        const dir = y1 > y0 ? 1 : -1;
        const yStart = Math.max(0, Math.ceil(yTop - 0.5));
        const yEnd = Math.min(sh - 1, Math.floor(yBot - 0.5));
        for (let yy = yStart; yy <= yEnd; yy++) {
          const yc = yy + 0.5;
          const xInt = x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0);
          const xi = Math.max(0, Math.min(sw - 1, Math.floor(xInt)));
          for (let xx = xi; xx < sw; xx++) cover[yy * sw + xx] += dir;
        }
      }
    }
    const bmp = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        let sum = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            if (cover[(yy * SS + sy) * sw + xx * SS + sx] !== 0) sum++;
          }
        }
        bmp[yy * w + xx] = Math.round((sum / (SS * SS)) * 255);
      }
    }
    const res = { bmp, w, h, ox, oy, adv };
    this.cache.set(key, res);
    return res;
  }
}

// ---------------------------------------------------------------------------
// Canvas: an RGB buffer with filled rectangles, lines, circles, polygons,
// and text drawn through the TrueType rasteriser above.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];
const PAPER: RGB = [246, 241, 229];
const INK: RGB = [20, 20, 20];
const RED: RGB = [160, 28, 33];
const BLUE: RGB = [29, 58, 95];
const TEAL: RGB = [28, 110, 110];
const GOLD: RGB = [176, 138, 28];
const GREEN: RGB = [46, 107, 52];
const SKY: RGB = [178, 208, 226];
const SAND: RGB = [232, 214, 176];
const LIGHT: RGB = [233, 226, 208];
const RULE: RGB = [185, 176, 154];
const WHITE: RGB = [255, 255, 255];

class Canvas {
  buf: Uint8Array;
  w: number;
  h: number;
  constructor(w: number, h: number, bg: RGB) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8Array(w * h * 3);
    this.fillRect(0, 0, w, h, bg);
  }
  set(x: number, y: number, c: RGB) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.buf[i] = c[0];
    this.buf[i + 1] = c[1];
    this.buf[i + 2] = c[2];
  }
  blend(x: number, y: number, c: RGB, a: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    if (a >= 1) return this.set(x, y, c);
    const i = (y * this.w + x) * 3;
    this.buf[i] = Math.round(this.buf[i] * (1 - a) + c[0] * a);
    this.buf[i + 1] = Math.round(this.buf[i + 1] * (1 - a) + c[1] * a);
    this.buf[i + 2] = Math.round(this.buf[i + 2] * (1 - a) + c[2] * a);
  }
  fillRect(x: number, y: number, w: number, h: number, c: RGB) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c);
    }
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, t = 1) {
    this.fillRect(x, y, w, t, c);
    this.fillRect(x, y + h - t, w, t, c);
    this.fillRect(x, y, t, h, c);
    this.fillRect(x + w - t, y, t, h, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, t = 1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + (dx * i) / steps);
      const y = Math.round(y0 + (dy * i) / steps);
      if (t <= 1) this.set(x, y, c);
      else this.fillRect(x - ((t - 1) >> 1), y - ((t - 1) >> 1), t, t, c);
    }
  }
  circle(cx: number, cy: number, r: number, c: RGB) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, c);
      }
    }
  }
  ring(cx: number, cy: number, r: number, c: RGB, t = 2) {
    for (let a = 0; a < 360; a += 1) {
      const rad = (a * Math.PI) / 180;
      for (let k = 0; k < t; k++) {
        this.set(Math.round(cx + (r - k) * Math.cos(rad)), Math.round(cy + (r - k) * Math.sin(rad)), c);
      }
    }
  }
  // Even-odd polygon fill.
  poly(pts: number[][], c: RGB) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of pts) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[(i + 1) % pts.length];
        if ((y0 <= y + 0.5 && y1 > y + 0.5) || (y1 <= y + 0.5 && y0 > y + 0.5)) {
          xs.push(x0 + ((y + 0.5 - y0) * (x1 - x0)) / (y1 - y0));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) this.set(x, y, c);
      }
    }
  }
  tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: RGB) {
    this.poly([[x0, y0], [x1, y1], [x2, y2]], c);
  }
}

// ---------------------------------------------------------------------------
// Text: three faces of one serif family, word wrap, alignment, tracking.
// ---------------------------------------------------------------------------

const REG = new TTF(readFileSync(join(HERE, "LiberationSerif-Regular.ttf")));
const BOLD = new TTF(readFileSync(join(HERE, "LiberationSerif-Bold.ttf")));
const ITAL = new TTF(readFileSync(join(HERE, "LiberationSerif-Italic.ttf")));

type Face = "reg" | "bold" | "ital";
function faceOf(f: Face): TTF {
  return f === "bold" ? BOLD : f === "ital" ? ITAL : REG;
}

function textWidth(s: string, px: number, f: Face): number {
  const font = faceOf(f);
  let w = 0;
  for (const ch of s) w += font.raster(font.glyphIndex(ch.codePointAt(0)!), px).adv;
  return w;
}

function drawText(cv: Canvas, s: string, x: number, y: number, px: number, f: Face, c: RGB, tracking = 0) {
  const font = faceOf(f);
  let cx = Math.round(x);
  const baseline = Math.round(y);
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const gid = font.glyphIndex(code);
    const g = font.raster(gid, px);
    for (let yy = 0; yy < g.h; yy++) {
      for (let xx = 0; xx < g.w; xx++) {
        const a = g.bmp[yy * g.w + xx] / 255;
        if (a > 0) cv.blend(cx + g.ox + xx, baseline + g.oy + yy, c, a);
      }
    }
    cx += g.adv + tracking;
  }
  return cx;
}

function wrapText(s: string, px: number, f: Face, maxW: number, tracking = 0): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const trial = cur ? cur + " " + word : word;
    if (textWidth(trial, px, f) + tracking * Math.max(0, trial.length - 1) <= maxW || !cur) cur = trial;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawPara(cv: Canvas, s: string, x: number, y: number, maxW: number, px: number, f: Face, c: RGB, lh: number, maxLines = 99, tracking = 0): number {
  const lines = wrapText(s, px, f, maxW, tracking).slice(0, maxLines);
  lines.forEach((ln, i) => drawText(cv, ln, x, y + i * lh, px, f, c, tracking));
  return y + lines.length * lh;
}

// ---------------------------------------------------------------------------
// Small drawn scenes, one per illustrated panel. Flat shapes, no photos.
// ---------------------------------------------------------------------------

function sceneGlobe(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [214, 232, 238]);
  const cx = x + w * 0.42;
  const cy = y + h * 0.52;
  const r = h * 0.36;
  cv.circle(cx, cy, r, [64, 120, 170]);
  cv.poly([[cx - r * 0.7, cy - r * 0.2], [cx - r * 0.2, cy - r * 0.55], [cx + r * 0.25, cy - r * 0.3], [cx + r * 0.1, cy + r * 0.1], [cx - r * 0.4, cy + r * 0.25]], [84, 150, 84]);
  cv.poly([[cx + r * 0.35, cy + r * 0.15], [cx + r * 0.75, cy - r * 0.1], [cx + r * 0.7, cy + r * 0.45], [cx + r * 0.3, cy + r * 0.55]], [84, 150, 84]);
  cv.circle(cx + r * 0.55, cy - r * 0.55, r * 0.16, WHITE);
  cv.circle(cx + r * 0.7, cy - r * 0.4, r * 0.12, WHITE);
  // A clock for the 06:00 vote.
  const kx = x + w * 0.82;
  const ky = y + h * 0.5;
  cv.circle(kx, ky, h * 0.26, WHITE);
  cv.ring(kx, ky, h * 0.26, INK, 2);
  cv.line(kx, ky, kx, ky - h * 0.18, INK, 2);
  cv.line(kx, ky, kx + h * 0.13, ky, INK, 2);
  cv.fillRect(x, y + h - 8, w, 8, [46, 107, 52]);
}

function sceneCricket(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [96, 150, 80]);
  cv.fillRect(x + w * 0.1, y + h * 0.18, w * 0.8, h * 0.64, [214, 196, 150]);
  cv.line(x + w * 0.1, y + h * 0.5, x + w * 0.9, y + h * 0.5, WHITE, 2);
  // Bat, swung.
  cv.line(x + w * 0.3, y + h * 0.75, x + w * 0.55, y + h * 0.2, [120, 84, 50], 7);
  cv.line(x + w * 0.55, y + h * 0.2, x + w * 0.62, y + h * 0.08, [120, 84, 50], 4);
  cv.circle(x + w * 0.78, y + h * 0.28, h * 0.11, [178, 32, 32]);
  cv.circle(x + w * 0.78, y + h * 0.28, h * 0.11, [178, 32, 32]);
  drawText(cv, "629/6", x + w * 0.06, y + h * 0.94, Math.round(h * 0.22), "bold", WHITE);
}

function sceneBallot(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [232, 214, 176]);
  cv.fillRect(x + w * 0.3, y + h * 0.42, w * 0.4, h * 0.42, [160, 28, 33]);
  cv.fillRect(x + w * 0.3, y + h * 0.36, w * 0.4, h * 0.08, [120, 18, 22]);
  cv.fillRect(x + w * 0.44, y + h * 0.52, w * 0.12, h * 0.04, WHITE);
  cv.poly([[x + w * 0.42, y + h * 0.3], [x + w * 0.5, y + h * 0.12], [x + w * 0.58, y + h * 0.3]], WHITE);
  cv.line(x + w * 0.5, y + h * 0.12, x + w * 0.5, y + h * 0.36, INK, 2);
  drawText(cv, "723", x + w * 0.72, y + h * 0.3, Math.round(h * 0.26), "bold", INK);
  drawText(cv, "SEATS", x + w * 0.72, y + h * 0.52, Math.round(h * 0.13), "bold", RED);
}

function sceneTennis(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [38, 74, 110]);
  const cx = x + w * 0.5;
  const cy = y + h * 0.52;
  const r = h * 0.34;
  cv.circle(cx, cy, r, [196, 214, 74]);
  cv.ring(cx, cy, r, WHITE, 2);
  cv.line(cx - r * 0.7, cy - r * 0.7, cx - r * 0.2, cy + r * 0.7, WHITE, 2);
  cv.line(cx + r * 0.7, cy - r * 0.7, cx + r * 0.2, cy + r * 0.7, WHITE, 2);
  drawText(cv, "18:00 CET", x + w * 0.06, y + h * 0.95, Math.round(h * 0.2), "bold", WHITE);
}

function sceneF1(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [24, 24, 28]);
  const by = y + h * 0.62;
  cv.poly([[x + w * 0.08, by], [x + w * 0.2, by - h * 0.22], [x + w * 0.55, by - h * 0.26], [x + w * 0.85, by - h * 0.1], [x + w * 0.92, by]], [178, 32, 32]);
  cv.fillRect(x + w * 0.86, by - h * 0.34, w * 0.06, h * 0.26, [178, 32, 32]);
  cv.circle(x + w * 0.26, by + 2, h * 0.13, INK);
  cv.circle(x + w * 0.72, by + 2, h * 0.13, INK);
  cv.circle(x + w * 0.26, by + 2, h * 0.06, [120, 120, 120]);
  cv.circle(x + w * 0.72, by + 2, h * 0.06, [120, 120, 120]);
  for (let i = 0; i < 5; i++) cv.line(x + w * (0.1 + i * 0.16), y + h * 0.85, x + w * (0.16 + i * 0.16), y + h * 0.95, [90, 90, 100], 2);
  drawText(cv, "POLE", x + w * 0.06, y + h * 0.3, Math.round(h * 0.24), "bold", [255, 210, 60]);
}

function sceneParliament(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [214, 226, 232]);
  cv.tri(x + w * 0.12, y + h * 0.42, x + w * 0.5, y + h * 0.14, x + w * 0.88, y + h * 0.42, [160, 28, 33]);
  for (let i = 0; i < 5; i++) cv.fillRect(x + w * (0.16 + i * 0.16), y + h * 0.44, w * 0.06, h * 0.42, WHITE);
  cv.fillRect(x + w * 0.1, y + h * 0.86, w * 0.8, h * 0.06, INK);
  cv.circle(x + w * 0.5, y + h * 0.3, h * 0.05, GOLD);
}

function sceneShip(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [32, 52, 84]);
  cv.circle(x + w * 0.8, y + h * 0.2, h * 0.1, [240, 230, 200]);
  for (let i = 0; i < 4; i++) {
    const fx = x + w * (0.2 + i * 0.16);
    cv.tri(fx, y + h * 0.42, fx + w * 0.07, y + h * 0.12, fx + w * 0.14, y + h * 0.42, [240, 120, 20]);
    cv.tri(fx + w * 0.04, y + h * 0.42, fx + w * 0.09, y + h * 0.22, fx + w * 0.14, y + h * 0.42, [255, 190, 40]);
  }
  cv.poly([[x + w * 0.08, y + h * 0.48], [x + w * 0.92, y + h * 0.48], [x + w * 0.86, y + h * 0.72], [x + w * 0.14, y + h * 0.72]], [120, 28, 28]);
  cv.fillRect(x + w * 0.2, y + h * 0.52, w * 0.6, h * 0.05, [200, 200, 200]);
  cv.fillRect(x, y + h * 0.72, w, h * 0.28, [28, 68, 110]);
  cv.line(x + w * 0.1, y + h * 0.82, x + w * 0.9, y + h * 0.82, WHITE, 1);
}

function sceneStorm(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [70, 90, 110]);
  cv.circle(x + w * 0.35, y + h * 0.4, h * 0.22, [40, 44, 54]);
  cv.circle(x + w * 0.55, y + h * 0.32, h * 0.26, [52, 58, 70]);
  cv.circle(x + w * 0.7, y + h * 0.42, h * 0.2, [40, 44, 54]);
  for (let i = 0; i < 6; i++) cv.line(x + w * (0.15 + i * 0.13), y + h * 0.62, x + w * (0.11 + i * 0.13), y + h * 0.78, [180, 200, 220], 2);
  cv.poly([[x + w * 0.5, y + h * 0.6], [x + w * 0.58, y + h * 0.78], [x + w * 0.52, y + h * 0.78], [x + w * 0.62, y + h * 0.95], [x + w * 0.44, y + h * 0.72], [x + w * 0.52, y + h * 0.72]], [255, 220, 60]);
}

function sceneScales(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [232, 226, 208]);
  const cx = x + w * 0.5;
  cv.line(cx, y + h * 0.2, cx, y + h * 0.8, INK, 3);
  cv.line(cx - w * 0.32, y + h * 0.28, cx + w * 0.32, y + h * 0.28, INK, 3);
  cv.circle(cx, y + h * 0.18, h * 0.05, GOLD);
  for (const s of [-1, 1]) {
    cv.line(cx + s * w * 0.32, y + h * 0.28, cx + s * w * 0.32, y + h * 0.5, INK, 2);
    cv.tri(cx + s * w * 0.42, y + h * 0.5, cx + s * w * 0.22, y + h * 0.5, cx + s * w * 0.32, y + h * 0.68, GOLD);
  }
  cv.fillRect(cx - w * 0.14, y + h * 0.8, w * 0.28, h * 0.06, INK);
}

function sceneBridge(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [178, 208, 226]);
  cv.fillRect(x, y + h * 0.66, w, h * 0.1, [120, 84, 50]);
  cv.line(x + w * 0.14, y + h * 0.2, x + w * 0.14, y + h * 0.66, INK, 3);
  cv.line(x + w * 0.86, y + h * 0.2, x + w * 0.86, y + h * 0.66, INK, 3);
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const px = x + w * (0.14 + 0.72 * t);
    const py = y + h * (0.2 + 0.46 * 4 * t * (1 - t) * 0.4);
    cv.line(px, py, px, y + h * 0.66, [90, 90, 100], 1);
  }
  cv.line(x + w * 0.14, y + h * 0.2, x + w * 0.86, y + h * 0.2, INK, 2);
  cv.fillRect(x, y + h * 0.76, w, h * 0.24, [96, 150, 80]);
}

function sceneMountain(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [214, 226, 232]);
  cv.tri(x + w * 0.02, y + h * 0.85, x + w * 0.3, y + h * 0.2, x + w * 0.58, y + h * 0.85, [120, 110, 100]);
  cv.tri(x + w * 0.42, y + h * 0.85, x + w * 0.68, y + h * 0.3, x + w * 0.98, y + h * 0.85, [96, 88, 80]);
  cv.tri(x + w * 0.24, y + h * 0.34, x + w * 0.3, y + h * 0.2, x + w * 0.36, y + h * 0.34, WHITE);
  cv.tri(x + w * 0.63, y + h * 0.42, x + w * 0.68, y + h * 0.3, x + w * 0.73, y + h * 0.42, WHITE);
  // Seismograph trace.
  let px = x + w * 0.06;
  let py = y + h * 0.62;
  const pts: [number, number][] = [[px, py]];
  const spikes = [0, 2, -3, 8, -14, 20, -10, 4, -2, 0, 3, -6, 9, -4, 1, 0];
  spikes.forEach((s, i) => {
    pts.push([x + w * (0.06 + ((i + 1) / spikes.length) * 0.88), y + h * 0.62 + s]);
  });
  for (let i = 0; i + 1 < pts.length; i++) cv.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], RED, 2);
}

function scenePlane(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [178, 208, 226]);
  cv.circle(x + w * 0.5, y + h * 0.45, h * 0.12, WHITE);
  cv.circle(x + w * 0.68, y + h * 0.38, h * 0.09, WHITE);
  cv.circle(x + w * 0.32, y + h * 0.5, h * 0.1, WHITE);
  // Plane silhouette.
  cv.poly([[x + w * 0.2, y + h * 0.62], [x + w * 0.82, y + h * 0.55], [x + w * 0.88, y + h * 0.6], [x + w * 0.2, y + h * 0.68]], [40, 60, 90]);
  cv.poly([[x + w * 0.45, y + h * 0.58], [x + w * 0.58, y + h * 0.42], [x + w * 0.66, y + h * 0.44], [x + w * 0.58, y + h * 0.6]], [40, 60, 90]);
  cv.poly([[x + w * 0.3, y + h * 0.64], [x + w * 0.4, y + h * 0.78], [x + w * 0.48, y + h * 0.76], [x + w * 0.42, y + h * 0.64]], [40, 60, 90]);
  cv.line(x + w * 0.08, y + h * 0.3, x + w * 0.3, y + h * 0.3, RED, 2);
  cv.line(x + w * 0.08, y + h * 0.38, x + w * 0.22, y + h * 0.38, RED, 2);
}

function sceneHandshake(cv: Canvas, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, [232, 214, 176]);
  cv.circle(x + w * 0.3, y + h * 0.42, h * 0.2, [214, 170, 120]);
  cv.circle(x + w * 0.7, y + h * 0.42, h * 0.2, [180, 140, 100]);
  cv.fillRect(x + w * 0.18, y + h * 0.6, w * 0.24, h * 0.3, [29, 58, 95]);
  cv.fillRect(x + w * 0.58, y + h * 0.6, w * 0.24, h * 0.3, [160, 28, 33]);
  cv.line(x + w * 0.42, y + h * 0.55, x + w * 0.58, y + h * 0.55, INK, 3);
  drawText(cv, "28 DAYS", x + w * 0.06, y + h * 0.28, Math.round(h * 0.2), "bold", INK);
}

const SCENES: Record<string, (cv: Canvas, x: number, y: number, w: number, h: number) => void> = {
  globe: sceneGlobe,
  cricket: sceneCricket,
  ballot: sceneBallot,
  tennis: sceneTennis,
  f1: sceneF1,
  parliament: sceneParliament,
  ship: sceneShip,
  storm: sceneStorm,
  scales: sceneScales,
  bridge: sceneBridge,
  mountain: sceneMountain,
  plane: scenePlane,
  handshake: sceneHandshake,
};

// ---------------------------------------------------------------------------
// The stories. Every fact below was checked against a named source on
// 22 November 2026 (Reuters, AP, AFP, HK Government, India MEA, ATP,
// Formula 1, RIK, CNN, Maariv, QNC). Labels: CONFIRMED = wire/Official
// record; OFFICIAL = a government or body said it; REPORTED = a named
// outlet reported it; CLAIM = one side says it, disputed or unproven.
// ---------------------------------------------------------------------------

type Story = {
  n: number;
  place: string;
  topic: string;
  scene: string;
  head: string;
  body: string;
  src: string;
  label: string;
  lon: number;
  lat: number;
};

const HEROES: Story[] = [
  {
    n: 1, place: "ANTALYA, TURKIYE", topic: "CLIMATE", scene: "globe",
    head: "COP31 nears a final deal at last",
    body: "A new package was announced at a late-night plenary: objections due 03:00 GMT, approval at 06:00 GMT Sunday. Fossil fuels and finance were the sticking points.",
    src: "Reuters", label: "CONFIRMED", lon: 30.7, lat: 36.9,
  },
  {
    n: 2, place: "WELLINGTON", topic: "CRICKET", scene: "cricket",
    head: "Pant's 128 puts India on top in Wellington",
    body: "India reached lunch on 629 for 6 on day four, a lead of 261 over New Zealand's 368 — India's highest Test total ever in New Zealand, beating 520 at Hamilton in 2009.",
    src: "Reuters", label: "CONFIRMED", lon: 174.8, lat: -41.3,
  },
  {
    n: 3, place: "HONG KONG", topic: "ELECTION", scene: "ballot",
    head: "Hong Kong goes to the polls",
    body: "Voting runs 9am to 6pm for the Election Committee: 856 candidates contest 723 seats in 31 subsectors, chosen by about 5,700 voters.",
    src: "HK Govt", label: "OFFICIAL", lon: 114.2, lat: 22.3,
  },
];

const SMALL: Story[] = [
  {
    n: 4, place: "NEW DELHI", topic: "DIPLOMACY", scene: "handshake",
    head: "Nepal PM Shah arrives for first India trip",
    body: "Balendra Shah, 36, lands for his first bilateral visit since March. Talks with Modi on Monday.",
    src: "India MEA", label: "OFFICIAL", lon: 77.2, lat: 28.6,
  },
  {
    n: 5, place: "TURIN", topic: "TENNIS", scene: "tennis",
    head: "Zverev v Alcaraz for the ATP Finals title",
    body: "Final tonight, 18:00 CET: world No. 1 Zverev, yet to drop a set, meets Alcaraz, on a 13-match streak.",
    src: "ATP", label: "OFFICIAL", lon: 7.7, lat: 45.1,
  },
  {
    n: 6, place: "LAS VEGAS", topic: "FORMULA 1", scene: "f1",
    head: "Verstappen on pole after Antonelli penalty",
    body: "Antonelli fastest, 1:33.893, but a five-place drop hands pole to Verstappen. Lights out 04:00 GMT.",
    src: "Formula 1", label: "OFFICIAL", lon: -115.1, lat: 36.2,
  },
  {
    n: 7, place: "JERUSALEM", topic: "POLITICS", scene: "parliament",
    head: "Eisenkot invites Likud to Sunday talks",
    body: "Asked to meet today on a broad coalition. His 28-day mandate runs to 6 Dec; he needs 61 of 120 seats.",
    src: "Maariv", label: "REPORTED", lon: 35.2, lat: 31.8,
  },
  {
    n: 8, place: "GULF OF FINLAND", topic: "WAR AT SEA", scene: "ship",
    head: "Sparta II still burning at dawn",
    body: "Hit by two drones on Saturday, the sanctioned ship drifted into Finnish waters; its crew were evacuated.",
    src: "CNN", label: "REPORTED", lon: 27.0, lat: 60.0,
  },
  {
    n: 9, place: "MOGADISHU", topic: "DIPLOMACY", scene: "scales",
    head: "Somalia: UAE envoy's 72 hours run out today",
    body: "Mogadishu ordered the envoy out on Thursday and recalled its own, accusing Abu Dhabi of meddling.",
    src: "QNC News", label: "REPORTED", lon: 45.3, lat: 2.0,
  },
  {
    n: 10, place: "SUBOTICA", topic: "ELECTION", scene: "ballot",
    head: "Serbia repeats votes at five stations",
    body: "Polls open 7am-8pm in Subotica and Bujanovac for minority councils. The 8 Nov ballots were annulled.",
    src: "RIK", label: "OFFICIAL", lon: 19.7, lat: 46.1,
  },
  {
    n: 11, place: "WELLINGTON", topic: "CRICKET", scene: "cricket",
    head: "Pant's 108 sixes: second-most ever",
    body: "His century took him past McCullum into second for Test sixes, behind only Ben Stokes on 138.",
    src: "Reuters", label: "CONFIRMED", lon: 174.8, lat: -41.3,
  },
  {
    n: 12, place: "HONG KONG", topic: "ELECTION", scene: "ballot",
    head: "Who votes: 5,700 voters, five stations",
    body: "Five ordinary stations and two dedicated ones serve the 31 subsectors. Results expected tonight.",
    src: "HK Govt", label: "OFFICIAL", lon: 114.2, lat: 22.3,
  },
  {
    n: 13, place: "ANTALYA", topic: "CLIMATE", scene: "globe",
    head: "The deal in numbers: 200, 03:00, 06:00",
    body: "Nearly 200 delegations. Objections 03:00 GMT, vote 06:00 GMT. Kurum: a text all parties can agree on.",
    src: "Reuters", label: "CONFIRMED", lon: 30.7, lat: 36.9,
  },
];

// The wire list: one line each, with the place that reported it.
const WIRES: [string, string, string][] = [
  ["PARIS", "Three officers jailed over racist Zecler beating", "Europe"],
  ["LONDON", "England thrash All Blacks 37-12, record margin", "Europe"],
  ["TALLINN", "Estonia to shut Russia border from 1 Dec", "Europe"],
  ["TURIN", "Doubles final first, 15:00 CET", "Europe"],
  ["KYIV", "Zelenskyy condemns Kryvyi Rih strike", "Europe"],
  ["NEW DELHI", "Air India Jeddah halt extended to 24 Nov", "Asia"],
  ["TOKYO", "Japan to train live-fire in India, a first", "Asia"],
  ["SEOUL", "Korea repeats $75,000 exam-cheating bounty", "Asia"],
  ["PATNA", "Modi opens 19.7 km Nitish Setu bridge", "Asia"],
  ["WELLINGTON", "Second Test starts in Christchurch Fri", "Oceania"],
  ["RIYADH", "Coalition says it downed a Houthi missile", "Middle East"],
  ["TEHRAN", "Qeshm blasts were US disposal, not attack", "Middle East"],
  ["GAZA", "Four nations press Israel on aid", "Middle East"],
  ["DOHA", "Iran confirms Qatari mediators' visit", "Middle East"],
  ["WASHINGTON", "Court backs $7.25bn Roundup deal", "Americas"],
  ["WASHINGTON", "Trump: Iran deal \"could last 20 years\"", "Americas"],
  ["WASHINGTON", "Pentagon curbs troops' Canada ties", "Americas"],
  ["WASHINGTON", "State details $12bn Venezuela oil cash", "Americas"],
  ["NEW YORK", "AI may have cracked Riemann, expert says", "Americas"],
  ["SYDNEY", "Rev Fred Nile dies at 92", "Oceania"],
  ["MELBOURNE", "Cummins keeps Test captaincy", "Oceania"],
  ["KINSHASA", "Ebola toll passes 5,700", "Africa"],
  ["LONDON", "TikTok launches deepfake detector", "Global"],
];

// ---------------------------------------------------------------------------
// Layout.
// ---------------------------------------------------------------------------

const MX = 14; // page margin
const CW = W - MX * 2;

function regionBar(cv: Canvas, y: number) {
  const parts: [string, RGB, number][] = [
    ["EUROPE 10", [29, 58, 95], 10],
    ["ASIA 7", [176, 94, 20], 7],
    ["AMERICAS 6", [46, 107, 52], 6],
    ["OCEANIA 5", [28, 110, 110], 5],
    ["MIDDLE EAST 5", [120, 40, 90], 5],
    ["AFRICA 2", [140, 110, 20], 2],
    ["GLOBAL 1", [90, 90, 90], 1],
  ];
  let x = MX;
  cv.fillRect(MX, y, CW, 16, INK);
  for (const [label, col] of parts) {
    const w = textWidth(label, 11, "bold") + 22;
    cv.fillRect(x + 3, y + 4, 8, 8, col);
    drawText(cv, label, x + 14, y + 12.5, 11, "bold", WHITE);
    x += w;
  }
}

function heroPanel(cv: Canvas, s: Story, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, WHITE);
  cv.rect(x, y, w, h, INK, 2);
  SCENES[s.scene](cv, x + 2, y + 2, w - 4, 90);
  const tx = x + 10;
  drawText(cv, s.n + "  " + s.place + " — " + s.topic, tx, y + 102, 11, "bold", RED);
  drawPara(cv, s.head, tx, y + 124, w - 20, 20, "bold", INK, 22, 2);
  drawPara(cv, s.body, tx, y + 156, w - 20, 11, "reg", [40, 40, 40], 13, 3);
  drawText(cv, s.src + " · " + s.label, tx, y + h - 5, 9.5, "bold", [110, 110, 110]);
}

function smallPanel(cv: Canvas, s: Story, x: number, y: number, w: number, h: number) {
  cv.fillRect(x, y, w, h, WHITE);
  cv.rect(x, y, w, h, INK, 1);
  SCENES[s.scene](cv, x + 1, y + 1, w - 2, 50);
  const tx = x + 7;
  drawText(cv, s.n + "  " + s.place, tx, y + 60, 9.5, "bold", RED);
  drawPara(cv, s.head, tx, y + 76, w - 14, 12.5, "bold", INK, 14.5, 2);
  drawPara(cv, s.body, tx, y + 110, w - 14, 9.5, "reg", [40, 40, 40], 12, 3);
  drawText(cv, s.src + " · " + s.label, tx, y + h - 4, 8.5, "bold", [110, 110, 110]);
}

// A rough equirectangular world map: continents as flat polygons.
function drawMap(cv: Canvas, x: number, y: number, w: number, h: number, stories: Story[]) {
  cv.fillRect(x, y, w, h, [178, 208, 226]);
  cv.rect(x, y, w, h, INK, 1);
  const px = (lon: number) => x + ((lon + 180) / 360) * w;
  const py = (lat: number) => y + ((90 - lat) / 180) * h;
  const land: RGB = [232, 214, 176];
  const polys: number[][][] = [
    // North America
    [[-168, 66], [-140, 70], [-120, 72], [-95, 80], [-75, 73], [-60, 60], [-70, 45], [-80, 32], [-90, 20], [-105, 20], [-115, 30], [-125, 42], [-150, 60]],
    // South America
    [[-80, 10], [-60, 5], [-50, 0], [-40, -8], [-48, -22], [-58, -35], [-70, -52], [-73, -30], [-78, -12]],
    // Greenland
    [[-55, 60], [-40, 70], [-25, 76], [-45, 82], [-60, 76]],
    // Africa
    [[-17, 15], [-10, 32], [10, 37], [30, 32], [43, 12], [51, 11], [40, -5], [35, -18], [28, -33], [18, -35], [12, -18], [8, 4], [-8, 4]],
    // Europe
    [[-10, 36], [-9, 43], [0, 48], [-2, 52], [5, 58], [10, 62], [18, 70], [30, 70], [40, 68], [28, 60], [22, 55], [12, 45], [18, 40], [8, 38]],
    // Asia
    [[40, 68], [60, 72], [90, 76], [120, 73], [160, 70], [178, 66], [160, 60], [142, 50], [140, 40], [127, 35], [120, 25], [108, 12], [100, 8], [92, 16], [80, 8], [75, 20], [60, 25], [48, 30], [40, 42]],
    // Australia
    [[113, -22], [122, -14], [132, -12], [142, -11], [150, -22], [153, -28], [146, -39], [140, -38], [129, -32], [115, -33]],
  ];
  for (const poly of polys) cv.poly(poly.map(([lo, la]) => [px(lo), py(la)]), land);
  // Numbered pins for the drawn stories (11–13 share Wellington, Hong Kong, Antalya).
  const placed: [number, number][] = [];
  for (const s of stories) {
    let cx = px(s.lon);
    let cy = py(s.lat);
    let k = 0;
    while (placed.some(([ax, ay]) => Math.abs(ax - cx) < 12 && Math.abs(ay - cy) < 12) && k < 6) {
      cx += 11;
      cy -= 6;
      k++;
    }
    placed.push([cx, cy]);
    cv.circle(cx, cy, 8, RED);
    cv.ring(cx, cy, 8, WHITE, 1);
    drawText(cv, String(s.n), cx - (s.n < 10 ? 3 : 6), cy + 3.5, 10, "bold", WHITE);
  }
  drawText(cv, "WHERE IT HAPPENED", x + 4, y + h - 6, 9, "bold", INK);
  drawText(cv, "Pins 1–13: the drawn stories", x + w - 4 - textWidth("Pins 1–13: the drawn stories", 8.5, "reg"), y + h - 6, 8.5, "reg", [80, 80, 80]);
}

function build(): Uint8Array {
  const cv = new Canvas(W, H, PAPER);
  // Top bar.
  drawText(cv, "THE WORLD IN ONE DAY", MX, 20, 13, "bold", RED);
  drawText(cv, "EARLY EDITION — WIRES AS OF 01:00 UTC", MX + CW - textWidth("EARLY EDITION — WIRES AS OF 01:00 UTC", 11, "bold"), 19, 11, "bold", INK);
  cv.fillRect(MX, 26, CW, 2, INK);
  // Masthead.
  const mast = "Sunday 22 November 2026";
  drawText(cv, mast, (W - textWidth(mast, 58, "bold")) / 2, 76, 58, "bold", INK);
  const sub = "COP31 vote at dawn · Pant's 128 puts India on top · Hong Kong goes to the polls";
  drawText(cv, sub, (W - textWidth(sub, 15, "ital")) / 2, 96, 15, "ital", [50, 50, 50]);
  cv.fillRect(MX, 102, CW, 1, RULE);
  // Stats row: six boxes.
  const stats: [string, string][] = [
    ["06:00", "GMT · COP31 vote"],
    ["629/6", "India's total, day 4"],
    ["128", "Pant, Wellington"],
    ["856", "HK candidates"],
    ["18:00", "CET · ATP final"],
    ["04:00", "GMT · F1 lights out"],
  ];
  const sw = CW / 6;
  for (let i = 0; i < 6; i++) {
    const bx = MX + i * sw;
    cv.rect(bx + 2, 108, sw - 4, 34, RULE, 1);
    drawText(cv, stats[i][0], bx + 10, 130, 20, "bold", RED);
    drawText(cv, stats[i][1], bx + 10, 139, 9.5, "reg", [60, 60, 60]);
  }
  // Timeline of the day (GMT): times above the line, labels below it.
  const tlY = 158;
  cv.line(MX, tlY, MX + CW, tlY, INK, 2);
  const ticks: [string, string, number][] = [
    ["03:00", "COP31 objections due", 0.12],
    ["04:00", "F1 lights out", 0.28],
    ["06:00", "COP31 vote", 0.46],
    ["09:00", "HK polls open", 0.62],
    ["15:00", "Turin doubles final", 0.8],
    ["18:00", "ATP final", 0.94],
  ];
  for (const [t, label, f] of ticks) {
    const tx = MX + f * CW;
    cv.circle(tx, tlY, 3, RED);
    drawText(cv, t, tx - textWidth(t, 10, "bold") / 2, tlY - 5, 10, "bold", INK);
    drawText(cv, label, tx - textWidth(label, 8.5, "reg") / 2, tlY + 13, 8.5, "reg", [60, 60, 60]);
  }
  regionBar(cv, 178);
  // Heroes.
  const hy = 200;
  const hh = 200;
  const hw = (CW - 16) / 3;
  HEROES.forEach((s, i) => heroPanel(cv, s, MX + i * (hw + 8), hy, hw, hh));
  // Small panels, two rows of five.
  const sy1 = 408;
  const sy2 = 568;
  const sh = 152;
  const smw = (CW - 32) / 5;
  SMALL.slice(0, 5).forEach((s, i) => smallPanel(cv, s, MX + i * (smw + 8), sy1, smw, sh));
  SMALL.slice(5).forEach((s, i) => smallPanel(cv, s, MX + i * (smw + 8), sy2, smw, sh));
  // Map + wire list.
  const my = 728;
  const mh = 198;
  drawMap(cv, MX, my, 330, mh, [...HEROES, ...SMALL]);
  const wx = MX + 342;
  const ww = CW - 342;
  drawText(cv, "ALSO IN SUNDAY'S WIRES — 23 MORE STORIES", wx, my + 11, 12, "bold", RED);
  cv.fillRect(wx, my + 16, ww, 2, INK);
  const colW = ww / 2;
  WIRES.forEach((wline, i) => {
    const col = i < 12 ? 0 : 1;
    const row = i < 12 ? i : i - 12;
    const lx = wx + col * colW;
    const ly = my + 32 + row * 14;
    drawText(cv, String(14 + i), lx, ly, 9.5, "bold", RED);
    drawText(cv, wline[0] + " — " + wline[1], lx + 20, ly, 9.5, "reg", INK);
  });
  // Date check.
  const dy = 934;
  cv.fillRect(MX, dy, CW, 52, [255, 244, 230]);
  cv.rect(MX, dy, CW, 52, RED, 2);
  drawText(cv, "DATE CHECK", MX + 8, dy + 13, 11, "bold", RED);
  const dc =
    "Left out because they are NOT 22 November news: Peru's M6.7 quake (00:09 UTC, 21 Nov, USGS); the \"Chapo Isidro\" capture (Fri 20 Nov, Guasave); the Kryvyi Rih strike (Fri night, 2 dead, 60 hurt); Russia's 400-drone barrage (19–20 Nov); the Shenzhen summit (Thu 19 Nov); the Iran–Bahrain–Kuwait drone exchanges (17–18 Nov); Brazil's supercell (Fri 20 Nov); Typhoon In-fa, which ended on 5 Nov. Sparta II was hit on Saturday; only its overnight fire is counted.";
  drawPara(cv, dc, MX + 8, dy + 26, CW - 16, 10, "reg", INK, 12.5, 3);
  // Footer.
  drawText(cv, "Every story here happened, or was first reported, on Sunday 22 November 2026 (UTC).", MX, 1000, 9, "reg", [80, 80, 80]);
  drawText(cv, "Sources named beside each story · Original drawings", MX + CW - textWidth("Sources named beside each story · Original drawings", 9, "reg"), 1000, 9, "reg", [80, 80, 80]);
  return writePng(cv.buf, W, H);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "entry.png"), build());
