-- Fixed-window rate limiting for edge functions.
--
-- Edge functions have no built-in throttling, and some endpoints are public
-- (patient-accept, client-errors) or trigger outbound email (patient-invite).
-- app.rate_limit_hit() counts a hit for a bucket in the current window and
-- says whether it's still within the limit, atomically (one upsert).
--
-- Buckets are opaque strings built by the caller; IP-based buckets are
-- hashed there, so no raw client IPs are stored.

CREATE TABLE IF NOT EXISTS app.rate_limit (
  bucket       TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_window_idx ON app.rate_limit (window_start);
ALTER TABLE app.rate_limit ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.rate_limit_hit(
  p_bucket TEXT,
  p_limit INT,
  p_window_seconds INT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_window TIMESTAMPTZ;
  v_hits   INT;
BEGIN
  IF p_bucket IS NULL OR p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'rate_limit_hit: invalid arguments';
  END IF;

  v_window := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO app.rate_limit AS r (bucket, window_start, hits)
  VALUES (p_bucket, v_window, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING hits INTO v_hits;

  -- Opportunistic cleanup; windows are at most a day long.
  IF random() < 0.01 THEN
    DELETE FROM app.rate_limit WHERE window_start < now() - interval '1 day';
  END IF;

  RETURN v_hits <= p_limit;
END;
$$;

REVOKE ALL ON TABLE app.rate_limit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.rate_limit TO service_role;
REVOKE EXECUTE ON FUNCTION app.rate_limit_hit(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.rate_limit_hit(TEXT, INT, INT) TO service_role;
