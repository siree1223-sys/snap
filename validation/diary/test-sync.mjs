// Snap Diary sync engine against an in-memory Google Drive (real drive.js client).
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDrive } from "./fake-drive.mjs";
import { createMemoryDB } from "./memory-db.mjs";
import { createDriveClient } from "../../snap-diary/js/drive.js";
import { createSync } from "../../snap-diary/js/sync.js";
import { createEntry, createPhoto, CONFLICT_MARK } from "../../snap-diary/js/model.js";
import { commitEdit, deleteEntry, attachDepth } from "../../snap-diary/js/repo.js";

function device(fake, { onUnauthorized } = {}) {
  const db = createMemoryDB();
  const drive = createDriveClient(async () => fake.token, { fetchImpl: fake.fetch, retryDelay: 1, onUnauthorized });
  const sync = createSync({ drive, db, folderName: "Snap Diary" });
  return { db, drive, sync };
}

const jpeg = (label) => new Blob([`JPEG:${label}`], { type: "image/jpeg" });
const png = (label) => new Blob([`PNG:${label}`], { type: "image/png" });

async function writeEntry(dev, { text = "오늘 한 일", title = "성수동 산책", place = true } = {}) {
  const entry = createEntry({ date: "2026-10-11" });
  entry.title = title;
  entry.text = text;
  entry.place = { name: "성수동", lat: 37.544, lng: 127.056 };
  const p1 = createPhoto({ width: 2560, height: 1920, kind: place ? "place" : "photo", name: "a.jpg" });
  const p2 = createPhoto({ width: 1920, height: 2560, kind: "photo", name: "b.jpg" });
  entry.photos.push(p1, p2);
  await dev.db.blobs.put(`photo:${p1.id}`, jpeg("p1"));
  await dev.db.blobs.put(`thumb:${p1.id}`, jpeg("t1"));
  await dev.db.blobs.put(`photo:${p2.id}`, jpeg("p2"));
  await dev.db.blobs.put(`thumb:${p2.id}`, jpeg("t2"));
  await commitEdit(dev.db, entry);
  if (place) await attachDepth(dev.db, entry.id, p1.id, png("d1"), "ai");
  return { entry, p1, p2 };
}

async function editText(dev, id, text) {
  const current = await dev.db.entries.get(id);
  current.text = text;
  return commitEdit(dev.db, current);
}

test("first sync creates the folder layout and uploads entry + media", async () => {
  const fake = createFakeDrive();
  const a = device(fake);
  const { entry } = await writeEntry(a);
  const stats = await a.sync.run();
  assert.equal(stats.pushed, 1);
  for (const role of ["root", "entries", "photos", "data"]) assert.equal(fake.live(role).length, 1, role);
  assert.equal(fake.live("entry").length, 1);
  assert.equal(fake.live("photo").length, 2);
  assert.equal(fake.live("thumb").length, 2);
  assert.equal(fake.live("depth").length, 1);
  const [root] = fake.live("root");
  assert.equal(root.name, "Snap Diary");
  const [photos] = fake.live("photos");
  assert.ok(fake.live("photo").every((f) => f.parents[0] === photos.id), "photos live in photos/");
  assert.match(fake.live("photo")[0].name, /^2026-10-11_성수동 산책_\d\.jpg$/);
  const doc = JSON.parse(fake.text(fake.live("entry")[0].id));
  assert.equal(doc.app, "snap-diary");
  assert.equal(doc.text, "오늘 한 일");
  assert.equal(doc.sync, undefined, "local sync bookkeeping is not uploaded");
  assert.ok(doc.photos.every((p) => p.driveId && p.thumbDriveId), "photo ids are in the document");
  assert.equal(doc.photos[0].depthSource, "ai");
  assert.ok(doc.photos[0].depthDriveId);
  const local = await a.db.entries.get(entry.id);
  assert.equal(local.sync.dirty, false);
  // A second run with nothing changed transfers nothing.
  const before = fake.log.length;
  const again = await a.sync.run();
  assert.deepEqual(again, { pulled: 0, pushed: 0, merged: 0, removed: 0 });
  assert.ok(fake.log.slice(before).every((line) => line.startsWith("GET")), "idle sync only reads");
});

test("a second device pulls entries and downloads media lazily", async () => {
  const fake = createFakeDrive();
  const a = device(fake), b = device(fake);
  const { entry, p1 } = await writeEntry(a);
  await a.sync.run();
  const stats = await b.sync.run();
  assert.equal(stats.pulled, 1);
  const copy = await b.db.entries.get(entry.id);
  assert.equal(copy.title, "성수동 산책");
  assert.equal(copy.sync.dirty, false);
  assert.equal(await b.db.blobs.get(`photo:${p1.id}`), undefined, "not downloaded eagerly");
  const photo = await b.sync.media(copy.photos[0], "photo");
  assert.equal(await photo.text(), "JPEG:p1");
  assert.equal(await (await b.sync.media(copy.photos[0], "depth")).text(), "PNG:d1");
  assert.ok(await b.db.blobs.get(`photo:${p1.id}`), "cached after first view");
  // Both devices reuse the same folders instead of creating new ones.
  assert.equal(fake.live("root").length, 1);
});

test("edits propagate and concurrent edits are merged without losing text", async () => {
  const fake = createFakeDrive();
  const a = device(fake), b = device(fake);
  const { entry } = await writeEntry(a);
  await a.sync.run();
  await b.sync.run();
  await editText(a, entry.id, "A에서 고친 내용");
  await a.sync.run();
  await b.sync.run();
  assert.equal((await b.db.entries.get(entry.id)).text, "A에서 고친 내용");

  await editText(a, entry.id, "A의 두 번째 수정");
  await new Promise((r) => setTimeout(r, 5));
  await editText(b, entry.id, "B의 오프라인 수정");
  await a.sync.run();
  const stats = await b.sync.run();
  assert.equal(stats.merged, 1);
  const merged = await b.db.entries.get(entry.id);
  assert.match(merged.text, /^B의 오프라인 수정/, "newer edit stays on top");
  assert.ok(merged.text.includes(CONFLICT_MARK));
  assert.ok(merged.text.includes("A의 두 번째 수정"), "other device's text kept");
  assert.equal(merged.sync.dirty, false, "merge was pushed in the same run");
  await a.sync.run();
  assert.equal((await a.db.entries.get(entry.id)).text, merged.text);
  assert.equal(fake.live("entry").length, 1, "still one document per entry");
});

test("deleting an entry trashes its Drive files and removes it on other devices", async () => {
  const fake = createFakeDrive();
  const a = device(fake), b = device(fake);
  const { entry, p1 } = await writeEntry(a);
  await a.sync.run();
  await b.sync.run();
  await b.sync.media((await b.db.entries.get(entry.id)).photos[0], "photo");
  await deleteEntry(a.db, entry.id);
  assert.equal((await a.db.entries.get(entry.id)).sync.deleted, true, "tombstone until synced");
  await a.sync.run();
  assert.equal(await a.db.entries.get(entry.id), undefined);
  for (const role of ["entry", "photo", "thumb", "depth"]) assert.equal(fake.live(role).length, 0, role);
  const stats = await b.sync.run();
  assert.equal(stats.removed, 1);
  assert.equal(await b.db.entries.get(entry.id), undefined);
  assert.equal(await b.db.blobs.get(`photo:${p1.id}`), undefined, "cached media removed too");
});

test("a never-synced entry is deleted immediately without a tombstone", async () => {
  const fake = createFakeDrive();
  const a = device(fake);
  const { entry } = await writeEntry(a);
  await deleteEntry(a.db, entry.id);
  assert.equal(await a.db.entries.get(entry.id), undefined);
  await a.sync.run();
  assert.equal(fake.byRole("entry").length, 0);
});

test("removing a photo in the editor trashes its uploaded files", async () => {
  const fake = createFakeDrive();
  const a = device(fake);
  const { entry, p1 } = await writeEntry(a);
  await a.sync.run();
  const current = await a.db.entries.get(entry.id);
  current.photos = current.photos.filter((p) => p.id !== p1.id);
  await commitEdit(a.db, current);
  assert.equal(await a.db.blobs.get(`photo:${p1.id}`), undefined);
  await a.sync.run();
  assert.equal(fake.live("photo").length, 1);
  assert.equal(fake.live("thumb").length, 1);
  assert.equal(fake.live("depth").length, 0);
  assert.equal(JSON.parse(fake.text(fake.live("entry")[0].id)).photos.length, 1);
});

test("an editor save does not wipe Drive ids attached by a sync meanwhile", async () => {
  const fake = createFakeDrive();
  const a = device(fake);
  const { entry } = await writeEntry(a);
  const editorCopy = structuredClone(await a.db.entries.get(entry.id)); // editor opened
  await a.sync.run(); // uploads while the editor is open
  editorCopy.text = "편집기에서 저장";
  await commitEdit(a.db, editorCopy);
  const saved = await a.db.entries.get(entry.id);
  assert.ok(saved.photos.every((p) => p.driveId), "drive ids preserved");
  assert.ok(saved.sync.driveId, "entry file id preserved");
  await a.sync.run();
  assert.equal(fake.live("photo").length, 2, "no duplicate uploads");
  assert.equal(fake.live("entry").length, 1);
});

test("an edit made during an upload keeps the entry dirty", async () => {
  const fake = createFakeDrive();
  const db = createMemoryDB();
  let injected = false;
  const fetchImpl = async (url, init) => {
    if (!injected && String(url).includes("/upload/") && init.body instanceof Blob &&
        (await init.body.text()).includes('"snapDiary":"entry"')) {
      injected = true;
      const [cur] = await db.entries.all();
      cur.text = "업로드 중 추가 수정";
      await commitEdit(db, cur);
    }
    return fake.fetch(url, init);
  };
  const drive = createDriveClient(async () => fake.token, { fetchImpl, retryDelay: 1 });
  const sync = createSync({ drive, db });
  await writeEntry({ db });
  await sync.run();
  const [after] = await db.entries.all();
  assert.equal(after.sync.dirty, true);
  await sync.run();
  const [final] = await db.entries.all();
  assert.equal(final.sync.dirty, false);
  assert.equal(JSON.parse(fake.text(final.sync.driveId)).text, "업로드 중 추가 수정");
});

test("a trashed Drive folder is recreated from this device's copy", async () => {
  const fake = createFakeDrive();
  const a = device(fake);
  const { entry } = await writeEntry(a);
  await a.sync.run();
  const [oldRoot] = fake.live("root");
  fake.trash(oldRoot.id);
  await a.sync.run();
  assert.ok(await a.db.entries.get(entry.id), "local entry survives");
  const [newRoot] = fake.live("root");
  assert.notEqual(newRoot.id, oldRoot.id);
  assert.equal(fake.live("entry").length, 1);
  assert.equal(fake.live("photo").length, 2);
  assert.equal(fake.live("depth").length, 1);
});

test("an entry edited here but deleted elsewhere is kept and re-uploaded", async () => {
  const fake = createFakeDrive();
  const a = device(fake), b = device(fake);
  const { entry } = await writeEntry(a);
  await a.sync.run();
  await b.sync.run();
  await deleteEntry(b.db, entry.id);
  await b.sync.run();
  await editText(a, entry.id, "삭제된 줄 모르고 수정");
  await a.sync.run();
  const kept = await a.db.entries.get(entry.id);
  assert.equal(kept.sync.dirty, false);
  assert.equal(fake.live("entry").length, 1);
  assert.equal(fake.live("photo").length, 2, "media re-uploaded from this device");
  await b.sync.run();
  assert.equal((await b.db.entries.get(entry.id)).text, "삭제된 줄 모르고 수정");
});

test("401 invalidates the token and surfaces a DriveError", async () => {
  const fake = createFakeDrive();
  let invalidated = 0;
  const db = createMemoryDB();
  const drive = createDriveClient(async () => "expired", {
    fetchImpl: fake.fetch, retryDelay: 1, onUnauthorized: () => invalidated++
  });
  const sync = createSync({ drive, db });
  await assert.rejects(sync.run(), (error) => error.status === 401);
  assert.equal(invalidated, 1);
});

test("concurrent run() calls share one sync", async () => {
  const fake = createFakeDrive();
  const a = device(fake);
  await writeEntry(a);
  const [one, two] = await Promise.all([a.sync.run(), a.sync.run()]);
  assert.equal(one, two);
  assert.equal(fake.live("entry").length, 1);
  assert.equal(fake.live("root").length, 1);
});
