// Edge Function: register / remove a Web Push subscription for the caller.
//   POST   /device-tokens   { endpoint, keys:{p256dh,auth}, platform }  -> upsert
//   DELETE /device-tokens   { endpoint }                                -> remove
//
// The owner (user vs patient) and owner_id are taken from the JWT, never the
// body. A clinician JWT (app.user) registers a 'user' token; a patient JWT
// (app.patient_auth) registers a 'patient' token.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { getAuthUser } from '../_shared/auth.ts';
import { requireMfa } from '../_shared/mfa.ts';

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
  const mfaRefusal = await requireMfa(req, user);
  if (mfaRefusal) return mfaRefusal;

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Is this a clinician (app.user) or a patient (app.patient_auth)?
  const { data: clinRow } = await svc.schema('app').from('user').select('id').eq('id', user.id).maybeSingle();
  let ownerType: 'user' | 'patient';
  let ownerId: string;
  if (clinRow) {
    ownerType = 'user';
    ownerId = user.id;
  } else {
    const { data: pa } = await svc
      .schema('app')
      .from('patient_auth')
      .select('patient_id')
      .eq('id', user.id)
      .maybeSingle();
    if (!pa) {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }
    ownerType = 'patient';
    ownerId = pa.patient_id;
  }

  let body: { endpoint?: string; keys?: { p256dh: string; auth: string }; platform?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 });
  }
  if (!body.endpoint) {
    return new Response(JSON.stringify({ error: 'bad_request', details: 'endpoint required' }), { status: 400 });
  }

  if (req.method === 'DELETE') {
    await svc.schema('app').rpc('delete_device_token', { p_endpoint: body.endpoint });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    const { error } = await svc.schema('app').rpc('register_device_token', {
      p_owner_type: ownerType,
      p_owner_id: ownerId,
      p_endpoint: body.endpoint,
      p_keys: body.keys ?? {},
      p_platform: body.platform ?? 'web',
    });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
}));
