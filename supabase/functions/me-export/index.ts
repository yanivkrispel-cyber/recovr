// Edge Function: patient data export (RULES §7 — "export ... endpoints exist
// from v1"). GET /me-export -> the caller's full data as one JSON download.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { getAuthUser } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(withCors(async (req) => {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const user = await getAuthUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await svc.schema('app').rpc('export_my_data', { p_patient_auth_id: user.id });
  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (data?.error === 'unauthorized') {
    return new Response(JSON.stringify(data), { status: 401 });
  }

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="recoveryos-my-data.json"',
    },
  });
}));
