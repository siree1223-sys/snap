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

/**
 * Diary entries arranged by country, then city (시 level), for the Places tab.
 * An entry appears under every city it touched: its own place and the places
 * its photos were taken. Entries without a known city are returned apart.
 * @returns {{ countries: [{ code, name, count, cities: [{ key, city, province, entries }] }], unplaced: [] }}
 */
/** Stable id of a city for grouping and links: "kr|전남|순천". */
export function placeKey(spot) {
  return `${spot.countryCode || spot.country || "?"}|${spot.province || ""}|${spot.city}`;
}

/** True when a place or photo has a position but no country/city yet (entries from before 1.3). */
export function needsRegion(entry) {
  const missing = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !p.city;
  return missing(entry.place) || entry.photos.some(missing);
}

export function groupPlaces(entries) {
  const countries = new Map();
  const unplaced = [];
  for (const entry of entries) {
    const spots = [entry.place, ...entry.photos].filter((p) => p?.city);
    if (!spots.length) {
      unplaced.push(entry);
      continue;
    }
    const seen = new Set();
    for (const spot of spots) {
      const code = spot.countryCode || "";
      const countryKey = code || spot.country || "?";
      const key = placeKey(spot);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!countries.has(countryKey)) {
        countries.set(countryKey, { code, name: spot.country || code.toUpperCase(), cities: new Map(), entryIds: new Set() });
      }
      const country = countries.get(countryKey);
      country.entryIds.add(entry.id);
      if (!country.cities.has(key)) country.cities.set(key, { key, city: spot.city, province: spot.province || "", entries: [] });
      country.cities.get(key).entries.push(entry);
    }
  }
  const byNewest = (a, b) => (a.date < b.date ? 1 : -1);
  return {
    countries: [...countries.values()]
      .map((c) => ({
        code: c.code, name: c.name, count: c.entryIds.size,
        cities: [...c.cities.values()]
          .map((city) => ({ ...city, entries: city.entries.sort(byNewest) }))
          .sort((a, b) => b.entries.length - a.entries.length || a.city.localeCompare(b.city, "ko"))
      }))
      // Home country first, then by how many days were spent there.
      .sort((a, b) => (b.code === "kr") - (a.code === "kr") || b.count - a.count || a.name.localeCompare(b.name, "ko")),
    unplaced: unplaced.sort(byNewest)
  };
}
