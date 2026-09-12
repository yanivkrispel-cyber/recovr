// Edge Function: GET /me/plan
// Current phase of the patient's plan for the printable home program (T-15):
// exercises, prescriptions, instructions, verified media, phase goals + criteria,
// and the treating clinician's contact for the footer.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { getSignedMediaUrl } from '../_shared/signed-media-url.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(withCors(async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization')!;
  const token = authHeader.replace('Bearer ', '');

  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', // TODO: patient's own timezone once available here
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const { data: result, error: rpcErr } = await service
    .schema('app')
    .rpc('patient_plan', { p_patient_auth_id: user.id, p_today: today });

  if (rpcErr) {
    return new Response(JSON.stringify({ error: 'internal_error', details: rpcErr.message }), { status: 500 });
  }
  if (!result) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  // Bucket-relative media paths (verified only — the RPC filtered) -> signed URLs,
  // returned API-origin-relative for the client to prefix. The private
  // exercise-media bucket isn't readable with a patient JWT.
  const exercises = Array.isArray(result.exercises) ? result.exercises : [];
  for (const ex of exercises) {
    const media = Array.isArray(ex?.media) ? ex.media : [];
    for (const m of media) {
      if (m.kind === 'video') continue; // url is a YouTube id, not a Storage path
      for (const field of ['url', 'thumb_url'] as const) {
        const path = m[field];
        if (typeof path === 'string' && path && !path.startsWith('http') && !path.startsWith('/storage/')) {
          const signedUrl = await getSignedMediaUrl(service, path);
          if (signedUrl) m[field] = signedUrl.replace(/^https?:\/\/[^/]+/, '');
        }
      }
    }
  }

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}));
