# MuseDeck — Music & Video Player

MuseDeck is a complete music and video player that runs entirely in the browser.
No account, no backend, no build step. It plays three kinds of sources:

1. **Media files committed to this repository**, listed in a manifest.
2. **Audio and video files you import from your device** (stored locally in your browser).
3. **Links you paste** — YouTube videos/playlists and direct audio/video file URLs.

The original “Phố Hoa Anh Đào” demo page was replaced by this application.

## Run it locally

The app uses ES modules, so open it through a static server (not `file://`):

```bash
# from the repository root, any one of:
python3 -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080>.

## Add media to the repository

1. Put audio/video files somewhere in the repo, for example `assets/media/my-song.mp3`.
2. List them in [`assets/media-manifest.json`](assets/media-manifest.json):

```json
{
  "items": [
    {
      "title": "My Song",
      "artist": "Optional artist name",
      "kind": "audio",
      "src": "assets/media/my-song.mp3",
      "artwork": "assets/media/my-song.jpg"
    },
    {
      "title": "My Video",
      "kind": "video",
      "src": "assets/media/my-video.mp4"
    }
  ]
}
```

Use **relative paths** (no leading slash) so they work under the GitHub Pages
project path. Only add metadata you actually know — MuseDeck never invents
titles, durations, or artwork. Durations are read from the media itself when played.
Keep committed media reasonably small; GitHub repositories are not a media CDN.

## Import local media

- Click **Import media**, or drag and drop files anywhere onto the window.
- Multiple files at once are supported. Duplicates (same name and size) are skipped.
- Supported formats are whatever your browser can decode — typically MP3, WAV,
  OGG, M4A/AAC, FLAC, Opus for audio and MP4 (H.264), WebM, MOV for video.
  MKV/AVI files generally do **not** play in browsers.
- Imported files are stored as blobs in **IndexedDB**, so they survive a reload.
  If the browser refuses storage (quota/private mode), the file still plays for
  the session and the UI says so honestly. The browser may evict stored blobs
  under disk pressure; your original files on the device are never touched.
- Remove an imported item with the trash button on its row — this deletes only
  the browser's stored copy.

## Paste a URL

Open **Open from URL** and paste:

- YouTube: `youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…`, `/embed/…`,
  `/live/…`, YouTube Music links, and playlist links (`/playlist?list=…` or any
  link containing a valid `list=` parameter). A `t=1m30s` start time is honoured.
- Direct media files: URLs ending in `.mp3 .wav .ogg .m4a .aac .flac .opus`
  (audio) or `.mp4 .webm .mov .m4v .m3u8` (video).

Malformed links, missing video IDs, unsupported hosts/extensions and
non-`http(s)` URLs are rejected with a specific explanation. You can play a
checked link immediately, add it to the library (links persist in localStorage),
or add it to the queue.

### YouTube rules and limits

- Playback uses the official **YouTube IFrame Player API** and YouTube's own
  embedded player, per the
  [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service).
  MuseDeck does not download YouTube media, extract streams, block ads, or hide the player.
- Videos whose owners disabled embedding, and private/removed videos, cannot
  play — YouTube reports that in the player and MuseDeck surfaces its error code message.
- Playlists play as a single playlist item inside YouTube's player; MuseDeck's
  queue cannot see or reorder the individual videos inside a YouTube playlist.
- Features that require processing the audio stream (equalizer, visualizer),
  subtitle-file import and picture-in-picture apply only to native media and
  are disabled, with an explanation, for YouTube items.

## Features

- **Transport:** play/pause, previous/next, seek bar with elapsed/total time,
  volume + mute (remembered), playback speed 0.5×–2×.
- **Queue:** play-next ordering from any list, add/remove, drag to reorder
  (plus keyboard-friendly up/down buttons), clear, shuffle, repeat off/all/one,
  automatic next-track.
- **Video:** dedicated watch layout, theater mode, fullscreen,
  picture-in-picture (native video), click-to-play/pause, `.vtt` subtitle file
  import for the loaded native video.
- **Library:** Home overview with real counts, music/video libraries, search,
  sorting, favorites, recently-played history (last 60).
- **Playlists:** create, rename, delete (with confirmation), add/remove items, play all.
- **Extras:** sleep timer (15/30/45/60 minutes), dark/light theme, compact
  sidebar, Media Session API (OS media keys and lock-screen metadata),
  optional Web Audio **visualizer and 3-band equalizer** for local media
  (Settings, off by default — see the note there about CORS and remote streams).
- **Premium-style tools** (inspired by popular YouTube browser extensions,
  rebuilt natively — see the honesty note below): **ambient glow** around the
  video stage from the item's artwork or a captured frame, **volume boost**
  150–300% for local media, **extended playback speeds** 0.25×–4× (YouTube
  applies the closest rate it offers and tells you), **video filters**
  (bright/warm/vivid/B&W), **A–B section loop** on the transport bar,
  **frame snapshot** to PNG for native video, and switchable
  **progress-bar styles**.

### An honest note about YouTube ads and “Premium”

MuseDeck cannot remove YouTube ads, and no feature here fakes a Premium
subscription. Ads are served by YouTube inside its own embedded player;
extensions that strip them inject code into youtube.com, which a website
using the official IFrame API neither can nor may do — the
[YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service)
prohibit circumventing ads and restrictions, and breaking them risks the
embed being blocked. A “Premium logo” swap (one popular extension does
exactly that and nothing more) is decoration, not a feature. What MuseDeck
adds instead is everything that can legitimately be built *around* the
official player, listed above.
- **Keyboard:** `Space`/`K` play-pause, `←`/`→` seek 5s (Shift = 15s),
  `↑`/`↓` volume, `M` mute, `N`/`P` next/previous, `S` shuffle, `R` repeat,
  `F` fullscreen in the watch view, `/` focuses search. Shortcuts never fire
  while typing in a field.

## Privacy and storage

Everything is local: settings, favorites, playlists, history and URL items in
`localStorage`; imported files in IndexedDB. Nothing is uploaded, tracked, or
sent anywhere except the media streams you explicitly play (YouTube's embed
loads from YouTube, direct URLs from their host). **Settings → Clear all local
data** wipes everything MuseDeck stored.

## Browser limitations

- Autoplay with sound requires a user gesture; MuseDeck only starts playback
  from your actions.
- Remote direct URLs can fail because of CORS, expired links, or unsupported
  codecs. The player shows the browser's real error instead of pretending.
- HLS (`.m3u8`) plays natively in Safari. Chromium-based browsers usually need
  an MSE-based HLS player, which MuseDeck deliberately does not bundle.
- MPEG-DASH (`.mpd`) is not natively playable in most browsers.

## Deploy on GitHub Pages

Enable it once in the repository:

**Settings → Pages → Build and deployment → Source: Deploy from a branch →
Branch: `main`, folder `/ (root)` → Save.**

GitHub then publishes the repository root as a static site at
`https://<user>.github.io/TESTMUSE/` and republishes on every push to `main`.
All asset paths in MuseDeck are relative, so the app works under that project
path as well as at a domain root. There is no build step and no dependency to
install — React or a bundler would add weight without changing what the
browser can do here. (A GitHub Actions deployment workflow would work equally
well; it is not included because the Muse GitHub App used to publish this repo
does not have the `workflows` permission GitHub requires to write workflow
files. Branch deployment needs no workflow file.)

## Project layout

```
index.html                    App shell: sidebar, views, dialogs, player bar
styles/main.css               Design tokens (dark/light), layout, components
scripts/main.js               Entry point
scripts/app.js                UI, library, queue, playlists, import, settings
scripts/player.js             Playback engine: native audio/video + YouTube API
scripts/urlparse.js           Pure YouTube/direct URL parsing (unit-tested)
scripts/store.js              localStorage state + IndexedDB file storage
scripts/icons.js              Inline SVG icon set (Lucide-style paths)
scripts/util.js               Formatting and DOM helpers
assets/media-manifest.json    Repository media catalog (empty by default)
tests/urlparse.test.mjs       Node unit tests:  node --test tests/urlparse.test.mjs
```

## Design notes

Built following Anthropic's `frontend-design` skill and Vercel's Web Interface
Guidelines: a deliberate token system (warm ink neutrals, one vermilion accent,
Be Vietnam Pro UI type, JetBrains Mono only for timecodes), visible
`:focus-visible` states, labelled icon buttons, `aria-live` toasts,
`prefers-reduced-motion` support, and no decorative gradients or placeholder
controls — every visible button does something. The Vercel React best-practices
skill was reviewed and intentionally not applied: the app uses no framework,
by design. Browser checks were run with the Playwright CLI skill's workflow
(snapshot, interact, console, screenshots at desktop and mobile sizes).
