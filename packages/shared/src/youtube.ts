// YouTube video linking for exercise media (kind='video').
// Only the 11-char video ID is ever stored (app.exercise_media.url) — the
// thumbnail and embed URLs are cheap to derive on read, so nothing here
// touches Storage or the signed-URL cache the way image/gif media does.

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const URL_ID_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

/** Resolves a pasted YouTube URL (any common form) or a bare 11-char id to the id, or null if unrecognized. */
export function parseYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (ID_RE.test(trimmed)) return trimmed;
  const match = trimmed.match(URL_ID_RE);
  return match ? match[1] : null;
}

/** Static thumbnail — no API key, cacheable, used for the click-to-load facade. */
export function youtubeThumbUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** youtube-nocookie.com avoids setting tracking cookies until the viewer opts in by clicking play. */
export function youtubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}
