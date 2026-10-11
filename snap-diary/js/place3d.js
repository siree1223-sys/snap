// 3D place viewer: the photo becomes a depth-displaced cloud of GPU grains.
//
// This is the Meet Vanish grain transport (meet-vanish-extension/
// grain-transport.js) lifted into 3D. Same ideas, same constants:
//   - one GPU point per source cell, plus two finer fragments per cell
//   - a hashed birth field decides when each grain detaches (right-leaning,
//     random on both sides, no sweep line)
//   - detached grains carry their source colour up/right with wind + swirl,
//     shrink by 32% and fade from age .35
//   - reappearing runs the same paths backwards (re-formation)
// What is new: each cell sits at its estimated depth, the camera can orbit,
// and attached cells sample their own image patch so the scene reads sharp.

import { buildGrainField, gridSize, disparityToZ, medianLevel, SNAP_DURATION } from "./grain.js";

const VERTEX = `
precision highp float;
attribute vec2 aCell;
attribute vec3 aInfo;
uniform mat4 uViewProj;
uniform vec2 uGrid;
uniform float uTanH, uAspect, uInvNear, uInvFar;
uniform float uProgress, uDrift, uProjScale, uMaxPoint, uPass;
varying vec2 vUv;
varying vec2 vSpan;
varying float vAlpha, vRound;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
  float disparity=aInfo.x, birth=aInfo.y, kind=aInfo.z;
  float rx=hash(aCell*731.+5.+kind*37.), ry=hash(aCell*811.+17.+kind*53.);
  vec2 offset=kind<.5 ? vec2(0.) : (vec2(rx,ry)-.5)*.55/uGrid;
  vec2 uv=aCell+offset;
  float released=step(birth,uProgress);
  // Pass 0 draws attached cores (opaque, depth-writing); pass 1 draws grains
  // in flight (blended). Everything else is parked off screen.
  bool visible=uPass<.5 ? (kind<.5 && released<.5) : released>.5;
  float rawAge=clamp((uProgress-birth)/(1.-birth),0.,1.);
  float age=rawAge*rawAge*(3.-2.*rawAge);
  float z=1./mix(uInvFar,uInvNear,disparity);
  vec3 p=vec3((uv.x-.5)*2.*z*uTanH*uAspect,(.5-uv.y)*2.*z*uTanH,-z);
  vec3 wind=vec3(42.+rx*120.,30.+ry*100.,(ry-.35)*90.)*(1.+kind*.16);
  vec3 swirl=vec3(sin(age*5.+rx*6.)-sin(rx*6.),cos(age*4.+ry*6.)-cos(ry*6.),
    sin(age*3.+ry*5.)-sin(ry*5.))*10.;
  p+=(wind*age+swirl)*uDrift*z;
  vec4 clip=uViewProj*vec4(p,1.);
  gl_Position=visible && clip.w>0. ? clip : vec4(3.,3.,0.,1.);
  float cellPx=(2.*z*uTanH/uGrid.y)*uProjScale/max(clip.w,1e-3);
  float grain=kind<.5 ? .85+rx*.30 : (kind<1.5 ? .52 : .34);
  float flying=smoothstep(0.,.12,age);
  gl_PointSize=min(uMaxPoint,cellPx*mix(1.12,1.25*grain,flying)*(1.-age*.32));
  float present=kind<.5 ? 1. : smoothstep(birth,birth+.018,uProgress);
  vAlpha=present*(1.-smoothstep(.35,1.,age));
  vRound=flying;
  vUv=uv;
  vSpan=1.12/uGrid;
}`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uImage;
varying vec2 vUv;
varying vec2 vSpan;
varying float vAlpha, vRound;
void main(){
  vec2 pc=gl_PointCoord-.5;
  float radius=length(pc);
  if(radius>mix(.75,.5,vRound) || vAlpha<=.001) discard;
  // Attached: the splat shows the image patch it covers (sharp photo).
  // In flight: one source colour per grain, like the /snap palette lookup.
  vec2 uv=mix(vUv+pc*vSpan,vUv,vRound);
  vec3 color=texture2D(uImage,uv).rgb;
  float edge=mix(1.,1.-smoothstep(.35,.5,radius),vRound);
  gl_FragColor=vec4(color,vAlpha*edge);
}`;

// ---------- tiny mat4 helpers (column-major) ----------
function perspective(tanHalf, aspect, near, far) {
  const f = 1 / tanHalf, nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1
  ]);
}
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const FOV_TAN = Math.tan((50 * Math.PI) / 180 / 2);
const Z_NEAR = 1;

function lowEndDevice() {
  return (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{image: ImageBitmap|HTMLImageElement, depth: {data,width,height}|null,
 *          density?: number, autoplay?: boolean}} options
 */
export function createPlaceViewer(canvas, options) {
  const gl = canvas.getContext("webgl", {
    alpha: false, antialias: false, depth: true, stencil: false, premultipliedAlpha: false,
    preserveDrawingBuffer: Boolean(options.preserveDrawingBuffer)
  });
  if (!gl) throw new Error("이 기기에서는 3D(WebGL)를 사용할 수 없습니다.");

  const image = options.image;
  const imgW = image.naturalWidth || image.width, imgH = image.naturalHeight || image.height;
  const aspect = imgW / imgH;
  const longSide = options.density || (lowEndDevice() ? 240 : 320);
  const { cols, rows } = gridSize(imgW, imgH, longSide);
  const field = buildGrainField(options.depth, cols, rows);
  const cores = cols * rows;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, VERTEX), fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  gl.useProgram(program);

  const loc = {};
  for (const name of ["uViewProj", "uGrid", "uTanH", "uAspect", "uInvNear", "uInvFar", "uProgress",
    "uDrift", "uProjScale", "uMaxPoint", "uPass", "uImage"]) loc[name] = gl.getUniformLocation(program, name);

  function attribute(name, data, size) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const index = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, gl.FLOAT, false, 0, 0);
    return buffer;
  }
  const buffers = [attribute("aCell", field.cell, 2), attribute("aInfo", field.info, 3)];

  // Texture: cap at 2048 px / GPU limit; the grains sample it per fragment.
  const maxTex = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  let source = image;
  if (Math.max(imgW, imgH) > maxTex) {
    const scale = maxTex / Math.max(imgW, imgH);
    source = document.createElement("canvas");
    source.width = Math.round(imgW * scale);
    source.height = Math.round(imgH * scale);
    source.getContext("2d").drawImage(image, 0, 0, source.width, source.height);
  }
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (source !== image) source.width = source.height = 1;
  gl.uniform1i(loc.uImage, 0);
  gl.uniform2f(loc.uGrid, cols, rows);
  gl.uniform1f(loc.uTanH, FOV_TAN);
  gl.uniform1f(loc.uAspect, aspect);
  // Same wind scale as /snap: offsets are in "pixels of a 480-px frame".
  gl.uniform1f(loc.uDrift, (2 * FOV_TAN * Math.min(1, aspect)) / 480);
  gl.uniform1f(loc.uMaxPoint, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1]);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.clearColor(0.047, 0.047, 0.063, 1);

  const median = options.depth ? medianLevel(options.depth) : 0.5;
  const state = {
    progress: options.autoplay === false ? 0 : 1,
    target: 0,
    animating: options.autoplay !== false,
    lastTime: 0,
    yaw: 0, pitch: 0, zoom: 1,
    gyroYaw: 0, gyroPitch: 0,
    strength: 1,
    pivot: 1,
    // The gentle "3D photo" sway starts once the opening re-formation is done.
    lastInteraction: performance.now() - 1500,
    disposed: false,
    frame: 0,
    onChange: options.onChange || (() => {})
  };

  function setStrength(value) {
    state.strength = clamp(value, 0, 2);
    const zFar = Z_NEAR * (1 + 2.6 * state.strength);
    gl.uniform1f(loc.uInvNear, 1 / Z_NEAR);
    gl.uniform1f(loc.uInvFar, 1 / zFar);
    state.pivot = disparityToZ(median, Z_NEAR, zFar);
    requestFrame();
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw(time) {
    resize();
    const w = canvas.width, h = canvas.height;
    const canvasAspect = w / h;
    // "Contain" the photo: with the camera at the origin it fills the view
    // exactly as the original photo, whatever the depth map says.
    const fitTan = FOV_TAN * Math.max(1, aspect / canvasAspect);
    const idle = time - state.lastInteraction > 4000;
    const sway = idle ? Math.min(1, (time - state.lastInteraction - 4000) / 1500) : 0;
    const yaw = state.yaw + state.gyroYaw + sway * 0.07 * Math.sin(time / 2100);
    const pitch = state.pitch + state.gyroPitch + sway * 0.035 * Math.sin(time / 2900);
    const pivot = state.pivot;
    const dist = pivot * state.zoom;
    const eye = [
      dist * Math.sin(yaw) * Math.cos(pitch),
      dist * Math.sin(pitch),
      -pivot + dist * Math.cos(yaw) * Math.cos(pitch)
    ];
    const proj = perspective(fitTan, canvasAspect, 0.05, 40);
    const view = lookAt(eye, [0, 0, -pivot], [0, 1, 0]);
    gl.viewport(0, 0, w, h);
    gl.uniformMatrix4fv(loc.uViewProj, false, multiply(proj, view));
    gl.uniform1f(loc.uProjScale, h / (2 * fitTan));
    gl.uniform1f(loc.uProgress, state.progress);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.uniform1f(loc.uPass, 0);
    gl.drawArrays(gl.POINTS, 0, cores);
    if (state.progress > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(loc.uPass, 1);
      gl.drawArrays(gl.POINTS, 0, field.count);
    }
    state.frame++;
  }

  let rafId = 0;
  function loop(time) {
    rafId = 0;
    if (state.disposed) return;
    if (state.animating) {
      const dt = state.lastTime ? Math.min(64, time - state.lastTime) : 16;
      const step = dt / SNAP_DURATION;
      const before = state.progress;
      state.progress = state.target > state.progress
        ? Math.min(state.target, state.progress + step)
        : Math.max(state.target, state.progress - step);
      if (state.progress === state.target) {
        state.animating = false;
        state.onChange({ vanished: state.progress === 1 });
      } else if (before === state.progress) state.animating = false;
    }
    state.lastTime = time;
    draw(time);
    rafId = requestAnimationFrame(loop); // keeps the idle sway alive while open
  }
  function requestFrame() {
    if (!rafId && !state.disposed) rafId = requestAnimationFrame(loop);
  }

  // ---------- interaction ----------
  const pointers = new Map();
  let pinchStart = null;
  function onDown(event) {
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    state.lastInteraction = performance.now();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom };
    }
  }
  function onMove(event) {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);
    state.lastInteraction = performance.now();
    if (pointers.size === 1) {
      const scale = 2.2 / Math.max(240, Math.min(canvas.clientWidth, canvas.clientHeight));
      state.yaw = clamp(state.yaw - (next.x - prev.x) * scale, -0.38, 0.38);
      state.pitch = clamp(state.pitch + (next.y - prev.y) * scale, -0.24, 0.24);
    } else if (pinchStart && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      state.zoom = clamp(pinchStart.zoom * (pinchStart.dist / Math.max(1, dist)), 0.45, 1.5);
    }
  }
  function onUp(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = null;
  }
  function onWheel(event) {
    event.preventDefault();
    state.lastInteraction = performance.now();
    state.zoom = clamp(state.zoom * Math.exp(event.deltaY * 0.001), 0.45, 1.5);
  }
  let gyroBase = null;
  function onOrientation(event) {
    if (event.beta == null || event.gamma == null) return;
    if (!gyroBase) gyroBase = { beta: event.beta, gamma: event.gamma };
    state.gyroYaw = clamp(-(event.gamma - gyroBase.gamma) * 0.012, -0.3, 0.3);
    state.gyroPitch = clamp((event.beta - gyroBase.beta) * 0.01, -0.22, 0.22);
  }
  function onContextLost(event) {
    event.preventDefault();
    state.disposed = true;
    options.onError?.(new Error("그래픽 메모리가 부족해 3D 보기를 닫았습니다."));
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("webglcontextlost", onContextLost);

  setStrength(1);
  requestFrame();

  return {
    cols, rows,
    grainCount: field.count,
    get progress() { return state.progress; },
    get frames() { return state.frame; },
    /** Toggle: dissolve into dust, or re-form from it (reverses mid-flight). */
    snap() {
      state.target = state.target === 1 ? 0 : 1;
      state.animating = true;
      state.lastInteraction = performance.now(); // hold the idle sway while dust flies
      requestFrame();
      return state.target === 1;
    },
    setDepthStrength: setStrength,
    resetView() {
      state.yaw = state.pitch = 0;
      state.zoom = 1;
      gyroBase = null;
      state.lastInteraction = performance.now();
    },
    /** iOS asks for motion permission; this must run inside a tap handler. */
    async enableGyro() {
      const Orientation = globalThis.DeviceOrientationEvent;
      if (!Orientation) return false;
      if (typeof Orientation.requestPermission === "function") {
        if ((await Orientation.requestPermission()) !== "granted") return false;
      }
      gyroBase = null;
      window.addEventListener("deviceorientation", onOrientation);
      return true;
    },
    disableGyro() {
      window.removeEventListener("deviceorientation", onOrientation);
      state.gyroYaw = state.gyroPitch = 0;
    },
    /** Deterministic still frame (tests and thumbnails). */
    renderAt(progress, { yaw = 0, pitch = 0 } = {}) {
      state.animating = false;
      state.progress = state.target = clamp(progress, 0, 1);
      state.yaw = yaw;
      state.pitch = pitch;
      state.lastInteraction = Infinity;
      draw(0);
      state.lastInteraction = performance.now();
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("deviceorientation", onOrientation);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      buffers.forEach((b) => gl.deleteBuffer(b));
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  };
}
