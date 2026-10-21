// Unit tests for the pure URL parser. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMediaUrl } from "../scripts/urlparse.js";

test("watch URL", () => {
  const r = parseMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(r.kind, "youtube-video");
  assert.equal(r.videoId, "dQw4w9WgXcQ");
});

test("watch URL with playlist context keeps both", () => {
  const r = parseMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjX9efdf");
  assert.equal(r.kind, "youtube-video");
  assert.equal(r.playlistId, "PLrAXtmErZgOeiKm4sgNOknGvNjX9efdf");
});

test("youtu.be short link", () => {
  const r = parseMediaUrl("https://youtu.be/dQw4w9WgXcQ?si=abc");
  assert.equal(r.kind, "youtube-video");
  assert.equal(r.videoId, "dQw4w9WgXcQ");
});

test("shorts link", () => {
  const r = parseMediaUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  assert.equal(r.kind, "youtube-video");
});

test("embed link", () => {
  const r = parseMediaUrl("https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(r.kind, "youtube-video");
});

test("YouTube Music watch link", () => {
  const r = parseMediaUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(r.kind, "youtube-video");
});

test("playlist-only link", () => {
  const r = parseMediaUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjX9efdf");
  assert.equal(r.kind, "youtube-playlist");
  assert.equal(r.playlistId, "PLrAXtmErZgOeiKm4sgNOknGvNjX9efdf");
});

test("start time is parsed", () => {
  const r = parseMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s");
  assert.equal(r.startSeconds, 90);
});

test("direct audio URL", () => {
  const r = parseMediaUrl("https://example.com/music/song.mp3");
  assert.equal(r.kind, "direct");
  assert.equal(r.mediaType, "audio");
});

test("direct video URL", () => {
  const r = parseMediaUrl("https://example.com/movie.mp4?token=1");
  assert.equal(r.kind, "direct");
  assert.equal(r.mediaType, "video");
});

test("m3u8 is direct video with a support note", () => {
  const r = parseMediaUrl("https://example.com/live/stream.m3u8");
  assert.equal(r.kind, "direct");
  assert.ok(r.note && r.note.includes("Safari"));
});

test("invalid: not a URL", () => {
  assert.equal(parseMediaUrl("hello world").kind, "invalid");
});

test("invalid: missing video id", () => {
  assert.equal(parseMediaUrl("https://www.youtube.com/watch").kind, "invalid");
  assert.equal(parseMediaUrl("https://youtu.be/").kind, "invalid");
});

test("invalid: bad video id characters", () => {
  assert.equal(parseMediaUrl("https://www.youtube.com/watch?v=short").kind, "invalid");
});

test("invalid: non-http protocol", () => {
  assert.equal(parseMediaUrl("ftp://example.com/song.mp3").kind, "invalid");
  assert.equal(parseMediaUrl("javascript:alert(1)").kind, "invalid");
});

test("invalid: unsupported container .mkv", () => {
  const r = parseMediaUrl("https://example.com/movie.mkv");
  assert.equal(r.kind, "invalid");
  assert.match(r.error, /not playable/);
});

test("invalid: web page instead of media file", () => {
  assert.equal(parseMediaUrl("https://example.com/about").kind, "invalid");
});

test("invalid: empty input", () => {
  assert.equal(parseMediaUrl("").kind, "invalid");
  assert.equal(parseMediaUrl("   ").kind, "invalid");
});

test("invalid: fake youtube host", () => {
  assert.equal(parseMediaUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ").kind, "invalid");
});
