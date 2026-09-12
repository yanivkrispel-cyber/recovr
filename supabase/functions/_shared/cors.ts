// Shared CORS handling for edge functions called directly from the browser
// (clinician /app and patient /m). Local dev never hits this — the Vite dev
// server proxies /api same-origin — so this only matters in production,
// where the frontend calls *.supabase.co cross-origin.
//
// Origin is allow-listed (not '*') because these endpoints accept a bearer
// JWT: a wildcard origin combined with an auth header would let any site's
// JS complete authenticated requests via a signed-in user's browser.
const ALLOWED_ORIGINS = new Set([
  'https://recovr-bykrispel.web.app',
  'http://localhost:5173',
  'http://localhost:5174',
]);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    // Lets the browser skip the preflight OPTIONS round-trip on repeat calls
    // to the same endpoint for a day, instead of paying it on every request.
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function withCors(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeadersFor(req);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    const res = await handler(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
