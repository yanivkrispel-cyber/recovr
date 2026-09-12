// Edge Function: POST /plan-templates — save the current phase's exercise
// set as a reusable template. GET/DELETE (list, remove) aren't built yet —
// nothing in the editor offers "apply a saved template" yet either; this
// covers exactly the "save as template" action T-07 asks for.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface Input {
  name: string;
  payload: unknown;
}

Deno.serve(withCors(async (req) => {
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

  const body: Input = await req.json();
  if (!body.name || !body.payload) {
    return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
  }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: result, error } = await service.schema('app').rpc('save_plan_template', {
    p_clinician_id: user.id,
    p_name: body.name,
    p_payload: body.payload,
  });

  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (result?.error === 'forbidden') {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  return new Response(JSON.stringify(result), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}));
