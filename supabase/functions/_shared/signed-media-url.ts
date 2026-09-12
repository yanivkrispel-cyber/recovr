// Reuses signed URLs for private exercise-media Storage objects instead of
// minting a fresh token (and therefore a new, uncacheable URL) on every
// request. See migration 0018_signed_url_cache.sql for why this exists.
//
// deno-lint-ignore-file no-explicit-any
const BUCKET = 'exercise-media';
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — media is static, not per-user
// Re-mint if less than this much validity remains, so a client never gets
// handed a URL that's about to 403 mid-session.
const REFRESH_MARGIN_SECONDS = 24 * 60 * 60;

export async function getSignedMediaUrl(service: any, path: string): Promise<string | null> {
  const { data: cached } = await service
    .schema('app')
    .from('media_signed_url_cache')
    .select('url, expires_at')
    .eq('path', path)
    .maybeSingle();

  if (cached && new Date(cached.expires_at).getTime() - Date.now() > REFRESH_MARGIN_SECONDS * 1000) {
    return cached.url;
  }

  const { data: signed } = await service.storage.from(BUCKET).createSignedUrl(path, TTL_SECONDS);
  if (!signed?.signedUrl) return null;

  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
  await service
    .schema('app')
    .from('media_signed_url_cache')
    .upsert({ path, url: signed.signedUrl, expires_at: expiresAt }, { onConflict: 'path' });

  return signed.signedUrl;
}
