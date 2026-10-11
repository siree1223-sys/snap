// Video attachments: the original file is kept untouched (no re-encoding on
// the phone); a poster JPEG is captured for lists, the calendar and Drive.

import { MAX_VIDEO_BYTES, videoMime } from "./media.js";

const POSTER_MAX_SIDE = 480;

function waitFor(target, okEvent, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(target.error || new Error("video error")); };
    function cleanup() {
      clearTimeout(timer);
      target.removeEventListener(okEvent, ok);
      target.removeEventListener("error", fail);
    }
    target.addEventListener(okEvent, ok, { once: true });
    target.addEventListener("error", fail, { once: true });
  });
}

function canvasOf(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toJpeg(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("poster encode failed"))), "image/jpeg", 0.8));
}

/** Stand-in poster for videos this browser cannot decode (e.g. HEVC on some Androids). */
async function placeholderPoster() {
  const canvas = canvasOf(480, 270);
  const g = canvas.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 480, 270);
  grad.addColorStop(0, "#2a2634");
  grad.addColorStop(1, "#4b3150");
  g.fillStyle = grad;
  g.fillRect(0, 0, 480, 270);
  g.fillStyle = "rgba(255,255,255,.85)";
  g.beginPath();
  g.moveTo(215, 100);
  g.lineTo(215, 170);
  g.lineTo(275, 135);
  g.closePath();
  g.fill();
  return toJpeg(canvas);
}

async function capturePoster(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    // Metadata alone proves the browser can read the file (size, length).
    await waitFor(video, "loadedmetadata", 10000);
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height) throw new Error("no video track");
    let poster = null;
    try {
      // iOS Safari ignores preload; seeking (or a muted inline play) loads a frame.
      video.currentTime = duration ? Math.min(1, duration * 0.1) : 0.001;
      await waitFor(video, "seeked", 5000).catch(async () => {
        await video.play();
        await waitFor(video, "timeupdate", 4000);
        video.pause();
      });
      const scale = Math.min(1, POSTER_MAX_SIDE / Math.max(width, height));
      const canvas = canvasOf(Math.round(width * scale), Math.round(height * scale));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      poster = await toJpeg(canvas);
    } catch (error) {
      console.warn("[Snap Diary] could not grab a video frame", error);
    }
    return { poster: poster || await placeholderPoster(), width, height, duration, playable: true };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** { video, poster, width, height, duration, mime, size, playable } for one picked file. */
export async function prepareVideo(file) {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error(`동영상이 너무 커요 (${Math.round(file.size / 1048576)} MB). 1 GB 이하로 골라 주세요.`);
  }
  const mime = videoMime(file);
  const video = file.type === mime ? file : new Blob([file], { type: mime });
  let info;
  try {
    info = await capturePoster(video);
  } catch (error) {
    console.warn("[Snap Diary] video preview unavailable on this device", error);
    info = { poster: await placeholderPoster(), width: 0, height: 0, duration: null, playable: false };
  }
  return { video, mime, size: file.size, ...info };
}
