// Pure-function checks for Snap Diary: data model, /snap grain port, depth
// heuristic and the Drive request builders.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createEntry, createPhoto, serializeEntry, parseEntry, mergeEntries, fileStem, monthGrid,
  isISODate, toISODate, formatKoreanDate, groupByMonth, matchesQuery, isEntryEmpty, touch, CONFLICT_MARK
} from "../../snap-diary/js/model.js";
import {
  hashGrain, birthAt, gridSize, sampleMap, disparityToZ, buildGrainField, medianLevel, FRAGMENTS_PER_CELL, SNAP_DURATION
} from "../../snap-diary/js/grain.js";
import { heuristicDepth } from "../../snap-diary/js/depth.js";
import { buildMultipart, quote } from "../../snap-diary/js/drive.js";
import { parseMultipart } from "./fake-drive.mjs";
import { looksLikeHeif, isHeifName, isVideoFile, videoMime, videoExtension, formatDuration } from "../../snap-diary/js/media.js";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const meetVanishDust = require("../../meet-vanish-extension/dust-effect.js");

test("grain hash is a faithful port of Meet Vanish's dust-effect.js", () => {
  for (let y = -3; y < 400; y += 7) {
    for (let x = -3; x < 400; x += 5) {
      for (const seed of [0, 7187, 123456]) assert.equal(hashGrain(x, y, seed), meetVanishDust.hashGrain(x, y, seed));
    }
  }
  assert.equal(SNAP_DURATION, meetVanishDust.duration);
  assert.equal(FRAGMENTS_PER_CELL, 3);
});

test("birth field: /snap range and quantization, right side releases first, both sides random", () => {
  const cols = 240;
  let left = 0, right = 0, n = 0, earlyLeft = 0;
  for (let y = 0; y < 180; y++) {
    for (let x = 0; x < cols; x++) {
      const b = birthAt(x, y, cols);
      assert.ok(b >= Math.round(255 * 0.018) / 255 && b <= Math.round(255 * 0.738) / 255, `birth ${b}`);
      assert.equal(Math.round(b * 255), b * 255, "quantized to the 8-bit birth texture");
    }
    for (let x = 0; x < 24; x++) {
      left += birthAt(x, y, cols);
      right += birthAt(cols - 1 - x, y, cols);
      if (birthAt(x, y, cols) < 0.3) earlyLeft++;
      n++;
    }
  }
  assert.ok(right / n < left / n - 0.2, `right ${right / n} vs left ${left / n}`);
  assert.ok(earlyLeft > 0, "some left grains still leave early: no hard sweep line");
});

test("grain field layout: cores first, square cells, depth sampled per cell", () => {
  assert.deepEqual(gridSize(4000, 3000, 320), { cols: 320, rows: 240 });
  assert.deepEqual(gridSize(3000, 4000, 320), { cols: 240, rows: 320 });
  const depth = { width: 2, height: 2, data: Uint8Array.from([0, 0, 255, 255]) };
  const field = buildGrainField(depth, 4, 4);
  assert.equal(field.count, 4 * 4 * 3);
  const cores = 16;
  for (let i = 0; i < field.count; i++) assert.equal(field.info[i * 3 + 2], Math.floor(i / cores), "kind-major order");
  assert.ok(field.info[0] < 0.01, "top row far");
  assert.ok(field.info[(cores - 1) * 3] > 0.99, "bottom row near");
  assert.equal(field.cell[0], 0.125);
  assert.equal(field.cell[1], 0.125);
  assert.equal(sampleMap(depth, 0.5, 0.5), 0.5);
  assert.equal(medianLevel({ data: Uint8Array.from([0, 10, 200, 250, 255]) }), 200 / 255);
});

test("disparity to distance is monotonic and hits the near/far planes", () => {
  assert.equal(disparityToZ(1, 1, 3.6), 1);
  assert.ok(Math.abs(disparityToZ(0, 1, 3.6) - 3.6) < 1e-12);
  let last = Infinity;
  for (let d = 0; d <= 1.0001; d += 0.05) {
    const z = disparityToZ(d, 1, 3.6);
    assert.ok(z < last);
    last = z;
  }
});

test("heuristic depth: ground recedes upward, bright sky is far, texture pops forward", () => {
  const w = 96, h = 72;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = y < h * 0.4 ? [150, 190, 245] : [90, 110, 80];
      // A textured (checkered) object standing on the flat ground on the left.
      if (x > 10 && x < 34 && y > h * 0.45 && y < h * 0.7) c = ((x >> 1) + (y >> 1)) & 1 ? [30, 30, 30] : [230, 230, 230];
      rgba.set([...c, 255], i);
    }
  }
  const d = heuristicDepth(rgba, w, h);
  const at = (x, y) => d[Math.round(y) * w + Math.round(x)];
  const row = (y) => d.slice(y * w, (y + 1) * w).reduce((a, b) => a + b, 0) / w;
  assert.ok(row(h - 2) > row(Math.round(h * 0.5)), "bottom nearer than middle");
  assert.ok(row(2) < 40, `sky far (${row(2)})`);
  assert.ok(at(22, h * 0.58) > at(75, h * 0.58) + 10, "textured object nearer than flat ground beside it");
  assert.equal(d.length, w * h);
});

test("entry JSON round-trips without local bookkeeping and rejects foreign files", () => {
  const entry = createEntry({ date: "2026-10-11" });
  entry.title = "성수동 산책";
  entry.text = "카페\n강변";
  entry.place = { name: "성수동", lat: 37.5, lng: 127.05 };
  entry.photos.push({ ...createPhoto({ width: 10, height: 20, kind: "place" }), driveId: "f1", depthSource: "ai" });
  const doc = serializeEntry(entry);
  assert.equal(doc.sync, undefined);
  const back = parseEntry(JSON.stringify(doc));
  assert.equal("sync" in back, false);
  assert.deepEqual(serializeEntry(back), doc);
  assert.deepEqual(back.place, { name: "성수동", lat: 37.5, lng: 127.05 });
  assert.equal(back.photos[0].kind, "place");
  assert.equal(back.photos[0].depthSource, "ai");
  assert.throws(() => parseEntry({ app: "other", id: "x", date: "2026-10-11" }));
  assert.throws(() => parseEntry({ ...doc, date: "2026-02-30" }));
  assert.throws(() => parseEntry({ ...doc, version: 99 }));
});

test("conflict merge keeps both texts and unites photos", () => {
  const base = createEntry({ date: "2026-10-11" });
  base.photos = [{ ...createPhoto({ width: 1, height: 1 }), id: "p1", driveId: null }];
  const local = { ...structuredClone(base), text: "여기서 쓴 글", updatedAt: "2026-10-11T10:00:00.000Z" };
  const remote = { ...structuredClone(base), text: "저기서 쓴 글", updatedAt: "2026-10-11T09:00:00.000Z",
    photos: [{ ...base.photos[0], driveId: "d1" }, { ...createPhoto({ width: 1, height: 1 }), id: "p2" }] };
  const merged = mergeEntries(local, remote);
  assert.match(merged.text, /^여기서 쓴 글\n\n— 다른 기기에서 수정된 내용 \(2026-10-11 \d\d:00\) —\n저기서 쓴 글$/);
  assert.ok(merged.text.includes(CONFLICT_MARK));
  assert.deepEqual(merged.photos.map((p) => p.id), ["p1", "p2"]);
  assert.equal(merged.photos[0].driveId, "d1", "drive id learnt from the other side");
  assert.equal(merged.updatedAt, local.updatedAt);
  const same = mergeEntries({ ...local, text: "같은 글" }, { ...remote, text: "같은 글" });
  assert.equal(same.text, "같은 글", "identical text is not duplicated");
});

test("dates, grouping, search and file names", () => {
  assert.ok(isISODate("2024-02-29"));
  assert.ok(!isISODate("2026-02-29"));
  assert.ok(!isISODate("2026-1-01"));
  assert.equal(toISODate(new Date(2026, 9, 11, 23, 59)), "2026-10-11", "local date, not UTC");
  assert.equal(formatKoreanDate("2026-10-11"), "2026년 10월 11일 (일)");
  const grid = monthGrid(2026, 9);
  assert.equal(grid.length % 7, 0);
  assert.equal(grid.indexOf("2026-10-01"), 4, "Oct 1 2026 is a Thursday");
  assert.equal(grid.filter(Boolean).length, 31);
  const a = { ...createEntry({ date: "2026-09-30" }), title: "추석" };
  const b = { ...createEntry({ date: "2026-10-11" }), text: "서울숲 산책" };
  const groups = groupByMonth([a, b]);
  assert.deepEqual(groups.map((g) => g.label), ["2026년 10월", "2026년 9월"]);
  assert.ok(matchesQuery(b, "서울숲"));
  assert.ok(!matchesQuery(a, "서울숲"));
  assert.equal(fileStem({ ...b, title: 'a/b:c*?"<>|#x' }), "2026-10-11_a b c x");
  assert.equal(fileStem({ ...a, title: "" }), "2026-09-30_일기");
  assert.ok(isEntryEmpty(createEntry()));
  const t = touch(createEntry(), new Date("2026-10-11T00:00:00Z"));
  assert.equal(t.sync.rev, 2);
  assert.equal(t.sync.dirty, true);
});

test("Drive multipart body and query escaping", async () => {
  const media = new Blob([new Uint8Array([0, 255, 13, 10, 45, 45])], { type: "image/jpeg" });
  const body = buildMultipart({ name: "사진.jpg", parents: ["p"] }, media, "Mixed_Case-Boundary");
  assert.equal(body.type, "", "boundary travels only in the explicit Content-Type header");
  const parsed = parseMultipart(new Uint8Array(await body.arrayBuffer()), "multipart/related; boundary=Mixed_Case-Boundary");
  assert.deepEqual(parsed.metadata, { name: "사진.jpg", parents: ["p"] });
  assert.equal(parsed.mime, "image/jpeg");
  assert.deepEqual([...parsed.content], [0, 255, 13, 10, 45, 45], "binary survives byte-for-byte");
  assert.equal(quote("it's a \\ test"), "'it\\'s a \\\\ test'");
});

test("HEIF is recognised by content, AVIF and other formats are not", () => {
  const heic = new Uint8Array(readFileSync(new URL("./fixtures/place.heic", import.meta.url)));
  assert.ok(looksLikeHeif(heic.subarray(0, 64)), "real libheif-encoded HEIC");
  const ftyp = (major, ...compatible) => {
    const brands = [major, "\0\0\0\0", ...compatible].join("");
    const size = 8 + brands.length;
    return Uint8Array.from([0, 0, 0, size, ...Buffer.from("ftyp"), ...Buffer.from(brands, "latin1")]);
  };
  assert.ok(looksLikeHeif(ftyp("mif1", "mif1", "heic")), "Samsung-style mif1 major brand");
  assert.ok(looksLikeHeif(ftyp("msf1", "msf1", "hevc")), "HEIF sequence (burst/live)");
  assert.ok(!looksLikeHeif(ftyp("avif", "mif1", "miaf")), "AVIF");
  assert.ok(!looksLikeHeif(ftyp("mif1", "mif1", "avif")), "AVIF listing mif1 first");
  assert.ok(!looksLikeHeif(ftyp("isom", "isom", "mp41")), "MP4 video");
  assert.ok(!looksLikeHeif(ftyp("qt  ", "qt  ")), "QuickTime video");
  assert.ok(!looksLikeHeif(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1])), "JPEG");
  assert.ok(!looksLikeHeif(new Uint8Array(4)), "too short");
  assert.ok(isHeifName({ name: "IMG_1234.HEIC", type: "" }));
  assert.ok(isHeifName({ name: "x", type: "image/heif" }));
  assert.ok(!isHeifName({ name: "a.jpg", type: "image/jpeg" }));
});

test("video files are recognised even without a MIME type (Android pickers)", () => {
  assert.ok(isVideoFile({ name: "a.mp4", type: "video/mp4" }));
  assert.ok(isVideoFile({ name: "IMG_0001.MOV", type: "" }));
  assert.ok(isVideoFile({ name: "clip.webm", type: "application/octet-stream" }));
  assert.ok(!isVideoFile({ name: "IMG_0001.HEIC", type: "" }));
  assert.ok(!isVideoFile({ name: "photo.jpg", type: "image/jpeg" }));
  assert.equal(videoMime({ name: "IMG_0001.MOV", type: "" }), "video/quicktime");
  assert.equal(videoMime({ name: "x.mp4", type: "video/mp4" }), "video/mp4");
  assert.equal(videoExtension("video/quicktime", "IMG_0001.MOV"), "mov");
  assert.equal(videoExtension("video/webm;codecs=vp9", ""), "webm");
  assert.equal(videoExtension("video/unknown", "noext"), "mp4");
  assert.equal(formatDuration(75.4), "1:15");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(null), "");
});

test("video attachments round-trip through the Drive document", () => {
  const entry = createEntry({ date: "2026-10-12" });
  entry.photos.push(createPhoto({ width: 1920, height: 1080, kind: "video", name: "a.mov", mime: "video/quicktime", duration: 12.5, size: 3000 }));
  entry.photos.push(createPhoto({ width: 10, height: 10, kind: "photo" }));
  const back = parseEntry(JSON.stringify(serializeEntry(entry)));
  assert.deepEqual(
    { kind: back.photos[0].kind, mime: back.photos[0].mime, duration: back.photos[0].duration, size: back.photos[0].size },
    { kind: "video", mime: "video/quicktime", duration: 12.5, size: 3000 });
  assert.equal("mime" in back.photos[1], false, "photos carry no video fields");
  const bogus = parseEntry({ ...serializeEntry(entry), photos: [{ id: "v", kind: "video", mime: "text/html", duration: -1 }] });
  assert.deepEqual([bogus.photos[0].mime, bogus.photos[0].duration], ["video/mp4", null], "untrusted fields are sanitised");
});
