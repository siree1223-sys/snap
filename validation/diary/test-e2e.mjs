// End-to-end: the built Snap Diary PWA in real Chromium (WebGL via SwiftShader)
// against an in-memory Google Drive, a fake Google sign-in script and a fake
// Transformers.js module. Two browser contexts act as two phones.
//
//   python3 scripts/build-diary.py && node validation/diary/test-e2e.mjs
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createFakeDrive } from "./fake-drive.mjs";
import { placePhoto, plainPhoto } from "./png.mjs";

// Lets context.route() see fetches made by the app's service worker (CDN cache).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const id of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try { return require(id); } catch { /* try next */ }
  }
  throw new Error("playwright is not installed (npm install --no-save playwright)");
}
const { chromium } = loadPlaywright();

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(here, "../../dist/snap-diary");
if (!fs.existsSync(path.join(SITE, "index.html"))) throw new Error("run python3 scripts/build-diary.py first");
const CLIENT_ID = "1234567890-testclient.apps.googleusercontent.com";
const HEIC = fs.readFileSync(path.join(here, "fixtures", "place.heic"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file = path.join(SITE, decodeURIComponent(url.pathname));
  if (!file.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const drive = createFakeDrive({ token: "test-token", email: "me@example.com" });
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, content-range, x-upload-content-type, x-upload-content-length",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
};
// Like the real endpoint (probed): X-GUploader-UploadID is readable from JS.
// Location is deliberately NOT exposed here, so the upload-id fallback is what
// these tests exercise.
const DRIVE_EXPOSE = { "access-control-expose-headers": "X-GUploader-UploadID, Range" };
let heicPath = null;
try { heicPath = require.resolve("heic-to"); } catch { /* optional: HEIC step reports it */ }
const FAKE_GIS = `window.google = { accounts: { oauth2: {
  initTokenClient(cfg) {
    return { requestAccessToken(opts) {
      (window.__gis = window.__gis || []).push({ client_id: cfg.client_id, scope: cfg.scope, opts });
      setTimeout(() => cfg.callback({ access_token: "test-token", expires_in: 3599, token_type: "Bearer", scope: cfg.scope }), 20);
    } };
  },
  revoke(token, done) { done && done({ successful: true }); }
} } };`;
const FAKE_TRANSFORMERS = `
export const env = { allowLocalModels: true };
export class RawImage {
  static async fromBlob(blob) {
    const bitmap = await createImageBitmap(blob);
    return Object.assign(new RawImage(), { width: bitmap.width, height: bitmap.height });
  }
}
export async function pipeline(task, model, options) {
  (globalThis.__pipelineCalls = globalThis.__pipelineCalls || []).push({ task, model, dtype: options.dtype, device: options.device });
  options.progress_callback?.({ status: "progress", file: "onnx/model_quantized.onnx", loaded: 40, total: 100 });
  options.progress_callback?.({ status: "progress", file: "onnx/model_quantized.onnx", loaded: 100, total: 100 });
  return async (image) => {
    const { width, height } = image;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = Math.round(255 * y / (height - 1));
    return { predicted_depth: null, depth: { data, width, height, channels: 1 } };
  };
}`;

async function newDevice(browser, { ai = true, config = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, locale: "ko-KR",
    permissions: ["clipboard-read", "clipboard-write"]
  });
  const stats = { cdn: 0, hf: 0, heic: 0 };
  await context.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_GIS }));
  await context.route("https://oauth2.googleapis.com/**", (route) => route.fulfill({ status: 200, headers: CORS, body: "{}" }));
  await context.route("https://www.googleapis.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const buffer = req.postDataBuffer();
    const result = await drive.handle({
      method: req.method(), url: req.url(), headers: await req.allHeaders(),
      body: buffer ? new Uint8Array(buffer) : null
    });
    if (result.networkError) return route.abort("connectionreset");
    return route.fulfill({ status: result.status, headers: { ...CORS, ...DRIVE_EXPOSE, ...result.headers },
      body: result.body == null ? "" : Buffer.from(result.body) });
  });
  await context.route("https://cdn.jsdelivr.net/**", (route) => {
    if (route.request().url().includes("/npm/heic-to@")) {
      stats.heic++;
      if (!heicPath) return route.fulfill({ status: 404, headers: CORS, body: "" });
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/javascript" }, body: fs.readFileSync(heicPath) });
    }
    stats.cdn++;
    if (!ai) return route.fulfill({ status: 404, headers: CORS, body: "blocked in test" });
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/javascript" }, body: FAKE_TRANSFORMERS });
  });
  await context.route("https://huggingface.co/**", (route) => { stats.hf++; return route.fulfill({ status: 404, body: "" }); });
  if (config) {
    await context.route(`${ORIGIN}/config.js`, (route) => route.fulfill({
      status: 200, contentType: "text/javascript", body: `export const SITE_CONFIG = ${JSON.stringify(config)};`
    }));
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector(".tabs");
  return { context, page, errors, stats };
}

const chip = (page) => page.locator(".sync-chip");
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function waitChip(page, pattern, timeout = 15000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".sync-chip")?.textContent || ""),
    pattern.source, { timeout });
}

async function setClientId(page) {
  await page.goto(`${ORIGIN}/#/settings`);
  await page.locator(".settings input.mono").fill(CLIENT_ID);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForFunction((id) => localStorage.getItem("snapdiary.clientId") === id, CLIENT_ID);
}

/** Fraction of lit pixels in the 3D canvas, sampled right after a rendered frame. */
async function litFraction(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    const c = document.querySelector(".viewer-canvas");
    const s = document.createElement("canvas");
    s.width = 120;
    s.height = Math.round(120 * c.height / c.width);
    const g = s.getContext("2d");
    g.drawImage(c, 0, 0, s.width, s.height);
    const d = g.getImageData(0, 0, s.width, s.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 90) lit++;
    resolve(lit / (s.width * s.height));
  })));
}

const viewerAt = (page, test) => page.waitForFunction(
  (src) => { const v = globalThis.__snapDiary?.viewer; return Boolean(v) && new Function("p", `return ${src}`)(v.progress); },
  test, { timeout: 30000 });
/** Straight-on camera with the idle sway held, so frames are comparable. */
const steady = (page) => page.evaluate(() => globalThis.__snapDiary.viewer.resetView());

async function openViewer(page) {
  await page.locator(".place-card").first().click();
  await page.waitForSelector(".viewer-tools:not([hidden])", { timeout: 30000 });
  await viewerAt(page, "p === 0"); // the opening re-formation has finished
  await steady(page);
}

const steps = [];
async function step(name, fn) {
  const started = Date.now();
  await fn();
  steps.push(name);
  console.log(`ok ${steps.length} - ${name} (${Date.now() - started} ms)`);
}

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
let A, B;
try {
  await step("first launch: app shell renders, Drive not configured yet", async () => {
    A = await newDevice(browser);
    await waitChip(A.page, /Drive 설정/);
    assert.match(await A.page.locator(".empty").innerText(), /아직 기록이 없어요/);
    const manifest = await A.page.evaluate(() => fetch("manifest.webmanifest").then((r) => r.json()));
    assert.equal(manifest.display, "standalone");
  });

  await step("write an entry with a photo and a 3D place photo (AI depth path)", async () => {
    await setClientId(A.page);
    await A.page.goto(`${ORIGIN}/#/new`);
    await A.page.locator(".title-input").fill("성수동 산책");
    await A.page.locator(".text-input").fill("카페에서 책을 읽고\n강변을 걸었다.");
    await A.page.locator(".mood-btn").first().click();
    await A.page.locator(".place-field input").fill("성수동");
    const inputs = A.page.locator(".photo-actions input[type=file]");
    await inputs.nth(0).setInputFiles({ name: "cafe.png", mimeType: "image/png", buffer: plainPhoto() });
    await inputs.nth(1).setInputFiles({ name: "river.png", mimeType: "image/png", buffer: placePhoto() });
    await A.page.waitForFunction(() => /3D 준비됨 · AI 깊이/.test(document.body.innerText), null, { timeout: 30000 });
    const calls = await A.page.evaluate(() => globalThis.__pipelineCalls);
    assert.deepEqual(calls, [{ task: "depth-estimation", model: "onnx-community/depth-anything-v2-small", dtype: "q8", device: "wasm" }]);
    await A.page.locator(".editor .screen-head .btn.primary").click();
    await A.page.waitForSelector(".screen.entry");
    assert.match(await A.page.locator(".entry-head h2").innerText(), /성수동 산책/);
    assert.equal(await A.page.locator(".place-card").count(), 1);
    assert.equal(await A.page.locator(".photo-cell").count(), 1);
  });

  await step("3D viewer renders the place, snaps to dust and re-forms", async () => {
    await openViewer(A.page);
    const intact = await litFraction(A.page);
    assert.ok(intact > 0.25, `photo visible in 3D (lit ${intact})`);
    assert.match(await A.page.locator(".viewer-top .chip").innerText(), /AI 깊이/);
    await A.page.screenshot({ path: path.join(here, "..", "..", "dist", "e2e-viewer.png") });
    await A.page.locator(".tool.primary").click();
    await viewerAt(A.page, "p > 0.35 && p < 0.65");
    const midway = await litFraction(A.page);
    await viewerAt(A.page, "p === 1");
    const vanished = await litFraction(A.page);
    assert.ok(vanished < 0.01, `everything dissolved (lit ${vanished})`);
    assert.ok(midway > vanished && midway < intact, `dust in flight midway (lit ${midway})`);
    assert.match(await A.page.locator(".tool.primary").innerText(), /다시 모으기/);
    await A.page.locator(".tool.primary").click();
    await viewerAt(A.page, "p === 0");
    await steady(A.page);
    const reformed = await litFraction(A.page);
    assert.ok(Math.abs(reformed - intact) < 0.02, `re-formed (lit ${reformed} vs ${intact})`);
    // Drag to orbit: the near red block should shift against the far sky.
    const box = await A.page.locator(".viewer-canvas").boundingBox();
    await A.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await A.page.mouse.down();
    await A.page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 6 });
    await A.page.mouse.up();
    const rotated = await litFraction(A.page);
    assert.ok(Math.abs(rotated - intact) > 0.005, `orbit changes the view (lit ${rotated} vs ${intact})`);
    await A.page.locator(".viewer-top .icon-btn").click();
    await A.page.waitForSelector(".screen.entry");
  });

  await step("connect Google (popup flow) and sync to Drive", async () => {
    await A.page.goto(`${ORIGIN}/#/`);
    await waitChip(A.page, /Drive 연결 · 대기 1/);
    await chip(A.page).click();
    await waitChip(A.page, /동기화됨/);
    const gis = await A.page.evaluate(() => window.__gis);
    assert.equal(gis[0].client_id, CLIENT_ID);
    assert.equal(gis[0].scope, "https://www.googleapis.com/auth/drive.file");
    assert.equal(drive.live("root")[0].name, "Snap Diary");
    assert.equal(drive.live("entry").length, 1);
    assert.equal(drive.live("photo").length, 2);
    assert.equal(drive.live("thumb").length, 2);
    assert.equal(drive.live("depth").length, 1);
    const doc = JSON.parse(drive.text(drive.live("entry")[0].id));
    assert.equal(doc.title, "성수동 산책");
    assert.equal(doc.place.name, "성수동");
    const place = doc.photos.find((p) => p.kind === "place");
    assert.equal(place.depthSource, "ai");
    const jpeg = drive.files.get(place.driveId).content;
    assert.deepEqual([...jpeg.slice(0, 3)], [0xff, 0xd8, 0xff], "photos are re-encoded JPEGs (EXIF stripped)");
    assert.equal(await A.page.locator(".dot-pending").count(), 0);
  });

  await step("second phone restores the diary from Drive and views it in 3D", async () => {
    B = await newDevice(browser);
    await setClientId(B.page);
    await B.page.getByRole("button", { name: /Google 계정 연결/ }).click();
    await waitChip(B.page, /동기화됨/);
    await B.page.goto(`${ORIGIN}/#/`);
    await B.page.waitForSelector(".card");
    assert.match(await B.page.locator(".card h2").first().innerText(), /성수동 산책/);
    await B.page.locator(".card").first().click();
    await B.page.waitForSelector(".screen.entry");
    assert.match(await B.page.locator(".entry-text").innerText(), /강변을 걸었다/);
    await openViewer(B.page);
    assert.ok((await litFraction(B.page)) > 0.25, "downloaded photo + depth render in 3D");
    assert.equal(await B.page.evaluate(() => globalThis.__pipelineCalls), undefined, "depth reused, not recomputed");
    await B.page.locator(".viewer-top .icon-btn").click();
  });

  await step("an edit on phone B reaches phone A", async () => {
    await B.page.goto(`${ORIGIN}/#/`);
    await B.page.locator(".card").first().click();
    await B.page.getByRole("button", { name: "수정" }).click();
    await B.page.locator(".text-input").fill("B에서 덧붙임: 노을이 예뻤다.");
    await B.page.locator(".editor .screen-head .btn.primary").click();
    await B.page.waitForSelector(".screen.entry");
    await until(() => drive.live("entry").some((f) => drive.text(f.id).includes("노을이 예뻤다")));
    await waitChip(B.page, /동기화됨/);
    await A.page.reload();
    await A.page.waitForSelector(".card");
    await chip(A.page).click();
    await waitChip(A.page, /동기화됨/);
    await A.page.locator(".card").first().click();
    assert.match(await A.page.locator(".entry-text").innerText(), /노을이 예뻤다/);
  });

  await step("offline: app opens from the service worker cache and queues new entries", async () => {
    await A.page.goto(`${ORIGIN}/#/`);
    await A.page.evaluate(() => navigator.serviceWorker.ready);
    await A.page.reload();
    await A.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await A.context.setOffline(true);
    await A.page.reload();
    await A.page.waitForSelector(".card");
    await waitChip(A.page, /오프라인/);
    await A.page.goto(`${ORIGIN}/#/new`);
    await A.page.locator(".text-input").fill("지하철에서 쓴 오프라인 기록");
    await A.page.locator(".editor .screen-head .btn.primary").click();
    await A.page.waitForSelector(".screen.entry");
    await A.page.goto(`${ORIGIN}/#/`);
    await waitChip(A.page, /오프라인 · 대기 1/);
    await A.context.setOffline(false);
    await waitChip(A.page, /동기화됨/);
    assert.equal(drive.live("entry").length, 2);
  });

  await step("PIN lock protects the app after relaunch", async () => {
    await A.page.goto(`${ORIGIN}/#/settings`);
    await A.page.getByRole("button", { name: "PIN 설정" }).click();
    for (const round of [1, 2]) {
      for (const d of "2580") await A.page.locator(".pin-key", { hasText: new RegExp(`^${d}$`) }).click();
      await A.page.getByRole("button", { name: "확인" }).click();
      if (round === 1) await A.page.waitForFunction(() => /한 번 더/.test(document.querySelector(".lock-screen h2")?.textContent));
    }
    await A.page.waitForFunction(() => !document.querySelector(".lock-screen"));
    await A.page.waitForFunction(() => localStorage.getItem("snapdiary.pin"));
    await A.page.reload();
    await A.page.waitForSelector(".lock-screen");
    assert.equal(await A.page.locator("#view .card").count(), 0, "diary not rendered while locked");
    for (const d of "1111") await A.page.keyboard.press(d);
    await A.page.waitForFunction(() => /맞지 않습니다/.test(document.querySelector(".lock-screen")?.innerText || ""));
    for (const d of "2580") await A.page.keyboard.press(d);
    await A.page.waitForSelector(".lock-screen", { state: "detached" });
    await A.page.waitForSelector(".screen.settings"); // back where we were
  });

  await step("deleting on phone A removes the entry and Drive files everywhere", async () => {
    await A.page.goto(`${ORIGIN}/#/`);
    const card = A.page.locator(".card", { hasText: "성수동 산책" });
    await card.click();
    await A.page.getByRole("button", { name: "삭제" }).click();
    await A.page.locator(".sheet .btn.danger").click();
    await A.page.waitForSelector(".timeline");
    await waitChip(A.page, /동기화됨/);
    assert.equal(drive.live("entry").length, 1);
    assert.equal(drive.live("photo").length, 0);
    assert.equal(drive.live("depth").length, 0);
    await B.page.goto(`${ORIGIN}/#/`);
    await chip(B.page).click();
    await waitChip(B.page, /동기화됨/);
    await B.page.waitForFunction(() => !/성수동 산책/.test(document.querySelector("#view").innerText));
  });

  await step("without the AI runtime the place photo falls back to heuristic depth", async () => {
    const C = await newDevice(browser, { ai: false });
    await C.page.goto(`${ORIGIN}/#/new`);
    await C.page.locator(".photo-actions input[type=file]").nth(1)
      .setInputFiles({ name: "street.png", mimeType: "image/png", buffer: placePhoto(640, 480) });
    await C.page.waitForFunction(() => /3D 준비됨 · 간이 깊이/.test(document.body.innerText), null, { timeout: 30000 });
    await C.page.locator(".editor .screen-head .btn.primary").click();
    await openViewer(C.page);
    assert.match(await C.page.locator(".viewer-top .chip").innerText(), /간이 깊이/);
    assert.ok((await litFraction(C.page)) > 0.2);
    assert.ok(C.stats.cdn >= 1 && C.stats.hf === 0);
    await C.context.close();
  });

  await step("allowed-account list rejects other Google accounts", async () => {
    const D = await newDevice(browser, { config: { googleClientId: CLIENT_ID, allowedEmails: ["owner@example.com"], driveFolderName: "Snap Diary" } });
    await chip(D.page).click();
    await D.page.waitForFunction(() => /접근할 수 없습니다/.test(document.getElementById("toast")?.textContent || ""));
    assert.equal(await D.page.evaluate(() => localStorage.getItem("snapdiary.token")), null, "token discarded");
    assert.doesNotMatch(await chip(D.page).innerText(), /동기화됨/);
    await D.context.close();
  });

  await step("redirect sign-in (iPhone home-screen mode) round-trips and rejects a forged state", async () => {
    const E = await newDevice(browser, { config: { googleClientId: CLIENT_ID, allowedEmails: [], driveFolderName: "Snap Diary" } });
    let forge = false;
    await E.context.route("https://accounts.google.com/o/oauth2/v2/auth**", (route) => {
      const q = new URL(route.request().url()).searchParams;
      assert.equal(q.get("client_id"), CLIENT_ID);
      assert.equal(q.get("response_type"), "token");
      assert.equal(q.get("redirect_uri"), `${ORIGIN}/`);
      assert.equal(q.get("scope"), "https://www.googleapis.com/auth/drive.file");
      const state = forge ? "forged" : q.get("state");
      const hash = new URLSearchParams({ access_token: "test-token", token_type: "Bearer", expires_in: "3599",
        scope: q.get("scope"), state });
      return route.fulfill({ status: 302, headers: { location: `${q.get("redirect_uri")}#${hash}` } });
    });
    await E.page.goto(`${ORIGIN}/#/settings`);
    await E.page.locator("select", { has: E.page.locator('option[value="redirect"]') }).selectOption("redirect");
    forge = true;
    await E.page.getByRole("button", { name: /Google 계정 연결/ }).click();
    await E.page.waitForFunction(() => /확인할 수 없습니다/.test(document.getElementById("toast")?.textContent || ""));
    assert.equal(await E.page.evaluate(() => localStorage.getItem("snapdiary.token")), null, "forged response ignored");
    assert.doesNotMatch(await E.page.evaluate(() => location.hash), /access_token/, "token scrubbed from the URL");
    forge = false;
    await E.page.goto(`${ORIGIN}/#/settings`);
    await E.page.getByRole("button", { name: /Google 계정 연결/ }).click();
    await waitChip(E.page, /동기화됨/);
    assert.equal(await E.page.evaluate(() => location.hash), "#/settings", "returns to the screen it left");
    await E.page.goto(`${ORIGIN}/#/`);
    await E.page.waitForSelector(".card");
    assert.match(await E.page.locator(".card").first().innerText(), /오프라인 기록/);
    await E.context.close();
  });

  let F;
  await step("HEIC photos open without native HEIC support (libheif) and are stored as JPEG", async () => {
    assert.ok(heicPath, "heic-to must be installed for this step (npm install --no-save heic-to@1.5.2)");
    F = await newDevice(browser, { config: { googleClientId: CLIENT_ID, allowedEmails: [], driveFolderName: "Snap Diary" } });
    const nativeHeic = await F.page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      try { await createImageBitmap(new Blob([bytes], { type: "image/heic" })); return true; } catch { return false; }
    }, HEIC.toString("base64"));
    assert.equal(nativeHeic, false, "this Chromium cannot decode HEIC itself, so the fallback is what runs");
    await F.page.goto(`${ORIGIN}/#/new`);
    await F.page.locator(".title-input").fill("HEIC와 동영상");
    const inputs = F.page.locator(".photo-actions input[type=file]");
    // Android pickers often send HEIC without a MIME type.
    await inputs.nth(0).setInputFiles({ name: "IMG_2001.HEIC", mimeType: "", buffer: HEIC });
    await inputs.nth(1).setInputFiles({ name: "IMG_2002.heic", mimeType: "image/heic", buffer: HEIC });
    await F.page.waitForFunction(() => document.querySelectorAll(".photo-tile:not(.pending) img.ph[src]").length === 2, null, { timeout: 30000 });
    await F.page.waitForFunction(() => /3D 준비됨 · AI 깊이/.test(document.body.innerText), null, { timeout: 30000 });
    const stored = await F.page.evaluate(async () => {
      const { db } = globalThis.__snapDiary;
      const out = [];
      for (const key of (await db.blobs.keys()).filter((k) => k.startsWith("photo:"))) {
        const blob = await db.blobs.get(key);
        const head = [...new Uint8Array(await blob.slice(0, 3).arrayBuffer())];
        const bmp = await createImageBitmap(blob);
        out.push({ type: blob.type, head, w: bmp.width, h: bmp.height });
      }
      return out;
    });
    assert.equal(stored.length, 2);
    for (const s of stored) {
      assert.equal(s.type, "image/jpeg");
      assert.deepEqual(s.head, [0xff, 0xd8, 0xff]);
      assert.deepEqual([s.w, s.h], [320, 240], "decoded at the HEIC's real size");
    }
    assert.ok(F.stats.heic >= 1, "converter fetched from the CDN on demand");
  });

  await step("a video gets a poster, uploads resumably to Drive and plays on another phone", async () => {
    const webm = Buffer.from(await F.page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 240;
      const g = canvas.getContext("2d");
      // The first recorded frame can be blank; the app must skip dark frames.
      g.fillStyle = "#000"; g.fillRect(0, 0, 320, 240);
      const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.start(100);
      await new Promise((r) => setTimeout(r, 300)); // ~0.3 s of black lead-in
      const t0 = performance.now();
      await new Promise((resolve) => {
        const draw = () => {
          const t = performance.now() - t0;
          g.fillStyle = "#1e64c8"; g.fillRect(0, 0, 320, 240);
          g.fillStyle = "#ffd60a"; g.fillRect((t / 8) % 280, 90, 40, 60);
          if (t < 2500) requestAnimationFrame(draw); else resolve();
        };
        draw();
      });
      rec.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(s);
    }), "base64");
    assert.ok(webm.length > 1000, `recorded a real clip (${webm.length} bytes)`);
    await F.page.locator(".photo-actions input[type=file]").nth(0).setInputFiles({ name: "clip.webm", mimeType: "video/webm", buffer: webm });
    await F.page.waitForFunction(() => document.querySelectorAll(".photo-tile:not(.pending)").length === 3, null, { timeout: 30000 });
    const tile = F.page.locator(".photo-tile").nth(2);
    assert.equal(await tile.locator(".play-badge").count(), 1);
    assert.equal(await tile.locator(".kind-btn").count(), 0, "videos cannot be turned into 3D places");
    const poster = await tile.locator("img.ph").evaluate((img) => new Promise((resolve) => {
      const check = () => {
        if (!img.complete || !img.naturalWidth) return setTimeout(check, 50);
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        resolve({ w: c.width, h: c.height, px: [...g.getImageData(4, 4, 1, 1).data].slice(0, 3) });
      };
      check();
    }));
    assert.deepEqual([poster.w, poster.h], [320, 240], "poster captured from the video itself");
    assert.ok(poster.px[2] > 150 && poster.px[0] < 80, `poster shows the clip's blue frame (${poster.px})`);
    await F.page.locator(".editor .screen-head .btn.primary").click();
    await F.page.waitForSelector(".screen.entry");
    await chip(F.page).click();
    await until(() => drive.live("video").length === 1 && drive.live("entry").some((f) => drive.text(f.id).includes("HEIC와 동영상")), 30000);
    const [video] = drive.live("video");
    assert.deepEqual(Buffer.from(video.content), webm, "the original video, byte for byte");
    assert.equal(video.mimeType, "video/webm");
    assert.equal(drive.files.get(video.parents[0]).appProperties.snapDiary, "videos");
    assert.ok(drive.log.some((l) => l.startsWith("PUT /upload/drive/v3/files") && /upload_id=/.test(l) && /fields=/.test(l)),
      "session URI rebuilt from X-GUploader-UploadID (Location hidden)");
    const doc = JSON.parse(drive.text(drive.live("entry").find((f) => drive.text(f.id).includes("HEIC와 동영상")).id));
    assert.deepEqual(doc.photos.map((p) => p.kind), ["photo", "place", "video"]);

    const G = await newDevice(browser, { config: { googleClientId: CLIENT_ID, allowedEmails: [], driveFolderName: "Snap Diary" } });
    await chip(G.page).click();
    await waitChip(G.page, /동기화됨/);
    await G.page.locator(".card", { hasText: "HEIC와 동영상" }).click();
    await G.page.waitForSelector(".screen.entry");
    await G.page.locator(".photo-cell").last().click();
    await G.page.waitForFunction(() => {
      const v = document.querySelector(".lightbox.player video");
      return v && v.readyState >= 1 && !v.classList.contains("hidden");
    }, null, { timeout: 30000 });
    await G.page.locator(".lightbox.player .close").click();
    assert.equal(await G.page.locator(".lightbox").count(), 0);
    assert.deepEqual(G.errors, []);
    await G.context.close();
    assert.deepEqual(F.errors, []);
    await F.context.close();
  });

  await step("organize picked photos into dated entries by capture date and GPS region", async () => {
    const H = await newDevice(browser, { config: { googleClientId: CLIENT_ID, allowedEmails: [], driveFolderName: "Snap Diary" } });
    const geocodes = [];
    const REGIONS = [
      [37.5, 127.0, { quarter: "성수2가3동", suburb: "성수동2가", borough: "성동구", city: "서울", country: "대한민국", country_code: "kr" }],
      [33.4, 126.9, { village: "성산리", town: "성산읍", city: "서귀포시", province: "제주특별자치도", country_code: "kr" }],
      [35.1, 129.1, { suburb: "우동", borough: "해운대구", city: "부산광역시", country_code: "kr" }]
    ];
    await H.context.route("https://nominatim.openstreetmap.org/**", (route) => {
      const q = new URL(route.request().url()).searchParams;
      geocodes.push(`${q.get("lat")},${q.get("lon")}`);
      const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
      const hit = REGIONS.find(([a, b]) => Math.abs(lat - a) < 0.2 && Math.abs(lon - b) < 0.2);
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ address: hit ? hit[2] : {} }) });
    });
    // An entry already written on Oct 5: the Jeju photo should join it.
    await H.page.goto(`${ORIGIN}/#/new/2026-10-05`);
    await H.page.locator(".text-input").fill("제주 둘째 날");
    await H.page.locator(".editor .screen-head .btn.primary").click();
    await H.page.waitForSelector(".screen.entry");

    await H.page.goto(`${ORIGIN}/#/`);
    await H.page.getByRole("link", { name: "사진으로 정리" }).click();
    await H.page.waitForSelector(".screen.organize");
    const fx = (name, mimeType = "") => ({ name, mimeType, buffer: fs.readFileSync(path.join(here, "fixtures", name)) });
    await H.page.locator(".organize input[type=file]").setInputFiles([
      fx("seongsu.jpg", "image/jpeg"), fx("seongsu-evening.heic"), fx("jeju.jpg", "image/jpeg"),
      fx("haeundae.mp4", "video/mp4"), fx("noexif.jpg", "image/jpeg")]);
    await H.page.waitForSelector(".org-day", { timeout: 30000 });
    const days = await H.page.locator(".org-day").evaluateAll((cards) => cards.map((c) => ({
      date: c.querySelector("strong").textContent, place: c.querySelector(".org-place").value,
      count: c.querySelector(".org-head .muted").textContent, guessed: Boolean(c.querySelector(".chip")),
      merges: /기록에 사진을 더해요/.test(c.textContent) })));
    const today = await H.page.evaluate(() => new Date().getFullYear());
    assert.deepEqual(days.filter((d) => !d.guessed), [
      { date: "2026년 10월 5일 (월)", place: "제주 서귀포시 성산읍", count: "1개", guessed: false, merges: true },
      { date: "2026년 10월 4일 (일)", place: "부산 해운대구 우동", count: "1개", guessed: false, merges: false },
      { date: "2026년 10월 3일 (토)", place: "서울 성동구 성수동", count: "2개", guessed: false, merges: false }
    ], "days (newest first) from EXIF/HEIC/MP4 metadata, regions from GPS");
    const guessedDay = days.find((d) => d.guessed);
    assert.ok(guessedDay && guessedDay.date.startsWith(`${today}년`), "a photo without metadata is shown as a guessed date");
    assert.equal(geocodes.length, 3, "one lookup per place (the two Seongsu photos are one place)");
    assert.ok(geocodes.every((g) => /^-?\d+\.\d{3},-?\d+\.\d{3}$/.test(g)), `rounded positions only: ${geocodes}`);
    assert.match(await H.page.locator(".organize-status").innerText(), /5개 중 촬영 날짜 4개, 위치 4개/);
    // Leave out the guessed day.
    await H.page.locator(".org-day", { hasText: "날짜 추정" }).locator("input[type=checkbox]").uncheck();
    await H.page.getByRole("button", { name: /일치 기록으로 정리하기/ }).click();
    await H.page.waitForSelector(".timeline", { timeout: 60000 });

    const entries = await H.page.evaluate(async () => (await globalThis.__snapDiary.db.entries.all())
      .map((e) => ({ date: e.date, text: e.text, place: e.place?.name || "", photos: e.photos.map((p) =>
        ({ kind: p.kind, takenAt: p.takenAt || null, placeName: p.placeName || null, gps: Number.isFinite(p.lat) })) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)));
    assert.deepEqual(entries.map((e) => [e.date, e.place, e.photos.length]), [
      ["2026-10-03", "서울 성동구 성수동", 2],
      ["2026-10-04", "부산 해운대구 우동", 1],
      ["2026-10-05", "제주 서귀포시 성산읍", 1]
    ], "three entries; Oct 5 reused the existing one");
    assert.equal(entries[2].text, "제주 둘째 날", "existing text kept");
    assert.deepEqual(entries[0].photos.map((p) => p.takenAt), ["2026-10-03T14:22:05", "2026-10-03T18:40:00"]);
    assert.ok(entries[0].photos.every((p) => p.gps && p.placeName === "서울 성동구 성수동"));
    assert.equal(entries[1].photos[0].kind, "video");

    await H.page.locator(".card", { hasText: "서울 성동구 성수동" }).click();
    await H.page.waitForSelector(".screen.entry");
    const link = await H.page.locator("a.gphotos").getAttribute("href");
    assert.equal(link, "https://photos.google.com/search/" + encodeURIComponent("2026년 10월 3일"));
    assert.deepEqual(H.errors, []);
    await H.context.close();
  });

  await step("the editor offers the photo's capture date and fills the place; photos are kept as small copies", async () => {
    const I = await newDevice(browser);
    await I.context.route("https://nominatim.openstreetmap.org/**", (route) => route.fulfill({
      status: 200, headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify({ address: { suburb: "성수동2가", borough: "성동구", city: "서울특별시", country_code: "kr" } }) }));
    await I.page.goto(`${ORIGIN}/#/new`);
    const inputs = I.page.locator(".photo-actions input[type=file]");
    await inputs.nth(0).setInputFiles({ name: "seongsu.jpg", mimeType: "image/jpeg",
      buffer: fs.readFileSync(path.join(here, "fixtures", "seongsu.jpg")) });
    await I.page.waitForSelector(".hint-banner:not([hidden])");
    assert.match(await I.page.locator(".hint-banner").innerText(), /사진을 찍은 날은 10월 3일 \(토\)이에요/);
    await I.page.waitForFunction(() => document.querySelector(".place-field input").value === "서울 성동구 성수동");
    assert.match(await I.page.locator(".editor .muted.small").first().innerText(), /37\.544\d, 127\.056\d/);
    await I.page.getByRole("button", { name: "그날 기록으로" }).click();
    assert.equal(await I.page.locator("input[type=date]").inputValue(), "2026-10-03");
    await inputs.nth(0).setInputFiles({ name: "big.png", mimeType: "image/png", buffer: plainPhoto(3000, 2000) });
    await I.page.waitForFunction(() => document.querySelectorAll(".photo-tile:not(.pending)").length === 2);
    await I.page.locator(".editor .screen-head .btn.primary").click();
    await I.page.waitForSelector(".screen.entry");
    const sizes = await I.page.evaluate(async () => {
      const { db } = globalThis.__snapDiary;
      const [entry] = await db.entries.all();
      const out = [];
      for (const p of entry.photos) {
        const bmp = await createImageBitmap(await db.blobs.get(`photo:${p.id}`));
        out.push([bmp.width, bmp.height]);
      }
      return { date: entry.date, place: entry.place.name, sizes: out };
    });
    assert.deepEqual(sizes, { date: "2026-10-03", place: "서울 성동구 성수동", sizes: [[640, 480], [1280, 853]] },
      "small copies by default (1280 px), never upscaled");
    assert.deepEqual(I.errors, []);
    await I.context.close();
  });

  await step("places are arranged by country and city; hand-typed and older entries can be placed", async () => {
    const J = await newDevice(browser);
    const searches = [];
    await J.context.route("https://nominatim.openstreetmap.org/**", (route) => {
      const url = new URL(route.request().url());
      const json = (body) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (url.pathname === "/search") {
        searches.push(url.searchParams.get("q"));
        return json([
          { lat: "34.9218", lon: "127.7537", name: "배알도수변공원", display_name: "배알도수변공원, 태인동, 광양시, 전라남도, 대한민국",
            address: { leisure: "배알도수변공원", suburb: "태인동", city: "광양시", province: "전라남도", country: "대한민국", country_code: "kr" } },
          { lat: "35.0116", lon: "135.7681", name: "교토", display_name: "교토시, 교토부, 일본",
            address: { city: "교토시", province: "교토부", country: "일본", country_code: "jp" } }]);
      }
      const lat = Number(url.searchParams.get("lat"));
      return json({ address: lat < 35
        ? { suburb: "해룡면", city: "순천시", province: "전라남도", country: "대한민국", country_code: "kr" }
        : { suburb: "성수동2가", borough: "성동구", city: "서울", country: "대한민국", country_code: "kr" } });
    });
    // 1) Typed by hand, no position (like entries written before this version).
    await J.page.goto(`${ORIGIN}/#/new/2026-10-10`);
    await J.page.locator(".title-input").fill("광양 배알도수변공원");
    await J.page.locator(".editor .screen-head .btn.primary").click();
    await J.page.waitForSelector(".screen.entry");
    // 2) An older entry with a position but no country/city yet.
    await J.page.evaluate(async () => {
      const { db } = globalThis.__snapDiary;
      await db.entries.put({ id: "olderentry1", date: "2026-10-09", title: "순천만 습지", text: "", mood: "",
        place: { name: "순천", lat: 34.8826, lng: 127.5097 }, photos: [], createdAt: "2026-10-09T10:00:00.000Z",
        updatedAt: "2026-10-09T10:00:00.000Z", sync: { dirty: true, rev: 1, driveId: null, remoteModified: null, trash: [] } });
    });
    await J.page.goto(`${ORIGIN}/#/places`);
    await J.page.waitForFunction(() => /순천/.test(document.querySelector(".country:not(.unplaced)")?.innerText || ""), null, { timeout: 15000 });
    assert.match(await J.page.locator(".country:not(.unplaced)").first().innerText(), /대한민국[\s\S]*순천/, "older entry filled in and placed");
    const older = await J.page.evaluate(() => globalThis.__snapDiary.db.entries.get("olderentry1"));
    assert.deepEqual([older.place.country, older.place.city, older.place.name], ["대한민국", "순천", "순천"], "typed name kept");
    assert.ok(older.sync.dirty && older.sync.rev > 1, "change queued for Drive");
    // The hand-typed entry waits under "no country/city" and is placed with a search.
    const unplaced = J.page.locator(".unplaced");
    assert.match(await unplaced.innerText(), /광양 배알도수변공원/);
    await unplaced.getByRole("button", { name: /위치 찾기/ }).click();
    await J.page.waitForSelector(".search-result");
    assert.deepEqual(searches, ["광양 배알도수변공원"], "searched with the entry's own words, on request only");
    const firstResult = J.page.locator(".search-result").first();
    assert.match(await firstResult.innerText(), /배알도수변공원[\s\S]*대한민국 › 광양/);
    await firstResult.click();
    await J.page.waitForFunction(() => !document.querySelector(".unplaced"));
    const cities = await J.page.locator(".country:not(.unplaced)").first().locator(".city-row strong").allInnerTexts();
    assert.deepEqual(cities.sort(), ["광양", "순천"]);
    // City page lists that city's entries; entries link back to their city.
    await J.page.locator(".city-row", { hasText: "광양" }).click();
    await J.page.waitForSelector(".screen .timeline .card");
    assert.match(await J.page.locator(".screen-head h1").innerText(), /광양/);
    await J.page.locator(".card").first().click();
    await J.page.waitForSelector(".screen.entry");
    assert.match(await J.page.locator(".region-link").innerText(), /대한민국 › 광양/);
    // 3) In the editor: "위치 찾기" sets a place abroad.
    await J.page.goto(`${ORIGIN}/#/new/2026-09-20`);
    await J.page.locator(".text-input").fill("교토 여행 첫날");
    await J.page.locator(".place-field input").fill("교토");
    await J.page.getByRole("button", { name: "위치 찾기" }).click();
    await J.page.locator(".search-result", { hasText: "교토시, 교토부" }).click();
    assert.match(await J.page.locator(".region-chip").innerText(), /일본 › 교토(?!시)/, "교토시 is shown as 교토, like 순천시 -> 순천");
    await J.page.locator(".editor .screen-head .btn.primary").click();
    await J.page.waitForSelector(".screen.entry");
    await J.page.goto(`${ORIGIN}/#/places`);
    await J.page.waitForSelector(".country:not(.unplaced)");
    const countries = await J.page.locator(".country:not(.unplaced) .country-head").allInnerTexts();
    assert.match(countries[0], /🇰🇷\s*대한민국/);
    assert.match(countries[1], /🇯🇵\s*일본/);
    assert.match(await J.page.locator(".lead").innerText(), /2개 나라 · 3개 도시/);
    assert.deepEqual(J.errors, []);
    await J.context.close();
  });

  for (const device of [A, B]) assert.deepEqual(device.errors, [], "no page errors");
  console.log(`\n# e2e pass ${steps.length}`);
} catch (error) {
  console.error(`not ok ${steps.length + 1} - ${error.stack || error}`);
  for (const device of [A, B].filter(Boolean)) {
    if (device.errors.length) console.error("page errors:", device.errors);
    await device.page.screenshot({ path: path.join(here, "..", "..", "dist", `e2e-failure-${device === A ? "A" : "B"}.png`) }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
