// Playback engine. One owner of playback state, three source adapters:
//   - native audio element (audio files / audio URLs / repo audio)
//   - native video element (video files / video URLs / repo video)
//   - YouTube IFrame Player API (youtube items, inside the stage container)
//
// The UI never touches the elements directly; it calls this API and listens
// to events: play, pause, timeupdate, durationchange, ended, error, state.
//
// YouTube notes, per the official API terms: playback happens in YouTube's
// own embedded player with its controls available; we do not download,
// extract, or obscure it. Some native-only features (equalizer, visualizer,
// subtitle file import, PiP) genuinely cannot apply to an iframe source and
// are disabled in the UI with an explanation.

let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    tag.onerror = () => reject(new Error("Could not load the YouTube player. Check your connection and try again."));
    document.head.appendChild(tag);
    setTimeout(() => { if (!window.YT || !window.YT.Player) reject(new Error("The YouTube player took too long to load. Check your connection and try again.")); }, 15000);
  });
  return ytApiPromise;
}

const YT_ERRORS = {
  2: "YouTube rejected the request (invalid parameter).",
  5: "YouTube's HTML5 player reported an error for this video.",
  100: "This video was not found. It may have been removed or made private.",
  101: "The owner of this video does not allow it to be played in embedded players.",
  150: "The owner of this video does not allow it to be played in embedded players.",
};

export class Player {
  constructor({ audioEl, videoEl, ytMount }) {
    this.audioEl = audioEl;
    this.videoEl = videoEl;
    this.ytMount = ytMount;
    this.mode = "none"; // none | native | youtube
    this.el = null;     // active native element
    this.yt = null;
    this.ytReady = false;
    this.ytPoll = null;
    this.pendingYt = null;
    this.listeners = new Map();

    const forward = (el, name, ev) => el.addEventListener(name, () => { if (this.el === el && this.mode === "native") this.emit(ev); });
    for (const el of [audioEl, videoEl]) {
      forward(el, "play", "play");
      forward(el, "pause", "pause");
      forward(el, "timeupdate", "timeupdate");
      forward(el, "loadedmetadata", "durationchange");
      forward(el, "durationchange", "durationchange");
      forward(el, "ended", "ended");
      el.addEventListener("error", () => {
        if (this.el === el && this.mode === "native") {
          const code = el.error && el.error.code;
          this.emit("error", nativeErrorMessage(code));
        }
      });
    }
  }

  on(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev).add(fn);
    return () => this.listeners.get(ev).delete(fn);
  }
  emit(ev, data) {
    (this.listeners.get(ev) || []).forEach(fn => { try { fn(data); } catch { /* listener errors must not break playback */ } });
  }

  get isYouTube() { return this.mode === "youtube"; }

  async load(item, { autoplay = true } = {}) {
    this.stopYtPoll();
    if (item.source === "youtube") {
      this.mode = "youtube";
      this.el = null;
      this.audioEl.pause();
      this.videoEl.pause();
      this.videoEl.removeAttribute("src");
      await this.loadYouTube(item, autoplay);
      return;
    }
    // native
    this.destroyYt();
    this.mode = "native";
    const el = item.kind === "video" ? this.videoEl : this.audioEl;
    const other = el === this.videoEl ? this.audioEl : this.videoEl;
    other.pause();
    if (other.getAttribute("src")) other.removeAttribute("src");
    this.el = el;
    if (el.getAttribute("src") !== item.src) el.src = item.src;
    el.load();
    this.emit("durationchange");
    this.emit("timeupdate");
    if (autoplay) await this.play().catch(() => {});
  }

  async loadYouTube(item, autoplay) {
    const YT = await loadYouTubeApi();
    const vars = {
      autoplay: autoplay ? 1 : 0,
      rel: 0,
      playsinline: 1,
      enablejsapi: 1,
      origin: window.location.origin === "null" ? undefined : window.location.origin,
    };
    const target = item.playlistId && !item.ytId
      ? { listType: "playlist", list: item.playlistId }
      : { videoId: item.ytId };
    if (item.startSeconds) vars.start = item.startSeconds;

    if (this.yt && this.ytReady && this.yt.loadVideoById) {
      if (target.videoId) this.yt.loadVideoById({ videoId: target.videoId, startSeconds: item.startSeconds || 0 });
      else this.yt.loadPlaylist({ listType: "playlist", list: target.list });
      return;
    }
    this.destroyYt();
    this.ytMount.replaceChildren();
    const mount = document.createElement("div");
    mount.id = "yt-player-mount";
    this.ytMount.appendChild(mount);
    this.ytReady = false;
    await new Promise((resolve, reject) => {
      this.yt = new YT.Player(mount.id, {
        width: "100%", height: "100%",
        ...target,
        playerVars: vars,
        events: {
          onReady: () => {
            this.ytReady = true;
            this.applyYtPrefs();
            this.startYtPoll();
            this.emit("durationchange");
            resolve();
          },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) this.emit("ended");
            if (e.data === YT.PlayerState.PLAYING) { this.emit("play"); this.emit("durationchange"); }
            if (e.data === YT.PlayerState.PAUSED) this.emit("pause");
          },
          onError: (e) => {
            this.emit("error", YT_ERRORS[e.data] || `YouTube reported an error (code ${e.data}). The video may be unavailable or restricted.`);
          },
        },
      });
      setTimeout(() => { if (!this.ytReady) reject(new Error("The YouTube player did not become ready. The video may be unavailable.")); }, 15000);
    }).catch(err => this.emit("error", err.message));
  }

  applyYtPrefs() {
    if (!this.yt || !this.ytReady) return;
    if (this._volume != null) this.yt.setVolume(Math.round(this._volume * 100));
    if (this._muted) this.yt.mute(); 
    if (this._rate) this.yt.setPlaybackRate(this._rate);
  }

  startYtPoll() {
    this.stopYtPoll();
    this.ytPoll = setInterval(() => { if (this.mode === "youtube") this.emit("timeupdate"); }, 500);
  }
  stopYtPoll() { if (this.ytPoll) { clearInterval(this.ytPoll); this.ytPoll = null; } }

  destroyYt() {
    this.stopYtPoll();
    if (this.yt && this.yt.destroy) { try { this.yt.destroy(); } catch { /* noop */ } }
    this.yt = null; this.ytReady = false;
    if (this.ytMount) this.ytMount.replaceChildren();
  }

  async play() {
    if (this.mode === "youtube") { if (this.yt && this.ytReady) this.yt.playVideo(); return; }
    if (this.el) await this.el.play();
  }
  pause() {
    if (this.mode === "youtube") { if (this.yt && this.ytReady) this.yt.pauseVideo(); return; }
    if (this.el) this.el.pause();
  }
  get paused() {
    if (this.mode === "youtube") {
      if (!this.yt || !this.ytReady || !this.yt.getPlayerState) return true;
      return this.yt.getPlayerState() !== 1; // 1 = playing
    }
    return this.el ? this.el.paused : true;
  }
  get currentTime() {
    if (this.mode === "youtube") return (this.yt && this.ytReady && this.yt.getCurrentTime) ? this.yt.getCurrentTime() : 0;
    return this.el ? this.el.currentTime : 0;
  }
  get duration() {
    if (this.mode === "youtube") return (this.yt && this.ytReady && this.yt.getDuration) ? this.yt.getDuration() : 0;
    return this.el && Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }
  seekTo(sec) {
    if (!Number.isFinite(sec)) return;
    if (this.mode === "youtube") { if (this.yt && this.ytReady) this.yt.seekTo(Math.max(0, sec), true); return; }
    if (this.el) { try { this.el.currentTime = Math.max(0, sec); } catch { /* not seekable yet */ } }
  }
  setVolume(v) {
    this._volume = v;
    if (this.mode === "youtube") { if (this.yt && this.ytReady) this.yt.setVolume(Math.round(v * 100)); return; }
    if (this.el) this.el.volume = v;
    if (this.audioEl !== this.el) this.audioEl.volume = v;
    if (this.videoEl !== this.el) this.videoEl.volume = v;
  }
  setMuted(m) {
    this._muted = m;
    if (this.mode === "youtube") { if (this.yt && this.ytReady) { m ? this.yt.mute() : this.yt.unMute(); } return; }
    this.audioEl.muted = m; this.videoEl.muted = m;
  }
  setRate(r) {
    this._rate = r;
    if (this.mode === "youtube") { if (this.yt && this.ytReady) this.yt.setPlaybackRate(r); return; }
    this.audioEl.playbackRate = r; this.videoEl.playbackRate = r;
  }
  stop() {
    this.pause();
    this.destroyYt();
    this.mode = "none"; this.el = null;
  }
}

function nativeErrorMessage(code) {
  switch (code) {
    case 1: return "Playback was aborted.";
    case 2: return "A network error interrupted playback. Check the connection or the source URL and try again.";
    case 3: return "The media could not be decoded. The file or stream format may not be supported by this browser.";
    case 4: return "This media could not be loaded. The format may be unsupported, the URL may be wrong, or the host may block cross-origin playback (CORS).";
    default: return "Playback failed for an unknown reason. Try another source or format.";
  }
}
