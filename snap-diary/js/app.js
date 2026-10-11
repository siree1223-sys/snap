import * as db from "./store.js";
import { CONFIG, clientId, setClientIdOverride, isValidClientId } from "./config.js";
import * as auth from "./auth.js";
import { createDriveClient } from "./drive.js";
import { createSync } from "./sync.js";
import { commitEdit, deleteEntry, attachDepth, visibleEntries } from "./repo.js";
import {
  createEntry, createPhoto, groupByMonth, formatKoreanDate, excerpt, matchesQuery, MOODS,
  monthGrid, toISODate, isEntryEmpty, sortEntries, formatMonth, isISODate, isVideo, applyCaptureInfo
} from "./model.js";
import { preparePhoto, decodeImage, photoSize, setPhotoSize } from "./images.js";
import { prepareVideo } from "./video.js";
import { isVideoFile, formatDuration } from "./media.js";
import { readCaptureInfo } from "./exif.js";
import { regionName, geocodeEnabled, setGeocodeEnabled, ATTRIBUTION } from "./geocode.js";
import { planDays, distinctNames, googlePhotosDayUrl } from "./organize.js";
import { estimateDepth, depthToBlob, blobToDepth } from "./depth.js";
import { createPlaceViewer } from "./place3d.js";
import { h, icon, clear, toast, confirmSheet, urlScope, formatTime, formatBytes } from "./ui.js";
import { hasPin, pinPad, setPin, clearPin, installAutoLock } from "./lock.js";

const AI_DEPTH_KEY = "snapdiary.aiDepth";
const store = { entries: db.entries, blobs: db.blobs, meta: db.meta };
const drive = createDriveClient(() => auth.getToken(), { onUnauthorized: () => auth.invalidateToken() });
const syncer = createSync({ drive, db: store, folderName: CONFIG.driveFolderName, onProgress: onSyncProgress });

const app = { cleanup: null, routeToken: 0, chip: null, view: null, tabs: null, fab: null, installPrompt: null };

// ---------- settings helpers ----------

function aiDepthEnabled() {
  try {
    return localStorage.getItem(AI_DEPTH_KEY) !== "off";
  } catch {
    return true;
  }
}
function setAiDepth(on) {
  try { localStorage.setItem(AI_DEPTH_KEY, on ? "on" : "off"); } catch { /* ignore */ }
}

// ---------- media ----------

// At most three Drive downloads at a time: quick lists, gentle on mobile data.
const downloads = { active: 0, waiting: [] };
async function limited(task) {
  if (downloads.active >= 3) await new Promise((resolve) => downloads.waiting.push(resolve));
  else downloads.active++;
  try {
    return await task();
  } finally {
    const next = downloads.waiting.shift();
    if (next) next(); // hand the slot straight to the next download
    else downloads.active--;
  }
}
const inflight = new Map();
/** Local blob, or a Drive download when signed in (deduplicated, cached). */
async function mediaBlob(photo, kind) {
  const key = `${kind}:${photo.id}`;
  const local = await db.blobs.get(key);
  if (local) return local;
  if (!auth.cachedToken() || !navigator.onLine) return null;
  if (!inflight.has(key)) {
    inflight.set(key, limited(() => syncer.media(photo, kind)).catch(() => null)
      .finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}
async function thumbBlob(photo) {
  const thumb = await mediaBlob(photo, "thumb");
  if (thumb || isVideo(photo)) return thumb; // never fetch a whole video for a thumbnail
  return mediaBlob(photo, "photo");
}

function photoImg(photo, scope, { kind = "thumb", cls = "" } = {}) {
  const img = h("img", { class: `ph ${cls}`, alt: photo.caption || "", decoding: "async", loading: "lazy" });
  const wrap = h("div", { class: `ph-wrap loading ${cls}` }, img,
    isVideo(photo) ? h("span", { class: "play-badge" }, icon("play", 14), formatDuration(photo.duration)) : null);
  (kind === "thumb" ? thumbBlob(photo) : mediaBlob(photo, kind)).then((blob) => {
    wrap.classList.remove("loading");
    if (blob) img.src = scope.url(blob);
    else wrap.classList.add("missing");
  });
  return wrap;
}

// ---------- importing picked files ----------

/**
 * Reads capture time/GPS from the original file (before re-encoding strips
 * it), stores the diary copy + thumbnail locally and returns the attachment.
 */
async function importMedia(file, kind) {
  const info = await readCaptureInfo(file);
  let photo, notice = "";
  if (isVideoFile(file)) {
    if (kind === "place") notice = "동영상은 3D 장소로 만들 수 없어 동영상으로 추가했어요.";
    const prepared = await prepareVideo(file);
    photo = createPhoto({ width: prepared.width, height: prepared.height, kind: "video", name: file.name || "",
      mime: prepared.mime, duration: prepared.duration, size: prepared.size });
    await db.blobs.put(`photo:${photo.id}`, prepared.video);
    await db.blobs.put(`thumb:${photo.id}`, prepared.poster);
    if (!prepared.playable) notice = "이 기기에서는 미리보기가 안 되는 형식이지만 그대로 저장해요.";
  } else {
    const prepared = await preparePhoto(file);
    photo = createPhoto({ width: prepared.width, height: prepared.height, kind, name: file.name || "" });
    await db.blobs.put(`photo:${photo.id}`, prepared.full);
    await db.blobs.put(`thumb:${photo.id}`, prepared.thumb);
  }
  applyCaptureInfo(photo, info);
  return { photo, info, notice };
}

const placeLookup = (lat, lng) => regionName(lat, lng, db.meta);

// ---------- depth jobs (one at a time; the AI model is memory hungry) ----------

const depthJobs = new Map();
const depthListeners = new Map();
const editorPhotoIds = new Set();
let depthChain = Promise.resolve();

function emitDepth(photoId, status) {
  for (const fn of depthListeners.get(photoId) || []) fn(status);
}
function onDepth(photoId, fn) {
  if (!depthListeners.has(photoId)) depthListeners.set(photoId, new Set());
  depthListeners.get(photoId).add(fn);
  return () => depthListeners.get(photoId)?.delete(fn);
}

function depthLabel(status) {
  if (!status) return "";
  if (status.stage === "queued") return "3D 대기 중…";
  if (status.stage === "download") return `AI 깊이 모델 받는 중 ${Math.round(status.ratio * 100)}%`;
  if (status.stage === "infer") return "AI가 깊이 계산 중…";
  if (status.stage === "fallback") return "AI 모델 사용 불가 → 간이 깊이로 계산";
  if (status.stage === "done") return status.source === "ai" ? "3D 준비됨 · AI 깊이" : "3D 준비됨 · 간이 깊이";
  if (status.stage === "error") return `3D 준비 실패: ${status.message}`;
  return "";
}

function queueDepth(entryId, photo) {
  if (depthJobs.has(photo.id)) return depthJobs.get(photo.id);
  emitDepth(photo.id, { stage: "queued" });
  const job = depthChain.then(async () => {
    const blob = await mediaBlob(photo, "photo");
    if (!blob) throw new Error("사진 원본을 불러올 수 없습니다.");
    const bitmap = await decodeImage(blob);
    let map;
    try {
      map = await estimateDepth(bitmap, { useAI: aiDepthEnabled(), onProgress: (s) => emitDepth(photo.id, s) });
    } finally {
      bitmap.close?.();
    }
    const depthBlob = await depthToBlob(map);
    await db.blobs.put(`depth:${photo.id}`, depthBlob);
    const stored = await db.entries.get(entryId);
    if (stored?.photos.some((p) => p.id === photo.id)) {
      await attachDepth(store, entryId, photo.id, depthBlob, map.source);
      scheduleSync();
    } else if (!editorPhotoIds.has(photo.id)) {
      await db.blobs.remove(`depth:${photo.id}`); // photo was discarded meanwhile
    }
    emitDepth(photo.id, { stage: "done", source: map.source });
    return map;
  }).catch((error) => {
    emitDepth(photo.id, { stage: "error", message: error.message });
    throw error;
  }).finally(() => depthJobs.delete(photo.id));
  depthChain = job.catch(() => {});
  depthJobs.set(photo.id, job);
  return job;
}

// ---------- sync ----------

const CHIP = {
  setup: ["Drive 설정", "cloud"],
  login: ["Drive 연결", "cloud"],
  offline: ["오프라인", "cloud"],
  syncing: ["동기화 중", "sync"],
  ok: ["동기화됨", "cloud"],
  error: ["동기화 오류", "cloud"]
};

function setChip(state, detail = "") {
  if (!app.chip) return;
  const [label, ic] = CHIP[state];
  app.chip.dataset.state = state;
  clear(app.chip).append(icon(ic, 18), h("span", { text: detail || label }));
  app.chip.title = state === "ok" ? "Google Drive와 동기화됨" : label;
}

function onSyncProgress(event) {
  if (event.phase === "upload" && event.total > 0) {
    const label = event.kind === "video" ? "동영상" : "파일";
    setChip("syncing", `${label} 올리는 중 ${Math.floor((100 * event.loaded) / event.total)}%`);
    return;
  }
  if (event.phase === "pull" || event.phase === "push") {
    setChip("syncing", event.total > 1 ? `동기화 ${Math.min(event.done + 1, event.total)}/${event.total}` : "동기화 중");
  }
}

async function pendingCount() {
  return (await db.entries.all()).filter((e) => e.sync?.dirty || e.sync?.deleted).length;
}

let syncTimer = 0;
function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  if (clientId() && navigator.onLine && auth.cachedToken()) setChip("syncing", "동기화 대기");
  syncTimer = setTimeout(() => runSync(), delay);
}

async function runSync({ interactive = false } = {}) {
  if (!clientId()) {
    setChip("setup");
    if (interactive) location.hash = "#/settings";
    return;
  }
  if (!navigator.onLine) {
    const n = await pendingCount();
    setChip("offline", n ? `오프라인 · 대기 ${n}` : "오프라인");
    return;
  }
  try {
    if (interactive) await auth.getToken({ interactive: true });
    else if (!auth.cachedToken()) {
      const n = await pendingCount();
      setChip("login", n ? `Drive 연결 · 대기 ${n}` : "Drive 연결");
      return;
    }
    setChip("syncing");
    const stats = await syncer.run();
    setChip("ok", `동기화됨 ${formatTime(new Date().toISOString())}`);
    if (stats.pulled || stats.pushed || stats.merged || stats.removed) refreshListScreen();
    if (interactive) {
      const parts = [];
      if (stats.pushed) parts.push(`올림 ${stats.pushed}`);
      if (stats.pulled) parts.push(`받음 ${stats.pulled}`);
      if (stats.merged) parts.push(`병합 ${stats.merged}`);
      toast(parts.length ? `동기화 완료 · ${parts.join(" · ")}` : "이미 최신 상태예요");
    }
  } catch (error) {
    if (error.code === "needs-login" || error.status === 401) setChip("login");
    else {
      setChip("error");
      console.warn("[Snap Diary] sync failed", error);
      if (interactive || error.code === "forbidden") toast(error.message, { error: true, ms: 4000 });
    }
  }
}

// ---------- router ----------

const ROUTES = [
  [/^#?\/?$/, () => screenTimeline(), "home"],
  [/^#\/calendar(?:\/(\d{4}-\d{2}))?$/, (m) => screenCalendar(m[1]), "calendar"],
  [/^#\/places$/, () => screenPlaces(), "places"],
  [/^#\/settings$/, () => screenSettings(), "settings"],
  [/^#\/entry\/([a-z0-9]+)$/, (m) => screenEntry(m[1]), "home"],
  [/^#\/edit\/([a-z0-9]+)$/, (m) => screenEditor({ id: m[1] }), null],
  [/^#\/new(?:\/(\d{4}-\d{2}-\d{2}))?$/, (m) => screenEditor({ date: m[1] }), null],
  [/^#\/view\/([a-z0-9]+)\/([a-z0-9]+)$/, (m) => screenViewer(m[1], m[2]), null],
  [/^#\/organize$/, () => screenOrganize(), null]
];

let ctx = null;
async function route({ keepScroll = false } = {}) {
  const token = ++app.routeToken;
  const scrollY = window.scrollY;
  if (ctx) {
    const old = ctx;
    ctx = null;
    for (const fn of old.cleanups.reverse()) {
      try { await fn(); } catch (error) { console.warn(error); }
    }
    old.scope.revokeAll();
  }
  // Overlays (photo lightbox, sheets) belong to the screen being left.
  document.querySelectorAll(".lightbox, .backdrop").forEach((node) => (node.closeOverlay ? node.closeOverlay() : node.remove()));
  const hash = location.hash || "#/";
  const found = ROUTES.find(([re]) => re.test(hash)) || ROUTES[0];
  const match = found[0].exec(hash) || [];
  const tab = found[2];
  document.body.dataset.mode = tab ? "tabs" : "full";
  for (const button of app.tabs.querySelectorAll("a")) button.classList.toggle("active", button.dataset.tab === tab);
  const local = { scope: urlScope(), cleanups: [] };
  ctx = local;
  let node;
  try {
    node = await found[1](match);
  } catch (error) {
    console.error(error);
    node = h("div", { class: "empty" }, h("p", { text: `화면을 열 수 없습니다: ${error.message}` }));
  }
  if (token !== app.routeToken) {
    for (const fn of local.cleanups) fn();
    local.scope.revokeAll();
    return;
  }
  clear(app.view).append(node);
  window.scrollTo(0, keepScroll ? scrollY : 0);
}

function refreshListScreen() {
  if (document.body.dataset.mode === "tabs") route({ keepScroll: true });
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---------- screens ----------

function topBar(title, { back = null, actions = [] } = {}) {
  return h("header", { class: "screen-head" },
    back ? h("button", { class: "icon-btn", "aria-label": "뒤로", onclick: back }, icon("back")) : null,
    h("h1", { text: title }),
    h("div", { class: "head-actions" }, actions));
}

function entryCard(entry, scope) {
  const photos = entry.photos.slice(0, 3);
  const places = entry.photos.filter((p) => p.kind === "place").length;
  const videos = entry.photos.filter(isVideo).length;
  const stills = entry.photos.length - videos;
  return h("a", { class: "card", href: `#/entry/${entry.id}` },
    photos.length ? h("div", { class: `card-photos n${photos.length}` }, photos.map((p) => photoImg(p, scope))) : null,
    h("div", { class: "card-body" },
      h("div", { class: "card-date" },
        h("span", { text: formatKoreanDate(entry.date, { withYear: false }) }),
        entry.mood ? h("span", { class: "mood", text: entry.mood }) : null,
        entry.sync?.dirty ? h("span", { class: "dot-pending", title: "동기화 대기" }) : null),
      entry.title ? h("h2", { text: entry.title }) : null,
      entry.text ? h("p", { class: "excerpt", text: excerpt(entry.text, 110) }) : null,
      h("div", { class: "card-meta" },
        entry.place?.name ? h("span", { class: "chip" }, icon("place", 14), entry.place.name) : null,
        stills ? h("span", { class: "chip" }, icon("photo", 14), String(stills)) : null,
        videos ? h("span", { class: "chip" }, icon("play", 14), String(videos)) : null,
        places ? h("span", { class: "chip accent" }, icon("cube", 14), `3D ${places}`) : null)));
}

async function screenTimeline() {
  const all = visibleEntries(await db.entries.all());
  const list = h("div", { class: "timeline" });
  const paint = (query) => {
    clear(list);
    const filtered = all.filter((e) => matchesQuery(e, query));
    if (!all.length) {
      list.append(h("div", { class: "empty" },
        h("div", { class: "empty-art", "aria-hidden": "true" }),
        h("p", { text: "아직 기록이 없어요." }),
        h("p", { class: "muted", text: "＋를 눌러 오늘 한 일을 남겨 보세요." }),
        h("a", { class: "btn accent", href: "#/organize" }, icon("sparkle", 18), "휴대폰 사진으로 날짜별 정리하기")));
      return;
    }
    if (!filtered.length) {
      list.append(h("p", { class: "empty muted", text: "검색 결과가 없어요." }));
      return;
    }
    for (const group of groupByMonth(filtered)) {
      list.append(h("section", { class: "month" },
        h("h3", { class: "month-label", text: `${group.label} · ${group.items.length}` }),
        group.items.map((e) => entryCard(e, ctx.scope))));
    }
  };
  const search = h("input", {
    class: "search", type: "search", placeholder: "기록 검색", "aria-label": "기록 검색",
    oninput: (e) => paint(e.target.value)
  });
  paint("");
  return h("div", { class: "screen" },
    topBar("나의 기록", { actions: [h("a", { class: "btn ghost small", href: "#/organize" }, icon("sparkle", 16), "사진으로 정리")] }),
    all.length ? h("label", { class: "search-wrap" }, icon("search", 18), search) : null,
    list);
}

async function screenEntry(id) {
  const entry = await db.entries.get(id);
  if (!entry || entry.sync?.deleted) {
    toast("기록을 찾을 수 없어요.", { error: true });
    return screenTimeline();
  }
  const scope = ctx.scope;
  const places = entry.photos.filter((p) => p.kind === "place");
  const others = entry.photos.filter((p) => p.kind !== "place");
  const remove = async () => {
    const ok = await confirmSheet({
      title: "이 기록을 삭제할까요?",
      message: "Google Drive의 일기 파일과 사진도 휴지통으로 이동합니다.",
      confirm: "삭제", danger: true
    });
    if (!ok) return;
    await deleteEntry(store, id);
    toast("삭제했어요.");
    scheduleSync(300);
    go("#/");
  };
  const visited = distinctNames(entry.photos.map((p) => p.placeName)).filter((n) => n !== entry.place?.name);
  const mapLink = entry.place && Number.isFinite(entry.place.lat)
    ? `https://www.google.com/maps/search/?api=1&query=${entry.place.lat},${entry.place.lng}` : null;
  return h("article", { class: "screen entry" },
    topBar(formatKoreanDate(entry.date), {
      back: () => history.length > 1 ? history.back() : go("#/"),
      actions: [
        h("button", { class: "icon-btn", "aria-label": "수정", onclick: () => go(`#/edit/${id}`) }, icon("edit")),
        h("button", { class: "icon-btn", "aria-label": "삭제", onclick: remove }, icon("trash"))
      ]
    }),
    h("div", { class: "entry-head" },
      entry.mood ? h("span", { class: "mood big", text: entry.mood }) : null,
      entry.title ? h("h2", { text: entry.title }) : null),
    entry.place?.name || mapLink
      ? h(mapLink ? "a" : "span", { class: "chip place-chip", href: mapLink, target: mapLink ? "_blank" : null, rel: "noopener" },
        icon("place", 16), entry.place?.name || `${entry.place.lat.toFixed(4)}, ${entry.place.lng.toFixed(4)}`)
      : null,
    visited.length ? h("div", { class: "chip-row" }, h("span", { class: "muted small", text: "이날 다녀온 곳" }),
      visited.map((name) => h("span", { class: "chip" }, icon("place", 14), name))) : null,
    places.map((p) => h("a", { class: "place-card", href: `#/view/${id}/${p.id}` },
      photoImg(p, scope, { kind: "photo" }),
      h("span", { class: "badge-3d" }, icon("cube", 16), "3D로 보기"),
      p.caption ? h("span", { class: "caption", text: p.caption }) : null)),
    entry.text ? h("div", { class: "entry-text", text: entry.text }) : null,
    others.length ? h("div", { class: "photo-grid" }, others.map((p) =>
      h("button", { class: "photo-cell", "aria-label": p.caption || (isVideo(p) ? "동영상 재생" : "사진 크게 보기"),
        onclick: () => (isVideo(p) ? videoPlayer(p) : lightbox(p)) },
        photoImg(p, scope), p.caption ? h("span", { class: "caption", text: p.caption }) : null))) : null,
    entry.photos.length ? h("a", { class: "btn ghost small gphotos", href: googlePhotosDayUrl(entry.date), target: "_blank", rel: "noopener" },
      icon("photo", 16), "구글 포토에서 이날 원본 찾기") : null,
    h("p", { class: "muted small", text: entry.sync?.dirty ? "이 기기에만 저장됨 · 동기화 대기" : `Google Drive에 저장됨` }));
}

function videoPlayer(photo) {
  const scope = urlScope();
  const status = h("div", { class: "player-status" }, h("div", { class: "spinner" }), h("span", { text: "동영상 불러오는 중…" }));
  const video = h("video", { controls: true, playsInline: true, preload: "auto", class: "hidden" });
  const close = () => {
    video.pause();
    video.removeAttribute("src");
    box.remove();
    scope.revokeAll();
  };
  const driveLink = photo.driveId ? `https://drive.google.com/file/d/${encodeURIComponent(photo.driveId)}/view` : null;
  const fail = (message) => {
    clear(status).append(h("p", { text: message }),
      driveLink ? h("a", { class: "btn ghost small light", href: driveLink, target: "_blank", rel: "noopener" }, "Google Drive에서 열기") : null);
    video.classList.add("hidden");
  };
  const box = h("div", { class: "lightbox player", role: "dialog", "aria-modal": "true",
    onclick: (e) => { if (e.target === box) close(); } },
    status, video, photo.caption ? h("p", { text: photo.caption }) : null,
    h("button", { class: "icon-btn close", "aria-label": "닫기", onclick: close }, icon("close")));
  box.closeOverlay = close;
  document.body.append(box);
  video.addEventListener("loadedmetadata", () => { status.remove(); video.classList.remove("hidden"); });
  video.addEventListener("error", () => fail("이 기기의 브라우저가 이 동영상 형식을 재생하지 못해요."));
  mediaBlob(photo, "photo").then((blob) => {
    if (!box.isConnected) return;
    if (!blob) {
      fail(auth.cachedToken() ? "동영상을 받지 못했어요. 잠시 후 다시 시도하세요."
        : "동영상은 Google Drive에 있어요. Drive를 연결하면 이 기기에서도 볼 수 있어요.");
      return;
    }
    video.src = scope.url(blob);
  });
}

async function lightbox(photo) {
  const scope = urlScope();
  const img = h("img", { alt: photo.caption || "" });
  const close = () => { box.remove(); scope.revokeAll(); };
  const box = h("div", { class: "lightbox", role: "dialog", "aria-modal": "true", onclick: close },
    img, photo.caption ? h("p", { text: photo.caption }) : null,
    h("button", { class: "icon-btn close", "aria-label": "닫기" }, icon("close")));
  document.body.append(box);
  const blob = await mediaBlob(photo, "photo") || await thumbBlob(photo);
  if (blob) img.src = scope.url(blob);
}

async function screenEditor({ id, date }) {
  let stored = null;
  if (id) {
    stored = await db.entries.get(id);
    if (!stored || stored.sync?.deleted) {
      toast("기록을 찾을 수 없어요.", { error: true });
      return screenTimeline();
    }
  }
  const isNew = !stored;
  const draft = stored ? structuredClone(stored) : createEntry({ date: isISODate(date) ? date : toISODate() });
  const added = new Set();
  let dirty = false;
  let finished = false;
  const scope = ctx.scope;
  const markDirty = () => { dirty = true; };
  for (const p of draft.photos) editorPhotoIds.add(p.id);

  const titleInput = h("input", { class: "title-input", placeholder: "제목", value: draft.title, maxlength: 80,
    oninput: (e) => { draft.title = e.target.value; markDirty(); } });
  const textArea = h("textarea", { class: "text-input", placeholder: "오늘 어떤 일을 했나요?", value: draft.text, rows: 8,
    oninput: (e) => { draft.text = e.target.value; markDirty(); grow(); } });
  const grow = () => { textArea.style.height = "auto"; textArea.style.height = `${Math.max(180, textArea.scrollHeight)}px`; };
  let dateTouched = false;
  const dateInput = h("input", { type: "date", value: draft.date, max: "9999-12-31",
    onchange: (e) => {
      if (isISODate(e.target.value)) { draft.date = e.target.value; dateTouched = true; markDirty(); dateHint.hidden = true; }
    } });
  const dateHint = h("div", { class: "hint-banner", hidden: true });
  const showDateHint = (date) => {
    clear(dateHint).append(icon("calendar", 18),
      h("span", { text: `사진을 찍은 날은 ${formatKoreanDate(date, { withYear: false })}이에요.` }),
      h("button", { type: "button", class: "btn small accent", text: "그날 기록으로", onclick: () => {
        draft.date = date;
        dateInput.value = date;
        dateTouched = true;
        markDirty();
        dateHint.hidden = true;
      } }));
    dateHint.hidden = false;
  };
  /** Capture metadata fills the date suggestion and the place, never overriding what you typed. */
  function useCaptureInfo(photo, info) {
    if (isNew && !dateTouched && info.source !== "file" && info.date && info.date !== draft.date) showDateHint(info.date);
    if (!Number.isFinite(photo.lat)) return;
    placeLookup(photo.lat, photo.lng).then((label) => { if (label) photo.placeName = label; });
    const hasPlace = draft.place?.name?.trim() || Number.isFinite(draft.place?.lat);
    if (hasPlace) return;
    draft.place = { name: "", lat: photo.lat, lng: photo.lng };
    markDirty();
    paintCoords();
    placeLookup(photo.lat, photo.lng).then((label) => {
      if (label && !placeInput.value.trim() && draft.place && !draft.place.name) {
        draft.place.name = label;
        placeInput.value = label;
      }
    });
  }
  const moods = h("div", { class: "moods", role: "group", "aria-label": "기분" }, MOODS.map((m) =>
    h("button", { type: "button", class: `mood-btn ${draft.mood === m ? "on" : ""}`, text: m, "aria-pressed": String(draft.mood === m),
      onclick: (e) => {
        draft.mood = draft.mood === m ? "" : m;
        markDirty();
        for (const b of moods.children) {
          b.classList.toggle("on", b.textContent === draft.mood);
          b.setAttribute("aria-pressed", String(b.textContent === draft.mood));
        }
        e.currentTarget.blur();
      } })));
  const coords = h("span", { class: "muted small" });
  const paintCoords = () => {
    coords.textContent = draft.place && Number.isFinite(draft.place.lat)
      ? `${draft.place.lat.toFixed(4)}, ${draft.place.lng.toFixed(4)}` : "";
  };
  const placeInput = h("input", { placeholder: "장소 이름 (예: 성수동 카페)", value: draft.place?.name || "", maxlength: 60,
    oninput: (e) => { draft.place = { lat: null, lng: null, ...(draft.place || {}), name: e.target.value }; markDirty(); } });
  const locate = h("button", { type: "button", class: "btn ghost small", onclick: () => {
    if (!navigator.geolocation) return toast("위치를 사용할 수 없어요.", { error: true });
    locate.disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      locate.disabled = false;
      draft.place = { name: draft.place?.name || "", lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) };
      markDirty();
      paintCoords();
    }, () => {
      locate.disabled = false;
      toast("위치 권한이 필요해요.", { error: true });
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  } }, icon("locate", 16), "현재 위치");
  paintCoords();

  const tiles = h("div", { class: "photo-tiles" });
  const unsubscribers = [];
  function tile(photo) {
    const status = h("span", { class: "depth-status small" });
    const kindBtn = h("button", { type: "button", class: `kind-btn ${photo.kind === "place" ? "on" : ""}` });
    const paintKind = () => {
      kindBtn.classList.toggle("on", photo.kind === "place");
      clear(kindBtn).append(icon("cube", 15), photo.kind === "place" ? "장소 3D" : "3D로 만들기");
      kindBtn.setAttribute("aria-pressed", String(photo.kind === "place"));
      if (photo.kind !== "place") status.textContent = "";
      else if (photo.depthSource && !depthJobs.has(photo.id)) {
        status.textContent = photo.depthSource === "ai" ? "3D 준비됨 · AI 깊이" : "3D 준비됨 · 간이 깊이";
      }
    };
    unsubscribers.push(onDepth(photo.id, (s) => {
      status.textContent = depthLabel(s);
      if (s.stage === "done") photo.depthSource = s.source;
    }));
    kindBtn.addEventListener("click", () => {
      photo.kind = photo.kind === "place" ? "photo" : "place";
      markDirty();
      paintKind();
      if (photo.kind === "place" && !photo.depthSource) queueDepth(draft.id, photo).catch(() => {});
    });
    const caption = h("input", { class: "caption-input", placeholder: "설명", value: photo.caption, maxlength: 120,
      oninput: (e) => { photo.caption = e.target.value; markDirty(); } });
    const removeBtn = h("button", { type: "button", class: "icon-btn tiny remove", "aria-label": "첨부 빼기",
      onclick: async () => {
        draft.photos = draft.photos.filter((p) => p !== photo);
        markDirty();
        node.remove();
        if (added.has(photo.id)) {
          added.delete(photo.id);
          editorPhotoIds.delete(photo.id);
          await db.removePhotoBlobs(photo.id);
        }
      } }, icon("close", 16));
    const node = h("div", { class: "photo-tile" }, photoImg(photo, scope), removeBtn,
      h("div", { class: "tile-foot" }, isVideo(photo) ? null : kindBtn, caption, status));
    if (isVideo(photo)) return node;
    paintKind();
    if (depthJobs.has(photo.id)) status.textContent = "3D 계산 중…";
    return node;
  }
  for (const p of draft.photos) tiles.append(tile(p));

  async function addFiles(files, kind) {
    for (const file of files) {
      const video = isVideoFile(file);
      const placeholder = h("div", { class: "photo-tile pending" },
        h("span", { class: "muted small", text: video ? "동영상 준비 중…" : "사진 준비 중…" }));
      tiles.append(placeholder);
      try {
        const { photo, info, notice } = await importMedia(file, kind);
        if (notice) toast(notice);
        if (finished) { await db.removePhotoBlobs(photo.id); return; }
        useCaptureInfo(photo, info);
        added.add(photo.id);
        editorPhotoIds.add(photo.id);
        draft.photos.push(photo);
        markDirty();
        placeholder.replaceWith(tile(photo));
        if (photo.kind === "place") queueDepth(draft.id, photo).catch(() => {});
      } catch (error) {
        placeholder.remove();
        toast(error.message || "사진을 추가하지 못했어요.", { error: true });
      }
    }
  }
  // HEIC/HEIF are listed explicitly: some Android pickers hide them under image/*.
  const picker = (kind) => {
    const accept = kind === "place" ? "image/*,.heic,.heif" : "image/*,video/*,.heic,.heif";
    const input = h("input", { type: "file", accept, multiple: true, class: "hidden",
      onchange: (e) => { addFiles([...e.target.files], kind); e.target.value = ""; } });
    return input;
  };
  const photoInput = picker("photo"), placeInput3d = picker("place");

  async function save() {
    if (isEntryEmpty(draft)) {
      toast("내용이나 사진을 하나 이상 남겨 주세요.", { error: true });
      return;
    }
    finished = true;
    const saved = await commitEdit(store, draft);
    toast("저장했어요.");
    scheduleSync(800);
    history.replaceState(null, "", `#/entry/${saved.id}`);
    route();
  }
  async function discard() {
    finished = true;
    for (const photoId of added) {
      editorPhotoIds.delete(photoId);
      await db.removePhotoBlobs(photoId);
    }
  }
  const cancel = async () => {
    if (dirty && !(await confirmSheet({ title: "작성 중인 내용을 버릴까요?", confirm: "버리기", danger: true }))) return;
    await discard();
    if (history.length > 1) history.back();
    else go("#/");
  };
  ctx.cleanups.push(async () => {
    unsubscribers.forEach((u) => u());
    for (const p of draft.photos) editorPhotoIds.delete(p.id);
    if (finished) return;
    if (dirty && !isEntryEmpty(draft)) {
      finished = true;
      await commitEdit(store, draft);
      toast("작성 중인 내용을 자동 저장했어요.");
      scheduleSync();
    } else {
      await discard();
    }
  });
  const unload = () => { if (dirty && !finished && !isEntryEmpty(draft)) commitEdit(store, draft); };
  window.addEventListener("pagehide", unload);
  ctx.cleanups.push(() => window.removeEventListener("pagehide", unload));
  requestAnimationFrame(grow);

  return h("div", { class: "screen editor" },
    topBar(isNew ? "새 기록" : "기록 수정", {
      back: cancel,
      actions: [h("button", { class: "btn primary small", text: "저장", onclick: save })]
    }),
    h("div", { class: "field-row" }, h("label", { class: "field" }, h("span", { text: "날짜" }), dateInput), moods),
    dateHint,
    titleInput,
    textArea,
    h("div", { class: "field place-field" }, icon("place", 18), placeInput, locate),
    coords,
    h("div", { class: "photo-actions" },
      h("button", { type: "button", class: "btn ghost", onclick: () => photoInput.click() }, icon("photo", 18), "사진·동영상"),
      h("button", { type: "button", class: "btn accent", onclick: () => placeInput3d.click() }, icon("cube", 18), "장소 사진 (3D)"),
      photoInput, placeInput3d),
    h("p", { class: "muted small hint", text: "장소 사진은 깊이를 추정해 3D 공간으로 만들어요. 다른 사진도 ‘3D로 만들기’로 바꿀 수 있어요. HEIC 사진과 동영상(최대 1 GB)도 올릴 수 있어요." }),
    tiles);
}

async function screenCalendar(month) {
  const today = toISODate();
  const key = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
  const [y, m] = key.split("-").map(Number);
  const all = visibleEntries(await db.entries.all());
  const byDate = new Map();
  for (const e of sortEntries(all)) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const shift = (delta) => {
    const d = new Date(y, m - 1 + delta, 1);
    return `#/calendar/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const monthCount = all.filter((e) => e.date.startsWith(key)).length;
  const cells = monthGrid(y, m - 1).map((iso) => {
    if (!iso) return h("div", { class: "cal-cell pad" });
    const list = byDate.get(iso) || [];
    const photo = list.flatMap((e) => e.photos)[0];
    const cell = h("button", {
      class: `cal-cell ${iso === today ? "today" : ""} ${list.length ? "has" : ""}`,
      "aria-label": `${formatKoreanDate(iso)}${list.length ? ` 기록 ${list.length}개` : ""}`,
      onclick: () => go(list.length === 1 ? `#/entry/${list[0].id}` : list.length ? `#/calendar-day/${iso}` : `#/new/${iso}`)
    }, h("span", { class: "cal-day", text: String(Number(iso.slice(8))) }),
    list.length > 1 ? h("span", { class: "cal-count", text: String(list.length) }) : null);
    if (photo) {
      thumbBlob(photo).then((blob) => {
        if (blob && ctx) { cell.style.backgroundImage = `url("${ctx.scope.url(blob)}")`; cell.classList.add("photo"); }
      });
    }
    return cell;
  });
  const dayLists = [...byDate.entries()].filter(([d]) => d.startsWith(key))
    .map(([d, list]) => list.length > 1 ? h("section", { class: "month", id: `day-${d}` },
      h("h3", { class: "month-label", text: formatKoreanDate(d, { withYear: false }) }), list.map((e) => entryCard(e, ctx.scope))) : null);
  return h("div", { class: "screen" },
    topBar("달력"),
    h("div", { class: "cal-nav" },
      h("a", { class: "icon-btn", href: shift(-1), "aria-label": "이전 달" }, icon("chevronL")),
      h("div", { class: "cal-title" }, h("strong", { text: formatMonth(key) }), h("span", { class: "muted small", text: `기록 ${monthCount}개` })),
      h("a", { class: "icon-btn", href: shift(1), "aria-label": "다음 달" }, icon("chevronR"))),
    h("div", { class: "cal-grid" },
      ["일", "월", "화", "수", "목", "금", "토"].map((d) => h("div", { class: "cal-head", text: d })),
      cells),
    dayLists);
}

async function screenPlaces() {
  const all = sortEntries(visibleEntries(await db.entries.all()));
  const items = all.flatMap((e) => e.photos.filter((p) => p.kind === "place").map((p) => ({ entry: e, photo: p })));
  return h("div", { class: "screen" },
    topBar("장소"),
    h("p", { class: "muted lead", text: "다녀온 곳을 3D로 다시 걸어 보세요. 사진이 먼지처럼 모였다가 흩어집니다." }),
    items.length ? h("div", { class: "place-grid" }, items.map(({ entry, photo }) =>
      h("a", { class: "place-tile", href: `#/view/${entry.id}/${photo.id}` },
        photoImg(photo, ctx.scope),
        h("span", { class: "badge-3d small" }, icon("cube", 13), "3D"),
        h("span", { class: "place-name", text: entry.place?.name || entry.title || formatKoreanDate(entry.date, { withYear: false }) }),
        h("span", { class: "place-date", text: entry.date })))) :
      h("div", { class: "empty" },
        h("div", { class: "empty-art cube", "aria-hidden": "true" }),
        h("p", { text: "아직 장소 사진이 없어요." }),
        h("p", { class: "muted", text: "기록을 쓸 때 ‘장소 사진 (3D)’로 올려 보세요." })));
}

async function screenViewer(entryId, photoId) {
  const entry = await db.entries.get(entryId);
  const photo = entry?.photos.find((p) => p.id === photoId);
  if (!photo) {
    toast("사진을 찾을 수 없어요.", { error: true });
    return screenPlaces();
  }
  const canvas = h("canvas", { class: "viewer-canvas", "aria-label": "3D 장소 사진. 드래그해서 둘러보세요." });
  const status = h("div", { class: "viewer-status" }, h("div", { class: "spinner" }), h("span", { text: "사진 불러오는 중…" }));
  const setStatus = (text) => { status.lastChild.textContent = text; };
  const depthBadge = h("span", { class: "chip dark" });
  const slider = h("input", { type: "range", min: "0", max: "2", step: "0.05", value: "1", "aria-label": "깊이 강도" });
  const snapBtn = h("button", { class: "tool primary" }, icon("snap", 20), h("span", { text: "스냅" }));
  const tiltBtn = h("button", { class: "tool" }, icon("tilt", 20), h("span", { text: "기울이기" }));
  const resetBtn = h("button", { class: "tool" }, icon("reset", 20), h("span", { text: "시점" }));
  const redoBtn = h("button", { class: "tool hidden" }, icon("cube", 20), h("span", { text: "AI로 다시" }));
  const toolbar = h("div", { class: "viewer-tools", hidden: true },
    h("label", { class: "depth-slider" }, h("span", { class: "small", text: "깊이" }), slider), snapBtn, tiltBtn, resetBtn, redoBtn);
  const close = () => (history.length > 1 ? history.back() : go(`#/entry/${entryId}`));
  const root = h("div", { class: "viewer" },
    canvas,
    h("div", { class: "viewer-top" },
      h("button", { class: "icon-btn light", "aria-label": "닫기", onclick: close }, icon("close")),
      h("div", { class: "viewer-title" },
        h("strong", { text: entry.place?.name || entry.title || "장소" }),
        h("span", { class: "small", text: [formatKoreanDate(entry.date), photo.caption].filter(Boolean).join(" · ") })),
      depthBadge),
    status, toolbar);

  let viewer = null;
  let gyroOn = false;
  ctx.cleanups.push(() => {
    viewer?.dispose();
    if (globalThis.__snapDiary?.viewer === viewer) globalThis.__snapDiary.viewer = null;
  });
  const myCtx = ctx;

  (async () => {
    const blob = await mediaBlob(photo, "photo") || await thumbBlob(photo);
    if (!blob) throw new Error("사진을 불러올 수 없어요. Drive 연결을 확인하세요.");
    const image = await decodeImage(blob);
    let depth = null;
    const depthBlob = await mediaBlob(photo, "depth");
    if (depthBlob) depth = await blobToDepth(depthBlob);
    let source = photo.depthSource;
    if (!depth) {
      const off = onDepth(photo.id, (s) => setStatus(depthLabel(s) || "3D 준비 중…"));
      myCtx.cleanups.push(off);
      setStatus("3D 깊이 계산 중…");
      depth = await queueDepth(entryId, photo);
      source = depth.source;
    }
    if (ctx !== myCtx) { image.close?.(); return; }
    depthBadge.textContent = source === "ai" ? "AI 깊이" : "간이 깊이";
    redoBtn.classList.toggle("hidden", !(source === "heuristic" && aiDepthEnabled()));
    try {
      viewer = createPlaceViewer(canvas, {
        image, depth,
        onChange: ({ vanished }) => { snapBtn.lastChild.textContent = vanished ? "다시 모으기" : "스냅"; },
        onError: (error) => toast(error.message, { error: true })
      });
    } catch (error) {
      image.close?.();
      const img = h("img", { class: "viewer-fallback", src: myCtx.scope.url(blob), alt: "" });
      canvas.replaceWith(img);
      status.remove();
      toast(error.message, { error: true });
      return;
    }
    status.remove();
    toolbar.hidden = false;
    if (globalThis.__snapDiary) globalThis.__snapDiary.viewer = viewer;
  })().catch((error) => {
    if (ctx !== myCtx) return;
    status.classList.add("error");
    setStatus(error.message);
  });

  slider.addEventListener("input", () => viewer?.setDepthStrength(Number(slider.value)));
  snapBtn.addEventListener("click", () => {
    if (!viewer) return;
    const vanishing = viewer.snap();
    snapBtn.lastChild.textContent = vanishing ? "다시 모으기" : "스냅";
  });
  resetBtn.addEventListener("click", () => {
    viewer?.resetView();
    slider.value = "1";
    viewer?.setDepthStrength(1);
  });
  tiltBtn.addEventListener("click", async () => {
    if (!viewer) return;
    if (gyroOn) {
      viewer.disableGyro();
      gyroOn = false;
    } else {
      gyroOn = await viewer.enableGyro().catch(() => false);
      if (!gyroOn) toast("이 기기에서는 기울이기를 쓸 수 없어요.", { error: true });
    }
    tiltBtn.classList.toggle("on", gyroOn);
  });
  redoBtn.addEventListener("click", async () => {
    redoBtn.disabled = true;
    await db.blobs.remove(`depth:${photo.id}`);
    try {
      await queueDepth(entryId, { ...photo, depthDriveId: null });
      route();
    } catch (error) {
      toast(error.message, { error: true });
      redoBtn.disabled = false;
    }
  });
  return root;
}

async function screenOrganize() {
  const scope = ctx.scope;
  const myCtx = ctx;
  const status = h("p", { class: "organize-status muted small", "aria-live": "polite" });
  const plan = h("div", { class: "organize-plan" });
  let running = false;
  const input = h("input", { type: "file", accept: "image/*,video/*,.heic,.heif", multiple: true, class: "hidden",
    onchange: (e) => { const files = [...e.target.files]; e.target.value = ""; if (files.length) analyse(files); } });
  const pickBtn = h("button", { class: "btn accent", onclick: () => input.click() }, icon("photo", 18), "사진·동영상 고르기");
  const alive = () => ctx === myCtx;

  async function analyse(files) {
    if (running) return;
    running = true;
    pickBtn.disabled = true;
    clear(plan);
    try {
      const items = [];
      for (const [i, file] of files.entries()) {
        status.textContent = `촬영 정보 읽는 중 ${i + 1}/${files.length}`;
        items.push({ id: `i${i}`, file, info: await readCaptureInfo(file) });
        if (!alive()) return;
      }
      const days = planDays(items, visibleEntries(await db.entries.all()));
      const places = days.flatMap((d) => d.places);
      for (const [i, place] of places.entries()) {
        status.textContent = geocodeEnabled() ? `지역 이름 찾는 중 ${i + 1}/${places.length}` : "";
        place.name = await placeLookup(place.lat, place.lng);
        if (!alive()) return;
      }
      const withGps = items.filter((it) => Number.isFinite(it.info.lat)).length;
      const exact = items.filter((it) => it.info.source && it.info.source !== "file").length;
      status.textContent = `${files.length}개 중 촬영 날짜 ${exact}개, 위치 ${withGps}개를 찾았어요.`;
      renderPlan(days);
    } finally {
      running = false;
      pickBtn.disabled = false;
    }
  }

  function preview(item) {
    const tile = h("div", { class: "org-thumb" });
    if (isVideoFile(item.file)) tile.append(icon("play", 20));
    else {
      const img = h("img", { alt: "", loading: "lazy", decoding: "async" });
      img.addEventListener("error", () => { img.remove(); tile.append(h("span", { class: "small", text: "HEIC" })); }, { once: true });
      img.src = scope.url(item.file);
      tile.append(img);
    }
    return tile;
  }

  function renderPlan(days) {
    clear(plan);
    if (!days.length) {
      plan.append(h("p", { class: "empty muted", text: "날짜를 알 수 있는 사진이 없어요." }));
      return;
    }
    const rows = days.map((day) => {
      const main = day.places[0];
      const check = h("input", { type: "checkbox", checked: true, "aria-label": `${day.date} 포함` });
      const name = h("input", { class: "org-place", value: main?.name || "", placeholder: main ? "지역 이름" : "장소 (선택)", maxlength: 60 });
      const others = distinctNames(day.places.slice(1).map((p) => p.name)).filter((n) => n !== main?.name);
      const card = h("div", { class: "org-day" },
        h("label", { class: "org-head" }, check,
          h("strong", { text: formatKoreanDate(day.date) }),
          day.guessed ? h("span", { class: "chip", text: "날짜 추정" }) : null,
          h("span", { class: "muted small", text: `${day.items.length}개` })),
        h("div", { class: "org-place-row" }, icon("place", 16), name),
        others.length ? h("p", { class: "muted small", text: `그 밖에: ${others.join(", ")}` }) : null,
        day.entryId ? h("p", { class: "muted small", text: "이날 쓴 기록에 사진을 더해요." }) : null,
        h("div", { class: "org-thumbs" }, day.items.slice(0, 6).map(preview),
          day.items.length > 6 ? h("div", { class: "org-thumb more", text: `+${day.items.length - 6}` }) : null));
      check.addEventListener("change", () => card.classList.toggle("off", !check.checked));
      return { day, check, name, card };
    });
    const confirmBtn = h("button", { class: "btn primary", onclick: () => commit(rows) }, icon("sparkle", 18),
      `${days.length}일치 기록으로 정리하기`);
    plan.append(...rows.map((r) => r.card), h("div", { class: "org-actions" }, confirmBtn));
  }

  async function commit(rows) {
    const chosen = rows.filter((r) => r.check.checked);
    if (!chosen.length || running) return;
    running = true;
    clear(plan);
    const total = chosen.reduce((n, r) => n + r.day.items.length, 0);
    let done = 0, failed = 0;
    try {
      for (const { day, name } of chosen) {
        const label = name.value.trim();
        const main = day.places[0];
        const placeOf = new Map(day.places.flatMap((p) => p.items.map((id) => [id, p.name])));
        const photos = [];
        for (const item of day.items) {
          status.textContent = `사진 정리 중 ${++done}/${total}`;
          try {
            const { photo } = await importMedia(item.file, "photo");
            if (placeOf.get(item.id)) photo.placeName = placeOf.get(item.id);
            photos.push(photo);
          } catch (error) {
            failed++;
            console.warn("[Snap Diary] skipped a file", item.file.name, error);
          }
        }
        if (!photos.length) continue;
        const place = label || main ? { name: label, lat: main?.lat ?? null, lng: main?.lng ?? null } : null;
        const stored = day.entryId ? await db.entries.get(day.entryId) : null;
        if (stored && !stored.sync?.deleted) {
          const next = structuredClone(stored);
          next.photos.push(...photos);
          if (!next.place?.name && place) next.place = place;
          await commitEdit(store, next);
        } else {
          const entry = createEntry({ date: day.date });
          entry.photos = photos;
          entry.place = place;
          await commitEdit(store, entry);
        }
      }
    } finally {
      running = false;
    }
    toast(failed ? `${chosen.length}일치 정리 완료 · ${failed}개는 열 수 없어 건너뛰었어요.` : `${chosen.length}일치 기록으로 정리했어요.`, { ms: 3500 });
    scheduleSync(500);
    if (alive()) go("#/");
  }

  return h("div", { class: "screen organize" },
    topBar("사진으로 정리", { back: () => (history.length > 1 ? history.back() : go("#/")) }),
    h("p", { class: "lead muted", text: "휴대폰에서 사진·동영상을 고르면 찍은 날짜와 위치(GPS)를 읽어 날짜별 기록으로 정리해요. 이미 그날 쓴 기록이 있으면 거기에 더해요." }),
    h("p", { class: "muted small", text: `다이어리에는 ${photoSize() === "large" ? "고화질(2560px)" : "작은(1280px)"} 사본이 저장되고, 원본은 휴대폰·구글 포토에 그대로 있어요.` }),
    h("div", { class: "btn-row" }, pickBtn, input),
    status, plan,
    geocodeEnabled() ? h("p", { class: "muted small about", text: `${ATTRIBUTION} · 위치는 약 100 m 단위로만 보내요.` }) : null);
}

async function screenSettings() {
  const account = auth.account();
  const connected = Boolean(auth.cachedToken());
  const lastSync = await db.meta.get("lastSync");
  const pending = await pendingCount();
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  // Videos already safe in Drive can be dropped from this phone and re-downloaded when played.
  const cachedVideos = [];
  for (const entry of visibleEntries(await db.entries.all())) {
    for (const photo of entry.photos.filter((p) => isVideo(p) && p.driveId)) {
      const blob = await db.blobs.get(`photo:${photo.id}`);
      if (blob) cachedVideos.push({ id: photo.id, size: blob.size });
    }
  }
  const cachedVideoBytes = cachedVideos.reduce((n, v) => n + v.size, 0);
  const section = (title, ...children) => h("section", { class: "settings-section" }, h("h2", { text: title }), children);
  const row = (label, value) => h("div", { class: "settings-row" }, h("span", { text: label }), h("span", { class: "muted", text: value }));

  const idInput = h("input", { class: "mono", placeholder: "123456789-xxxx.apps.googleusercontent.com", value: clientId(),
    autocomplete: "off", spellcheck: false });
  const saveId = () => {
    const value = idInput.value.trim();
    if (value && !isValidClientId(value)) return toast("클라이언트 ID 형식이 아니에요.", { error: true });
    setClientIdOverride(value === CONFIG.googleClientId ? "" : value);
    auth.invalidateToken();
    toast(value ? "클라이언트 ID를 저장했어요." : "클라이언트 ID를 지웠어요.");
    runSync();
    route();
  };
  const modeSelect = h("select", { onchange: (e) => { auth.setAuthMode(e.target.value); toast("로그인 방식을 바꿨어요."); } },
    h("option", { value: "popup", text: "팝업 (기본)", selected: auth.authMode() === "popup" }),
    h("option", { value: "redirect", text: "페이지 이동 (iPhone 홈 화면 앱)", selected: auth.authMode() === "redirect" }));
  const aiToggle = h("input", { type: "checkbox", checked: aiDepthEnabled(), onchange: (e) => setAiDepth(e.target.checked) });

  const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast("복사했어요."), () => toast(text));
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  return h("div", { class: "screen settings" },
    topBar("설정"),
    section("Google Drive",
      h("p", { class: "muted", text: connected || account
        ? `${account?.email || "연결됨"} 의 Drive › ${CONFIG.driveFolderName} 폴더에 저장합니다.`
        : "일기와 사진을 내 Google Drive에 저장합니다. 앱은 자신이 만든 파일만 볼 수 있어요(drive.file 권한)." }),
      row("상태", connected ? "연결됨" : account ? "다시 연결 필요 (1시간마다 만료)" : "연결 안 됨"),
      row("마지막 동기화", lastSync ? formatTime(lastSync) : "-"),
      row("동기화 대기", `${pending}건`),
      h("div", { class: "btn-row" },
        h("button", { class: "btn primary", onclick: () => runSync({ interactive: true }).then(() => route({ keepScroll: true })) },
          icon("sync", 18), connected ? "지금 동기화" : "Google 계정 연결"),
        account ? h("button", { class: "btn ghost", text: "연결 해제", onclick: async () => {
          await auth.disconnect();
          toast("연결을 해제했어요. 이 기기의 기록은 그대로 남아 있어요.");
          setChip("login");
          route();
        } }) : null)),
    section("OAuth 클라이언트",
      h("p", { class: "muted small", text: "Google Cloud 콘솔에서 만든 웹 애플리케이션 클라이언트 ID입니다. README의 ‘설정 방법’을 따라 주세요." }),
      idInput,
      h("div", { class: "btn-row" }, h("button", { class: "btn ghost small", text: "저장", onclick: saveId })),
      h("div", { class: "settings-row col" },
        h("span", { class: "small", text: "승인된 JavaScript 원본" }),
        h("button", { class: "mono copy", text: location.origin, onclick: () => copy(location.origin) })),
      h("div", { class: "settings-row col" },
        h("span", { class: "small", text: "승인된 리디렉션 URI" }),
        h("button", { class: "mono copy", text: auth.redirectUri(), onclick: () => copy(auth.redirectUri()) })),
      h("label", { class: "settings-row" }, h("span", { text: "로그인 방식" }), modeSelect)),
    section("사진 · 위치",
      h("label", { class: "settings-row" }, h("span", { text: "다이어리에 저장할 사진 크기" }),
        h("select", { onchange: (e) => { setPhotoSize(e.target.value); toast("이제부터 추가하는 사진에 적용돼요."); } },
          h("option", { value: "small", text: "작은 사본 1280px (추천)", selected: photoSize() === "small" }),
          h("option", { value: "large", text: "고화질 2560px", selected: photoSize() === "large" }))),
      h("label", { class: "settings-row toggle" },
        h("span", {}, "사진 위치로 지역 이름 찾기",
          h("small", { class: "muted", text: "사진의 GPS를 약 100 m 단위로 OpenStreetMap에 보내 ‘서울 성동구 성수동’ 같은 이름을 받아요. 끄면 좌표만 저장해요." })),
        h("input", { type: "checkbox", checked: geocodeEnabled(), onchange: (e) => setGeocodeEnabled(e.target.checked) }))),
    section("3D 장소 사진",
      h("label", { class: "settings-row toggle" },
        h("span", {}, "AI 깊이 추정 사용",
          h("small", { class: "muted", text: "Depth Anything V2 모델이 이 기기 안에서 실행돼요. 처음 한 번 수십 MB를 내려받습니다(Wi-Fi 권장). 끄면 간이 깊이를 씁니다." })),
        aiToggle)),
    section("앱 잠금",
      row("PIN", hasPin() ? "사용 중" : "사용 안 함"),
      h("div", { class: "btn-row" },
        h("button", { class: "btn ghost", text: hasPin() ? "PIN 변경" : "PIN 설정", onclick: async () => {
          const pin = await pinPad({ mode: "create" });
          if (!pin) return;
          await setPin(pin);
          toast("PIN을 설정했어요. 1분 이상 자리를 비우면 잠깁니다.");
          route();
        } }),
        hasPin() ? h("button", { class: "btn ghost", text: "PIN 끄기", onclick: async () => {
          if (!(await pinPad({ mode: "unlock" }))) return;
          clearPin();
          toast("PIN을 껐어요.");
          route();
        } }) : null),
      h("p", { class: "muted small", text: "PIN은 화면 잠금이에요. 이 기기 저장소를 암호화하지는 않습니다." })),
    section("이 기기",
      row("저장 공간", estimate ? `${formatBytes(estimate.usage)} 사용` : "-"),
      cachedVideos.length ? h("div", { class: "btn-row" }, h("button", { class: "btn ghost small",
        text: `Drive에 올라간 동영상 ${cachedVideos.length}개 이 기기에서 비우기 (${formatBytes(cachedVideoBytes)})`,
        onclick: async () => {
          for (const v of cachedVideos) await db.blobs.remove(`photo:${v.id}`);
          toast("비웠어요. 재생하면 Drive에서 다시 받아요.");
          route({ keepScroll: true });
        } })) : null,
      standalone ? row("앱 설치", "설치됨") :
        app.installPrompt ? h("div", { class: "btn-row" }, h("button", { class: "btn accent", text: "홈 화면에 설치", onclick: async () => {
          app.installPrompt.prompt();
          await app.installPrompt.userChoice.catch(() => null);
          app.installPrompt = null;
          route();
        } })) :
          h("p", { class: "muted small", text: isIOS ? "Safari 공유 버튼 → ‘홈 화면에 추가’로 설치하세요." : "브라우저 메뉴 → ‘앱 설치’ 또는 ‘홈 화면에 추가’로 설치하세요." }),
      h("div", { class: "btn-row" }, h("button", { class: "btn danger ghost", text: "이 기기에서 기록 지우기", onclick: async () => {
        const n = await pendingCount();
        const ok = await confirmSheet({
          title: "이 기기의 기록을 지울까요?",
          message: n ? `아직 Drive에 올라가지 않은 기록 ${n}건이 영원히 사라집니다!` : "Google Drive의 기록은 그대로 남아 다시 동기화하면 돌아옵니다.",
          confirm: "지우기", danger: true
        });
        if (!ok) return;
        await db.clearAll();
        toast("이 기기의 기록을 지웠어요.");
        go("#/");
      } }))),
    h("div", { class: "btn-row center" }, h("button", { class: "btn ghost small", text: "앱 새로 불러오기 (최신 버전 받기)", onclick: reloadApp })),
    h("p", { class: "muted small about", text: `스냅 다이어리 ${CONFIG.appVersion} · 기록은 그대로 두고 앱 화면만 새로 받아요. 3D 그레인 렌더러는 Meet Vanish(/snap)의 먼지 효과에서 왔어요.` }));
}

// calendar day with several entries scrolls to that day's list
ROUTES.push([/^#\/calendar-day\/(\d{4}-\d{2}-\d{2})$/, async (m) => {
  const node = await screenCalendar(m[1].slice(0, 7));
  requestAnimationFrame(() => document.getElementById(`day-${m[1]}`)?.scrollIntoView({ behavior: "smooth" }));
  return node;
}, "calendar"]);

// ---------- shell ----------

function buildShell() {
  app.chip = h("button", { class: "sync-chip", onclick: () => runSync({ interactive: true }) });
  app.view = h("main", { id: "view" });
  app.fab = h("a", { class: "fab", href: "#/new", "aria-label": "새 기록" }, icon("plus", 28));
  const tab = (id, href, ic, label) => h("a", { href, dataset: { tab: id } }, icon(ic), h("span", { text: label }));
  app.tabs = h("nav", { class: "tabs", "aria-label": "주 메뉴" },
    tab("home", "#/", "book", "기록"),
    tab("calendar", "#/calendar", "calendar", "달력"),
    tab("places", "#/places", "place", "장소"),
    tab("settings", "#/settings", "gear", "설정"));
  const brand = h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", { text: "스냅 다이어리" }));
  document.getElementById("app").replaceChildren(h("div", { class: "appbar" }, brand, app.chip), app.view, app.fab, app.tabs);
}

let locking = null;
function lockNow() {
  if (locking || !hasPin()) return locking;
  locking = pinPad({
    mode: "unlock",
    onForgot: async (finish) => {
      const ok = await confirmSheet({
        title: "PIN을 초기화할까요?",
        message: "이 기기의 기록을 모두 지우고 PIN을 해제합니다. Drive에 동기화된 기록은 Google 계정을 다시 연결하면 돌아와요.",
        confirm: "초기화", danger: true
      });
      if (!ok) return;
      await db.clearAll();
      clearPin();
      await auth.disconnect();
      finish(true);
      go("#/");
    }
  }).finally(() => { locking = null; });
  return locking;
}

function showUpdateBanner() {
  if (document.getElementById("update-banner")) return;
  document.body.append(h("div", { id: "update-banner", class: "update-banner", role: "status" },
    h("span", { text: "새 버전이 준비됐어요." }),
    h("button", { class: "btn small accent", text: "지금 적용", onclick: () => location.reload() })));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  // A page that was already controlled has an older version running. When the
  // new release takes over, switch to it right away on list screens; while
  // writing or viewing, offer it instead of interrupting.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    if (document.body.dataset.mode === "tabs" && !document.querySelector(".lock-screen, .backdrop, .lightbox")) {
      reloading = true;
      location.reload();
    } else showUpdateBanner();
  });
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    // Home-screen apps are often resumed rather than reopened: check then too.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) reg?.update?.().catch(() => {});
    });
  }).catch((error) => console.warn("[Snap Diary] service worker", error));
}

/**
 * Fetches the latest release now (the diary itself is untouched). A newer
 * release takes over through controllerchange; otherwise this release's
 * offline files are re-downloaded past the browser's HTTP cache.
 */
async function reloadApp() {
  const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
  if (reg) {
    await reg.update().catch(() => {});
    const incoming = reg.installing || reg.waiting;
    if (incoming) {
      toast("새 버전을 받는 중이에요…");
      await new Promise((resolve) => {
        incoming.addEventListener("statechange", () => { if (incoming.state === "activated" || incoming.state === "redundant") resolve(); });
        setTimeout(resolve, 20000);
      });
      location.reload(); // usually controllerchange has already reloaded
      return;
    }
  }
  try {
    for (const key of await caches.keys()) {
      if (!key.startsWith("snap-diary-shell-")) continue;
      const cache = await caches.open(key);
      for (const request of await cache.keys()) {
        const response = await fetch(request.url, { cache: "reload" });
        if (response.ok) await cache.put(request, response);
      }
    }
  } finally {
    location.reload();
  }
}

async function start() {
  const redirect = auth.consumeRedirect();
  buildShell();
  registerServiceWorker();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    app.installPrompt = event;
  });
  if (hasPin()) await lockNow();
  installAutoLock(() => lockNow());
  window.addEventListener("hashchange", () => route());
  await route();
  db.requestPersistence();
  if (redirect && !redirect.ok) toast(redirect.error, { error: true, ms: 4000 });
  if (redirect?.ok) {
    try {
      const who = await auth.verifyCurrent();
      toast(`${who.email} 연결됨`);
    } catch (error) {
      toast(error.message, { error: true, ms: 4000 });
    }
  }
  if (clientId() && !auth.cachedToken()) auth.preloadGoogle().catch(() => {});
  runSync();
  window.addEventListener("online", () => runSync());
  window.addEventListener("offline", () => runSync());
  setInterval(() => { if (!document.hidden && !syncer.busy) runSync(); }, 5 * 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) runSync(); });
}

start().catch((error) => {
  console.error(error);
  document.getElementById("app").textContent = `앱을 시작할 수 없습니다: ${error.message}`;
});

// Test hook (used by the automated browser tests only).
globalThis.__snapDiary = { route, runSync, db, syncer, version: CONFIG.appVersion };
