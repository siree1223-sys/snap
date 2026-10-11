// GPS position -> region name ("서울 성동구 성수동"), via OpenStreetMap's
// Nominatim service. Nominatim's policy: at most 1 request per second, cache
// results, show attribution. Positions are rounded (~100 m) before they are
// sent, and every answer is cached on this device.

const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
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

/**
 * Builds a short Korean region label from a Nominatim `address` object. Keys
 * are not relied on (they vary by area); Korean administrative units are
 * recognised by their suffixes, from most specific to most general.
 */
export function regionLabel(address) {
  if (!address || typeof address !== "object") return "";
  const country = String(address.country_code || "").toLowerCase();
  const values = Object.entries(address)
    .filter(([key, value]) => typeof value === "string" && value.trim() && !SKIP_KEYS.test(key))
    .map(([, value]) => value.trim());
  if (country && country !== "kr") {
    const city = address.city || address.town || address.village || address.municipality ||
      address.county || address.state || address.province || "";
    return [city, address.country].filter(Boolean).join(" · ");
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
    if (/^(서울|부산|대구|인천|광주|대전|울산|세종)/.test(city)) l1 = city;
  }
  // A metropolitan city may also appear as the "시" level; do not repeat it.
  const province = l1 ? shortProvince(l1) : "";
  const middle = l2.filter((name) => shortProvince(name) !== province && name !== l1);
  return [province, ...middle, hood ? neighbourhood(hood) : ""].filter(Boolean).join(" ");
}

/** Rounded position used for requests and the cache (~110 m). */
export function cacheKey(lat, lng) {
  return `geo:${lat.toFixed(3)},${lng.toFixed(3)}`;
}

let lastRequest = 0;
let queue = Promise.resolve();

/**
 * @param {{get(key), set(key, value)}} meta cache store (IndexedDB meta)
 * @returns {Promise<string>} region label, or "" when unknown / disabled / offline
 */
export function regionName(lat, lng, meta, { fetchImpl = (...a) => fetch(...a), minInterval = 1100 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Promise.resolve("");
  const key = cacheKey(lat, lng);
  const job = queue.then(async () => {
    const cached = await meta.get(key);
    if (typeof cached === "string") return cached;
    if (!geocodeEnabled() || (typeof navigator !== "undefined" && navigator.onLine === false)) return "";
    const wait = lastRequest + minInterval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const params = new URLSearchParams({
      format: "jsonv2", lat: lat.toFixed(3), lon: lng.toFixed(3), zoom: "16", addressdetails: "1", "accept-language": "ko"
    });
    try {
      const response = await fetchImpl(`${ENDPOINT}?${params}`, { headers: { Accept: "application/json" } });
      if (!response.ok) return "";
      const data = await response.json();
      const label = regionLabel(data.address) || String(data.name || "");
      await meta.set(key, label);
      return label;
    } catch {
      return "";
    }
  });
  queue = job.catch(() => "");
  return job;
}
