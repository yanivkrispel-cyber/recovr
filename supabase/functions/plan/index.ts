// Edge Function: patient plan (T-07).
//   GET   /patients/:id/plan?version=N   -> app.get_plan (N omitted = current)
//   POST  /patients/:id/plan/versions    -> app.save_plan_version_phases, atomic
//         body {base_version, phases: [{phase_n, exercises, removal_reasons?, criteria?}], note?};
//         the older single-phase body {base_version, phase_n, exercises, ...} is still accepted
//   PATCH /patients/:id/plan             -> app.rename_patient_pathology and/or app.update_patient_note
//   GET   /patients/:id/plan/template-diff   -> app.plan_template_diff (protocol changes since the plan's base version)
//   POST  /patients/:id/plan/template-update -> app.apply_plan_template_update
//         body {base_version, protocol_version_id, accept: [change keys], note?}

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { getAuthUser } from '../_shared/auth.ts';
import { requireMfa } from '../_shared/mfa.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface PhaseEdit {
  phase_n: number;
  exercises: unknown[];
  removal_reasons?: Record<string, string>;
  criteria?: unknown[] | null;
}

interface SaveInput extends Partial<PhaseEdit> {
  base_version: number;
  phases?: PhaseEdit[];
  note?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(withCors(async (req) => {
  const user = await getAuthUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const mfaRefusal = await requireMfa(req, user);
  if (mfaRefusal) return mfaRefusal;

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const last = parts[parts.length - 1];

  if (req.method === 'GET' && last === 'template-diff') {
    const patientId = parts[parts.length - 3];
    const { data: result, error } = await service.schema('app').rpc('plan_template_diff', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
    });
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (result?.error) return json(result, result.error === 'forbidden' ? 403 : 404);
    // RULES §7: shows plan contents, audited like GET /plan.
    await service.schema('app').rpc('audit_read', {
      p_actor_type: 'clinician',
      p_actor_id: user.id,
      p_entity_type: 'plan',
      p_entity_id: patientId,
    });
    return json(result);
  }

  if (req.method === 'POST' && last === 'template-update') {
    const patientId = parts[parts.length - 3];
    const body = await req.json().catch(() => ({})) as {
      base_version?: unknown; protocol_version_id?: unknown; accept?: unknown; note?: unknown;
    };
    if (
      typeof body.base_version !== 'number' ||
      typeof body.protocol_version_id !== 'string' ||
      !Array.isArray(body.accept) || body.accept.some((k) => typeof k !== 'string')
    ) {
      return json({ error: 'validation_failed' }, 422);
    }
    const { data: result, error } = await service.schema('app').rpc('apply_plan_template_update', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
      p_base_version: body.base_version,
      p_target_version_id: body.protocol_version_id,
      p_accept: body.accept,
      p_note: typeof body.note === 'string' ? body.note : null,
    });
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (result?.error) {
      const status = result.error === 'forbidden' ? 403
        : result.error === 'not_found' ? 404
        : result.error === 'plan_version_conflict' || result.error === 'template_changed' ? 409
        : 422;
      return json(result, status);
    }
    return json(result);
  }

  if (req.method === 'GET') {
    // .../patients/:id/plan — id is second-to-last segment.
    const patientId = parts[parts.length - 2];
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    const versionParam = url.searchParams.get('version');

    const { data: result, error } = await service.schema('app').rpc('get_plan', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
      p_version: versionParam ? Number(versionParam) : null,
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

    // RULES §7: a clinician read of a patient record is audited.
    await service.schema('app').rpc('audit_read', {
      p_actor_type: 'clinician',
      p_actor_id: user.id,
      p_entity_type: 'plan',
      p_entity_id: patientId,
    });

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    // .../patients/:id/plan/versions — id is 3rd-from-last segment.
    const patientId = parts[parts.length - 3];
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const body: SaveInput = await req.json();
    const phases: PhaseEdit[] | null = Array.isArray(body.phases)
      ? body.phases
      : typeof body.phase_n === 'number' && Array.isArray(body.exercises)
        ? [{ phase_n: body.phase_n, exercises: body.exercises, removal_reasons: body.removal_reasons, criteria: body.criteria }]
        : null;
    if (
      typeof body.base_version !== 'number' ||
      !phases ||
      phases.length === 0 ||
      phases.some((p) => typeof p?.phase_n !== 'number' || !Array.isArray(p.exercises))
    ) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('save_plan_version_phases', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
      p_base_version: body.base_version,
      p_phases: phases.map((p) => ({
        phase_n: p.phase_n,
        exercises: p.exercises,
        removal_reasons: p.removal_reasons ?? {},
        criteria: p.criteria ?? null,
      })),
      p_note: body.note ?? null,
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
    if (result?.error === 'plan_version_conflict') {
      return new Response(
        JSON.stringify({ error: 'plan_version_conflict', current_version: result.current_version }),
        { status: 409 },
      );
    }
    if (result?.error === 'validation_failed' || result?.error === 'phase_not_found') {
      return new Response(
        JSON.stringify({ error: 'validation_failed', message: result.message ?? result.error, phase_n: result.phase_n }),
        { status: 422 },
      );
    }

    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'PATCH') {
    // .../patients/:id/plan — id is second-to-last segment.
    const patientId = parts[parts.length - 2];
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const body = await req.json().catch(() => ({})) as { name?: unknown; intake_note?: unknown };
    const hasName = typeof body.name === 'string' && body.name.trim() !== '';
    const hasNote = typeof body.intake_note === 'string';
    if (!hasName && !hasNote) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    let merged: Record<string, unknown> = {};

    if (hasName) {
      const { data: result, error } = await service.schema('app').rpc('rename_patient_pathology', {
        p_clinician_id: user.id,
        p_patient_id: patientId,
        p_name: body.name,
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
      if (result?.error === 'not_custom') {
        return new Response(JSON.stringify({ error: 'not_custom' }), { status: 422 });
      }
      if (result?.error === 'validation_failed') {
        return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
      }
      merged = { ...merged, ...result };
    }

    if (hasNote) {
      const { data: result, error } = await service.schema('app').rpc('update_patient_note', {
        p_clinician_id: user.id,
        p_patient_id: patientId,
        p_note: body.intake_note,
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
        return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
      }
      merged = { ...merged, ...result };
    }

    return new Response(JSON.stringify(merged), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method not allowed', { status: 405 });
}));
