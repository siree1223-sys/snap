// Optional app PIN. It keeps a casual onlooker out of the open diary on this
// phone; it does NOT encrypt the on-device copy (your phone's own screen lock
// and Google account remain the real protection).

import { h, toast } from "./ui.js";

const PIN_KEY = "snapdiary.pin";
const FAIL_KEY = "snapdiary.pinFails";
const ITERATIONS = 150_000;
const AUTO_LOCK_MS = 60_000;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(pin, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

function stored() {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) || "null");
  } catch {
    return null;
  }
}

export function hasPin() {
  return Boolean(stored()?.hash);
}

export async function setPin(pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN은 숫자 4~8자리입니다.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  localStorage.setItem(PIN_KEY, JSON.stringify({
    salt: b64(salt), hash: b64(hash), iterations: ITERATIONS, length: pin.length
  }));
}

export function clearPin() {
  localStorage.removeItem(PIN_KEY);
  localStorage.removeItem(FAIL_KEY);
}

export async function verifyPin(pin) {
  const record = stored();
  if (!record) return true;
  const hash = new Uint8Array(await derive(pin, unb64(record.salt), record.iterations));
  const expected = unb64(record.hash);
  let diff = hash.length ^ expected.length;
  for (let i = 0; i < Math.min(hash.length, expected.length); i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}

function failures() {
  try {
    return JSON.parse(localStorage.getItem(FAIL_KEY) || '{"count":0,"until":0}');
  } catch {
    return { count: 0, until: 0 };
  }
}

/** PIN pad. mode "unlock" resolves when unlocked; "create" resolves the new PIN or null. */
export function pinPad({ mode = "unlock", onForgot } = {}) {
  return new Promise((resolve) => {
    let digits = "";
    let first = null;
    const title = h("h2", { text: mode === "unlock" ? "스냅 다이어리" : "새 PIN 입력" });
    const hint = h("p", { class: "muted", text: mode === "unlock" ? "PIN을 입력하세요" : "숫자 4~8자리" });
    const dots = h("div", { class: "pin-dots", "aria-live": "polite" });
    const paint = () => {
      dots.textContent = "";
      for (let i = 0; i < Math.max(4, digits.length); i++) dots.append(h("span", { class: i < digits.length ? "on" : "" }));
    };
    const finish = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    let busy = false;
    async function submit() {
      if (busy || digits.length < 4) return;
      busy = true;
      try {
        await attempt();
      } finally {
        busy = false;
      }
    }
    async function attempt() {
      if (mode === "create") {
        if (first === null) {
          first = digits;
          digits = "";
          title.textContent = "한 번 더 입력";
          paint();
          return;
        }
        if (first !== digits) {
          toast("PIN이 서로 다릅니다.", { error: true });
          first = null;
          digits = "";
          title.textContent = "새 PIN 입력";
          paint();
          return;
        }
        finish(digits);
        return;
      }
      const fails = failures();
      if (Date.now() < fails.until) {
        toast(`${Math.ceil((fails.until - Date.now()) / 1000)}초 후 다시 시도하세요.`, { error: true });
        digits = "";
        paint();
        return;
      }
      if (await verifyPin(digits)) {
        localStorage.removeItem(FAIL_KEY);
        finish(true);
        return;
      }
      fails.count++;
      if (fails.count % 5 === 0) fails.until = Date.now() + 30_000 * (fails.count / 5);
      localStorage.setItem(FAIL_KEY, JSON.stringify(fails));
      digits = "";
      paint();
      dots.classList.remove("shake");
      void dots.offsetWidth;
      dots.classList.add("shake");
      hint.textContent = fails.until > Date.now() ? "잠시 후 다시 시도하세요" : "PIN이 맞지 않습니다";
    }
    function press(key) {
      if (key === "del") digits = digits.slice(0, -1);
      else if (key === "ok") return submit();
      else if (busy) return;
      else if (digits.length < 8) digits += key;
      paint();
      // Submit automatically at the PIN's length. Every try goes through
      // submit(), so the failure counter and back-off always apply.
      if (mode === "unlock" && key !== "del" && digits.length === stored()?.length) submit();
    }
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("del");
      else if (e.key === "Enter") press("ok");
    };
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "ok"];
    const pad = h("div", { class: "pin-pad" }, keys.map((k) =>
      h("button", { class: `pin-key ${k.length > 1 ? "fn" : ""}`, type: "button",
        "aria-label": k === "del" ? "지우기" : k === "ok" ? "확인" : k,
        text: k === "del" ? "⌫" : k === "ok" ? "확인" : k, onclick: () => press(k) })));
    const overlay = h("div", { class: "lock-screen", role: "dialog", "aria-modal": "true" },
      h("div", { class: "lock-inner" },
        h("div", { class: "lock-logo", "aria-hidden": "true" }),
        title, hint, dots, pad,
        mode === "unlock" && onForgot
          ? h("button", { class: "btn link", text: "PIN을 잊었어요", onclick: () => onForgot(finish) })
          : h("button", { class: "btn link", text: "취소", onclick: () => finish(null) })));
    paint();
    document.body.append(overlay);
    document.addEventListener("keydown", onKey);
  });
}

/** Locks on start and after the app has been in the background for a minute. */
export function installAutoLock(lock) {
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hasPin() && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) lock();
  });
}
