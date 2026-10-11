// Two-way sync between this device (IndexedDB) and Google Drive.
//
// Drive layout (all created by this app; drive.file can see nothing else):
//   Snap Diary/
//     entries/     one JSON document per diary entry
//     photos/      full-size JPEGs, readable in Drive itself
//     videos/      original video files (resumable upload, any size)
//     .app-data/   thumbnails, video posters and 3D depth maps
//
// Order per run: verify folders -> pull remote changes -> push local changes.
// Conflicts (both sides edited) are merged without dropping text or photos.

import { parseEntry, serializeEntry, mergeEntries, fileStem, isVideo } from "./model.js";
import { quote } from "./drive.js";
import { videoExtension } from "./media.js";

// Per attachment: "photo" is the main file (a JPEG, or the original video),
// "thumb" the small JPEG (poster for videos), "depth" the 3D depth map.
const MEDIA = {
  photo: { field: "driveId", folder: "photos", ext: "jpg", mime: "image/jpeg" },
  thumb: { field: "thumbDriveId", folder: "data", ext: "thumb.jpg", mime: "image/jpeg" },
  depth: { field: "depthDriveId", folder: "data", ext: "depth.png", mime: "image/png" }
};
// Multipart uploads are limited to 5 MB; larger files use a resumable session.
const MULTIPART_LIMIT = 4.5 * 1024 * 1024;

function mediaSpec(photo, kind) {
  if (kind === "photo" && isVideo(photo)) {
    return { field: "driveId", folder: "videos", ext: videoExtension(photo.mime, photo.name), mime: photo.mime };
  }
  return MEDIA[kind];
}

function cleanSync(file) {
  return { dirty: false, rev: 1, driveId: file.id, remoteModified: file.modifiedTime, trash: [] };
}

export function createSync({ drive, db, folderName = "Snap Diary", onProgress = () => {} }) {
  let running = null;

  /** Which media kinds of each photo exist on this device. */
  async function localKinds(photos) {
    return Promise.all(photos.map(async (photo) => {
      const kinds = {};
      for (const kind of Object.keys(MEDIA)) kinds[kind] = Boolean(await db.blobs.get(`${kind}:${photo.id}`));
      return kinds;
    }));
  }

  /** Forget Drive ids of media this device can upload again itself. */
  function detachUploadable(photos, kinds) {
    photos.forEach((photo, i) => {
      for (const [kind, spec] of Object.entries(MEDIA)) if (kinds[i]?.[kind]) photo[spec.field] = null;
    });
  }

  async function resetRemote() {
    // The Drive folder was trashed or deleted. This device's copy becomes the
    // source: everything stored locally is uploaded again into a new folder.
    await db.meta.remove("folders");
    for (const entry of await db.entries.all()) {
      const kinds = await localKinds(entry.photos);
      await db.entries.update(entry.id, (cur) => {
        if (!cur) return undefined;
        if (cur.sync?.deleted) return null;
        detachUploadable(cur.photos, kinds);
        cur.sync = { ...cur.sync, driveId: null, remoteModified: null, dirty: true, trash: [] };
        return cur;
      });
    }
  }

  async function folders() {
    const cached = await db.meta.get("folders");
    if (cached?.root) {
      let alive = false;
      try {
        alive = !(await drive.getFile(cached.root)).trashed;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (alive) {
        // Folders added in later app versions are created on first use.
        if (!cached.videos) {
          cached.videos = await drive.ensureFolder("videos", "videos", cached.root);
          await db.meta.set("folders", cached);
        }
        return cached;
      }
      await resetRemote();
    }
    const root = await drive.ensureFolder(folderName, "root");
    const result = {
      root,
      entries: await drive.ensureFolder("entries", "entries", root),
      photos: await drive.ensureFolder("photos", "photos", root),
      videos: await drive.ensureFolder("videos", "videos", root),
      data: await drive.ensureFolder(".app-data", "data", root)
    };
    await db.meta.set("folders", result);
    return result;
  }

  async function removeBlobsOf(photos) {
    for (const photo of photos) {
      for (const prefix of Object.keys(MEDIA)) await db.blobs.remove(`${prefix}:${photo.id}`);
    }
  }

  async function pull(dirs, stats) {
    const files = await drive.list(
      `${quote(dirs.entries)} in parents and trashed=false and ` +
      "appProperties has { key='snapDiary' and value='entry' }");
    const remote = new Map();
    for (const file of files) {
      const id = file.appProperties?.entryId;
      if (!id) continue;
      const seen = remote.get(id);
      if (!seen || seen.modifiedTime < file.modifiedTime) remote.set(id, file);
    }
    const locals = new Map((await db.entries.all()).map((e) => [e.id, e]));
    let done = 0;
    for (const [id, file] of remote) {
      onProgress({ phase: "pull", done: done++, total: remote.size });
      const local = locals.get(id);
      if (local?.sync?.deleted) continue; // the local delete is pushed below
      if (local && local.sync?.remoteModified === file.modifiedTime && local.sync?.driveId === file.id) continue;
      const data = parseEntry(await drive.downloadJSON(file.id));
      let dropped = [];
      await db.entries.update(id, (cur) => {
        if (!cur) {
          stats.pulled++;
          return { ...data, sync: cleanSync(file) };
        }
        if (cur.sync?.deleted) return undefined;
        if (!cur.sync?.dirty) {
          const keep = new Set(data.photos.map((p) => p.id));
          dropped = cur.photos.filter((p) => !keep.has(p.id));
          stats.pulled++;
          return { ...data, sync: { ...cleanSync(file), rev: cur.sync?.rev || 1 } };
        }
        stats.merged++;
        const merged = mergeEntries(cur, data);
        return { ...merged, sync: { ...cur.sync, driveId: file.id, remoteModified: file.modifiedTime,
          dirty: true, rev: (cur.sync.rev || 0) + 1 } };
      });
      await removeBlobsOf(dropped);
    }
    // Entries another device deleted.
    for (const local of locals.values()) {
      if (!local.sync?.driveId || local.sync.deleted || remote.has(local.id)) continue;
      const kinds = local.sync.dirty ? await localKinds(local.photos) : [];
      let gone = null;
      await db.entries.update(local.id, (cur) => {
        if (!cur || cur.sync?.deleted || remote.has(cur.id)) return undefined;
        if (cur.sync?.dirty) {
          // Edited here after it was deleted elsewhere: keep it and upload it
          // anew, including media the other device moved to the trash.
          const byId = new Map(local.photos.map((p, i) => [p.id, kinds[i]]));
          detachUploadable(cur.photos, cur.photos.map((p) => byId.get(p.id)));
          cur.sync = { ...cur.sync, driveId: null, remoteModified: null };
          return cur;
        }
        gone = cur;
        return null;
      });
      if (gone) {
        stats.removed++;
        await removeBlobsOf(gone.photos);
      }
    }
  }

  async function trashAll(ids) {
    for (const id of ids) await drive.trash(id);
  }

  async function uploadMedia(dirs, entry, photo, index, kind) {
    const spec = mediaSpec(photo, kind);
    if (photo[spec.field]) return null;
    const blob = await db.blobs.get(`${kind}:${photo.id}`);
    if (!blob) return null;
    const metadata = {
      name: `${fileStem(entry)}_${index + 1}.${spec.ext}`,
      parents: [dirs[spec.folder]],
      mimeType: spec.mime,
      appProperties: { snapDiary: isVideo(photo) && kind === "photo" ? "video" : kind, entryId: entry.id, photoId: photo.id }
    };
    const file = blob.size > MULTIPART_LIMIT || (isVideo(photo) && kind === "photo")
      ? await drive.uploadResumable(metadata, blob, {
        onProgress: (loaded, total) => onProgress({ phase: "upload", kind: isVideo(photo) ? "video" : kind, loaded, total })
      })
      : await drive.createFile(metadata, blob);
    await db.entries.update(entry.id, (cur) => {
      const target = cur?.photos.find((p) => p.id === photo.id);
      if (!target) return undefined;
      target[spec.field] = file.id;
      return cur;
    });
    return file.id;
  }

  async function push(dirs, stats) {
    const pending = (await db.entries.all()).filter((e) => e.sync?.dirty || e.sync?.deleted);
    let done = 0;
    for (const snapshot of pending) {
      onProgress({ phase: "push", done: done++, total: pending.length });
      if (snapshot.sync.deleted) {
        await trashAll([snapshot.sync.driveId, ...(snapshot.sync.trash || []),
          ...snapshot.photos.flatMap((p) => Object.values(MEDIA).map((m) => p[m.field]))].filter(Boolean));
        await db.entries.update(snapshot.id, (cur) => (cur?.sync?.deleted ? null : undefined));
        await removeBlobsOf(snapshot.photos);
        stats.removed++;
        continue;
      }
      const trash = [...(snapshot.sync.trash || [])];
      if (trash.length) {
        await trashAll(trash);
        await db.entries.update(snapshot.id, (cur) => {
          if (!cur) return undefined;
          cur.sync.trash = (cur.sync.trash || []).filter((id) => !trash.includes(id));
          return cur;
        });
      }
      for (const [index, photo] of snapshot.photos.entries()) {
        for (const kind of Object.keys(MEDIA)) await uploadMedia(dirs, snapshot, photo, index, kind);
      }
      const current = await db.entries.get(snapshot.id);
      if (!current || current.sync?.deleted) continue;
      const body = new Blob([JSON.stringify(serializeEntry(current), null, 2)], { type: "application/json" });
      const metadata = {
        name: `${fileStem(current)}.json`,
        parents: [dirs.entries],
        mimeType: "application/json",
        appProperties: { snapDiary: "entry", entryId: current.id, date: current.date }
      };
      let file;
      if (current.sync.driveId) {
        try {
          file = await drive.updateFile(current.sync.driveId, metadata, body);
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      if (!file) file = await drive.createFile(metadata, body);
      await db.entries.update(current.id, (cur) => {
        if (!cur) return undefined;
        cur.sync.driveId = file.id;
        cur.sync.remoteModified = file.modifiedTime;
        // Edited again while uploading? Stay dirty so the next run sends it.
        if (cur.sync.rev === current.sync.rev) cur.sync.dirty = false;
        return cur;
      });
      stats.pushed++;
    }
  }

  async function runOnce() {
    const stats = { pulled: 0, pushed: 0, merged: 0, removed: 0 };
    const dirs = await folders();
    await pull(dirs, stats);
    await push(dirs, stats);
    await db.meta.set("lastSync", new Date().toISOString());
    onProgress({ phase: "done", stats });
    return stats;
  }

  return {
    /** Runs one sync; concurrent callers share the same run. */
    run() {
      if (!running) running = runOnce().finally(() => { running = null; });
      return running;
    },
    get busy() {
      return Boolean(running);
    },
    folders,
    /** Returns a local blob, downloading it from Drive on first use. */
    async media(photo, kind) {
      const key = `${kind}:${photo.id}`;
      const local = await db.blobs.get(key);
      if (local) return local;
      const fileId = photo[mediaSpec(photo, kind).field];
      if (!fileId) return null;
      const blob = await drive.download(fileId);
      await db.blobs.put(key, blob);
      return blob;
    }
  };
}
