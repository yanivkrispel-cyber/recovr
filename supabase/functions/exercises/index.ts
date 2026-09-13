// Edge Function: exercise library (T-08, T-14).
//   GET  /exercises?q=&category=&region_id=&phase=&muscle=&protocol=  -> search
//   GET  /exercises/:id                                   -> full detail + media
//   POST /exercises                                       -> create clinic-custom exercise
//   POST /exercises/:id/duplicate                         -> clone into a clinic-owned copy
//   DELETE /exercises/:id                                 -> soft-delete a clinic-custom exercise
// Exercise picker (T-29):
//   GET  /exercises/recommend?protocol_id=&region_id=&phase=&anchor_ids=&exclude_ids=&limit=
//   GET  /exercises/recent?limit=
//   PUT|DELETE /exercises/:id/favorite
//   POST /exercises/picker-events

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { getSignedMediaUrl, getSignedMediaUrls } from '../_shared/signed-media-url.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Card = Record<string, unknown>;

const MAX_ID_LIST = 100;

// Picker/search cards carry Storage object paths (thumb_path / gif_path).
// Swap them for signed URLs relative to the API origin — same convention as
// the detail route below (the client prefixes its own Supabase URL).
// deno-lint-ignore no-explicit-any
async function withCardMedia(service: any, items: Card[]) {
  const isStoragePath = (p: unknown): p is string => typeof p === 'string' && p !== '' && !p.startsWith('http');
  const signed = await getSignedMediaUrls(service, items.flatMap((i) => [i.thumb_path, i.gif_path]).filter(isStoragePath));
  const resolve = (p: unknown): string | null => {
    if (typeof p !== 'string' || !p) return null;
    if (p.startsWith('http')) return p;
    const url = signed.get(p);
    return url ? url.replace(/^https?:\/\/[^/]+/, '') : null;
  };
  for (const item of items) {
    item.thumb_url = resolve(item.thumb_path);
    item.gif_url = resolve(item.gif_path);
    delete item.thumb_path;
    delete item.gif_path;
  }
}

// Comma-separated UUID list from a query param; null when any entry is malformed.
function parseIdList(raw: string | null): string[] | null {
  if (!raw) return [];
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length > MAX_ID_LIST || ids.some((id) => !UUID_RE.test(id))) return null;
  return ids;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface CreateInput {
  name: string;
  name_en?: string;
  category: string;
  body_region_id?: string;
  description?: string;
  instructions?: string;
  is_bilateral?: boolean;
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
        if (m.kind === 'video') continue; // url is a YouTube id, not a Storage path
        for (const field of ['url', 'thumb_url'] as const) {
          const path = m[field];
          if (typeof path === 'string' && path && !path.startsWith('http') && !path.startsWith('/storage/')) {
            // Return a path relative to the API origin; the client prefixes its
            // own configured Supabase URL. (Local storage signs URLs with an
            // internal docker host the browser can't resolve.)
            const signedUrl = await getSignedMediaUrl(service, path);
            if (signedUrl) m[field] = signedUrl.replace(/^https?:\/\/[^/]+/, '');
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

  if (req.method === 'GET' && url.pathname.endsWith('/recommend')) {
    const protocolId = url.searchParams.get('protocol_id');
    const regionId = url.searchParams.get('region_id');
    const phase = url.searchParams.get('phase');
    const limit = url.searchParams.get('limit');
    const anchorIds = parseIdList(url.searchParams.get('anchor_ids'));
    const excludeIds = parseIdList(url.searchParams.get('exclude_ids'));

    if ((protocolId && !UUID_RE.test(protocolId)) || (regionId && !UUID_RE.test(regionId))
        || (phase && !/^\d{1,3}$/.test(phase)) || anchorIds === null || excludeIds === null) {
      return json({ error: 'validation_failed' }, 422);
    }

    const { data: result, error } = await service.schema('app').rpc('recommend_exercises', {
      p_clinician_id: user.id,
      p_protocol_id: protocolId || null,
      p_body_region_id: regionId || null,
      p_phase_n: phase ? Number(phase) : null,
      p_anchor_ids: anchorIds,
      p_exclude_ids: excludeIds,
      p_limit: limit ? Number(limit) : undefined,
    });

    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (result?.error === 'forbidden') return json({ error: 'forbidden' }, 403);
    if (result?.error === 'not_found') return json({ error: 'not_found' }, 404);
    if (result?.error === 'validation_failed') return json({ error: 'validation_failed', message: result.message }, 422);

    await withCardMedia(service, result.items ?? []);
    return json(result);
  }

  if (req.method === 'GET' && url.pathname.endsWith('/recent')) {
    const limit = url.searchParams.get('limit');
    const { data: result, error } = await service.schema('app').rpc('recent_picked_exercises', {
      p_clinician_id: user.id,
      p_limit: limit ? Number(limit) : undefined,
    });

    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (result?.error === 'forbidden') return json({ error: 'forbidden' }, 403);

    await withCardMedia(service, result.items ?? []);
    return json(result);
  }

  if (req.method === 'GET') {
    const q = url.searchParams.get('q');
    const category = url.searchParams.get('category');
    const regionId = url.searchParams.get('region_id');
    const phase = url.searchParams.get('phase');
    const muscle = url.searchParams.get('muscle');
    const protocol = url.searchParams.get('protocol');
    const limit = url.searchParams.get('limit');
    const offset = url.searchParams.get('offset');
    const equipment = url.searchParams.get('equipment');
    const favoritesOnly = url.searchParams.get('favorites') === '1';
    const mediaOnly = url.searchParams.get('media') === '1';

    if (regionId && !UUID_RE.test(regionId)) {
      return new Response(JSON.stringify({ error: 'validation_failed', message: 'invalid_region_id' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('search_exercises', {
      p_clinician_id: user.id,
      p_query: q,
      p_category: category,
      p_body_region_id: regionId,
      p_phase_n: phase ? Number(phase) : null,
      p_muscle: muscle,
      p_protocol_slug: protocol,
      p_limit: limit ? Number(limit) : undefined,
      p_offset: offset ? Number(offset) : undefined,
      p_equipment: equipment,
      p_favorites_only: favoritesOnly,
      p_media_only: mediaOnly,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error === 'forbidden') {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }

    await withCardMedia(service, result.items ?? []);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if ((req.method === 'PUT' || req.method === 'DELETE') && url.pathname.endsWith('/favorite')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const exerciseId = parts[parts.length - 2];
    if (!exerciseId || !UUID_RE.test(exerciseId)) return json({ error: 'not_found' }, 404);

    const { data: result, error } = await service.schema('app').rpc('set_exercise_favorite', {
      p_clinician_id: user.id,
      p_exercise_id: exerciseId,
      p_on: req.method === 'PUT',
    });

    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (result?.error === 'forbidden') return json({ error: 'forbidden' }, 403);
    if (result?.error === 'not_found') return json({ error: 'not_found' }, 404);
    return json(result);
  }

  if (req.method === 'POST' && url.pathname.endsWith('/picker-events')) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'validation_failed' }, 422);

    const { data: result, error } = await service.schema('app').rpc('log_exercise_pick_events', {
      p_clinician_id: user.id,
      p_payload: body,
    });

    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (result?.error === 'forbidden') return json({ error: 'forbidden' }, 403);
    if (result?.error === 'validation_failed') return json({ error: 'validation_failed', message: result.message }, 422);
    return json(result, 201);
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

  if (req.method === 'PUT' && url.pathname.endsWith('/video')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const exerciseId = parts[parts.length - 2];
    if (!exerciseId || !UUID_RE.test(exerciseId)) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const body: { youtube_id?: string | null } = await req.json();

    const { data: result, error } = await service.schema('app').rpc('set_exercise_video', {
      p_clinician_id: user.id,
      p_exercise_id: exerciseId,
      p_youtube_id: body.youtube_id || null,
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
    if (result?.error === 'validation_failed') {
      return new Response(JSON.stringify({ error: 'validation_failed', message: result.message }), { status: 422 });
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'PUT') {
    const segs = url.pathname.split('/').filter(Boolean);
    const tail = segs[segs.length - 1];
    if (!(segs.length >= 2 && segs[segs.length - 2] === 'exercises' && UUID_RE.test(tail))) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const body: CreateInput = await req.json();
    if (!body.name || !body.category) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('update_custom_exercise', {
      p_clinician_id: user.id,
      p_exercise_id: tail,
      p_name: body.name,
      p_name_en: body.name_en ?? null,
      p_category: body.category,
      p_body_region_id: body.body_region_id ?? null,
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
    if (result?.error === 'not_found') {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    if (result?.error === 'validation_failed') {
      return new Response(JSON.stringify({ error: 'validation_failed', message: result.message }), { status: 422 });
    }

    return new Response(JSON.stringify(result), {
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
      p_body_region_id: body.body_region_id ?? null,
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
}));
