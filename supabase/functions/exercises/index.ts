// Edge Function: exercise library (T-08, T-14).
//   GET  /exercises?q=&category=&region=&phase=&muscle=&protocol=  -> search
//   GET  /exercises/:id                                   -> full detail + media
//   POST /exercises                                       -> create clinic-custom exercise
//   POST /exercises/:id/duplicate                         -> clone into a clinic-owned copy
//   DELETE /exercises/:id                                 -> soft-delete a clinic-custom exercise

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface CreateInput {
  name: string;
  name_en?: string;
  category: string;
  region?: string;
  description?: string;
  instructions?: string;
  is_bilateral?: boolean;
}

Deno.serve(async (req) => {
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

  if (req.method === 'GET') {
    const segs = url.pathname.split('/').filter(Boolean);
    const tail = segs[segs.length - 1];
    if (segs.length >= 2 && segs[segs.length - 2] === 'exercises' && UUID_RE.test(tail)) {
      const { data: result, error } = await service.schema('app').rpc('get_exercise', {
        p_clinician_id: user.id,
        p_exercise_id: tail,
      });

      if (error) {
        return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
      }
      if (result?.error === 'forbidden') {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
      }
      if (!result || result.error === 'not_found') {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }

      // Mint short-lived signed URLs for the private exercise-media bucket so
      // the client never needs storage access. The `verified` flag on each
      // media row is untouched — the patient-facing gate lives elsewhere.
      const media = Array.isArray(result.media) ? result.media : [];
      for (const m of media) {
        for (const field of ['url', 'thumb_url'] as const) {
          const path = m[field];
          if (typeof path === 'string' && path && !path.startsWith('http') && !path.startsWith('/storage/')) {
            const { data: signed } = await service.storage.from('exercise-media').createSignedUrl(path, 3600);
            // Return a path relative to the API origin; the client prefixes its
            // own configured Supabase URL. (Local storage signs URLs with an
            // internal docker host the browser can't resolve.)
            if (signed?.signedUrl) m[field] = signed.signedUrl.replace(/^https?:\/\/[^/]+/, '');
          }
        }
      }

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (req.method === 'GET' && url.pathname.endsWith('/filter-options')) {
    const { data: result, error } = await service.schema('app').rpc('exercise_filter_options', {
      p_clinician_id: user.id,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error === 'forbidden') {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'GET') {
    const q = url.searchParams.get('q');
    const category = url.searchParams.get('category');
    const region = url.searchParams.get('region');
    const phase = url.searchParams.get('phase');
    const muscle = url.searchParams.get('muscle');
    const protocol = url.searchParams.get('protocol');

    const { data: result, error } = await service.schema('app').rpc('search_exercises', {
      p_clinician_id: user.id,
      p_query: q,
      p_category: category,
      p_region: region,
      p_phase_n: phase ? Number(phase) : null,
      p_muscle: muscle,
      p_protocol_slug: protocol,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error === 'forbidden') {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST' && url.pathname.endsWith('/duplicate')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const exerciseId = parts[parts.length - 2];
    if (!exerciseId) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const { data: result, error } = await service.schema('app').rpc('duplicate_exercise', {
      p_clinician_id: user.id,
      p_exercise_id: exerciseId,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error === 'forbidden') {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }
    if (result?.error === 'not_found') {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    const body: CreateInput = await req.json();
    if (!body.name || !body.category) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('create_custom_exercise', {
      p_clinician_id: user.id,
      p_name: body.name,
      p_name_en: body.name_en ?? null,
      p_category: body.category,
      p_region: body.region ?? null,
      p_description: body.description ?? null,
      p_instructions: body.instructions ?? null,
      p_is_bilateral: body.is_bilateral ?? false,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error === 'forbidden') {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }
    if (result?.error === 'validation_failed') {
      return new Response(JSON.stringify({ error: 'validation_failed', message: result.message }), { status: 422 });
    }

    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'DELETE') {
    const segs = url.pathname.split('/').filter(Boolean);
    const tail = segs[segs.length - 1];
    if (!(segs.length >= 2 && segs[segs.length - 2] === 'exercises' && UUID_RE.test(tail))) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const { data: result, error } = await service.schema('app').rpc('delete_custom_exercise', {
      p_clinician_id: user.id,
      p_exercise_id: tail,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error === 'forbidden') {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }
    if (result?.error === 'not_found') {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method not allowed', { status: 405 });
});
