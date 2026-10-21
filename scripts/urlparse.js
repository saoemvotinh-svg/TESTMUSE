// Pure URL parsing for YouTube and direct media links.
// No DOM access here, so this module is unit-testable in Node (tests/).

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,}$/;

const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "m3u8", "mpd"]);
const UNSUPPORTED_EXT = new Set(["mkv", "avi", "wmv", "flv", "ts", "mpg", "mpeg", "3gp"]);

const YT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com",
  "music.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com",
]);

function invalid(error) { return { kind: "invalid", error }; }

function extOf(url) {
  const path = url.pathname.toLowerCase();
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return "";
  return path.slice(dot + 1);
}

export function youtubeThumbnail(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function parseMediaUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return invalid("Paste a YouTube or direct media URL first.");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return invalid("That does not look like a valid URL. Check for typos and try again.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return invalid("Only http:// and https:// links are supported.");
  }

  const host = url.hostname.toLowerCase();

  // --- youtu.be/<id> -------------------------------------------------------
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] || "";
    if (!YT_ID.test(id)) return invalid("The youtu.be link does not contain a valid 11-character video ID.");
    return youtubeVideo(id, url, null);
  }

  // --- youtube.* ------------------------------------------------------------
  if (YT_HOSTS.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const list = url.searchParams.get("list");

    if (parts[0] === "watch") {
      const v = url.searchParams.get("v") || "";
      if (v && YT_ID.test(v)) {
        return youtubeVideo(v, url, list && PLAYLIST_ID.test(list) ? list : null);
      }
      if (list && PLAYLIST_ID.test(list)) return youtubePlaylist(list, url);
      return invalid("The watch link is missing a valid video ID (the v=… part).");
    }
    if (["shorts", "embed", "live", "v"].includes(parts[0])) {
      const id = parts[1] || "";
      if (!YT_ID.test(id)) return invalid(`The ${parts[0]} link does not contain a valid 11-character video ID.`);
      return youtubeVideo(id, url, null);
    }
    if (parts[0] === "playlist") {
      if (list && PLAYLIST_ID.test(list)) return youtubePlaylist(list, url);
      return invalid("The playlist link is missing a valid list=… playlist ID.");
    }
    if (list && PLAYLIST_ID.test(list) && !url.searchParams.get("v")) {
      return youtubePlaylist(list, url);
    }
    return invalid("That YouTube link type is not supported. Use a video, Shorts, or playlist link.");
  }

  if (host.endsWith("youtube.com") || host.endsWith("youtu.be")) {
    return invalid("That looks like a YouTube link, but the address is not an official youtube.com / youtu.be host.");
  }

  // --- Direct media file ----------------------------------------------------
  const ext = extOf(url);
  if (AUDIO_EXT.has(ext)) return direct(url, "audio", ext);
  if (VIDEO_EXT.has(ext)) {
    const note = ext === "m3u8"
      ? "HLS (.m3u8) plays natively in Safari; Chromium-based browsers may not support it without an MSE player."
      : ext === "mpd"
        ? "MPEG-DASH (.mpd) is not natively playable in most browsers and will likely fail."
        : null;
    return direct(url, "video", ext, note);
  }
  if (UNSUPPORTED_EXT.has(ext)) {
    return invalid(`.${ext} files are not playable by web browsers. Convert the file to MP4/WebM (video) or MP3/WAV (audio), or import a local copy in a supported format.`);
  }
  return invalid("The link does not end in a recognised media file extension (for example .mp3, .mp4, .webm). If it is a streaming page rather than a media file, it cannot be played directly.");
}

function youtubeVideo(id, url, playlistId) {
  const start = parseStartSeconds(url);
  return {
    kind: "youtube-video",
    mediaType: "video",
    videoId: id,
    playlistId: playlistId || null,
    startSeconds: start,
    embedUrl: `https://www.youtube.com/embed/${id}`,
    artwork: youtubeThumbnail(id),
    url: url.toString(),
  };
}

function youtubePlaylist(playlistId, url) {
  return {
    kind: "youtube-playlist",
    mediaType: "video",
    playlistId,
    videoId: null,
    startSeconds: 0,
    embedUrl: `https://www.youtube.com/embed?listType=playlist&list=${playlistId}`,
    artwork: null,
    url: url.toString(),
  };
}

function direct(url, mediaType, ext, note = null) {
  return { kind: "direct", mediaType, format: ext, note, url: url.toString() };
}

function parseStartSeconds(url) {
  const t = url.searchParams.get("t") || url.searchParams.get("start");
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

export function isYouTubeResult(parsed) {
  return parsed && (parsed.kind === "youtube-video" || parsed.kind === "youtube-playlist");
}
