// Per-bucket fixed-window rate limiting backed by app.rate_limit_hit()
// (migration 0049). Use it on public endpoints and on anything that sends
// email or push, e.g.:
//
//   const limited = await rateLimit(svc, `accept:ip:${await ipKey(req)}`, 10, 600);
//   if (limited) return limited;
//
// Fails open: if the limiter itself errors, the request proceeds (logged) —
// a limiter outage must not take the endpoint down with it.
//
// deno-lint-ignore-file no-explicit-any

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hashed client IP, so raw IPs are never stored. Prefers cf-connecting-ip,
 * which Supabase's Cloudflare edge overwrites (a client can't spoof it);
 * the X-Forwarded-For first hop is client-controllable and only a fallback
 * (local dev has no Cloudflare in front).
 */
export async function ipKey(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip')
    || req.headers.get('x-real-ip')
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
  return (await sha256Hex(`ip:${ip}`)).slice(0, 32);
}

/** Hashed opaque value (e.g. an invite token) for use inside a bucket name. */
export async function hashKey(value: string): Promise<string> {
  return (await sha256Hex(value)).slice(0, 32);
}

/**
 * Counts one hit on `bucket`. Returns a 429 Response when the bucket is over
 * `limit` hits in the current `windowSeconds` window, otherwise null.
 */
export async function rateLimit(
  service: any,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const { data: allowed, error } = await service.schema('app').rpc('rate_limit_hit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'rate limiter failed', bucket: bucket.split(':')[0], details: error.message }));
    return null;
  }
  if (allowed === false) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(windowSeconds) },
    });
  }
  return null;
}
