// Edge Function: protocol library.
//   GET    /protocols                  -> protocol options for the "add patient" wizard
//   GET    /protocols/manage           -> flat list (incl. archived) for the management screen
//   GET    /protocols/:id              -> full nested detail (incl. criteria) for the editor
//   POST   /protocols                  -> create a clinic-owned protocol
//   PATCH  /protocols/:id              -> replace-all update of a clinic-owned protocol
//   DELETE /protocols/:id              -> archive (soft delete)
//   POST   /protocols/:id/restore      -> unarchive
//   POST   /protocols/:id/duplicate    -> clone into an editable clinic copy
//   POST   /protocols/:id/exercises    -> "quick attach" an exercise to one phase

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface ProtocolPayload {
  name: string;
  name_en?: string;
  region?: string;
  region_en?: string;
  phases: unknown[];
}

function errorStatus(err: string | undefined): number {
  if (err === 'forbidden') return 403;
  if (err === 'not_found') return 404;
  if (err === 'validation_failed') return 422;
  return 500;
}

Deno.serve(withCors(async (req) => {
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
  const url = new URL(req.url);
  const segs = url.pathname.split('/').filter(Boolean);
  // segs[0] is always 'protocols' (the function name) behind the /functions/v1 prefix.
  const rest = segs.slice(segs.indexOf('protocols') + 1);

  if (req.method === 'GET' && rest.length === 0) {
    const { data: result, error } = await service.schema('app').rpc('protocol_options', {
      p_clinician_id: user.id,
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'GET' && rest.length === 1 && rest[0] === 'manage') {
    const { data: result, error } = await service.schema('app').rpc('protocol_library', {
      p_clinician_id: user.id,
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'GET' && rest.length === 1 && UUID_RE.test(rest[0])) {
    const { data: result, error } = await service.schema('app').rpc('protocol_detail', {
      p_clinician_id: user.id,
      p_protocol_id: rest[0],
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST' && rest.length === 2 && UUID_RE.test(rest[0]) && rest[1] === 'duplicate') {
    const { data: result, error } = await service.schema('app').rpc('protocol_duplicate', {
      p_clinician_id: user.id,
      p_protocol_id: rest[0],
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST' && rest.length === 2 && UUID_RE.test(rest[0]) && rest[1] === 'restore') {
    const { data: result, error } = await service.schema('app').rpc('protocol_set_active', {
      p_clinician_id: user.id,
      p_protocol_id: rest[0],
      p_is_active: true,
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST' && rest.length === 2 && UUID_RE.test(rest[0]) && rest[1] === 'exercises') {
    const body: { exercise_id?: string; phase_n?: number } = await req.json();
    if (!body.exercise_id || !UUID_RE.test(body.exercise_id) || !Number.isInteger(body.phase_n)) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }
    const { data: result, error } = await service.schema('app').rpc('attach_exercise_to_protocol_phase', {
      p_clinician_id: user.id,
      p_exercise_id: body.exercise_id,
      p_protocol_id: rest[0],
      p_phase_n: body.phase_n,
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST' && rest.length === 0) {
    const body: ProtocolPayload = await req.json();
    if (!body.name || !Array.isArray(body.phases)) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }
    const { data: result, error } = await service.schema('app').rpc('protocol_create', {
      p_clinician_id: user.id,
      p_name: body.name,
      p_name_en: body.name_en ?? null,
      p_region: body.region ?? null,
      p_region_en: body.region_en ?? null,
      p_phases: body.phases,
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH' && rest.length === 1 && UUID_RE.test(rest[0])) {
    const body: ProtocolPayload = await req.json();
    if (!body.name || !Array.isArray(body.phases)) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }
    const { data: result, error } = await service.schema('app').rpc('protocol_update', {
      p_clinician_id: user.id,
      p_protocol_id: rest[0],
      p_name: body.name,
      p_name_en: body.name_en ?? null,
      p_region: body.region ?? null,
      p_region_en: body.region_en ?? null,
      p_phases: body.phases,
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'DELETE' && rest.length === 1 && UUID_RE.test(rest[0])) {
    const { data: result, error } = await service.schema('app').rpc('protocol_set_active', {
      p_clinician_id: user.id,
      p_protocol_id: rest[0],
      p_is_active: false,
    });
    if (error) return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    if (result?.error) return new Response(JSON.stringify(result), { status: errorStatus(result.error) });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
}));
