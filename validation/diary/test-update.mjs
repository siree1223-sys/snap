// A new release must reach an installed app on its next launch, even though
// GitHub Pages lets browsers cache files for 10 minutes (max-age=600).
//
//   python3 scripts/build-diary.py && node validation/diary/test-update.mjs
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const id of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try { return require(id); } catch { /* try next */ }
  }
  throw new Error("playwright is not installed");
}
const { chromium } = loadPlaywright();
const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(here, "../../dist/snap-diary");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "snap-diary-update-"));

/** A copy of the built site that identifies itself as `version`, as a deploy would. */
function release(version) {
  const dir = path.join(work, version);
  fs.cpSync(SITE, dir, { recursive: true });
  const config = path.join(dir, "js", "config.js");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(/appVersion: "[^"]+"/, `appVersion: "${version}"`));
  const sw = path.join(dir, "sw.js");
  fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(/^const BUILD = "[^"]*"/m, `const BUILD = "${version}"`));
  return dir;
}

let root = release("1.0-a");
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const type = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png" }[path.extname(file)];
    res.writeHead(200, { "content-type": type || "application/octet-stream", "cache-control": "max-age=600" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const running = () => page.evaluate(() => globalThis.__snapDiary?.version);
const waitForVersion = (v) => page.waitForFunction((want) => globalThis.__snapDiary?.version === want, v, { timeout: 15000 });

try {
  await page.goto(ORIGIN);
  await page.waitForSelector(".tabs");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector(".tabs");
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
  assert.equal(await running(), "1.0-a");
  console.log("ok 1 - installed release 1.0-a (served with max-age=600)");

  root = release("1.0-b");
  await page.goto(ORIGIN); // one launch after the deploy
  await waitForVersion("1.0-b");
  await page.waitForSelector(".tabs");
  const cached = await page.evaluate(async () => {
    const out = {};
    for (const key of await caches.keys()) {
      const hit = await (await caches.open(key)).match("./js/config.js");
      if (hit) out[key] = /appVersion: "([^"]+)"/.exec(await hit.text())[1];
    }
    return out;
  });
  assert.deepEqual(cached, { "snap-diary-shell-1.0-b": "1.0-b" }, "new cache holds the new files, old cache removed");
  console.log("ok 2 - the next launch switches to 1.0-b by itself (no stale HTTP-cached files)");

  await page.goto(`${ORIGIN}#/new`);
  await page.locator(".text-input").fill("업데이트 중에 쓰던 글");
  root = release("1.0-c");
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.waitForSelector("#update-banner", { timeout: 15000 });
  assert.equal(await page.locator(".text-input").inputValue(), "업데이트 중에 쓰던 글", "writing is not interrupted");
  assert.equal(await running(), "1.0-b");
  await page.getByRole("button", { name: "지금 적용" }).click();
  await waitForVersion("1.0-c");
  console.log("ok 3 - while writing, the update waits for a tap and then applies");

  root = release("1.0-d");
  await page.goto(`${ORIGIN}#/settings`);
  await page.getByRole("button", { name: /앱 새로 불러오기/ }).click();
  await waitForVersion("1.0-d");
  console.log("ok 4 - '앱 새로 불러오기' fetches the latest release on demand");

  assert.deepEqual(errors, []);
  console.log("\n# update pass 4");
} catch (error) {
  console.error(`not ok - ${error.stack || error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
}
