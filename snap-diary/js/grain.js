// Grain math shared by the 3D place viewer and the tests.
//
// Ported from Meet Vanish (../meet-vanish-extension/dust-effect.js and
// grain-transport.js): one GPU point per source cell, a hashed birth field that
// decides when each grain detaches, a right-leaning release bias with random
// births on BOTH sides, and core + two finer fragments per cell. The 2D room /
// person compositing becomes a depth-displaced 3D point cloud here.

export const SNAP_DURATION = 2200; // ms, same as MeetVanishDust.duration
export const FRAGMENTS_PER_CELL = 3;
const BIRTH_SEED = 7187;

/** Identical to MeetVanishDust.hashGrain so the release pattern matches /snap. */
export function hashGrain(x, y, seed) {
  let value = Math.imul((x | 0) + 1, 374761393) + Math.imul((y | 0) + 1, 668265263) +
    Math.imul(seed | 0, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

/**
 * Birth time in [0.018, 0.738], quantized to 1/255 like the /snap birth
 * texture. More release on the right, but births stay random on both sides:
 * no ordered sweep or hard edge.
 */
export function birthAt(x, y, cols) {
  const bias = Math.max(0.25, Math.min(1.75, 1 + 4 * ((x + 0.5) / cols - 0.5)));
  return Math.round(255 * (0.018 + Math.pow(hashGrain(x, y, BIRTH_SEED), bias) * 0.72)) / 255;
}

/** Grid that keeps cells square for an image aspect ratio. */
export function gridSize(width, height, longSide) {
  const aspect = width / height;
  if (aspect >= 1) {
    return { cols: longSide, rows: Math.max(1, Math.round(longSide / aspect)) };
  }
  return { cols: Math.max(1, Math.round(longSide * aspect)), rows: longSide };
}

/** Bilinear sample of a single-channel 0..255 map at normalized (u, v), v down. */
export function sampleMap(map, u, v) {
  const { data, width, height } = map;
  const x = Math.min(width - 1, Math.max(0, u * width - 0.5));
  const y = Math.min(height - 1, Math.max(0, v * height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * width + x0] * (1 - fx) + data[y0 * width + x1] * fx;
  const b = data[y1 * width + x0] * (1 - fx) + data[y1 * width + x1] * fx;
  return (a * (1 - fy) + b * fy) / 255;
}

/**
 * Relative disparity (1 = nearest, 0 = farthest, as Depth Anything outputs)
 * to a camera distance. Interpolating in 1/Z keeps the parallax physically
 * plausible: near things move more than far things when the camera orbits.
 */
export function disparityToZ(d, zNear, zFar) {
  const clamped = Math.min(1, Math.max(0, d));
  return 1 / ((1 - clamped) / zFar + clamped / zNear);
}

/**
 * Per-grain attributes for the viewer.
 *   cell:   (u, v) of the source cell centre, v down
 *   info:   (disparity, birth, kind) with kind 0 = core, 1/2 = fine fragments
 * Core grains are the attached image; fine fragments only appear once their
 * cell has been released, exactly like the /snap points pass.
 */
export function buildGrainField(depthMap, cols, rows, fragments = FRAGMENTS_PER_CELL) {
  const count = cols * rows * fragments;
  const cell = new Float32Array(count * 2);
  const info = new Float32Array(count * 3);
  let i = 0;
  // Draw fine fragments after cores so attached cores keep the depth buffer.
  for (let kind = 0; kind < fragments; kind++) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols, v = (y + 0.5) / rows;
        cell[i * 2] = u;
        cell[i * 2 + 1] = v;
        info[i * 3] = depthMap ? sampleMap(depthMap, u, v) : 0.5;
        info[i * 3 + 1] = birthAt(x, y, cols);
        info[i * 3 + 2] = kind;
        i++;
      }
    }
  }
  return { cell, info, count };
}

/** Median of a 0..255 map, as 0..1. Used to pivot the orbit at mid-scene. */
export function medianLevel(map) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < map.data.length; i++) hist[map.data[i]]++;
  let seen = 0;
  const half = map.data.length / 2;
  for (let level = 0; level < 256; level++) {
    seen += hist[level];
    if (seen >= half) return level / 255;
  }
  return 0.5;
}

export function smootherstep(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}
