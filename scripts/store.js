// Local persistence only. Nothing is uploaded anywhere.
//
// - Settings, favorites, playlists, history and URL-item descriptors live in
//   localStorage (small JSON data).
// - Imported media files live as Blobs in IndexedDB so they survive reloads.
//   The browser may evict that storage under disk pressure, and the user can
//   clear it from Settings. Both limits are surfaced in the UI, never hidden.

const LS = {
  settings: "musedeck.v1.settings",
  favorites: "musedeck.v1.favorites",
  playlists: "musedeck.v1.playlists",
  history: "musedeck.v1.history",
  urlItems: "musedeck.v1.urlItems",
};

export const DEFAULT_SETTINGS = {
  theme: "dark",           // dark | light
  volume: 0.8,
  muted: false,
  rate: 1,
  autoplayNext: true,
  repeat: "off",           // off | all | one
  shuffle: false,
  boost: 1,                // WebAudio gain for native local media (1 = off)
  skin: "default",         // progress bar style: default | teal | amber | mono
  ambient: true,           // ambient glow around the video stage
  eq: { bass: 0, mid: 0, treble: 0 },
  // Opt-in: enables WebAudio processing (visualizer + EQ) for native media.
  // Off by default because routing a cross-origin stream without CORS
  // through WebAudio can silence it; local files are unaffected.
  visualizer: false,
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback; // corrupted record: fall back instead of crashing
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota / private mode: caller decides how to surface it
  }
}

export const store = {
  loadSettings() {
    const saved = readJSON(LS.settings, {});
    return { ...DEFAULT_SETTINGS, ...saved, eq: { ...DEFAULT_SETTINGS.eq, ...(saved.eq || {}) } };
  },
  saveSettings(settings) { return writeJSON(LS.settings, settings); },

  loadFavorites() { return new Set(readJSON(LS.favorites, [])); },
  saveFavorites(set) { return writeJSON(LS.favorites, [...set]); },

  loadPlaylists() { return readJSON(LS.playlists, []); },
  savePlaylists(list) { return writeJSON(LS.playlists, list); },

  loadHistory() { return readJSON(LS.history, []); },
  saveHistory(list) { return writeJSON(LS.history, list.slice(0, 60)); },

  loadUrlItems() { return readJSON(LS.urlItems, []); },
  saveUrlItems(list) { return writeJSON(LS.urlItems, list); },

  async clearAll() {
    Object.values(LS).forEach(k => { try { localStorage.removeItem(k); } catch { /* noop */ } });
    await idbClear().catch(() => {});
  },

  async storageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try { return await navigator.storage.estimate(); } catch { return null; }
    }
    return null;
  },
};

// ---------------- IndexedDB: imported file blobs ---------------------------

const DB_NAME = "musedeck-db";
const DB_STORE = "files";

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB is not available in this browser.")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open local file storage."));
  });
}

function idbTx(mode, run) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const storeObj = tx.objectStore(DB_STORE);
    let result;
    try { result = run(storeObj); } catch (e) { reject(e); return; }
    if (result && "onsuccess" in result) {
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    }
    tx.oncomplete = () => { db.close(); if (!(result && "onsuccess" in result)) resolve(result); };
    tx.onerror = () => reject(tx.error);
  }));
}

export function idbPutFile(record) {
  // record: { id, blob, name, kind, size, addedAt }
  return idbTx("readwrite", s => s.put(record));
}

export function idbGetAllFiles() {
  return idbTx("readonly", s => s.getAll()).then(rows => rows || []).catch(() => []);
}

export function idbDeleteFile(id) {
  return idbTx("readwrite", s => s.delete(id));
}

export function idbClear() {
  return idbTx("readwrite", s => s.clear());
}
