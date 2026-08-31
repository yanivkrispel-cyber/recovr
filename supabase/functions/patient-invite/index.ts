// Edge Function: POST /patients (invite part — full create+assign-protocol
// flow per API_CONTRACT.md is M1 T-07 territory; this covers only what
// T-03 needs: create the patient stub and send an invite).

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface Input {
  name: string;
  email: string;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
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

  const { data: roleRow } = await userClient
    .schema('app')
    .from('user')
    .select('role')
    .eq('id', user.id)
    .single();
  if (!roleRow || !['clinician', 'admin'].includes(roleRow.role)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const body: Input = await req.json();
  if (!body.name || !body.email) {
    return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
  }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: result, error } = await service.schema('app').rpc('invite_patient', {
    p_clinician_id: user.id,
    p_name: body.name,
    p_email: body.email,
  });

  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (result?.error) {
    const status = result.error === 'forbidden' ? 403 : 404;
    return new Response(JSON.stringify({ error: result.error }), { status });
  }

  // TODO(T-18 Notifications): email the invite link
  // (`/m/invite/${result.invite_token}`) once an email provider is wired
  // up. Returned in the response for now so the flow is testable end to
  // end without one.
  return new Response(JSON.stringify(result), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
});
