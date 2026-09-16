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

function fnName(req: Request): string {
  return new URL(req.url).pathname.split('/').filter(Boolean)[0] ?? 'unknown';
}

// Server errors never carry internals to the client. Handlers put the raw
// database/auth message in `details` for 5xx responses; it's logged here and
// stripped, so a schema/function name can't leak through an error body.
async function redactServerError(req: Request, res: Response): Promise<Response> {
  if (res.status < 500 || !res.body) return res;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (body && typeof body === 'object' && 'details' in body) {
    const { details, ...rest } = body as Record<string, unknown>;
    console.error(JSON.stringify({ level: 'error', fn: fnName(req), status: res.status, details }));
    const headers = new Headers(res.headers);
    headers.set('Content-Type', 'application/json');
    headers.delete('Content-Length');
    return new Response(JSON.stringify(rest), { status: res.status, statusText: res.statusText, headers });
  }
  return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function withCors(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeadersFor(req);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    let res: Response;
    try {
      res = await redactServerError(req, await handler(req));
    } catch (e) {
      // An unhandled throw would otherwise surface as a runtime error page
      // without CORS headers (the browser then reports a misleading CORS
      // failure) and could include the exception text.
      console.error(JSON.stringify({
        level: 'error',
        fn: fnName(req),
        msg: 'unhandled exception',
        details: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      }));
      res = new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
