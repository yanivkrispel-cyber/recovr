-- Performance: exercise media is served through Storage signed URLs (the
-- bucket is private for licensing reasons, not patient privacy — see
-- scripts/ingest-exercises.ts). Minting a fresh token on every request means
-- the URL changes every time, so the browser can never cache the same image
-- twice — patients re-download the same GIFs on every visit. This cache lets
-- repeat requests for the same file reuse the same signed URL (and therefore
-- hit the browser's HTTP cache) until it's close to expiring.
CREATE TABLE app.media_signed_url_cache (
  path        TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX media_signed_url_cache_expires_idx ON app.media_signed_url_cache(expires_at);
