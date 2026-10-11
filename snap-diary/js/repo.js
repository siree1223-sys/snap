// Local writes. Every change goes through an atomic update so that a sync
// running in the background and the editor never overwrite each other's work.

import { touch } from "./model.js";

const DRIVE_FIELDS = ["driveId", "thumbDriveId", "depthDriveId"];

function freshSync() {
  return { dirty: true, rev: 1, driveId: null, remoteModified: null, trash: [] };
}

/**
 * Saves the editor's copy of an entry. Drive ids that a sync attached to the
 * stored record while the editor was open are kept, and photos removed in the
 * editor have their Drive files queued for the trash.
 */
export async function commitEdit(db, edited, now = new Date()) {
  let removed = [];
  const saved = await db.entries.update(edited.id, (stored) => {
    const next = structuredClone(edited);
    const storedPhotos = new Map((stored?.photos || []).map((p) => [p.id, p]));
    for (const photo of next.photos) {
      const before = storedPhotos.get(photo.id);
      if (!before) continue;
      for (const key of DRIVE_FIELDS) if (!photo[key] && before[key]) photo[key] = before[key];
      if (!photo.depthSource && before.depthSource) photo.depthSource = before.depthSource;
    }
    const keep = new Set(next.photos.map((p) => p.id));
    removed = [...storedPhotos.values()].filter((p) => !keep.has(p.id));
    next.sync = { ...freshSync(), ...(stored?.sync || {}) };
    next.sync.trash = [...(next.sync.trash || []),
      ...removed.flatMap((p) => DRIVE_FIELDS.map((k) => p[k]).filter(Boolean))];
    next.sync.rev = stored?.sync?.rev || 0;
    next.sync.deleted = false;
    return touch(next, now);
  });
  for (const photo of removed) {
    for (const prefix of ["photo", "thumb", "depth"]) await db.blobs.remove(`${prefix}:${photo.id}`);
  }
  return saved;
}

/** Deletes locally now; a tombstone remains until sync trashes the Drive files. */
export async function deleteEntry(db, id) {
  const stored = await db.entries.get(id);
  if (!stored) return;
  const hasRemote = stored.sync?.driveId || stored.sync?.trash?.length ||
    stored.photos.some((p) => DRIVE_FIELDS.some((k) => p[k]));
  for (const photo of stored.photos) {
    for (const prefix of ["photo", "thumb", "depth"]) await db.blobs.remove(`${prefix}:${photo.id}`);
  }
  if (!hasRemote) {
    await db.entries.remove(id);
    return;
  }
  await db.entries.update(id, (cur) => {
    if (!cur) return undefined;
    cur.sync = { ...freshSync(), ...cur.sync, deleted: true, dirty: true };
    return cur;
  });
}

/** Stores a computed depth map for a photo and queues the entry for upload. */
export async function attachDepth(db, entryId, photoId, depthBlob, source) {
  await db.blobs.put(`depth:${photoId}`, depthBlob);
  return db.entries.update(entryId, (cur) => {
    const photo = cur?.photos.find((p) => p.id === photoId);
    if (!photo || cur.sync?.deleted) return undefined;
    if (photo.depthDriveId) cur.sync.trash = [...(cur.sync.trash || []), photo.depthDriveId];
    photo.depthDriveId = null;
    photo.depthSource = source;
    return touch(cur);
  });
}

export function visibleEntries(list) {
  return list.filter((e) => !e.sync?.deleted);
}
