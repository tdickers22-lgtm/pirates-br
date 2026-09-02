// Minimal PNG reader for Playwright screenshots (8-bit RGB / RGBA, non-interlaced)
// so a gate can read pixel bands back without a native image dependency.
import { inflateSync } from 'node:zlib';

/** @returns {{ width: number, height: number, channels: number, data: Uint8Array }} */
export function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; colour = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`unsupported PNG: depth ${depth} colour ${colour} interlace ${interlace}`);
  const channels = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(width * height * channels);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = data.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[i] = v & 0xff;
    }
    prev = out;
  }
  return { width, height, channels, data };
}

/** Mean luma / chroma over a horizontal band of rows [y0, y1) (fractions of height). */
export function bandStats(png, y0, y1, x0 = 0.05, x1 = 0.95) {
  const { width, height, channels, data } = png;
  let luma = 0, chroma = 0, n = 0;
  for (let y = Math.floor(height * y0); y < Math.floor(height * y1); y++) {
    for (let x = Math.floor(width * x0); x < Math.floor(width * x1); x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      n++;
    }
  }
  return { luma: luma / n, chroma: chroma / n, n };
}
