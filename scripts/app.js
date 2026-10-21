// MuseDeck application layer: library, queue, playlists, views, import,
// settings. Playback itself is delegated to scripts/player.js; parsing to
// scripts/urlparse.js; persistence to scripts/store.js.
import { $, $$, uid, fmtTime, fmtBytes, fmtDateTime, hueFromString, initials, clamp, debounce } from "./util.js";
import { parseMediaUrl, isYouTubeResult } from "./urlparse.js";
import { store, idbPutFile, idbGetAllFiles, idbDeleteFile } from "./store.js";
import { Player } from "./player.js";
import { hydrateIcons, setIcon, icon } from "./icons.js";

const VIEWS = ["home", "music", "videos", "watch", "playlists", "favorites", "history", "queue", "url", "settings"];
const VIEW_TITLES = {
  home: "Home", music: "Music library", videos: "Video library", watch: "Now watching",
  playlists: "Playlists", favorites: "Favorites", history: "Recently played",
  queue: "Play queue", url: "Open from URL", settings: "Settings",
};
const AUDIO_EXTS = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"];
const VIDEO_EXTS = ["mp4", "m4v", "webm", "mov"];

const state = {
  view: "home",
  library: new Map(),       // id -> item
  queue: [],                // item ids
  queueIndex: -1,
  currentId: null,
  favorites: store.loadFavorites(),
  playlists: store.loadPlaylists(),
  history: store.loadHistory(),
  settings: store.loadSettings(),
  query: "",
  sort: "added",
  objectUrls: new Map(),    // item id -> blob URL for imported files
  stageClosed: false,
  sleepEndsAt: 0,
  sleepTimer: null,
  seeking: false,
  graph: null,              // WebAudio graph (opt-in, native local media)
  graphWarned: false,
  pendingPlaylistItem: null,
};

const els = {};
function grab() {
  ["app", "content", "view-title", "search-input", "sort-select", "music-list", "videos-list",
   "fav-list", "history-list", "queue-list", "queue-panel-list", "playlist-list", "home-sections",
   "music-count", "videos-count", "fav-count", "queue-count", "np-title", "np-sub", "np-art",
   "btn-play", "btn-fav", "seek", "time-cur", "time-dur", "volume", "btn-mute", "rate-select",
   "player-error", "audio-el", "video-el", "yt-mount", "stage", "stage-media", "stage-title",
   "stage-note", "file-input", "subtitle-input", "drop-overlay", "toast-region", "queue-panel",
   "url-form", "url-input", "url-error", "url-result", "viz", "sleep-left",
  ].forEach(id => { els[id] = document.getElementById(id); });
}
const player = () => state.player;

/* ------------------------------ items ----------------------------------- */
// item: { id, title, kind: 'audio'|'video', source: 'repo'|'file'|'youtube'|'direct',
//         src?, blob?, ytId?, playlistId?, artwork?, size?, duration?, addedAt,
//         persisted?: bool, unavailable?: bool }

function itemMeta(item) {
  const bits = [];
  bits.push(item.kind === "video" ? "Video" : "Audio");
  bits.push({ repo: "In this repository", file: "Imported file", youtube: "YouTube", direct: "Direct URL" }[item.source] || item.source);
  if (item.size) bits.push(fmtBytes(item.size));
  if (item.duration) bits.push(fmtTime(item.duration));
  if (item.source === "file" && item.persisted === false) bits.push("This session only — not saved");
  return bits;
}

function sortedFiltered(items) {
  let list = [...items];
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter(i => i.title.toLowerCase().includes(q) || i.source.includes(q));
  switch (state.sort) {
    case "title": list.sort((a, b) => a.title.localeCompare(b.title)); break;
    case "kind": list.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title)); break;
    case "size": list.sort((a, b) => (b.size || 0) - (a.size || 0)); break;
    default: list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }
  return list;
}

function libraryByKind(kind) {
  return sortedFiltered([...state.library.values()].filter(i => i.kind === kind));
}
function allLibrary() { return sortedFiltered([...state.library.values()]); }

/* ------------------------------ toasts ---------------------------------- */
function toast(msg, isError = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " error" : "");
  t.textContent = msg;
  els["toast-region"].appendChild(t);
  setTimeout(() => { t.remove(); }, 5200);
}

/* --------------------------- library loading ----------------------------- */
async function loadManifest() {
  try {
    const res = await fetch("assets/media-manifest.json", { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    for (const entry of (data.items || [])) {
      if (!entry || !entry.src || !entry.title) continue;
      const kind = entry.kind === "video" ? "video" : "audio";
      const id = `repo-${entry.src}`;
      if (!state.library.has(id)) {
        state.library.set(id, {
          id, title: String(entry.title), kind, source: "repo",
          src: entry.src, artwork: entry.artwork || null,
          artist: entry.artist ? String(entry.artist) : null,
          addedAt: 0, persisted: true,
        });
      }
    }
  } catch { /* manifest is optional; the empty state explains how to add media */ }
}

async function loadImportedFiles() {
  const rows = await idbGetAllFiles();
  for (const row of rows) {
    if (!row || !row.id || !row.blob) continue;
    state.library.set(row.id, {
      id: row.id, title: row.name, kind: row.kind, source: "file",
      blob: row.blob, size: row.size, addedAt: row.addedAt || 0, persisted: true,
    });
  }
}

function loadUrlItems() {
  for (const item of store.loadUrlItems()) {
    if (item && item.id && !state.library.has(item.id)) state.library.set(item.id, item);
  }
}

function persistUrlItems() {
  const items = [...state.library.values()].filter(i => i.source === "youtube" || i.source === "direct");
  store.saveUrlItems(items.map(({ blob, ...rest }) => rest));
}

/* ------------------------------ rendering -------------------------------- */
function artNode(item, sizeClass = "") {
  const wrap = document.createElement("div");
  wrap.className = "thumb " + sizeClass;
  wrap.setAttribute("aria-hidden", "true");
  if (item.artwork) {
    const img = document.createElement("img");
    img.src = item.artwork;
    img.alt = "";
    img.loading = "lazy";
    img.width = 46; img.height = 46;
    img.onerror = () => { img.remove(); wrap.textContent = initials(item.title); };
    wrap.appendChild(img);
  } else {
    wrap.style.background = `hsl(${hueFromString(item.title)} 32% 30%)`;
    wrap.style.color = "#fff";
    wrap.textContent = initials(item.title);
  }
  const bars = document.createElement("span");
  bars.className = "eq-bars";
  bars.innerHTML = "<i></i><i></i><i></i>";
  wrap.appendChild(bars);
  return wrap;
}

function iconBtn(name, label, onClick, opts = {}) {
  const b = document.createElement("button");
  b.className = "icon-btn small" + (opts.extraClass ? " " + opts.extraClass : "");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = icon(name, opts.filled);
  if (opts.pressed != null) b.setAttribute("aria-pressed", String(opts.pressed));
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

function makeRow(item, opts = {}) {
  const row = document.createElement("div");
  row.className = "row" + (item.id === state.currentId ? " playing" : "");
  row.dataset.itemId = item.id;

  const art = artNode(item);

  const main = document.createElement("button");
  main.className = "row-main";
  main.type = "button";
  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = item.title;
  const meta = document.createElement("div");
  meta.className = "row-meta";
  const badge = document.createElement("span");
  badge.className = "badge" + (item.kind === "video" ? " video" : "");
  badge.textContent = item.kind;
  meta.appendChild(badge);
  itemMeta(item).slice(1).forEach(bit => {
    const s = document.createElement("span"); s.textContent = bit; meta.appendChild(s);
  });
  if (opts.extraMeta) { const s = document.createElement("span"); s.textContent = opts.extraMeta; meta.appendChild(s); }
  main.append(title, meta);
  main.addEventListener("click", () => opts.onPlay ? opts.onPlay(item) : playItem(item.id));

  const actions = document.createElement("div");
  actions.className = "row-actions";
  const isFav = state.favorites.has(item.id);
  actions.appendChild(iconBtn("heart", isFav ? `Remove “${item.title}” from favorites` : `Add “${item.title}” to favorites`,
    () => toggleFavorite(item.id), { filled: isFav, pressed: isFav }));
  actions.appendChild(iconBtn("plus", `Add “${item.title}” to queue`, () => { addToQueue(item.id); toast(`Added to queue: ${item.title}`); }));
  actions.appendChild(iconBtn("list", `Add “${item.title}” to a playlist`, () => openAddToPlaylist(item.id)));
  if (opts.queueControls) {
    actions.appendChild(iconBtn("up", "Move up in queue", () => moveQueueItem(opts.queueIndex, -1)));
    actions.appendChild(iconBtn("down", "Move down in queue", () => moveQueueItem(opts.queueIndex, 1)));
    actions.appendChild(iconBtn("x", "Remove from queue", () => removeFromQueue(opts.queueIndex)));
  }
  if (item.source === "file" || item.source === "youtube" || item.source === "direct") {
    if (!opts.inPlaylist) {
      actions.appendChild(iconBtn("trash", `Remove “${item.title}” from the library`, () => removeLibraryItem(item.id)));
    }
  }
  if (opts.inPlaylist) {
    actions.appendChild(iconBtn("x", `Remove “${item.title}” from this playlist`, () => removeFromPlaylist(opts.inPlaylist, item.id)));
  }

  const side = document.createElement("div");
  side.className = "row-side mono";
  side.textContent = item.duration ? fmtTime(item.duration) : (opts.sideText || "");

  row.append(art, main, actions, side);
  if (opts.draggable) {
    row.draggable = true;
    row.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", String(opts.queueIndex)); e.dataTransfer.effectAllowed = "move"; });
    row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("drag-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", e => {
      e.preventDefault(); row.classList.remove("drag-over");
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (Number.isFinite(from)) reorderQueue(from, opts.queueIndex);
    });
  }
  return row;
}

function emptyState(title, body, actions = []) {
  const box = document.createElement("div");
  box.className = "empty";
  const h = document.createElement("h3"); h.textContent = title;
  const p = document.createElement("p"); p.textContent = body;
  box.append(h, p);
  if (actions.length) {
    const row = document.createElement("div"); row.className = "row-actions";
    actions.forEach(a => {
      const b = document.createElement("button");
      b.className = "btn" + (a.primary ? " btn-accent" : "");
      b.type = "button"; b.textContent = a.label;
      b.addEventListener("click", a.onClick);
      row.appendChild(b);
    });
    box.appendChild(row);
  }
  return box;
}

function renderList(container, items, opts = {}) {
  container.replaceChildren();
  if (!items.length) {
    container.appendChild(emptyState(opts.emptyTitle || "Nothing here yet", opts.emptyBody || "", opts.emptyActions || []));
    return;
  }
  const frag = document.createDocumentFragment();
  items.forEach((item, idx) => frag.appendChild(makeRow(item, { ...opts, queueIndex: idx })));
  container.appendChild(frag);
}

function counts() {
  const items = [...state.library.values()];
  return {
    total: items.length,
    audio: items.filter(i => i.kind === "audio").length,
    video: items.filter(i => i.kind === "video").length,
    favs: state.favorites.size,
    playlists: state.playlists.length,
  };
}

function renderHome() {
  const host = els["home-sections"];
  host.replaceChildren();
  const c = counts();

  if (c.total === 0) {
    host.appendChild(emptyState(
      "Your library is empty",
      "MuseDeck ships without bundled songs or videos, so nothing here is faked. Import audio or video files from this device, paste a YouTube or direct media link, or add files to the repository manifest.",
      [
        { label: "Import media files", primary: true, onClick: () => els["file-input"].click() },
        { label: "Open from URL", onClick: () => setView("url") },
      ]));
  }

  const grid = document.createElement("div");
  grid.className = "home-grid";
  [["Media items", c.total], ["Audio", c.audio], ["Videos", c.video], ["Favorites", c.favs], ["Playlists", c.playlists]]
    .forEach(([lbl, num]) => {
      const tile = document.createElement("div"); tile.className = "stat-tile";
      const n = document.createElement("div"); n.className = "num"; n.textContent = num;
      const l = document.createElement("div"); l.className = "lbl"; l.textContent = lbl;
      tile.append(n, l); grid.appendChild(tile);
    });
  host.appendChild(grid);

  const addSection = (title, items, viewName, opts = {}) => {
    if (!items.length) return;
    const sec = document.createElement("div"); sec.className = "home-section";
    const head = document.createElement("div"); head.className = "section-head";
    const h = document.createElement("h2"); h.textContent = title;
    const more = document.createElement("button"); more.className = "btn btn-ghost btn-small"; more.type = "button";
    more.textContent = "View all";
    more.addEventListener("click", () => setView(viewName));
    head.append(h, more);
    const list = document.createElement("div"); list.className = "track-list";
    items.slice(0, 5).forEach(item => list.appendChild(makeRow(item, opts)));
    sec.append(head, list); host.appendChild(sec);
  };

  const recentItems = state.history.map(h => state.library.get(h.itemId)).filter(Boolean);
  addSection("Recently played", [...new Map(recentItems.map(i => [i.id, i])).values()], "history");
  addSection("Favorites", [...state.favorites].map(id => state.library.get(id)).filter(Boolean), "favorites");
  addSection("Latest additions", allLibrary(), "music");
}

function renderPlaylists() {
  const host = els["playlist-list"];
  host.replaceChildren();
  $("#nav-playlist-count").hidden = !state.playlists.length;
  $("#nav-playlist-count").textContent = state.playlists.length || "";
  if (!state.playlists.length) {
    host.appendChild(emptyState("No playlists yet", "Create a playlist, then add items from any list with the playlist button.", [
      { label: "New playlist", primary: true, onClick: () => openPlaylistDialog() },
    ]));
    return;
  }
  for (const pl of state.playlists) {
    const block = document.createElement("div"); block.className = "playlist-block";
    const head = document.createElement("div"); head.className = "playlist-head";
    const h = document.createElement("h3"); h.textContent = pl.name;
    const count = document.createElement("span"); count.className = "count";
    count.textContent = `${pl.itemIds.length} item${pl.itemIds.length === 1 ? "" : "s"}`;
    const tools = document.createElement("div"); tools.className = "view-tools";
    const playBtn = document.createElement("button"); playBtn.className = "btn btn-small"; playBtn.type = "button"; playBtn.textContent = "Play";
    playBtn.disabled = !pl.itemIds.length;
    playBtn.addEventListener("click", () => {
      const ids = pl.itemIds.filter(id => state.library.has(id));
      if (ids.length) { setQueue(ids, 0); playItem(ids[0]); }
    });
    const renameBtn = document.createElement("button"); renameBtn.className = "btn btn-small"; renameBtn.type = "button"; renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => openPlaylistDialog(pl));
    const delBtn = document.createElement("button"); delBtn.className = "btn btn-small btn-danger-ghost"; delBtn.type = "button"; delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (await confirmDialog(`Delete playlist “${pl.name}”?`, "The playlist is removed from this browser. Its items stay in your library.")) {
        state.playlists = state.playlists.filter(p => p.id !== pl.id);
        store.savePlaylists(state.playlists); renderAll(); toast("Playlist deleted.");
      }
    });
    tools.append(playBtn, renameBtn, delBtn);
    head.append(h, count, tools);
    const itemsHost = document.createElement("div"); itemsHost.className = "playlist-items track-list";
    const items = pl.itemIds.map(id => state.library.get(id)).filter(Boolean);
    if (!items.length) {
      const p = document.createElement("p"); p.className = "view-sub"; p.style.padding = "8px";
      p.textContent = "Empty. Add items with the playlist button on any track.";
      itemsHost.appendChild(p);
    } else {
      items.forEach(item => itemsHost.appendChild(makeRow(item, { inPlaylist: pl.id })));
    }
    block.append(head, itemsHost);
    host.appendChild(block);
  }
}

function renderAll() {
  renderHome();
  const audio = libraryByKind("audio");
  const video = libraryByKind("video");
  els["music-count"].textContent = audio.length ? `${audio.length} audio item${audio.length === 1 ? "" : "s"}` : "";
  els["videos-count"].textContent = video.length ? `${video.length} video item${video.length === 1 ? "" : "s"}` : "";
  renderList(els["music-list"], audio, {
    emptyTitle: "No audio yet", emptyBody: "Import MP3, WAV, OGG, FLAC and other browser-supported audio, or paste a direct audio URL.",
    emptyActions: [{ label: "Import audio", primary: true, onClick: () => els["file-input"].click() }, { label: "Open from URL", onClick: () => setView("url") }],
  });
  renderList(els["videos-list"], video, {
    emptyTitle: "No videos yet", emptyBody: "Import MP4 or WebM files, or paste a YouTube or direct video link.",
    emptyActions: [{ label: "Import video", primary: true, onClick: () => els["file-input"].click() }, { label: "Open from URL", onClick: () => setView("url") }],
  });
  const favItems = sortedFiltered([...state.favorites].map(id => state.library.get(id)).filter(Boolean));
  els["fav-count"].textContent = favItems.length ? `${favItems.length} favorite${favItems.length === 1 ? "" : "s"}` : "";
  renderList(els["fav-list"], favItems, { emptyTitle: "No favorites yet", emptyBody: "Use the heart button on any item to keep it here." });
  renderHistory();
  renderQueueViews();
  renderPlaylists();
  renderNowPlaying();
  $("#nav-fav-count").hidden = !state.favorites.size;
  $("#nav-fav-count").textContent = state.favorites.size || "";
  $("#nav-queue-count").hidden = !state.queue.length;
  $("#nav-queue-count").textContent = state.queue.length || "";
}

function renderHistory() {
  const host = els["history-list"];
  host.replaceChildren();
  if (!state.history.length) {
    host.appendChild(emptyState("Nothing played yet", "Items you play in this browser will show up here."));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const h of state.history) {
    const item = state.library.get(h.itemId);
    if (item) frag.appendChild(makeRow(item, { extraMeta: fmtDateTime(h.at) }));
    else {
      const row = document.createElement("div"); row.className = "row";
      const main = document.createElement("div");
      const t = document.createElement("div"); t.className = "row-title"; t.textContent = h.title || "Removed item";
      const m = document.createElement("div"); m.className = "row-meta"; m.textContent = `No longer in the library · ${fmtDateTime(h.at)}`;
      main.append(t, m); row.append(artNode({ title: h.title || "?", artwork: null }), main);
      frag.appendChild(row);
    }
  }
  host.appendChild(frag);
}

function renderQueueViews() {
  const items = state.queue.map(id => state.library.get(id)).filter(Boolean);
  els["queue-count"].textContent = items.length ? `${items.length} item${items.length === 1 ? "" : "s"} in the queue` : "";
  renderList(els["queue-list"], items, {
    queueControls: true, draggable: true,
    emptyTitle: "The queue is empty", emptyBody: "Play something, or add items with the + button on any track.",
  });
  renderList(els["queue-panel-list"], items, {
    queueControls: true,
    emptyTitle: "Queue is empty", emptyBody: "Add items from the library.",
  });
}

/* ------------------------------ queue ------------------------------------ */
function setQueue(ids, startIndex = 0) {
  state.queue = ids.filter(id => state.library.has(id));
  state.queueIndex = clamp(startIndex, 0, Math.max(0, state.queue.length - 1));
  renderQueueViews();
}
function addToQueue(id, { playNext = false } = {}) {
  if (playNext && state.queueIndex >= 0) state.queue.splice(state.queueIndex + 1, 0, id);
  else state.queue.push(id);
  renderQueueViews();
}
function removeFromQueue(index) {
  const [removed] = state.queue.splice(index, 1);
  if (index < state.queueIndex) state.queueIndex--;
  else if (index === state.queueIndex && removed === state.currentId) state.queueIndex = Math.min(index, state.queue.length - 1);
  renderQueueViews();
}
function moveQueueItem(index, dir) {
  const to = index + dir;
  if (to < 0 || to >= state.queue.length) return;
  reorderQueue(index, to);
}
function reorderQueue(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length) return;
  const currentId = state.queue[state.queueIndex];
  const [moved] = state.queue.splice(from, 1);
  state.queue.splice(to, 0, moved);
  state.queueIndex = state.queue.indexOf(currentId);
  renderQueueViews();
}
function nextIndex({ auto = false } = {}) {
  if (!state.queue.length) return -1;
  if (state.settings.repeat === "one" && auto) return state.queueIndex;
  if (state.settings.shuffle && state.queue.length > 1) {
    let n = state.queueIndex;
    while (n === state.queueIndex) n = Math.floor(Math.random() * state.queue.length);
    return n;
  }
  const n = state.queueIndex + 1;
  if (n >= state.queue.length) return state.settings.repeat === "all" || !auto ? 0 : -1;
  return n;
}
function prevIndex() {
  if (!state.queue.length) return -1;
  // Convention from desktop players: past 3s goes to the start of the track.
  if (player() && player().currentTime > 3) return state.queueIndex;
  const n = state.queueIndex - 1;
  return n < 0 ? (state.settings.repeat === "all" ? state.queue.length - 1 : 0) : n;
}
function playNext(auto = false) {
  const n = nextIndex({ auto });
  if (n < 0) { toast("End of queue."); return; }
  state.queueIndex = n;
  const id = state.queue[n];
  if (id) playItem(id, { fromQueue: true });
}
function playPrev() {
  const n = prevIndex();
  if (n < 0) return;
  if (n === state.queueIndex && player() && player().currentTime > 3) { player().seekTo(0); return; }
  state.queueIndex = n;
  const id = state.queue[n];
  if (id) playItem(id, { fromQueue: true });
}

/* ---------------------------- playback ----------------------------------- */
function resolveSrc(item) {
  if (item.source === "file") {
    if (!state.objectUrls.has(item.id) && item.blob) {
      state.objectUrls.set(item.id, URL.createObjectURL(item.blob));
    }
    return state.objectUrls.get(item.id);
  }
  return item.src;
}

async function playItem(id, { fromQueue = false } = {}) {
  const item = state.library.get(id);
  if (!item) { toast("That item is no longer available.", true); return; }
  hidePlayerError();
  if (!fromQueue) {
    // Build a queue from the item's visible list when it is not queued yet.
    if (!state.queue.includes(id)) setQueue([id], 0);
    else state.queueIndex = state.queue.indexOf(id);
  }
  state.currentId = id;
  state.stageClosed = false;
  const playable = { ...item, src: resolveSrc(item) };
  if (item.source === "file" && !playable.src) {
    showPlayerError("This imported file could not be read back from local storage. It may have been evicted by the browser — import it again.");
    return;
  }
  try {
    await player().load(playable, { autoplay: true });
  } catch (err) {
    showPlayerError(err.message || "Playback could not start.");
  }
  recordHistory(item);
  if (item.kind === "video" || item.source === "youtube") setView("watch");
  placeStage();
  renderAll();
  updateMediaSession(item);
}

function recordHistory(item) {
  state.history = state.history.filter(h => h.itemId !== item.id);
  state.history.unshift({ itemId: item.id, title: item.title, at: Date.now() });
  store.saveHistory(state.history);
}

function showPlayerError(msg) {
  els["player-error"].textContent = msg;
  els["player-error"].hidden = false;
  toast(msg, true);
}
function hidePlayerError() { els["player-error"].hidden = true; els["player-error"].textContent = ""; }

function currentItem() { return state.currentId ? state.library.get(state.currentId) : null; }

function renderNowPlaying() {
  const item = currentItem();
  const art = els["np-art"];
  art.replaceChildren();
  if (item) {
    els["np-title"].textContent = item.title;
    els["np-sub"].textContent = itemMeta(item).join(" · ");
    if (item.artwork) {
      const img = document.createElement("img"); img.src = item.artwork; img.alt = ""; img.width = 50; img.height = 50;
      img.onerror = () => { art.textContent = initials(item.title); };
      art.appendChild(img);
    } else {
      art.style.background = `hsl(${hueFromString(item.title)} 32% 30%)`;
      art.style.color = "#fff";
      art.textContent = initials(item.title);
    }
    els["btn-fav"].disabled = false;
    const fav = state.favorites.has(item.id);
    els["btn-fav"].setAttribute("aria-pressed", String(fav));
    els["btn-fav"].setAttribute("aria-label", fav ? "Remove current item from favorites" : "Add current item to favorites");
    setIcon(els["btn-fav"], "heart", fav);
    els["stage-title"].textContent = item.title;
  } else {
    els["np-title"].textContent = "Nothing playing";
    els["np-sub"].textContent = "Import a file or paste a link to start";
    art.style.background = ""; art.style.color = "";
    art.textContent = "";
    els["btn-fav"].disabled = true;
  }
  // Highlight the playing row without a full re-render.
  $$(".row").forEach(r => r.classList.toggle("playing", r.dataset.itemId === state.currentId));
}

/* ------------------------------- stage ----------------------------------- */
function stageSlotForView(view) {
  return { home: $("#home-stage-slot"), videos: $("#videos-stage-slot"), watch: $("#watch-stage-slot") }[view] || null;
}
function placeStage() {
  const item = currentItem();
  const stage = els.stage;
  const isVideo = item && (item.kind === "video" || item.source === "youtube");
  if (!isVideo || state.stageClosed) { stage.hidden = true; return; }
  const slot = stageSlotForView(state.view) || $("#watch-stage-slot");
  if (slot && stage.parentElement !== slot) slot.appendChild(stage);
  stage.hidden = false;
  const native = item.source !== "youtube";
  // Only the active layer may receive pointer events: the empty YouTube
  // mount must not sit over the native <video>, and vice versa.
  els["yt-mount"].style.pointerEvents = native ? "none" : "auto";
  els["video-el"].style.pointerEvents = native ? "auto" : "none";
  els["stage-note"].textContent = native
    ? "Native playback. Subtitle file, picture-in-picture and theater mode apply."
    : "YouTube's embedded player. Equalizer, visualizer, subtitles and PiP do not apply to YouTube.";
  $("#btn-subtitle").style.display = native && item.kind === "video" ? "" : "none";
  $("#btn-pip").disabled = !native;
  $("#btn-pip").title = native ? "" : "Picture-in-picture is not available for YouTube embeds in this player.";
  updateStagePausedClass();
}
function updateStagePausedClass() {
  const p = player();
  els["stage-media"].classList.toggle("paused", !p || p.paused);
  setIcon($("#stage-bigplay"), p && !p.paused ? "pause" : "play");
}

/* --------------------------- favorites/playlists -------------------------- */
function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
  store.saveFavorites(state.favorites);
  renderAll();
}
function removeFromPlaylist(playlistId, itemId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  pl.itemIds = pl.itemIds.filter(x => x !== itemId);
  store.savePlaylists(state.playlists);
  renderAll();
}
async function removeLibraryItem(id) {
  const item = state.library.get(id);
  if (!item) return;
  const ok = await confirmDialog(`Remove “${item.title}” from the library?`,
    item.source === "file"
      ? "The stored copy in this browser will be deleted. Your original file on the device is untouched."
      : "The link will be removed from this browser's library.");
  if (!ok) return;
  if (item.source === "file") { await idbDeleteFile(id).catch(() => {}); }
  if (state.objectUrls.has(id)) { URL.revokeObjectURL(state.objectUrls.get(id)); state.objectUrls.delete(id); }
  if (state.currentId === id) { player().stop(); state.currentId = null; }
  state.library.delete(id);
  state.queue = state.queue.filter(q => q !== id);
  state.playlists.forEach(pl => { pl.itemIds = pl.itemIds.filter(x => x !== id); });
  store.savePlaylists(state.playlists);
  persistUrlItems();
  renderAll();
  toast("Removed from the library.");
}

/* ------------------------------- dialogs --------------------------------- */
function dialogPromise(dialog, setup) {
  return new Promise(resolve => {
    const onClose = () => { dialog.removeEventListener("close", onClose); resolve(dialog.returnValue); };
    dialog.addEventListener("close", onClose);
    if (setup) setup();
    dialog.returnValue = "cancel";
    dialog.showModal();
  });
}
async function confirmDialog(title, body) {
  const d = $("#dialog-confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  const result = await dialogPromise(d);
  return result === "yes";
}
async function openPlaylistDialog(existing = null, initialName = "") {
  const d = $("#dialog-playlist");
  $("#dialog-playlist-title").textContent = existing ? "Rename playlist" : "New playlist";
  const input = $("#playlist-name");
  input.value = existing ? existing.name : initialName;
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); d.close("save"); } };
  const result = await dialogPromise(d, () => setTimeout(() => input.focus(), 30));
  if (result !== "save") return null;
  const name = input.value.trim();
  if (!name) { toast("Give the playlist a name first.", true); return null; }
  if (existing) {
    existing.name = name;
    store.savePlaylists(state.playlists);
    renderAll(); toast("Playlist renamed.");
    return existing;
  }
  const pl = { id: uid("pl"), name, itemIds: [], createdAt: Date.now() };
  state.playlists.push(pl);
  store.savePlaylists(state.playlists);
  renderAll(); toast(`Playlist created: ${name}`);
  return pl;
}
async function openAddToPlaylist(itemId) {
  if (!state.playlists.length) {
    const pl = await openPlaylistDialog();
    if (pl) { pl.itemIds.push(itemId); store.savePlaylists(state.playlists); renderAll(); toast(`Added to ${pl.name}.`); }
    return;
  }
  const d = $("#dialog-addto");
  const host = $("#addto-list");
  host.replaceChildren();
  for (const pl of state.playlists) {
    const b = document.createElement("button");
    b.className = "btn"; b.type = "submit"; b.value = pl.id; b.textContent = `${pl.name} (${pl.itemIds.length})`;
    host.appendChild(b);
  }
  const result = await dialogPromise(d);
  if (result === "new") {
    const pl = await openPlaylistDialog();
    if (pl) { pl.itemIds.push(itemId); store.savePlaylists(state.playlists); renderAll(); toast(`Added to ${pl.name}.`); }
    return;
  }
  const pl = state.playlists.find(p => p.id === result);
  if (pl) {
    if (!pl.itemIds.includes(itemId)) pl.itemIds.push(itemId);
    store.savePlaylists(state.playlists);
    renderAll(); toast(`Added to ${pl.name}.`);
  }
}

/* ------------------------------- import ---------------------------------- */
function classifyFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (file.type.startsWith("audio/") || AUDIO_EXTS.includes(ext)) return "audio";
  if (file.type.startsWith("video/") || VIDEO_EXTS.includes(ext)) return "video";
  return null;
}

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let added = 0, skipped = 0, sessionOnly = 0;
  for (const file of files) {
    const kind = classifyFile(file);
    if (!kind) { skipped++; toast(`Skipped “${file.name}”: not a browser-supported audio or video file.`, true); continue; }
    const dupe = [...state.library.values()].some(i => i.source === "file" && i.title === file.name && i.size === file.size);
    if (dupe) { skipped++; continue; }
    const id = uid("file");
    const item = {
      id, title: file.name, kind, source: "file", blob: file,
      size: file.size, addedAt: Date.now(), persisted: true,
    };
    try {
      await idbPutFile({ id, blob: file, name: file.name, kind, size: file.size, addedAt: item.addedAt });
    } catch {
      item.persisted = false; sessionOnly++;
    }
    state.library.set(id, item);
    added++;
    // Learn the duration in the background without blocking the import.
    probeDuration(item);
  }
  renderAll();
  if (added) toast(`Imported ${added} file${added === 1 ? "" : "s"}.${sessionOnly ? ` ${sessionOnly} could not be saved to browser storage and will only last this session.` : ""}`);
  if (!added && !skipped) toast("No files were imported.", true);
}

function probeDuration(item) {
  if (!item.blob) return;
  const url = URL.createObjectURL(item.blob);
  const probe = document.createElement(item.kind === "video" ? "video" : "audio");
  probe.preload = "metadata";
  probe.onloadedmetadata = () => {
    if (Number.isFinite(probe.duration)) { item.duration = probe.duration; renderAll(); }
    URL.revokeObjectURL(url);
  };
  probe.onerror = () => URL.revokeObjectURL(url);
  probe.src = url;
}

/* ------------------------------ URL form --------------------------------- */
function titleFromUrl(urlStr, parsed) {
  try {
    const u = new URL(urlStr);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || u.hostname);
    return last || u.hostname;
  } catch { return parsed.kind; }
}

function handleUrlSubmit(e) {
  e.preventDefault();
  const raw = els["url-input"].value;
  const parsed = parseMediaUrl(raw);
  const errBox = els["url-error"];
  const resultBox = els["url-result"];
  resultBox.hidden = true; resultBox.replaceChildren();
  if (parsed.kind === "invalid") {
    errBox.textContent = parsed.error;
    errBox.hidden = false;
    els["url-input"].focus();
    return;
  }
  errBox.hidden = true;
  const item = ensureLibraryItem(itemFromParsed(parsed, raw));
  const row = makeRow(item);
  const note = document.createElement("p");
  note.className = "view-sub";
  note.textContent = parsed.kind === "youtube-playlist"
    ? "Playlist link. It plays as one YouTube playlist item in YouTube's embedded player; individual videos inside it are controlled by YouTube."
    : parsed.kind === "youtube-video"
      ? "YouTube video. It will play in YouTube's official embedded player."
      : (parsed.note || "Direct media file. Playback depends on the host allowing cross-origin access and on a browser-supported codec.");
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const mkBtn = (label, primary, fn) => {
    const b = document.createElement("button");
    b.className = "btn" + (primary ? " btn-accent" : ""); b.type = "button"; b.textContent = label;
    b.addEventListener("click", fn); return b;
  };
  actions.append(
    mkBtn("Play now", true, async () => { ensureLibraryItem(item); await playItem(item.id); }),
    mkBtn("Add to library", false, () => { ensureLibraryItem(item); toast("Added to your library."); renderAll(); }),
    mkBtn("Add to queue", false, () => { ensureLibraryItem(item); addToQueue(item.id); toast("Added to queue."); }),
  );
  resultBox.append(row, note, actions);
  resultBox.hidden = false;
}

function itemFromParsed(parsed, raw) {
  if (isYouTubeResult(parsed)) {
    const id = parsed.kind === "youtube-playlist" ? `yt-pl-${parsed.playlistId}` : `yt-${parsed.videoId}`;
    return {
      id, title: parsed.kind === "youtube-playlist" ? `YouTube playlist (${parsed.playlistId})` : `YouTube video (${parsed.videoId})`,
      kind: "video", source: "youtube", ytId: parsed.videoId, playlistId: parsed.playlistId,
      startSeconds: parsed.startSeconds || 0, artwork: parsed.artwork, src: parsed.url,
      addedAt: Date.now(), persisted: true,
    };
  }
  return {
    id: `url-${uid("m")}`, title: titleFromUrl(raw, parsed), kind: parsed.mediaType,
    source: "direct", src: parsed.url, addedAt: Date.now(), persisted: true,
  };
}
function ensureLibraryItem(item) {
  if (!state.library.has(item.id)) {
    // Direct URLs get a stable id derived from the URL so re-adding is a no-op.
    if (item.source === "direct") item.id = `url-${[...item.src].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;
    state.library.set(item.id, item);
    persistUrlItems();
  }
  return state.library.get(item.id);
}

/* --------------------------- audio graph (opt-in) -------------------------- */
// The visualizer and EQ process the native media elements through WebAudio.
// This is opt-in from Settings because routing a cross-origin stream without
// CORS through WebAudio can silence it; local/imported media is unaffected.
function ensureGraph() {
  if (state.graph) return state.graph;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const bass = ctx.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 200;
    const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.9;
    const treble = ctx.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 3200;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 128;
    for (const el of [els["audio-el"], els["video-el"]]) {
      const src = ctx.createMediaElementSource(el);
      src.connect(bass);
    }
    bass.connect(mid); mid.connect(treble); treble.connect(analyser); analyser.connect(ctx.destination);
    state.graph = { ctx, bass, mid, treble, analyser };
    applyEq();
    return state.graph;
  } catch { return null; }
}
function applyEq() {
  if (!state.graph) return;
  const { bass, mid, treble } = state.graph;
  const eq = state.settings.eq;
  bass.gain.value = eq.bass; mid.gain.value = eq.mid; treble.gain.value = eq.treble;
}
let vizRaf = null;
function drawViz() {
  const canvas = els.viz;
  const g = state.graph;
  if (!g || !state.settings.visualizer || player().isYouTube || player().paused) {
    canvas.hidden = true; vizRaf = null; return;
  }
  canvas.hidden = false;
  const ctx2d = canvas.getContext("2d");
  const data = new Uint8Array(g.analyser.frequencyBinCount);
  g.analyser.getByteFrequencyData(data);
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  ctx2d.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e4572e";
  const bars = 12, bw = canvas.width / bars;
  for (let i = 0; i < bars; i++) {
    const v = data[Math.floor(i * data.length / bars)] / 255;
    const h = Math.max(2, v * canvas.height);
    ctx2d.fillRect(i * bw + 1, canvas.height - h, bw - 2, h);
  }
  vizRaf = requestAnimationFrame(drawViz);
}
function syncViz() {
  if (vizRaf) cancelAnimationFrame(vizRaf);
  vizRaf = requestAnimationFrame(drawViz);
}

/* ------------------------------ sleep timer -------------------------------- */
function setSleep(minutes) {
  if (state.sleepTimer) { clearInterval(state.sleepTimer); state.sleepTimer = null; }
  state.sleepEndsAt = 0;
  els["sleep-left"].textContent = "";
  $("#btn-sleep").setAttribute("aria-pressed", "false");
  if (!minutes) { toast("Sleep timer off."); return; }
  state.sleepEndsAt = Date.now() + minutes * 60000;
  $("#btn-sleep").setAttribute("aria-pressed", "true");
  toast(`Sleep timer: playback will pause in ${minutes} minutes.`);
  state.sleepTimer = setInterval(() => {
    const left = state.sleepEndsAt - Date.now();
    if (left <= 0) {
      clearInterval(state.sleepTimer); state.sleepTimer = null;
      els["sleep-left"].textContent = "";
      $("#btn-sleep").setAttribute("aria-pressed", "false");
      player().pause();
      toast("Sleep timer: playback paused.");
      return;
    }
    els["sleep-left"].textContent = fmtTime(Math.ceil(left / 1000));
  }, 500);
}

/* ------------------------------- settings ---------------------------------- */
function applySettingsToPlayer() {
  const s = state.settings;
  player().setVolume(s.volume);
  player().setMuted(s.muted);
  player().setRate(s.rate);
  els.volume.value = Math.round(s.volume * 100);
  els["rate-select"].value = String(s.rate);
  setIcon(els["btn-mute"], s.muted || s.volume === 0 ? "volumeMute" : "volume");
  els["btn-mute"].setAttribute("aria-label", s.muted ? "Unmute" : "Mute");
  $("#btn-shuffle").setAttribute("aria-pressed", String(s.shuffle));
  updateRepeatBtn();
}
function updateRepeatBtn() {
  const r = state.settings.repeat;
  const btn = $("#btn-repeat");
  btn.setAttribute("aria-pressed", String(r !== "off"));
  btn.setAttribute("aria-label", `Repeat: ${r}`);
  btn.title = `Repeat: ${r}`;
  setIcon(btn, r === "one" ? "repeat1" : "repeat");
}
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  const isDark = state.settings.theme === "dark";
  $("#btn-theme").setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
  setIcon($("#btn-theme"), isDark ? "sun" : "moon");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark ? "#101214" : "#f3f1ec";
  $("#set-theme").value = state.settings.theme;
}
function saveSettings() { store.saveSettings(state.settings); }

async function refreshStorageInfo() {
  const est = await store.storageEstimate();
  const el = $("#storage-info");
  if (!el) return;
  el.textContent = est && est.usage != null
    ? `This browser is using about ${fmtBytes(est.usage)} for MuseDeck data${est.quota ? ` of ${fmtBytes(est.quota)} available` : ""}.`
    : "Storage usage is not reported by this browser.";
}

/* ------------------------------ navigation --------------------------------- */
function setView(view) {
  if (!VIEWS.includes(view)) view = "home";
  state.view = view;
  $$(".view").forEach(sec => { sec.hidden = sec.dataset.view !== view; });
  $$(".nav-item").forEach(b => {
    if (b.dataset.nav === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  els["view-title"].textContent = VIEW_TITLES[view];
  if (location.hash !== `#/${view}`) history.replaceState(null, "", `#/${view}`);
  renderAll(); // lists always reflect the latest library/queue state on entry
  placeStage();
  els.content.scrollTop = 0;
}
function viewFromHash() {
  const m = /^#\/(\w+)/.exec(location.hash || "");
  return m && VIEWS.includes(m[1]) ? m[1] : "home";
}

/* ---------------------------- media session -------------------------------- */
function updateMediaSession(item) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title,
      artist: item.artist || ({ repo: "Repository media", file: "Imported file", youtube: "YouTube", direct: "Direct URL" }[item.source] || ""),
      artwork: item.artwork ? [{ src: item.artwork, sizes: "480x360", type: "image/jpeg" }] : [],
    });
    navigator.mediaSession.setActionHandler("play", () => player().play());
    navigator.mediaSession.setActionHandler("pause", () => player().pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext());
    navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
    navigator.mediaSession.setActionHandler("seekto", (d) => { if (d.seekTime != null) player().seekTo(d.seekTime); });
  } catch { /* Media Session is progressive enhancement */ }
}

/* -------------------------------- init ------------------------------------- */
async function init() {
  grab();
  hydrateIcons(document);
  state.player = new Player({ audioEl: els["audio-el"], videoEl: els["video-el"], ytMount: els["yt-mount"] });

  await loadManifest();
  loadUrlItems();
  await loadImportedFiles().catch(() => {});
  // Durations for repo/direct items are learned when first played.

  applyTheme();
  applySettingsToPlayer();
  $("#set-visualizer").checked = !!state.settings.visualizer;
  $("#set-autoplay").checked = !!state.settings.autoplayNext;
  $("#set-rate").value = String(state.settings.rate);
  $("#eq-bass").value = state.settings.eq.bass;
  $("#eq-mid").value = state.settings.eq.mid;
  $("#eq-treble").value = state.settings.eq.treble;
  updateEqOutputs();
  refreshStorageInfo();

  wireEvents();
  setView(viewFromHash());
  renderAll();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Motion is handled in CSS; nothing else animates by default.
  }
}

function updateEqOutputs() {
  $("#eq-bass-out").textContent = `${state.settings.eq.bass} dB`;
  $("#eq-mid-out").textContent = `${state.settings.eq.mid} dB`;
  $("#eq-treble-out").textContent = `${state.settings.eq.treble} dB`;
}

function wireEvents() {
  const p = player();

  /* navigation */
  $$(".nav-item").forEach(b => b.addEventListener("click", () => setView(b.dataset.nav)));
  window.addEventListener("hashchange", () => setView(viewFromHash()));
  $("#btn-import-side").addEventListener("click", () => els["file-input"].click());
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action]");
    if (!t) return;
    if (t.dataset.action === "import") els["file-input"].click();
    if (t.dataset.action === "play-all") {
      const scope = t.dataset.scope;
      const items = scope === "music" ? libraryByKind("audio") : scope === "favorites"
        ? sortedFiltered([...state.favorites].map(id => state.library.get(id)).filter(Boolean)) : allLibrary();
      if (items.length) { setQueue(items.map(i => i.id), 0); playItem(items[0].id, { fromQueue: true }); }
    }
  });

  /* search + sort */
  els["search-input"].addEventListener("input", debounce(() => {
    state.query = els["search-input"].value;
    renderAll();
  }, 120));
  els["sort-select"].addEventListener("change", () => { state.sort = els["sort-select"].value; renderAll(); });

  /* theme / compact / queue panel */
  $("#btn-theme").addEventListener("click", () => {
    state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
    saveSettings(); applyTheme();
  });
  $("#btn-compact").addEventListener("click", () => {
    const app = els.app;
    const on = app.classList.toggle("compact");
    $("#btn-compact").setAttribute("aria-pressed", String(on));
  });
  const queuePanel = els["queue-panel"];
  const toggleQueuePanel = (force) => {
    const show = force != null ? force : queuePanel.hidden;
    queuePanel.hidden = !show;
    $("#btn-queue-toggle").setAttribute("aria-pressed", String(show));
    if (show) renderQueueViews();
  };
  $("#btn-queue-toggle").addEventListener("click", () => toggleQueuePanel());
  $("#btn-queue-close").addEventListener("click", () => toggleQueuePanel(false));

  /* transport */
  els["btn-play"].addEventListener("click", () => togglePlay());
  $("#btn-next").addEventListener("click", () => playNext());
  $("#btn-prev").addEventListener("click", () => playPrev());
  $("#btn-shuffle").addEventListener("click", () => {
    state.settings.shuffle = !state.settings.shuffle;
    saveSettings(); applySettingsToPlayer();
    toast(`Shuffle ${state.settings.shuffle ? "on" : "off"}.`);
  });
  $("#btn-repeat").addEventListener("click", () => {
    const order = ["off", "all", "one"];
    state.settings.repeat = order[(order.indexOf(state.settings.repeat) + 1) % order.length];
    saveSettings(); updateRepeatBtn();
    toast(`Repeat: ${state.settings.repeat}.`);
  });
  els["btn-fav"].addEventListener("click", () => { if (state.currentId) toggleFavorite(state.currentId); });

  function togglePlay() {
    if (!state.currentId) {
      const first = state.queue[0] || (allLibrary()[0] && allLibrary()[0].id);
      if (first) { if (!state.queue.length) setQueue([first], 0); playItem(first, { fromQueue: true }); }
      else toast("Add some media first — import a file or paste a link.");
      return;
    }
    if (p.paused) p.play().catch(err => showPlayerError(err.message)); else p.pause();
  }
  state.togglePlay = togglePlay;

  /* seek */
  const seek = els.seek;
  seek.addEventListener("pointerdown", () => { state.seeking = true; });
  seek.addEventListener("pointerup", () => { state.seeking = false; });
  seek.addEventListener("input", () => {
    const d = p.duration;
    if (d > 0) {
      const target = (Number(seek.value) / 1000) * d;
      els["time-cur"].textContent = fmtTime(target);
    }
  });
  seek.addEventListener("change", () => {
    const d = p.duration;
    if (d > 0) p.seekTo((Number(seek.value) / 1000) * d);
    state.seeking = false;
  });

  /* volume / rate */
  els.volume.addEventListener("input", () => {
    state.settings.volume = Number(els.volume.value) / 100;
    state.settings.muted = false;
    saveSettings(); applySettingsToPlayer();
  });
  els["btn-mute"].addEventListener("click", () => {
    state.settings.muted = !state.settings.muted;
    saveSettings(); applySettingsToPlayer();
  });
  els["rate-select"].addEventListener("change", () => {
    state.settings.rate = Number(els["rate-select"].value);
    saveSettings(); applySettingsToPlayer();
  });

  /* sleep */
  const sleepMenu = $("#sleep-menu");
  $("#btn-sleep").addEventListener("click", () => {
    const open = sleepMenu.hidden;
    sleepMenu.hidden = !open;
    $("#btn-sleep").setAttribute("aria-expanded", String(open));
  });
  sleepMenu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sleep]");
    if (!b) return;
    sleepMenu.hidden = true;
    setSleep(Number(b.dataset.sleep));
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".sleep-wrap")) { sleepMenu.hidden = true; }
  });

  /* stage controls */
  $("#stage-bigplay").addEventListener("click", () => togglePlay());
  els["video-el"].addEventListener("click", () => togglePlay());
  $("#btn-close-stage").addEventListener("click", () => {
    p.pause(); state.stageClosed = true; placeStage();
    if (state.view === "watch") setView("home");
  });
  $("#btn-fullscreen").addEventListener("click", async () => {
    const media = els["stage-media"];
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await media.requestFullscreen();
    } catch { toast("Fullscreen is not available here.", true); }
  });
  $("#btn-theater").addEventListener("click", () => {
    const stage = els.stage;
    const on = stage.classList.toggle("theater");
    els.content.classList.toggle("theater-mode", on);
    $("#btn-theater").setAttribute("aria-pressed", String(on));
  });
  $("#btn-pip").addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await els["video-el"].requestPictureInPicture();
    } catch { toast("Picture-in-picture is not available for this video or browser.", true); }
  });
  els["subtitle-input"].addEventListener("change", () => {
    const file = els["subtitle-input"].files[0];
    els["subtitle-input"].value = "";
    if (!file) return;
    const item = currentItem();
    if (!item || item.source === "youtube" || item.kind !== "video") {
      toast("Subtitles can only be added to a local or direct video that is currently loaded.", true); return;
    }
    const video = els["video-el"];
    video.querySelectorAll("track").forEach(t => t.remove());
    const track = document.createElement("track");
    track.kind = "subtitles"; track.label = file.name; track.srclang = "und";
    track.src = URL.createObjectURL(file);
    track.default = true;
    video.appendChild(track);
    if (video.textTracks[0]) video.textTracks[0].mode = "showing";
    toast(`Subtitles added: ${file.name}. They last for this session.`);
  });

  /* import */
  els["file-input"].addEventListener("change", () => {
    importFiles(els["file-input"].files);
    els["file-input"].value = "";
  });
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
      dragDepth++; els["drop-overlay"].hidden = false;
    }
  });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els["drop-overlay"].hidden = true; });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; els["drop-overlay"].hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  /* url form */
  els["url-form"].addEventListener("submit", handleUrlSubmit);

  /* playlists */
  $("#btn-new-playlist").addEventListener("click", () => openPlaylistDialog());
  $("#btn-clear-history").addEventListener("click", async () => {
    if (await confirmDialog("Clear playback history?", "Recently played will be emptied in this browser.")) {
      state.history = []; store.saveHistory([]); renderAll(); toast("History cleared.");
    }
  });
  $("#btn-clear-queue").addEventListener("click", () => {
    state.queue = []; state.queueIndex = -1; renderQueueViews(); toast("Queue cleared.");
  });

  /* settings */
  $("#set-theme").addEventListener("change", () => { state.settings.theme = $("#set-theme").value; saveSettings(); applyTheme(); });
  $("#set-autoplay").addEventListener("change", () => { state.settings.autoplayNext = $("#set-autoplay").checked; saveSettings(); });
  $("#set-rate").addEventListener("change", () => {
    state.settings.rate = Number($("#set-rate").value); saveSettings(); applySettingsToPlayer();
  });
  $("#set-visualizer").addEventListener("change", () => {
    state.settings.visualizer = $("#set-visualizer").checked; saveSettings();
    if (state.settings.visualizer) {
      ensureGraph();
      if (state.graph && state.graph.ctx.state === "suspended") state.graph.ctx.resume();
    }
    syncViz();
  });
  for (const band of ["bass", "mid", "treble"]) {
    $(`#eq-${band}`).addEventListener("input", () => {
      state.settings.eq[band] = Number($(`#eq-${band}`).value);
      saveSettings(); updateEqOutputs();
      if (state.settings.visualizer || state.graph) { ensureGraph(); applyEq(); }
    });
  }
  $("#btn-shortcuts").addEventListener("click", () => $("#dialog-shortcuts").showModal());
  $("#btn-clear-data").addEventListener("click", async () => {
    if (await confirmDialog("Clear all MuseDeck data?", "Settings, favorites, playlists, history and all imported files stored in this browser will be deleted. Files on your device are not touched.")) {
      await store.clearAll();
      state.objectUrls.forEach(u => URL.revokeObjectURL(u));
      location.reload();
    }
  });

  /* player events */
  p.on("play", () => {
    setIcon(els["btn-play"], "pause");
    els["btn-play"].setAttribute("aria-label", "Pause");
    updateStagePausedClass();
    if (state.settings.visualizer && !p.isYouTube) { ensureGraph(); if (state.graph && state.graph.ctx.state === "suspended") state.graph.ctx.resume(); }
    syncViz();
  });
  p.on("pause", () => {
    setIcon(els["btn-play"], "play");
    els["btn-play"].setAttribute("aria-label", "Play");
    updateStagePausedClass(); syncViz();
  });
  p.on("timeupdate", () => {
    if (!state.seeking) {
      const d = p.duration, t = p.currentTime;
      els.seek.value = d > 0 ? String(Math.round((t / d) * 1000)) : "0";
      els["time-cur"].textContent = fmtTime(t);
    }
    const item = currentItem();
    if (item && p.duration > 0 && !item.duration) { item.duration = p.duration; }
  });
  p.on("durationchange", () => { els["time-dur"].textContent = fmtTime(p.duration); });
  p.on("ended", () => {
    if (state.settings.repeat === "one") { p.seekTo(0); p.play().catch(() => {}); return; }
    if (state.settings.autoplayNext) playNext(true);
  });
  p.on("error", (msg) => showPlayerError(msg));

  /* keyboard */
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const typing = target instanceof Element
      ? (target.closest("input, textarea, select, [contenteditable='true']") || target.isContentEditable)
      : false;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector("dialog[open]")) return;
    const item = currentItem();
    switch (e.code) {
      case "Space": case "KeyK": e.preventDefault(); togglePlay(); break;
      case "ArrowRight": e.preventDefault(); p.seekTo(p.currentTime + (e.shiftKey ? 15 : 5)); break;
      case "ArrowLeft": e.preventDefault(); p.seekTo(p.currentTime - (e.shiftKey ? 15 : 5)); break;
      case "ArrowUp": e.preventDefault(); setVolumeDelta(0.05); break;
      case "ArrowDown": e.preventDefault(); setVolumeDelta(-0.05); break;
      case "KeyM": state.settings.muted = !state.settings.muted; saveSettings(); applySettingsToPlayer(); break;
      case "KeyN": playNext(); break;
      case "KeyP": playPrev(); break;
      case "KeyS": $("#btn-shuffle").click(); break;
      case "KeyR": $("#btn-repeat").click(); break;
      case "KeyF": if (item && (item.kind === "video" || item.source === "youtube")) $("#btn-fullscreen").click(); break;
      case "Slash": e.preventDefault(); els["search-input"].focus(); break;
    }
  });
  function setVolumeDelta(d) {
    state.settings.volume = clamp(state.settings.volume + d, 0, 1);
    state.settings.muted = false;
    saveSettings(); applySettingsToPlayer();
  }
}

document.addEventListener("DOMContentLoaded", () => { init().catch(err => {
  const box = document.getElementById("toast-region");
  if (box) { const t = document.createElement("div"); t.className = "toast error"; t.textContent = `MuseDeck failed to start: ${err.message}`; box.appendChild(t); }
}); });
