// Turns picked photos/videos into one plan per day: which entry they go to
// and where that day happened. Pure functions; the screen lives in app.js.

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Photos taken within this distance of each other count as one place that day. */
export const SAME_PLACE_KM = 1.5;

/**
 * @param items  [{ id, info: { takenAt, date, lat, lng, source } }]
 * @param entries existing (visible) diary entries
 * @returns days, newest first:
 *   [{ date, items (by capture time), guessed, entryId|null, places: [{ key, lat, lng, count, items }] }]
 *   `guessed` is true when no item of that day had real capture metadata.
 */
export function planDays(items, entries = []) {
  const byDate = new Map();
  for (const item of items) {
    const date = item.info?.date;
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(item);
  }
  const days = [];
  for (const [date, list] of byDate) {
    list.sort((a, b) => String(a.info.takenAt).localeCompare(String(b.info.takenAt)));
    // Greedy clustering by real distance (a fixed grid would split two photos
    // taken 300 m apart whenever a grid line runs between them).
    const places = [];
    for (const item of list) {
      const { lat, lng } = item.info;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const place = places.find((p) => distanceKm(p, { lat, lng }) <= SAME_PLACE_KM);
      if (place) {
        place.count++;
        place.items.push(item.id);
      } else places.push({ key: `p${places.length}`, lat, lng, count: 1, items: [item.id] });
    }
    const existing = entries
      .filter((e) => e.date === date && !e.sync?.deleted)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    days.push({
      date,
      items: list,
      guessed: list.every((item) => item.info.source === "file"),
      entryId: existing?.id || null,
      // Most photographed place first; ties keep the order of the day.
      places: places.sort((a, b) => b.count - a.count)
    });
  }
  return days.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Distinct, non-empty region names in order of appearance. */
export function distinctNames(names) {
  return [...new Set(names.map((n) => String(n || "").trim()).filter(Boolean))];
}

/** Google Photos search for one day (best effort: Google decides how it parses dates). */
export function googlePhotosDayUrl(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `https://photos.google.com/search/${encodeURIComponent(`${y}년 ${m}월 ${d}일`)}`;
}
