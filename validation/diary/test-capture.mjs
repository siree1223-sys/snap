// Capture time / GPS extraction against real files written by Pillow+piexif,
// pillow-heif (libheif) and ffmpeg (fixtures/make-fixtures.py). Expected values
// were read back with Pillow and ffmpeg, independently of this parser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readCaptureInfo, exifDateTime, parseMoov } from "../../snap-diary/js/exif.js";

const fixture = (name, type = "", lastModified = Date.UTC(2030, 0, 1, 12)) =>
  new File([readFileSync(new URL(`./fixtures/${name}`, import.meta.url))], name, { type, lastModified });
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

test("JPEG EXIF: DateTimeOriginal (not DateTime) and GPS", async () => {
  const info = await readCaptureInfo(fixture("seongsu.jpg", "image/jpeg"));
  assert.equal(info.takenAt, "2026-10-03T14:22:05", "original capture time, not the edit time");
  assert.equal(info.date, "2026-10-03");
  assert.equal(info.source, "exif");
  assert.ok(near(info.lat, 37.5446) && near(info.lng, 127.0561), `${info.lat},${info.lng}`);
  const jeju = await readCaptureInfo(fixture("jeju.jpg", "image/jpeg"));
  assert.equal(jeju.date, "2026-10-05");
  assert.ok(near(jeju.lat, 33.4589) && near(jeju.lng, 126.9425));
});

test("HEIC: the Exif item is found through iinf/iloc", async () => {
  const info = await readCaptureInfo(fixture("seongsu-evening.heic", ""));
  assert.equal(info.takenAt, "2026-10-03T18:40:00");
  assert.equal(info.source, "heif");
  assert.ok(near(info.lat, 37.547) && near(info.lng, 127.058));
});

test("Android MP4: mvhd UTC time shown in local time, ©xyz location", async () => {
  const info = await readCaptureInfo(fixture("haeundae.mp4", "video/mp4"), { timeZoneOffsetMinutes: 540 });
  assert.equal(info.takenAt, "2026-10-04T12:00:00", "03:00Z is noon in Korea");
  assert.equal(info.source, "video");
  assert.ok(near(info.lat, 35.1587) && near(info.lng, 129.1604));
  const utc = await readCaptureInfo(fixture("haeundae.mp4", "video/mp4"), { timeZoneOffsetMinutes: 0 });
  assert.equal(utc.takenAt, "2026-10-04T03:00:00");
});

test("iPhone MOV: Apple creationdate (local, with offset) wins over mvhd UTC", async () => {
  const info = await readCaptureInfo(fixture("gwangan.mov", ""), { timeZoneOffsetMinutes: -300 });
  assert.equal(info.takenAt, "2026-10-04T19:30:00", "the time on the phone where it was filmed");
  assert.ok(near(info.lat, 35.1532) && near(info.lng, 129.1186));
});

test("no metadata: falls back to the file date and says so", async () => {
  for (const name of ["noexif.jpg", "place.heic"]) {
    const info = await readCaptureInfo(fixture(name, ""));
    assert.equal(info.source, "file", name);
    assert.equal(info.lat, null);
    assert.match(info.date, /^2030-01-0[12]$/);
  }
});

test("damaged or bogus metadata never throws and is ignored", async () => {
  const jpeg = readFileSync(new URL("./fixtures/seongsu.jpg", import.meta.url));
  for (const cut of [4, 20, 60, 200]) {
    const info = await readCaptureInfo(new File([jpeg.subarray(0, cut)], "x.jpg", { lastModified: 0 }));
    assert.ok(info.source === null || info.source === "exif" || info.source === "file");
  }
  const garbage = new File([new Uint8Array(4096).fill(0xff)], "x.mp4", { type: "video/mp4", lastModified: 0 });
  await readCaptureInfo(garbage);
  assert.equal(exifDateTime("0000:00:00 00:00:00"), null);
  assert.equal(exifDateTime("2026:13:01 00:00:00"), null);
  assert.equal(exifDateTime("2026:10:03 07:05:09"), "2026-10-03T07:05:09");
  const moov = new TextEncoder().encode("\0\0\0\x10moovjunk +91.0000+000.0000/");
  assert.equal(parseMoov(moov).lat, null, "impossible latitude rejected");
});

// ---------- region names and day plans ----------
import { regionLabel, regionInfo, neighbourhood, regionName, lookupRegion, searchPlaces, cacheKey, flag } from "../../snap-diary/js/geocode.js";
import { planDays, distinctNames, googlePhotosDayUrl, distanceKm } from "../../snap-diary/js/organize.js";

test("Korean region labels do not depend on which address keys Nominatim uses", () => {
  const cases = [
    [{ road: "아차산로", quarter: "성수2가3동", suburb: "성수동2가", borough: "성동구", city: "서울",
      "ISO3166-2-lvl4": "KR-11", postcode: "04782", country: "대한민국", country_code: "kr" }, "서울 성동구 성수동"],
    [{ suburb: "성수동2가", city_district: "성동구", city: "서울특별시", country_code: "kr" }, "서울 성동구 성수동"],
    [{ road: "일출로", village: "성산리", town: "성산읍", city: "서귀포시", province: "제주특별자치도", country_code: "kr" },
      "제주 서귀포시 성산읍"],
    [{ suburb: "행궁동", city_district: "팔달구", city: "수원시", province: "경기도", country_code: "kr" },
      "경기 수원시 팔달구 행궁동"],
    [{ suburb: "우동", borough: "해운대구", city: "부산광역시", country_code: "kr" }, "부산 해운대구 우동"],
    [{ quarter: "역삼1동", borough: "강남구", city: "서울특별시", country_code: "kr" }, "서울 강남구 역삼동"],
    [{ suburb: "종로2가", borough: "종로구", city: "서울특별시", country_code: "kr" }, "서울 종로구 종로2가"],
    [{ village: "가남읍", county: "여주시", state: "경기도", country_code: "kr" }, "경기 여주시 가남읍"],
    [{ town: "보은읍", county: "보은군", province: "충청북도", country_code: "kr" }, "충북 보은군 보은읍"],
    [{ quarter: "도담동", city: "세종특별자치시", country_code: "kr" }, "세종 도담동"],
    [{ neighbourhood: "가부키초", city: "신주쿠구", province: "도쿄도", country: "일본", country_code: "jp" }, "도쿄 · 일본"],
    [{ city: "Paris", state: "Île-de-France", country: "프랑스", country_code: "fr" }, "Paris · 프랑스"]
  ];
  for (const [address, expected] of cases) assert.equal(regionLabel(address), expected, JSON.stringify(address));
  assert.equal(regionLabel(null), "");
  assert.equal(neighbourhood("성수동2가"), "성수동");
  assert.equal(neighbourhood("서교동"), "서교동");
});

test("region lookups are rounded, cached, throttled and fail soft", async () => {
  const meta = new Map();
  const store = { get: async (k) => meta.get(k), set: async (k, v) => meta.set(k, v) };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push({ url, at: Date.now() });
    return new Response(JSON.stringify({ address: { suburb: "우동", borough: "해운대구", city: "부산광역시", country_code: "kr" } }));
  };
  const a = await regionName(35.15871234, 129.16049876, store, { fetchImpl, minInterval: 150 });
  const b = await regionName(35.1589, 129.1603, store, { fetchImpl, minInterval: 150 }); // same ~100 m cell
  const c = await regionName(35.2001, 129.2001, store, { fetchImpl, minInterval: 150 });
  assert.equal(a, "부산 해운대구 우동");
  assert.equal(b, a);
  assert.equal(calls.length, 2, "second lookup served from the cache");
  assert.match(calls[0].url, /lat=35\.159&lon=129\.160/, "only a rounded position is sent");
  assert.match(calls[0].url, /accept-language=ko/);
  assert.ok(calls[1].at - calls[0].at >= 140, "requests are spaced out");
  assert.deepEqual(meta.get(cacheKey(35.15871234, 129.16049876)),
    { label: "부산 해운대구 우동", country: "대한민국", countryCode: "kr", province: "부산", city: "부산" });
  // A label cached by app 1.2 (a plain string) is looked up once more to get country and city.
  meta.set(cacheKey(37.5, 127.0), "서울 성동구");
  const before = calls.length;
  const upgraded = await lookupRegion(37.5, 127.0, store, { fetchImpl, minInterval: 0 });
  assert.equal(calls.length, before + 1);
  assert.equal(upgraded.city, "부산");
  const failing = async () => { throw new TypeError("offline"); };
  assert.equal(await regionName(1.234, 2.345, store, { fetchImpl: failing, minInterval: 0 }), "");
  assert.equal(c, "부산 해운대구 우동");
});

test("day plans group by capture date, rank places and find existing entries", () => {
  const item = (id, takenAt, lat = null, lng = null, source = "exif") =>
    ({ id, info: { takenAt, date: takenAt.slice(0, 10), lat, lng, source } });
  const items = [
    item("a", "2026-10-03T18:40:00", 37.547, 127.058),
    item("b", "2026-10-03T14:22:05", 37.5446, 127.0561),
    item("c", "2026-10-03T16:00:00", 37.2636, 127.0286),
    item("d", "2026-10-05T09:10:00", 33.4589, 126.9425),
    item("e", "2026-09-30T12:00:00", null, null, "file"),
    { id: "f", info: { takenAt: null, date: null } }
  ];
  const entries = [{ id: "old", date: "2026-10-05", createdAt: "2026-10-05T20:00:00Z", sync: {} },
    { id: "gone", date: "2026-10-03", createdAt: "2026-10-03T01:00:00Z", sync: { deleted: true } }];
  const days = planDays(items, entries);
  assert.deepEqual(days.map((d) => d.date), ["2026-10-05", "2026-10-03", "2026-09-30"], "newest first; undated skipped");
  const oct3 = days[1];
  assert.deepEqual(oct3.items.map((i) => i.id), ["b", "c", "a"], "in capture order");
  assert.equal(oct3.places.length, 2);
  assert.equal(oct3.places[0].count, 2, "Seongsu (2 photos, 300 m apart) is the day's main place");
  assert.deepEqual(oct3.places[0].items.sort(), ["a", "b"]);
  const seoulToBusan = distanceKm({ lat: 37.5665, lng: 126.978 }, { lat: 35.1796, lng: 129.0756 });
  assert.ok(seoulToBusan > 320 && seoulToBusan < 330, `Seoul–Busan ≈ 325 km (${seoulToBusan})`);
  assert.equal(oct3.entryId, null, "deleted entries are not merge targets");
  assert.equal(days[0].entryId, "old", "photos join the diary entry already written that day");
  assert.equal(days[2].guessed, true);
  assert.equal(oct3.guessed, false);
  assert.deepEqual(distinctNames(["서울 성동구 성수동", "", "경기 수원시 팔달구", "서울 성동구 성수동"]),
    ["서울 성동구 성수동", "경기 수원시 팔달구"]);
  assert.equal(googlePhotosDayUrl("2026-10-03"), "https://photos.google.com/search/2026%EB%85%84%2010%EC%9B%94%203%EC%9D%BC");
});

test("each place knows its country and city (시 level)", () => {
  const cases = [
    [{ suburb: "성수동2가", borough: "성동구", city: "서울", country_code: "kr" }, "대한민국", "서울"],
    [{ suburb: "우동", borough: "해운대구", city: "부산광역시", country_code: "kr" }, "대한민국", "부산"],
    [{ village: "성산리", town: "성산읍", city: "서귀포시", province: "제주특별자치도", country_code: "kr" }, "대한민국", "서귀포"],
    [{ suburb: "행궁동", city_district: "팔달구", city: "수원시", province: "경기도", country_code: "kr" }, "대한민국", "수원"],
    [{ suburb: "해룡면", city: "순천시", province: "전라남도", country: "대한민국", country_code: "kr" }, "대한민국", "순천"],
    [{ suburb: "태인동", city: "광양시", province: "전라남도", country_code: "kr" }, "대한민국", "광양"],
    [{ town: "보은읍", county: "보은군", province: "충청북도", country_code: "kr" }, "대한민국", "보은"],
    [{ quarter: "도담동", city: "세종특별자치시", country_code: "kr" }, "대한민국", "세종"],
    [{ suburb: "경안동", city: "광주시", province: "경기도", country_code: "kr" }, "대한민국", "광주(경기)"],
    [{ suburb: "충장동", borough: "동구", city: "광주광역시", country_code: "kr" }, "대한민국", "광주"],
    [{ neighbourhood: "가부키초", city: "신주쿠구", province: "도쿄도", country: "일본", country_code: "jp" }, "일본", "도쿄"],
    [{ city: "오사카시", province: "오사카부", country: "일본", country_code: "jp" }, "일본", "오사카"],
    [{ city: "상하이시", country: "중국", country_code: "cn" }, "중국", "상하이"],
    [{ city: "Paris", state: "Île-de-France", country: "프랑스", country_code: "fr" }, "프랑스", "Paris"],
    [{ town: "Hallstatt", state: "Oberösterreich", country: "오스트리아", country_code: "at" }, "오스트리아", "Hallstatt"]
  ];
  for (const [address, country, city] of cases) {
    const info = regionInfo(address);
    assert.deepEqual([info.country, info.city], [country, city], JSON.stringify(address));
  }
  assert.equal(regionInfo({ suburb: "해룡면", city: "순천시", province: "전라남도", country_code: "kr" }).province, "전남");
  assert.deepEqual(regionInfo(null), { label: "", country: "", countryCode: "", province: "", city: "" });
  assert.equal(flag("kr"), "🇰🇷");
  assert.equal(flag("JP"), "🇯🇵");
  assert.equal(flag(""), "🌐");
});

test("place search returns pickable places with their country and city", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify([
      { lat: "34.9218", lon: "127.7537", name: "배알도수변공원", display_name: "배알도수변공원, 태인동, 광양시, 전라남도, 대한민국",
        address: { leisure: "배알도수변공원", suburb: "태인동", city: "광양시", province: "전라남도", country: "대한민국", country_code: "kr" } },
      { lat: "x", lon: "y", name: "broken" }
    ]));
  };
  const results = await searchPlaces("광양 배알도", { fetchImpl, minInterval: 0 });
  assert.equal(results.length, 1, "unusable results dropped");
  assert.deepEqual({ name: results[0].name, lat: results[0].lat, lng: results[0].lng, city: results[0].region.city,
    country: results[0].region.country, label: results[0].region.label },
  { name: "배알도수변공원", lat: 34.9218, lng: 127.7537, city: "광양", country: "대한민국", label: "전남 광양시 태인동" });
  assert.match(urls[0], /\/search\?.*q=%EA%B4%91%EC%96%91/);
  assert.match(urls[0], /accept-language=ko/);
  assert.deepEqual(await searchPlaces("   ", { fetchImpl, minInterval: 0 }), []);
  assert.deepEqual(await searchPlaces("x", { fetchImpl: async () => { throw new TypeError("offline"); }, minInterval: 0 }), []);
});

// ---------- places by country and city ----------
import { groupPlaces, placeKey, needsRegion } from "../../snap-diary/js/organize.js";
import { createEntry as newEntry, createPhoto as newPhoto, serializeEntry, parseEntry, applyRegion, mergeEntries } from "../../snap-diary/js/model.js";

test("entries are grouped by country, then city; trips count under every city", () => {
  const seoul = { country: "대한민국", countryCode: "kr", province: "서울", city: "서울" };
  const suncheon = { country: "대한민국", countryCode: "kr", province: "전남", city: "순천" };
  const kyoto = { country: "일본", countryCode: "jp", province: "교토부", city: "교토시" };
  const e = (id, date, place, photoRegions = []) => ({
    id, date, place, photos: photoRegions.map((r, i) => ({ id: `${id}p${i}`, ...r }))
  });
  const entries = [
    e("a", "2026-10-09", { name: "순천만", ...suncheon }),
    e("b", "2026-10-03", { name: "성수동", ...seoul }, [seoul, suncheon]), // day trip: Seoul -> Suncheon
    e("c", "2026-09-20", { name: "기요미즈데라", ...kyoto }),
    e("d", "2026-10-10", { name: "광양 배알도", lat: null, lng: null }), // typed by hand
    e("e", "2026-10-11", null)
  ];
  const { countries, unplaced } = groupPlaces(entries);
  assert.deepEqual(countries.map((c) => [c.code, c.name, c.count]), [["kr", "대한민국", 2], ["jp", "일본", 1]],
    "home country first");
  assert.deepEqual(countries[0].cities.map((c) => [c.city, c.province, c.entries.map((x) => x.id)]),
    [["순천", "전남", ["a", "b"]], ["서울", "서울", ["b"]]], "cities by number of days, entries newest first");
  assert.equal(countries[0].cities[0].key, "kr|전남|순천");
  assert.equal(placeKey(suncheon), "kr|전남|순천");
  assert.deepEqual(unplaced.map((x) => x.id), ["e", "d"]);
  assert.equal(needsRegion(e("x", "2026-01-01", { name: "", lat: 37.5, lng: 127 })), true);
  assert.equal(needsRegion(e("y", "2026-01-01", { name: "", lat: 37.5, lng: 127, ...seoul })), false);
  assert.equal(needsRegion({ place: null, photos: [{ lat: 1, lng: 2 }] }), true);
});

test("country and city travel with the entry document to Drive and back", () => {
  const entry = newEntry({ date: "2026-10-09" });
  entry.place = applyRegion({ name: "순천만 습지", lat: 34.88, lng: 127.51 },
    { country: "대한민국", countryCode: "KR", province: "전남", city: "순천", label: "전남 순천시 해룡면" });
  const photo = newPhoto({ width: 1, height: 1 });
  applyRegion(photo, { country: "일본", countryCode: "jp", city: "교토시" });
  entry.photos.push(photo);
  const back = parseEntry(JSON.stringify(serializeEntry(entry)));
  assert.deepEqual(back.place, { name: "순천만 습지", lat: 34.88, lng: 127.51, country: "대한민국", countryCode: "kr", province: "전남", city: "순천" });
  assert.deepEqual([back.photos[0].country, back.photos[0].countryCode, back.photos[0].city], ["일본", "jp", "교토시"]);
  assert.equal("label" in back.place, false, "only the structured fields are stored");
  applyRegion(back.place, {});
  assert.deepEqual(back.place, { name: "순천만 습지", lat: 34.88, lng: 127.51 }, "clearing removes country/city");
  assert.deepEqual(parseEntry(JSON.stringify(serializeEntry({ ...entry, place: { city: "순천" } }))).place,
    { name: "", lat: null, lng: null, city: "순천" });
});

test("a conflict keeps the country/city one phone found for the same position", () => {
  const suncheon = { country: "대한민국", countryCode: "kr", province: "전남", city: "순천" };
  const base = newEntry({ date: "2026-10-09" });
  base.place = { name: "순천만 습지", lat: 34.88, lng: 127.51 };
  base.photos.push({ ...newPhoto({ width: 1, height: 1 }), lat: 34.88, lng: 127.51 });
  const filled = structuredClone(base); // phone A filled the city in
  applyRegion(filled.place, suncheon);
  applyRegion(filled.photos[0], suncheon);
  filled.photos[0].placeName = "전남 순천시 해룡면";
  filled.updatedAt = "2026-10-10T09:00:00.000Z";
  const edited = structuredClone(base); // phone B edited the text later
  edited.text = "갈대가 좋았다";
  edited.updatedAt = "2026-10-10T10:00:00.000Z";
  for (const merged of [mergeEntries(edited, filled), mergeEntries(filled, edited)]) {
    assert.equal(merged.text, "갈대가 좋았다");
    assert.deepEqual([merged.place.country, merged.place.city], ["대한민국", "순천"]);
    assert.deepEqual([merged.photos[0].city, merged.photos[0].placeName], ["순천", "전남 순천시 해룡면"]);
  }
  const moved = structuredClone(edited); // a different position keeps its own (empty) region
  moved.place = { name: "광양", lat: 34.92, lng: 127.75 };
  assert.equal(mergeEntries(moved, filled).place.city, undefined);
});
