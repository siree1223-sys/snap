// Google sign-in for Drive access, browser-only (no server, no client secret).
//
// Scope: drive.file — the app can only see files it created itself, never the
// rest of your Drive. Tokens last about an hour; no refresh token exists in a
// browser-only flow, so reconnecting later is a quick popup or redirect.
//
// Two transports to the same Google OAuth endpoint:
//  - popup: Google Identity Services token client (default)
//  - redirect: plain OAuth implicit redirect (used by iOS home-screen apps, and
//    as fallback when a popup is blocked)

import { CONFIG, clientId } from "./config.js";

const TOKEN_KEY = "snapdiary.token";
const ACCOUNT_KEY = "snapdiary.account";
const STATE_KEY = "snapdiary.oauthState";
const MODE_KEY = "snapdiary.authMode";
const GIS_URL = "https://accounts.google.com/gsi/client";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export class AuthError extends Error {
  constructor(message, code = "auth") {
    super(message);
    this.code = code;
  }
}

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: token lives for this page only */ }
}

let memoryToken = null;

export function cachedToken() {
  const token = memoryToken || load(TOKEN_KEY);
  if (token?.access_token && token.expires_at - 60_000 > Date.now()) return token.access_token;
  return null;
}

export function account() {
  return load(ACCOUNT_KEY);
}

export function authMode() {
  const stored = load(MODE_KEY);
  if (stored === "popup" || stored === "redirect") return stored;
  // Home-screen apps on iOS cannot reliably return a popup result.
  return navigator.standalone === true ? "redirect" : "popup";
}

export function setAuthMode(mode) {
  save(MODE_KEY, mode === "popup" || mode === "redirect" ? mode : null);
}

export function invalidateToken() {
  memoryToken = null;
  save(TOKEN_KEY, null);
}

function storeToken(accessToken, expiresIn) {
  memoryToken = { access_token: accessToken, expires_at: Date.now() + Number(expiresIn || 3600) * 1000 };
  save(TOKEN_KEY, memoryToken);
}

function hasDriveScope(granted) {
  return String(granted || "").split(/\s+/).includes(CONFIG.scope);
}

// ---------- popup (Google Identity Services) ----------

let gisPromise = null;
export function preloadGoogle() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisPromise = null;
        script.remove();
        reject(new AuthError("Google 로그인 스크립트를 불러오지 못했습니다. 인터넷 연결을 확인하세요.", "offline"));
      };
      document.head.append(script);
    });
  }
  return gisPromise;
}

function popupToken(hint) {
  return new Promise((resolve, reject) => {
    const client = globalThis.google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: CONFIG.scope,
      callback: (response) => {
        if (response.error) reject(new AuthError(response.error_description || response.error, response.error));
        else resolve(response);
      },
      error_callback: (error) => {
        const type = error?.type || "unknown";
        reject(new AuthError(type === "popup_closed" ? "로그인 창이 닫혔습니다." :
          "로그인 팝업을 열 수 없습니다.", type));
      }
    });
    client.requestAccessToken(hint ? { prompt: "", login_hint: hint } : { prompt: "consent" });
  });
}

// ---------- redirect (OAuth 2.0 implicit flow) ----------

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function redirectToGoogle(hint) {
  const state = randomState();
  save(STATE_KEY, { state, back: location.hash.startsWith("#/") ? location.hash : "#/", at: Date.now() });
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: CONFIG.scope,
    include_granted_scopes: "true",
    state
  });
  if (hint) params.set("login_hint", hint);
  else params.set("prompt", "consent");
  location.assign(`${AUTH_URL}?${params}`);
  return new Promise(() => {}); // the page is navigating away
}

/**
 * Call once at startup, before routing. Consumes an OAuth redirect response
 * in the URL fragment, if any. Returns null when there was none.
 */
export function consumeRedirect() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!/(^|&)(access_token|error)=/.test(hash)) return null;
  const params = new URLSearchParams(hash);
  const pending = load(STATE_KEY);
  save(STATE_KEY, null);
  const back = pending?.back || "#/";
  history.replaceState(null, "", `${location.pathname}${location.search}${back}`);
  if (!pending || params.get("state") !== pending.state || Date.now() - pending.at > 15 * 60_000) {
    return { ok: false, error: "로그인 응답을 확인할 수 없습니다. 다시 시도하세요." };
  }
  if (params.get("error")) {
    return { ok: false, error: params.get("error") === "access_denied" ? "권한 허용이 취소되었습니다." :
      `로그인 실패: ${params.get("error")}` };
  }
  if (!hasDriveScope(params.get("scope"))) {
    return { ok: false, error: "Google Drive 권한을 허용해야 동기화할 수 있습니다." };
  }
  storeToken(params.get("access_token"), params.get("expires_in"));
  return { ok: true };
}

// ---------- account check ----------

async function verifyAccount(token) {
  const response = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new AuthError(`계정 확인 실패 (${response.status})`, "verify");
  const { user } = await response.json();
  const email = String(user?.emailAddress || "").toLowerCase();
  const allowed = (CONFIG.allowedEmails || []).map((e) => String(e).toLowerCase().trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) {
    await revoke(token);
    invalidateToken();
    save(ACCOUNT_KEY, null);
    throw new AuthError(email ? `${email} 계정은 이 다이어리에 접근할 수 없습니다.`
      : "Google 계정 이메일을 확인할 수 없어 접근할 수 없습니다.", "forbidden");
  }
  const info = { email, name: user?.displayName || email };
  save(ACCOUNT_KEY, info);
  return info;
}

/** Verifies a token obtained through the redirect flow (call after consumeRedirect). */
export async function verifyCurrent() {
  const token = cachedToken();
  if (!token) throw new AuthError("로그인이 필요합니다.", "needs-login");
  return verifyAccount(token);
}

/**
 * Returns a valid access token. With interactive=false it never opens UI and
 * throws "needs-login" instead. Interactive calls must come from a tap.
 */
export async function getToken({ interactive = false } = {}) {
  const token = cachedToken();
  if (token) return token;
  if (!interactive) throw new AuthError("Google 계정 연결이 필요합니다.", "needs-login");
  if (!clientId()) throw new AuthError("설정에서 Google OAuth 클라이언트 ID를 먼저 입력하세요.", "no-client");
  const hint = account()?.email || "";
  if (authMode() === "redirect") return redirectToGoogle(hint);
  try {
    await preloadGoogle();
    const response = await popupToken(hint);
    if (!hasDriveScope(response.scope)) {
      throw new AuthError("Google Drive 권한을 허용해야 동기화할 수 있습니다.", "scope");
    }
    storeToken(response.access_token, response.expires_in);
    await verifyAccount(response.access_token);
    return response.access_token;
  } catch (error) {
    if (error.code === "popup_failed_to_open") return redirectToGoogle(hint);
    throw error;
  }
}

async function revoke(token) {
  try {
    if (globalThis.google?.accounts?.oauth2?.revoke) {
      await new Promise((resolve) => globalThis.google.accounts.oauth2.revoke(token, resolve));
    } else {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: "POST", mode: "no-cors"
      });
    }
  } catch { /* best effort */ }
}

export async function disconnect() {
  const token = cachedToken();
  if (token) await revoke(token);
  invalidateToken();
  save(ACCOUNT_KEY, null);
}
