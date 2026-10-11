// GPS position -> region ("서울 성동구 성수동", country 대한민국, city 서울), via
// OpenStreetMap's Nominatim service. Nominatim's policy: at most 1 request per second, cache
// results, show attribution. Positions are rounded (~100 m) before they are
// sent, and every answer is cached on this device.

const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";
export const ATTRIBUTION = "지역 이름 © OpenStreetMap contributors";
const SETTING_KEY = "snapdiary.geocode";

const L1 = /(특별시|광역시|특별자치시|특별자치도|도)$/;
const L1_SHORT = [[/특별자치도$/, ""], [/특별자치시$/, ""], [/특별시$/, ""], [/광역시$/, ""],
  [/^(충청|전라|경상)(남|북)도$/, (_, a, b) => a[0] + b], [/도$/, ""]];
const L2 = /(시|군|구)$/;
const L3 = /(동|읍|면|리|\d+가)$/;
const SKIP_KEYS = /^(road|house_number|postcode|country|country_code|ISO3166.*|amenity|building|shop|tourism|leisure|office|railway|highway|man_made|historic|club|craft|aeroway|emergency|natural|place)$/;

export function geocodeEnabled() {
  try { return localStorage.getItem(SETTING_KEY) !== "off"; } catch { return true; }
}
export function setGeocodeEnabled(on) {
  try { localStorage.setItem(SETTING_KEY, on ? "on" : "off"); } catch { /* ignore */ }
}

function shortProvince(name) {
  if (/^(경기도|강원도)$/.test(name)) return name.slice(0, 2);
  if (/^강원특별자치도$/.test(name)) return "강원";
  let out = name;
  for (const [re, to] of L1_SHORT) {
    if (re.test(out)) { out = out.replace(re, to); break; }
  }
  return out || name;
}

/** "성수동2가" -> "성수동", "성수2가3동" -> "성수동", "역삼1동" -> "역삼동", "종로2가" stays. */
export function neighbourhood(name) {
  let m = /^(\D+동)\d+가$/.exec(name);
  if (m) return m[1];
  m = /^(\D+?)\d+가\d+동$/.exec(name) || /^(\D+?)\d+동$/.exec(name);
  if (m) return `${m[1]}동`;
  return name;
}

const METROS = /^(서울|부산|대구|인천|광주|대전|울산|세종)/;

/** "🇰🇷" from "kr". */
export function flag(countryCode) {
  const code = String(countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "🌐";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * Structured region from a Nominatim `address` object:
 *   { label: "서울 성동구 성수동", country: "대한민국", countryCode: "kr",
 *     province: "서울", city: "서울" }
 * `city` is the 시 level used to group places: metropolitan cities (서울,
 * 부산, …) themselves, otherwise the 시/군 inside a 도 (순천, 광양, 서귀포).
 * Keys are not relied on (they vary by area); Korean administrative units are
 * recognised by their suffixes, from most specific to most general.
 */
export function regionInfo(address) {
  const empty = { label: "", country: "", countryCode: "", province: "", city: "" };
  if (!address || typeof address !== "object") return empty;
  const countryCode = String(address.country_code || "").toLowerCase();
  const values = Object.entries(address)
    .filter(([key, value]) => typeof value === "string" && value.trim() && !SKIP_KEYS.test(key))
    .map(([, value]) => value.trim());
  if (countryCode && countryCode !== "kr") {
    const state = address.state || address.province || address.region || "";
    let city = address.city || address.town || address.village || address.municipality || address.county || state || "";
    // Tokyo's 23 wards come back as the "city"; the metropolis is the city people mean.
    if (countryCode === "jp" && /^도쿄도?$/.test(state)) city = "도쿄";
    // Korean names of Japanese/Chinese/Taiwanese cities carry 시 ("교토시");
    // drop it as for Korean cities (순천시 -> 순천).
    else if (/^(jp|cn|tw)$/.test(countryCode) && /^.{2,}시$/.test(city)) city = city.slice(0, -1);
    const country = address.country || countryCode.toUpperCase();
    return { label: [city, country].filter(Boolean).join(" · "), country, countryCode, province: state, city };
  }
  let l1 = "";
  const l2 = [], l3 = [];
  for (const value of values) {
    if (L3.test(value)) l3.push(value);
    else if (L2.test(value) && !L1.test(value) && !l2.includes(value)) l2.unshift(value);
    else if (L1.test(value) || value === "서울" || value === "세종") l1 = l1 || value;
  }
  // Neighbourhood preference: 동 (city), then 읍/면 (town), then 가, then 리 (village).
  const pick = (re) => l3.find((v) => re.test(v));
  const hood = pick(/동$/) || pick(/(읍|면)$/) || pick(/\d+가$/) || pick(/리$/) || "";
  // Seoul and other metropolitan cities sometimes come back as a plain "city".
  if (!l1) {
    const city = address.city || address.state || address.province || "";
    if (METROS.test(city)) l1 = city;
  }
  // A metropolitan city may also appear as the "시" level; do not repeat it.
  const province = l1 ? shortProvince(l1) : "";
  const middle = l2.filter((name) => shortProvince(name) !== province && name !== l1);
  const label = [province, ...middle, hood ? neighbourhood(hood) : ""].filter(Boolean).join(" ");
  const metro = METROS.test(province) && (!l1 || !/도$/.test(l1));
  let city = metro ? province : "";
  if (!city) {
    const municipality = middle.find((name) => /(시|군)$/.test(name));
    city = municipality ? municipality.replace(/(시|군)$/, "") : province;
    // 경기 광주시 is not 광주광역시.
    if (municipality && METROS.test(city) && city.length <= 2 && province && province !== city) city = `${city}(${province})`;
  }
  if (!label && !city) return empty;
  return { label, country: address.country || "대한민국", countryCode: "kr", province, city };
}

/** Short Korean region label ("서울 성동구 성수동"); see regionInfo. */
export function regionLabel(address) {
  return regionInfo(address).label;
}

/** Rounded position used for requests and the cache (~110 m). */
export function cacheKey(lat, lng) {
  return `geo:${lat.toFixed(3)},${lng.toFixed(3)}`;
}

let lastRequest = 0;
let queue = Promise.resolve();

/** Runs one Nominatim request at a time, at most one per `minInterval` ms (their policy: 1/s). */
function polite(task, minInterval) {
  const job = queue.then(async () => {
    const wait = lastRequest + minInterval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    return task();
  });
  queue = job.catch(() => null);
  return job;
}

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * Structured region for a position (see regionInfo), or null when unknown,
 * disabled or offline. Answers are cached per ~100 m cell.
 * @param {{get(key), set(key, value)}} meta cache store (IndexedDB meta)
 */
export async function lookupRegion(lat, lng, meta, { fetchImpl = (...a) => fetch(...a), minInterval = 1100 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = cacheKey(lat, lng);
  const cached = await meta.get(key);
  // Cache entries from app 1.2 were plain labels; those are looked up again once.
  if (cached && typeof cached === "object") return cached.label || cached.city ? cached : null;
  if (!geocodeEnabled() || offline()) return null;
  return polite(async () => {
    const again = await meta.get(key);
    if (again && typeof again === "object") return again.label || again.city ? again : null;
    const params = new URLSearchParams({
      format: "jsonv2", lat: lat.toFixed(3), lon: lng.toFixed(3), zoom: "16", addressdetails: "1", "accept-language": "ko"
    });
    try {
      const response = await fetchImpl(`${ENDPOINT}?${params}`, { headers: { Accept: "application/json" } });
      if (!response.ok) return null;
      const data = await response.json();
      const info = regionInfo(data.address);
      if (!info.label) info.label = String(data.name || "");
      await meta.set(key, info);
      return info.label || info.city ? info : null;
    } catch {
      return null;
    }
  }, minInterval);
}

/** Region label for a position, or "" (kept for callers that only need the name). */
export async function regionName(lat, lng, meta, options) {
  return (await lookupRegion(lat, lng, meta, options))?.label || "";
}

/**
 * Finds places by name ("광양 배알도", "순천만") for entries typed by hand.
 * Runs only when asked (a button), never while typing, per Nominatim's policy.
 * @returns [{ name, detail, lat, lng, region }]
 */
export async function searchPlaces(query, { fetchImpl = (...a) => fetch(...a), minInterval = 1100 } = {}) {
  const q = String(query || "").trim();
  if (!q || !geocodeEnabled() || offline()) return [];
  return polite(async () => {
    const params = new URLSearchParams({ format: "jsonv2", q, addressdetails: "1", limit: "6", "accept-language": "ko" });
    try {
      const response = await fetchImpl(`${SEARCH_ENDPOINT}?${params}`, { headers: { Accept: "application/json" } });
      if (!response.ok) return [];
      const results = await response.json();
      return (Array.isArray(results) ? results : []).map((r) => {
        const region = regionInfo(r.address);
        const lat = Number(r.lat), lng = Number(r.lon);
        return {
          name: String(r.name || "").trim() || region.label,
          detail: String(r.display_name || ""),
          lat: Number.isFinite(lat) ? Math.round(lat * 1e5) / 1e5 : null,
          lng: Number.isFinite(lng) ? Math.round(lng * 1e5) / 1e5 : null,
          region
        };
      }).filter((r) => r.lat !== null && (r.region.city || r.region.country));
    } catch {
      return [];
    }
  }, minInterval);
}
