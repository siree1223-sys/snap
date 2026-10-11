// Media type helpers. Pure functions (no DOM) shared by the app and tests.

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1", "mif2"]);
// AVIF also uses the HEIF container; browsers decode it natively, so it is
// deliberately not treated as HEIF here.
const VIDEO_EXTENSIONS = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", qt: "video/quicktime",
  webm: "video/webm", mkv: "video/x-matroska", "3gp": "video/3gpp", "3g2": "video/3gpp2", avi: "video/x-msvideo"
};
const EXTENSION_FOR_MIME = {
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv",
  "video/3gpp": "3gp", "video/3gpp2": "3g2", "video/x-msvideo": "avi"
};

/** Largest video the app accepts. Phones keep it in local storage until uploaded. */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return match ? match[1].toLowerCase() : "";
}

/**
 * HEIF/HEIC by content: an ISO-BMFF "ftyp" box whose major or compatible
 * brand is a HEIF image brand. File names and MIME types are unreliable on
 * Android (often empty), so the bytes decide.
 */
export function looksLikeHeif(bytes) {
  if (!bytes || bytes.length < 16) return false;
  const ascii = (i) => String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
  if (ascii(4) !== "ftyp") return false;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : 16);
  const brands = [ascii(8)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(i));
  // AVIF lists "mif1" too; it is excluded whichever order the brands come in.
  if (brands.includes("avif") || brands.includes("avis")) return false;
  return brands.some((brand) => HEIF_BRANDS.has(brand));
}

export function isHeifName(file) {
  return /^image\/hei[cf](-sequence)?$/i.test(file?.type || "") || ["heic", "heif", "hif"].includes(extensionOf(file?.name));
}

export function isVideoFile(file) {
  const type = String(file?.type || "");
  if (type.startsWith("video/")) return true;
  if (type && !type.startsWith("application/octet-stream")) return false;
  return Boolean(VIDEO_EXTENSIONS[extensionOf(file?.name)]);
}

export function videoMime(file) {
  const type = String(file?.type || "");
  if (type.startsWith("video/")) return type;
  return VIDEO_EXTENSIONS[extensionOf(file?.name)] || "video/mp4";
}

export function videoExtension(mime, name = "") {
  const fromName = extensionOf(name);
  if (VIDEO_EXTENSIONS[fromName]) return fromName;
  return EXTENSION_FOR_MIME[String(mime || "").split(";")[0]] || "mp4";
}

/** 75.4 -> "1:15", 3725 -> "1:02:05" */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
