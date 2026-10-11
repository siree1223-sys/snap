// Diary data model. Pure functions only (no DOM, no storage) so the same code
// runs in the app and in the Node regression tests.

export const FORMAT_VERSION = 1;
export const MOODS = ["😊", "🥰", "😌", "😐", "😢", "😡", "😴", "🤒"];
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function newId() {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

/** Local calendar date (not UTC) as YYYY-MM-DD. */
export function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function parseISODate(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatKoreanDate(iso, { withYear = true } = {}) {
  if (!isISODate(iso)) return "";
  const date = parseISODate(iso);
  const day = WEEKDAYS[date.getDay()];
  const md = `${date.getMonth() + 1}월 ${date.getDate()}일 (${day})`;
  return withYear ? `${date.getFullYear()}년 ${md}` : md;
}

export function monthKey(iso) {
  return iso.slice(0, 7);
}

export function formatMonth(key) {
  const [y, m] = key.split("-").map(Number);
  return `${y}년 ${m}월`;
}

export function createEntry({ date = toISODate(), now = new Date() } = {}) {
  const stamp = now.toISOString();
  return {
    id: newId(),
    date,
    title: "",
    text: "",
    mood: "",
    place: null,
    photos: [],
    createdAt: stamp,
    updatedAt: stamp,
    sync: { dirty: true, rev: 1, syncedRev: 0, driveId: null, remoteModified: null, trash: [] }
  };
}

const KINDS = new Set(["photo", "place", "video"]);

/** One attachment: a photo, a 3D place photo, or a video (+ its poster). */
export function createPhoto({ width, height, kind = "photo", name = "", mime = "", duration = null, size = 0 }) {
  const photo = {
    id: newId(),
    kind: KINDS.has(kind) ? kind : "photo",
    caption: "",
    name,
    width,
    height,
    driveId: null,
    thumbDriveId: null,
    depthDriveId: null,
    depthSource: null
  };
  if (photo.kind === "video") Object.assign(photo, { mime, duration, size });
  return photo;
}

export const isVideo = (photo) => photo?.kind === "video";

export function isEntryEmpty(entry) {
  return !entry.title.trim() && !entry.text.trim() && entry.photos.length === 0 &&
    !entry.place?.name?.trim() && !entry.mood;
}

/** Mark a local edit. Every edit bumps `rev`; sync records which rev it pushed. */
export function touch(entry, now = new Date()) {
  entry.updatedAt = now.toISOString();
  entry.sync = entry.sync || {};
  entry.sync.dirty = true;
  entry.sync.rev = (entry.sync.rev || 0) + 1;
  return entry;
}

function cleanPhoto(p) {
  const clean = {
    id: String(p.id),
    kind: KINDS.has(p.kind) ? p.kind : "photo",
    caption: typeof p.caption === "string" ? p.caption : "",
    name: typeof p.name === "string" ? p.name : "",
    width: Number(p.width) || 0,
    height: Number(p.height) || 0,
    driveId: p.driveId || null,
    thumbDriveId: p.thumbDriveId || null,
    depthDriveId: p.depthDriveId || null,
    depthSource: p.depthSource === "ai" || p.depthSource === "heuristic" ? p.depthSource : null
  };
  if (clean.kind === "video") {
    clean.mime = typeof p.mime === "string" && p.mime.startsWith("video/") ? p.mime : "video/mp4";
    clean.duration = Number.isFinite(p.duration) && p.duration >= 0 ? p.duration : null;
    clean.size = Number.isFinite(p.size) && p.size >= 0 ? p.size : 0;
  }
  return clean;
}

function cleanPlace(place) {
  if (!place || typeof place !== "object") return null;
  const name = typeof place.name === "string" ? place.name : "";
  const lat = Number.isFinite(place.lat) ? place.lat : null;
  const lng = Number.isFinite(place.lng) ? place.lng : null;
  if (!name && lat === null) return null;
  return { name, lat, lng };
}

/** The JSON document stored in Google Drive. Local sync bookkeeping is excluded. */
export function serializeEntry(entry) {
  return {
    app: "snap-diary",
    version: FORMAT_VERSION,
    id: entry.id,
    date: entry.date,
    title: entry.title,
    text: entry.text,
    mood: entry.mood || "",
    place: cleanPlace(entry.place),
    photos: entry.photos.map(cleanPhoto),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

export function parseEntry(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  if (!data || data.app !== "snap-diary" || typeof data.id !== "string" || !isISODate(data.date)) {
    throw new Error("스냅 다이어리 형식이 아닙니다.");
  }
  if (data.version > FORMAT_VERSION) throw new Error("더 새로운 버전의 앱에서 만든 일기입니다.");
  return {
    id: data.id,
    date: data.date,
    title: typeof data.title === "string" ? data.title : "",
    text: typeof data.text === "string" ? data.text : "",
    mood: typeof data.mood === "string" ? data.mood : "",
    place: cleanPlace(data.place),
    photos: Array.isArray(data.photos) ? data.photos.filter((p) => p && p.id).map(cleanPhoto) : [],
    createdAt: data.createdAt || data.updatedAt || new Date(0).toISOString(),
    updatedAt: data.updatedAt || new Date(0).toISOString()
  };
}

function stampLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${toISODate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const CONFLICT_MARK = "— 다른 기기에서 수정된 내용";

/**
 * Both this device and another device changed the same entry since the last
 * sync. Nothing written in a diary should be silently dropped: the newer
 * version wins for scalar fields, the other version's differing text is kept
 * below a marker, and photos are united by id.
 */
export function mergeEntries(local, remote) {
  const localNewer = local.updatedAt >= remote.updatedAt;
  const winner = localNewer ? local : remote;
  const loser = localNewer ? remote : local;
  const merged = {
    ...winner,
    photos: winner.photos.map((p) => ({ ...p })),
    updatedAt: (local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt)
  };
  const loserText = loser.text.trim();
  if (loserText && loserText !== winner.text.trim() && !winner.text.includes(loserText)) {
    merged.text = `${winner.text.trimEnd()}\n\n${CONFLICT_MARK} (${stampLabel(loser.updatedAt)}) —\n${loser.text}`;
  }
  if (!merged.title.trim() && loser.title.trim()) merged.title = loser.title;
  if (!merged.mood && loser.mood) merged.mood = loser.mood;
  if (!merged.place && loser.place) merged.place = loser.place;
  const byId = new Map(merged.photos.map((p) => [p.id, p]));
  for (const photo of loser.photos) {
    const mine = byId.get(photo.id);
    if (!mine) {
      const copy = { ...photo };
      merged.photos.push(copy);
      byId.set(copy.id, copy);
    } else {
      // Keep any Drive ids either side already knows about.
      for (const key of ["driveId", "thumbDriveId", "depthDriveId", "depthSource"]) {
        if (!mine[key] && photo[key]) mine[key] = photo[key];
      }
    }
  }
  return merged;
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) =>
    a.date === b.date ? (b.createdAt > a.createdAt ? 1 : -1) : (b.date > a.date ? 1 : -1));
}

export function groupByMonth(entries) {
  const groups = new Map();
  for (const entry of sortEntries(entries)) {
    const key = monthKey(entry.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, label: formatMonth(key), items }));
}

export function excerpt(text, max = 90) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function matchesQuery(entry, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.title, entry.text, entry.place?.name || "", entry.date,
    ...entry.photos.map((p) => p.caption)]
    .some((field) => field.toLowerCase().includes(q));
}

/** A Drive-safe, human-readable file stem: "2026-10-11_성수동 산책". */
export function fileStem(entry) {
  const title = (entry.title || entry.place?.name || "일기")
    .replace(/[\\/:*?"<>|#\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return `${entry.date}_${title || "일기"}`;
}

/** Days of a month as a 6x7 grid (null = padding), Sunday first. */
export function monthGrid(year, monthIndex) {
  const first = new Date(year, monthIndex, 1);
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(toISODate(new Date(year, monthIndex, d)));
  while (cells.length % 7) cells.push(null);
  return cells;
}
