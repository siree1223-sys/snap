// Photo decoding and re-encoding. Re-encoding through a canvas applies the
// camera's EXIF rotation and strips EXIF metadata (including GPS) before
// anything is uploaded. HEIF/HEIC photos end up as JPEG the same way.

import { CONFIG } from "./config.js";
import { looksLikeHeif, isHeifName } from "./media.js";

const SIZE_KEY = "snapdiary.photoSize";
// "small" keeps a 1280 px copy (the original stays in your phone / Google Photos);
// "large" keeps 2560 px.
export const PHOTO_SIDES = { small: 1280, large: 2560 };
const THUMB_MAX_SIDE = 480;

export function photoSize() {
  try { return localStorage.getItem(SIZE_KEY) === "large" ? "large" : "small"; } catch { return "small"; }
}
export function setPhotoSize(size) {
  try { localStorage.setItem(SIZE_KEY, size === "large" ? "large" : "small"); } catch { /* ignore */ }
}
// Drive's simple multipart upload accepts up to 5 MB; stay comfortably below.
export const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024;

let heicModule = null;
/** libheif (WebAssembly) via heic-to, fetched only the first time a HEIC needs it. */
function heicConverter() {
  if (!heicModule) {
    heicModule = import(/* @vite-ignore */ CONFIG.heicUrl).catch((error) => {
      heicModule = null;
      throw error;
    });
  }
  return heicModule;
}

async function isHeif(blob) {
  if (isHeifName(blob)) return true;
  return looksLikeHeif(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
}

async function decodeNative(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch { /* fall through to <img> decoding (e.g. older Safari) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decodes JPEG/PNG/WebP/AVIF natively. HEIF/HEIC decodes natively where the
 * browser can (Safari); elsewhere (Chrome on Android/desktop) it goes through
 * libheif, with its rotation/mirroring applied.
 */
export async function decodeImage(blob) {
  try {
    return await decodeNative(blob);
  } catch (nativeError) {
    if (!(await isHeif(blob))) throw new Error("이 사진 형식은 열 수 없습니다. JPG/PNG/HEIC 사진을 선택해 주세요.");
  }
  let converter;
  try {
    converter = await heicConverter();
  } catch {
    throw new Error("HEIC 사진을 열려면 처음 한 번 인터넷 연결이 필요해요 (변환기 다운로드).");
  }
  try {
    return await converter.heicTo({ blob, type: "bitmap" });
  } catch (error) {
    console.warn("[Snap Diary] HEIC decode failed", error);
    throw new Error("이 HEIC 사진을 열 수 없습니다.");
  }
}

export function sizeOf(image) {
  return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
}

function fit(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function encode(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("사진 인코딩 실패"))), type, quality));
}

async function render(image, maxSide, quality, maxBytes = Infinity) {
  const src = sizeOf(image);
  let target = fit(src.width, src.height, maxSide);
  let q = quality;
  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, target.width, target.height);
    const blob = await encode(canvas, "image/jpeg", q);
    canvas.width = canvas.height = 1;
    if (blob.size <= maxBytes) return { blob, ...target };
    if (q > 0.62) q -= 0.08;
    else target = fit(target.width, target.height, Math.round(Math.max(target.width, target.height) * 0.8));
  }
  throw new Error("사진이 너무 큽니다.");
}

/** Diary copy (1280 or 2560 px, ≤4.5 MB) and thumbnail JPEGs for one picked file. */
export async function preparePhoto(file, { maxSide = PHOTO_SIDES[photoSize()] } = {}) {
  const image = await decodeImage(file);
  try {
    const full = await render(image, maxSide, maxSide <= 1280 ? 0.85 : 0.9, MAX_UPLOAD_BYTES);
    const thumb = await render(image, THUMB_MAX_SIDE, 0.78);
    return { full: full.blob, thumb: thumb.blob, width: full.width, height: full.height };
  } finally {
    image.close?.();
  }
}
