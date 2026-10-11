// Capture time and GPS position from the original files, read before photos
// are re-encoded (which strips this metadata). No dependencies; works on
// byte arrays so the parsers run in Node tests too.
//
//   JPEG  APP1 "Exif" -> TIFF IFD0 -> Exif IFD (DateTimeOriginal) + GPS IFD
//   HEIC  meta/iinf "Exif" item -> iloc extent -> the same TIFF structure
//   MP4/MOV  moov: Apple creationdate key (local time + offset) or mvhd (UTC);
//            ISO 6709 location ("+37.5446+127.0561/") from ©xyz or Apple keys

import { looksLikeHeif, isVideoFile } from "./media.js";

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const latin1 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

// ---------- TIFF / EXIF ----------

/** "2026:10:03 14:22:05" -> "2026-10-03T14:22:05" (local wall-clock time, as the camera saw it). */
export function exifDateTime(text) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || "").trim());
  if (!m || m[1] === "0000" || m[2] === "00" || m[3] === "00") return null;
  const [, y, mo, d, h, mi, s] = m;
  if (+mo > 12 || +d > 31 || +h > 23 || +mi > 59 || +s > 60) return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function validPosition(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0);
}

/** Parses a TIFF block (starting at its "II"/"MM" header). */
export function parseTiff(bytes) {
  if (bytes.length < 8) return null;
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!le && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => view.getUint16(o, le);
  const u32 = (o) => view.getUint32(o, le);
  if (u16(2) !== 42) return null;
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function readIfd(offset) {
    const tags = new Map();
    if (offset < 8 || offset + 2 > bytes.length) return tags;
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > bytes.length) break;
      const tag = u16(e), type = u16(e + 2), n = u32(e + 4);
      const size = (SIZES[type] || 0) * n;
      if (!size) continue;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (at + size > bytes.length) continue;
      let value;
      if (type === 2) value = ascii(bytes, at, n).replace(/\0.*$/s, "");
      else if (type === 3) value = Array.from({ length: n }, (_, k) => u16(at + k * 2));
      else if (type === 4) value = Array.from({ length: n }, (_, k) => u32(at + k * 4));
      else if (type === 5) value = Array.from({ length: n }, (_, k) => u32(at + k * 8) / (u32(at + k * 8 + 4) || NaN));
      else if (type === 10) {
        value = Array.from({ length: n }, (_, k) => view.getInt32(at + k * 8, le) / (view.getInt32(at + k * 8 + 4, le) || NaN));
      } else value = bytes.subarray(at, at + size);
      tags.set(tag, value);
    }
    return tags;
  }

  const ifd0 = readIfd(u32(4));
  const exif = ifd0.has(0x8769) ? readIfd(ifd0.get(0x8769)[0]) : new Map();
  const gps = ifd0.has(0x8825) ? readIfd(ifd0.get(0x8825)[0]) : new Map();
  const takenAt = exifDateTime(exif.get(0x9003)) || exifDateTime(exif.get(0x9004)) || exifDateTime(ifd0.get(0x0132));
  const offset = /^[+-]\d{2}:\d{2}$/.test(exif.get(0x9011) || "") ? exif.get(0x9011) : null;
  let lat = null, lng = null;
  const toDegrees = (v) => (Array.isArray(v) && v.length >= 1 ? (v[0] || 0) + (v[1] || 0) / 60 + (v[2] || 0) / 3600 : NaN);
  if (gps.has(2) && gps.has(4)) {
    const la = toDegrees(gps.get(2)) * (/^S/i.test(gps.get(1) || "N") ? -1 : 1);
    const lo = toDegrees(gps.get(4)) * (/^W/i.test(gps.get(3) || "E") ? -1 : 1);
    if (validPosition(la, lo)) { lat = la; lng = lo; }
  }
  return { takenAt, offset, lat, lng };
}

export function parseJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const marker = bytes[p + 1];
    if (marker === 0xd9 || marker === 0xda) return null; // end / start of scan: no EXIF
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (marker === 0xe1 && ascii(bytes, p + 4, 4) === "Exif") {
      return parseTiff(bytes.subarray(p + 10, Math.min(bytes.length, p + 2 + length)));
    }
    p += 2 + length;
  }
  return null;
}

// ---------- ISO BMFF boxes (HEIF, MP4, MOV) ----------

function boxes(bytes, start = 0, end = bytes.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    const type = ascii(bytes, p + 4, 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(new DataView(bytes.buffer, bytes.byteOffset + p + 8, 8).getBigUint64(0));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header) break;
    out.push({ type, start: p, body: p + header, end: Math.min(end, p + size), size });
    p += size;
  }
  return out;
}

function readUint(bytes, at, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + bytes[at + i];
  return v;
}

/** Location of the HEIF "Exif" item: { offset, length } in the file, or null. */
export function heifExifExtent(bytes) {
  const meta = boxes(bytes).find((b) => b.type === "meta");
  if (!meta) return null;
  const children = boxes(bytes, meta.body + 4, meta.end);
  const iinf = children.find((b) => b.type === "iinf");
  const iloc = children.find((b) => b.type === "iloc");
  if (!iinf || !iloc) return null;
  const iinfVersion = bytes[iinf.body];
  const entriesAt = iinf.body + 4 + (iinfVersion === 0 ? 2 : 4);
  let exifId = null;
  for (const infe of boxes(bytes, entriesAt, iinf.end).filter((b) => b.type === "infe")) {
    const v = bytes[infe.body];
    if (v < 2) continue;
    const idSize = v === 2 ? 2 : 4;
    const id = readUint(bytes, infe.body + 4, idSize);
    if (ascii(bytes, infe.body + 4 + idSize + 2, 4) === "Exif") { exifId = id; break; }
  }
  if (exifId === null) return null;
  const v = bytes[iloc.body];
  let p = iloc.body + 4;
  const offsetSize = bytes[p] >> 4, lengthSize = bytes[p] & 15;
  const baseSize = bytes[p + 1] >> 4, indexSize = v > 0 ? bytes[p + 1] & 15 : 0;
  p += 2;
  const count = readUint(bytes, p, v < 2 ? 2 : 4);
  p += v < 2 ? 2 : 4;
  for (let i = 0; i < count; i++) {
    const id = readUint(bytes, p, v < 2 ? 2 : 4);
    p += v < 2 ? 2 : 4;
    let method = 0;
    if (v > 0) { method = readUint(bytes, p, 2) & 15; p += 2; }
    p += 2; // data_reference_index
    const base = readUint(bytes, p, baseSize);
    p += baseSize;
    const extents = readUint(bytes, p, 2);
    p += 2;
    let first = null;
    for (let e = 0; e < extents; e++) {
      p += indexSize;
      const offset = readUint(bytes, p, offsetSize); p += offsetSize;
      const length = readUint(bytes, p, lengthSize); p += lengthSize;
      if (!first) first = { offset: base + offset, length };
    }
    if (id === exifId) return method === 0 && first ? first : null;
  }
  return null;
}

/** HEIF Exif item payload: 4-byte offset to the TIFF header, then the TIFF data. */
export function parseHeifExifItem(item) {
  if (item.length < 12) return null;
  const skip = readUint(item, 0, 4);
  return parseTiff(item.subarray(4 + skip));
}

function parseIso6709(text) {
  const m = /([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\//.exec(text);
  if (!m || !m[1].includes(".") || !m[2].includes(".")) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return validPosition(lat, lng) ? { lat, lng } : null;
}

const MAC_EPOCH_OFFSET = 2082844800; // seconds from 1904-01-01 to 1970-01-01

/** Capture info from a moov box (bytes = the whole moov box, header included). */
export function parseMoov(bytes, { timeZoneOffsetMinutes } = {}) {
  const text = latin1(bytes);
  const position = parseIso6709(text);
  const toLocal = (utc) => {
    const offset = timeZoneOffsetMinutes ?? -utc.getTimezoneOffset();
    return new Date(utc.getTime() + offset * 60000).toISOString().slice(0, 19);
  };
  // iPhone: com.apple.quicktime.creationdate is local time with an explicit
  // UTC offset; that wall-clock time is the one to keep. Text dates ending in
  // "Z" (e.g. a creation_time key) are UTC like mvhd.
  const local = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?[+-]\d{2}:?\d{2}/.exec(text);
  const zulu = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z/.exec(text);
  let takenAt = local ? `${local[1]}T${local[2]}` : null;
  if (!takenAt && zulu && !Number.isNaN(Date.parse(`${zulu[1]}Z`))) takenAt = toLocal(new Date(`${zulu[1]}Z`));
  if (!takenAt) {
    const mvhd = boxes(bytes, 8).find((b) => b.type === "mvhd");
    if (mvhd) {
      const v = bytes[mvhd.body];
      const seconds = v === 1 ? readUint(bytes, mvhd.body + 4, 8) : readUint(bytes, mvhd.body + 4, 4);
      if (seconds > MAC_EPOCH_OFFSET) takenAt = toLocal(new Date((seconds - MAC_EPOCH_OFFSET) * 1000));
    }
  }
  return { takenAt, offset: null, lat: position?.lat ?? null, lng: position?.lng ?? null };
}

// ---------- files ----------

const HEAD_BYTES = 512 * 1024;
const MAX_MOOV_BYTES = 16 * 1024 * 1024;

async function readBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

async function videoInfo(file, options) {
  let p = 0;
  while (p + 8 <= file.size) {
    const head = await readBytes(file, p, p + 16);
    const [box] = boxes(head, 0, head.length);
    if (!box) return null;
    let size = box.size;
    if (((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) === 0) size = file.size - p;
    if (box.type === "moov") {
      if (size > MAX_MOOV_BYTES) return null;
      return parseMoov(await readBytes(file, p, p + size), options);
    }
    if (size < 8) return null;
    p += size;
  }
  return null;
}

/**
 * { takenAt: "YYYY-MM-DDTHH:MM:SS"|null, date: "YYYY-MM-DD"|null, lat, lng, source }
 * source: "exif" | "heif" | "video" | "file" (only the file's modified time) | null
 */
export async function readCaptureInfo(file, options = {}) {
  let info = null, source = null;
  try {
    const head = await readBytes(file, 0, Math.min(file.size, HEAD_BYTES));
    if (head[0] === 0xff && head[1] === 0xd8) {
      info = parseJpeg(head);
      source = "exif";
    } else if (looksLikeHeif(head)) {
      const extent = heifExifExtent(head);
      if (extent) info = parseHeifExifItem(await readBytes(file, extent.offset, extent.offset + extent.length));
      source = "heif";
    } else if (isVideoFile(file) || ascii(head, 4, 4) === "ftyp") {
      info = await videoInfo(file, options);
      source = "video";
    }
  } catch (error) {
    console.warn("[Snap Diary] could not read capture info", error);
  }
  if (info?.takenAt || info?.lat !== null && info?.lat !== undefined) {
    return { takenAt: info.takenAt || null, date: info.takenAt ? info.takenAt.slice(0, 10) : null,
      lat: info.lat ?? null, lng: info.lng ?? null, source };
  }
  // No metadata: the file's modified time is a weak hint (often the download time).
  if (file.lastModified) {
    const d = new Date(file.lastModified);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    return { takenAt: local, date: local.slice(0, 10), lat: null, lng: null, source: "file" };
  }
  return { takenAt: null, date: null, lat: null, lng: null, source: null };
}
