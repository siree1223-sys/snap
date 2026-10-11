// Depth maps for place photos.
//
// 1. On-device AI: Depth Anything V2 (small) through Transformers.js. The model
//    runs in this browser; only the weights are downloaded once and cached.
// 2. Offline fallback: a cheap monocular heuristic (ground-plane prior, local
//    texture, sky detection). Labelled "heuristic" so it can be recomputed.
//
// Output: { data: Uint8Array, width, height, source } where 255 = nearest.

import { CONFIG } from "./config.js";

const MAX_DEPTH_SIDE = 384;

// ---------- heuristic (pure; tested in Node) ----------

function boxBlur(src, width, height, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    let acc = 0, n = 0;
    for (let x = -radius; x < width + radius; x++) {
      if (x + radius < width) { acc += src[y * width + Math.min(width - 1, x + radius)]; n++; }
      if (x - radius - 1 >= 0) { acc -= src[y * width + (x - radius - 1)]; n--; }
      if (x >= 0 && x < width) tmp[y * width + x] = acc / n;
    }
  }
  for (let x = 0; x < width; x++) {
    let acc = 0, n = 0;
    for (let y = -radius; y < height + radius; y++) {
      if (y + radius < height) { acc += tmp[Math.min(height - 1, y + radius) * width + x]; n++; }
      if (y - radius - 1 >= 0) { acc -= tmp[(y - radius - 1) * width + x]; n--; }
      if (y >= 0 && y < height) out[y * width + x] = acc / n;
    }
  }
  return out;
}

function percentile(values, q) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/**
 * Heuristic relative disparity from RGBA pixels (row-major, top row first).
 * Assumptions, stated plainly: the ground recedes upward, textured surfaces are
 * nearer than flat haze, and bright low-texture regions near the top are sky.
 */
export function heuristicDepth(rgba, width, height) {
  const n = width * height;
  const luma = new Float32Array(n);
  const blue = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    blue[i] = b - (r + g) / 2;
  }
  const radius = Math.max(1, Math.round(Math.max(width, height) / 80));
  const local = boxBlur(luma, width, height, radius);
  const detail = new Float32Array(n);
  for (let i = 0; i < n; i++) detail[i] = Math.abs(luma[i] - local[i]);
  const texture = boxBlur(detail, width, height, radius * 3);
  const texHigh = Math.max(1e-4, percentile(texture, 0.95));
  const disparity = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    const v = height > 1 ? y / (height - 1) : 0.5;
    const ground = Math.pow(v, 1.15);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tex = Math.min(1, texture[i] / texHigh);
      const top = Math.max(0, 1 - v / 0.6);
      const sky = top * (luma[i] > 0.5 ? 1 : 0) * (tex < 0.25 ? 1 : 0) *
        (blue[i] > 0.02 || luma[i] > 0.82 ? 1 : 0);
      disparity[i] = Math.max(0, 0.62 * ground + 0.38 * tex - 0.7 * sky);
    }
  }
  let smooth = disparity;
  for (let pass = 0; pass < 3; pass++) smooth = boxBlur(smooth, width, height, radius * 2);
  const lo = percentile(smooth, 0.02), hi = percentile(smooth, 0.98);
  const span = Math.max(1e-4, hi - lo);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(255 * Math.min(1, Math.max(0, (smooth[i] - lo) / span)));
  return out;
}

// ---------- browser helpers ----------

function fitSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function canvasOf(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지 인코딩 실패"))), type, quality));
}

async function pixelsOf(bitmap, maxSide) {
  const size = fitSize(bitmap.width, bitmap.height, maxSide);
  const canvas = canvasOf(size.width, size.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  return { ...size, rgba: ctx.getImageData(0, 0, size.width, size.height).data, canvas };
}

/** Resample any single-channel map to fit MAX_DEPTH_SIDE (bilinear-ish via canvas). */
function resizeMap(data, width, height, maxSide) {
  const size = fitSize(width, height, maxSide);
  if (size.width === width && size.height === height) return { data, ...size };
  const out = new Uint8Array(size.width * size.height);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) * width / size.width - 0.5));
      const sy = Math.min(height - 1, Math.max(0, (y + 0.5) * height / size.height - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const a = data[y0 * width + x0] * (1 - fx) + data[y0 * width + x1] * fx;
      const b = data[y1 * width + x0] * (1 - fx) + data[y1 * width + x1] * fx;
      out[y * size.width + x] = Math.round(a * (1 - fy) + b * fy);
    }
  }
  return { data: out, ...size };
}

// ---------- AI model ----------

let pipelinePromise = null;

function loadPipeline(onProgress) {
  if (!pipelinePromise) {
    const files = new Map();
    pipelinePromise = (async () => {
      const transformers = await import(/* @vite-ignore */ CONFIG.transformersUrl);
      transformers.env.allowLocalModels = false;
      const estimator = await transformers.pipeline("depth-estimation", CONFIG.depthModel, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (event) => {
          if (event?.status !== "progress" || !event.file) return;
          files.set(event.file, { loaded: event.loaded || 0, total: event.total || 0 });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          if (total > 0) onProgress?.({ stage: "download", ratio: loaded / total });
        }
      });
      return { estimator, RawImage: transformers.RawImage };
    })().catch((error) => {
      pipelinePromise = null;
      throw error;
    });
  }
  return pipelinePromise;
}

async function aiDepth(bitmap, onProgress) {
  const { estimator, RawImage } = await loadPipeline(onProgress);
  onProgress?.({ stage: "infer" });
  // The model resizes to ~518 px internally; a smaller input saves decoding work.
  const { canvas } = await pixelsOf(bitmap, 640);
  const blob = await canvasToBlob(canvas, "image/png");
  const image = await RawImage.fromBlob(blob);
  const output = await estimator(image);
  const depth = output?.depth;
  if (!depth?.data || !depth.width || !depth.height) throw new Error("깊이 결과가 비어 있습니다.");
  let gray = depth.data;
  if (depth.channels && depth.channels !== 1) {
    gray = new Uint8Array(depth.width * depth.height);
    for (let i = 0; i < gray.length; i++) gray[i] = depth.data[i * depth.channels];
  }
  return resizeMap(Uint8Array.from(gray), depth.width, depth.height, MAX_DEPTH_SIDE);
}

/**
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 * @param {{useAI?: boolean, onProgress?: Function}} options
 */
export async function estimateDepth(bitmap, { useAI = true, onProgress } = {}) {
  if (useAI) {
    try {
      const map = await aiDepth(bitmap, onProgress);
      return { ...map, source: "ai" };
    } catch (error) {
      console.warn("[Snap Diary] AI depth unavailable, using heuristic depth.", error);
      onProgress?.({ stage: "fallback", error: String(error?.message || error) });
    }
  }
  const { rgba, width, height } = await pixelsOf(bitmap, 160);
  const data = heuristicDepth(rgba, width, height);
  return { data, width, height, source: "heuristic" };
}

/** Depth maps are stored (locally and in Drive) as grayscale PNGs. */
export async function depthToBlob(map) {
  const canvas = canvasOf(map.width, map.height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(map.width, map.height);
  for (let i = 0; i < map.data.length; i++) {
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = map.data[i];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvasToBlob(canvas, "image/png");
}

export async function blobToDepth(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = canvasOf(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const data = new Uint8Array(bitmap.width * bitmap.height);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
    return { data, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close?.();
  }
}
