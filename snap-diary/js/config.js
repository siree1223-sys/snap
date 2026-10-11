import { SITE_CONFIG } from "../config.js";

const CLIENT_ID_KEY = "snapdiary.clientId";

function readLocal(key) {
  try {
    return globalThis.localStorage?.getItem(key) || "";
  } catch {
    return "";
  }
}

export const CONFIG = {
  ...SITE_CONFIG,
  appVersion: "1.0.0",
  scope: "https://www.googleapis.com/auth/drive.file",
  // Pinned, not "latest": a model/runtime update must be a deliberate change.
  transformersUrl: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js",
  depthModel: "onnx-community/depth-anything-v2-small"
};

export function clientId() {
  return readLocal(CLIENT_ID_KEY).trim() || CONFIG.googleClientId.trim();
}

export function setClientIdOverride(value) {
  try {
    if (value && value.trim()) globalThis.localStorage.setItem(CLIENT_ID_KEY, value.trim());
    else globalThis.localStorage.removeItem(CLIENT_ID_KEY);
  } catch { /* private mode: the site config value still applies */ }
}

export function isValidClientId(value) {
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(String(value || "").trim());
}
