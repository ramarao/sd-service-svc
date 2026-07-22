// Encode a QR code as a PNG, inside the Worker.
//
// Why hand-roll this: the `qrcode` package can only emit SVG here — its
// toDataURL() wants a browser canvas and toBuffer() is the Node build, neither of
// which exists in workerd. And an SVG is useless for our actual purpose: the
// customer saves the QR to their phone gallery and points a UPI app's "Scan from
// gallery" at it, and neither galleries nor UPI scanners read SVG.
//
// A QR is 1-bit, so the PNG is trivial: greyscale, no palette, one IDAT. The only
// real machinery is zlib for IDAT — and the platform hands us that via
// CompressionStream("deflate"), which emits the zlib-wrapped stream PNG expects
// (as opposed to "deflate-raw").
import QRCode from "qrcode";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// length + type + data + CRC(type+data) — the PNG chunk envelope.
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes) {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/**
 * Render `text` as a PNG QR code.
 * @param {string} text            payload to encode (here: the upi:// string)
 * @param {number} opts.scale      pixels per QR module
 * @param {number} opts.margin     quiet-zone width, in modules. The spec says >= 4;
 *                                 scanners genuinely fail without it, so don't trim.
 * @returns {Promise<Uint8Array>}  a complete PNG
 */
export async function qrPng(text, { scale = 10, margin = 4 } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const modules = qr.modules.data; // row-major, 1 = dark
  const size = (n + margin * 2) * scale;

  // Greyscale 8-bit: one byte per pixel, each scanline prefixed with a filter
  // byte (0 = None). White background, so the quiet zone comes for free.
  const stride = size + 1;
  const raw = new Uint8Array(stride * size).fill(0xff);
  for (let y = 0; y < size; y++) raw[y * stride] = 0; // filter byte per scanline

  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      if (!modules[my * n + mx]) continue;
      const px = (mx + margin) * scale;
      const py = (my + margin) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const rowStart = (py + dy) * stride + 1; // +1 skips the filter byte
        raw.fill(0x00, rowStart + px, rowStart + px + scale);
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); // width
  dv.setUint32(4, size); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0 = greyscale
  // [10] compression, [11] filter, [12] interlace — all 0/none.

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // signature
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}
