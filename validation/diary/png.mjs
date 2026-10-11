// Tiny PNG encoder for synthetic test photos (RGB, 8-bit, no dependencies).
import { deflateSync } from "node:zlib";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** pixel(x, y) -> [r, g, b] */
export function encodePNG(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** A 4:3 "place": sky, ground, a near red block and a yellow sign. */
export function placePhoto(width = 960, height = 720) {
  return encodePNG(width, height, (x, y) => {
    const u = x / width, v = y / height;
    if (u > 0.03 && u < 0.13 && v > 0.04 && v < 0.13) return [255, 214, 10];
    if (u > 0.35 && u < 0.65 && v > 0.45 && v < 0.85) return [214, 40, 40];
    if (v < 0.45) return [58 + Math.round(40 * v), 123, 213];
    return [46, 139 - Math.round(40 * (v - 0.45)), 58];
  });
}

export function plainPhoto(width = 800, height = 600) {
  return encodePNG(width, height, (x, y) => [(x * 7) & 255, (y * 5) & 255, 160]);
}
