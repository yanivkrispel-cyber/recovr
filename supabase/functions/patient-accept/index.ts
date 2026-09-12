// Edge Function: patient invite acceptance. Public (verify_jwt=false) — the
// patient has no session yet.
//   GET  /patients/invite/:token          -> invite preview (name, clinician)
//   POST /patients/invite/:token/accept   -> {password, consent} -> activates

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Bump this when the consent copy in COPY.md changes materially.
const CONSENT_VERSION = '1.0';

interface AcceptInput {
  password: string;
  consent: boolean;
}

Deno.serve(withCors(async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === 'GET') {
    // .../patients/invite/:token — token is the last segment.
    const inviteToken = parts[parts.length - 1];
    if (!inviteToken) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const { data: invite, error } = await service.schema('app').rpc('resolve_invite', {
      p_token: inviteToken,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (invite?.error) {
      const code = invite.error === 'expired' ? 'token_expired' : 'not_found';
      return new Response(JSON.stringify({ error: code }), { status: 404 });
    }

    return new Response(
      JSON.stringify({ name: invite.name, clinician_name: invite.clinician_name }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (req.method === 'POST') {
    // .../patients/invite/:token/accept — token is second-to-last.
    const inviteToken = parts[parts.length - 2];
    if (!inviteToken) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const body: AcceptInput = await req.json();
    if (!body.password || body.password.length < 10 || !body.consent) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: invite, error: resolveErr } = await service
      .schema('app')
      .rpc('resolve_invite', { p_token: inviteToken });

    if (resolveErr) {
      return new Response(JSON.stringify({ error: 'internal_error', details: resolveErr.message }), { status: 500 });
    }
    if (invite?.error) {
      const code = invite.error === 'expired' ? 'token_expired' : 'not_found';
      return new Response(JSON.stringify({ error: code }), { status: 404 });
    }

    const { data: created, error: createErr } = await service.auth.admin.createUser({
      email: invite.email,
      password: body.password,
      email_confirm: true,
    });

    if (createErr || !created?.user) {
      return new Response(
        JSON.stringify({ error: 'validation_failed', details: createErr?.message }),
        { status: 422 },
      );
    }

    const { data: result, error: acceptErr } = await service
      .schema('app')
      .rpc('accept_patient_invite', {
        p_token: inviteToken,
        p_new_auth_user_id: created.user.id,
        p_consent_version: CONSENT_VERSION,
      });

    if (acceptErr || result?.error) {
      // Roll back the auth account so the invite can still be retried.
      await service.auth.admin.deleteUser(created.user.id);
      return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true, email: invite.email }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method not allowed', { status: 405 });
}));
