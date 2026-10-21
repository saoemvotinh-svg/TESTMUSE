// Small shared helpers. No user data is ever interpolated into HTML strings:
// every dynamic label is set through textContent in the UI layer.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function uid(prefix = "id") {
  const rand = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtDateTime(ts) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "short",
    }).format(new Date(ts));
  } catch { return ""; }
}

// Deterministic hue from a title, used only for monogram placeholder art on
// items that have no real artwork. It is decoration, not metadata.
export function hueFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export function initials(title) {
  const words = String(title || "?").trim().split(/\s+/).slice(0, 2);
  return words.map(w => w.charAt(0).toUpperCase()).join("") || "?";
}

export function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
