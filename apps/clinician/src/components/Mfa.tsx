// TOTP second factor for clinicians: the post-login code prompt, the
// enrollment flow (forced for admins, opt-in from Settings), and the
// Settings section. The server enforces the policy (supabase/functions/
// _shared/mfa.ts); these screens only get the session to aal2.
//
// A successful challengeAndVerify() emits MFA_CHALLENGE_VERIFIED, which the
// auth listener in App.tsx picks up to re-resolve the session — so the
// gate screens don't navigate on their own.

import { useContext, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Button, Card, Input, Logo } from 'ui';
import { SupabaseContext } from '../App';

const CODE_RE = /^\d{6}$/;

function GateLayout({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--sand)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'var(--font-ui)' }}>
      <Card padding={32} style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <Logo height={64} style={{ display: 'block', margin: '0 auto' }} />
        </div>
        {children}
        <div style={{ marginTop: 18, textAlign: 'center' }}>
          <button type="button" onClick={onSignOut} style={linkStyle}>יציאה · Sign out</button>
        </div>
      </Card>
    </div>
  );
}

function CodeForm({ busy, error, submitLabel, onSubmit, children }: {
  busy: boolean;
  error: string;
  submitLabel: string;
  onSubmit: (code: string) => void;
  children?: ReactNode;
}) {
  const [code, setCode] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    if (CODE_RE.test(code)) onSubmit(code);
  }
  useEffect(() => {
    if (error) setCode('');
  }, [error]);
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {children}
      <Input
        label="קוד אימות (6 ספרות)"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        dir="ltr"
        style={{ letterSpacing: '0.3em', textAlign: 'center', fontSize: 18 }}
        error={error || undefined}
      />
      <Button type="submit" loading={busy} disabled={busy || !CODE_RE.test(code)} style={{ width: '100%', justifyContent: 'center' }}>
        {submitLabel}
      </Button>
    </form>
  );
}

/** Post-password prompt for users who already have a verified factor. */
export function MfaChallenge({ onSignOut }: { onSignOut: () => void }) {
  const supabase = useContext(SupabaseContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function verify(code: string) {
    setBusy(true);
    setError('');
    const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp[0];
    if (listErr || !factor) {
      setError('לא נמצא אמצעי אימות לחשבון. פנה/י למנהל המערכת.');
      setBusy(false);
      return;
    }
    const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (verifyErr) {
      setError('הקוד שגוי או שפג תוקפו. נסה/י שוב.');
      setBusy(false);
    }
  }

  return (
    <GateLayout onSignOut={onSignOut}>
      <h2 style={titleStyle}>אימות דו-שלבי</h2>
      <p style={hintStyle}>הזן/י את הקוד מאפליקציית האימות שלך. · <bdi>Enter the code from your authenticator app.</bdi></p>
      <CodeForm busy={busy} error={error} submitLabel="אימות · Verify" onSubmit={verify} />
    </GateLayout>
  );
}

interface PendingFactor {
  id: string;
  qr: string;
  secret: string;
}

/**
 * Enrollment: creates a TOTP factor, shows the QR/secret, verifies the first
 * code. Used as a full-page gate (`required`, admins) or inline in Settings.
 */
export function MfaEnroll({ required, onSignOut, onDone, onCancel }: {
  required: boolean;
  onSignOut?: () => void;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const supabase = useContext(SupabaseContext);
  const [pending, setPending] = useState<PendingFactor | null>(null);
  const [setupError, setSetupError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Drop abandoned, never-verified factors from earlier attempts first.
      const { data: factors } = await supabase.auth.mfa.listFactors();
      for (const f of factors?.all ?? []) {
        if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      if (cancelled) return;
      const { data, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `ReCOVR ${crypto.randomUUID().slice(0, 8)}`,
      });
      if (cancelled) {
        if (data) void supabase.auth.mfa.unenroll({ factorId: data.id });
        return;
      }
      if (enrollErr || !data) {
        setSetupError('לא ניתן להתחיל הגדרת אימות דו-שלבי כרגע. נסה/י שוב מאוחר יותר.');
        return;
      }
      setPending({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function verify(code: string) {
    if (!pending) return;
    setBusy(true);
    setError('');
    const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({ factorId: pending.id, code });
    setBusy(false);
    if (verifyErr) {
      setError('הקוד שגוי. ודא/י שהשעון במכשיר מדויק ונסה/י שוב.');
      return;
    }
    onDone?.();
  }

  async function cancel() {
    if (pending) await supabase.auth.mfa.unenroll({ factorId: pending.id });
    onCancel?.();
  }

  const body = (
    <>
      {required && (
        <>
          <h2 style={titleStyle}>הגדרת אימות דו-שלבי</h2>
          <p style={hintStyle}>חשבונות מנהל מחויבים באימות דו-שלבי. · <bdi>Admin accounts require two-factor authentication.</bdi></p>
        </>
      )}
      <ol style={{ margin: '0 0 14px', paddingInlineStart: 18, fontSize: 13, color: 'var(--ink)', lineHeight: 1.7 }}>
        <li>פתח/י אפליקציית אימות, למשל <bdi>Google Authenticator</bdi> או <bdi>Microsoft Authenticator</bdi>.</li>
        <li>סרוק/י את הקוד, או הזן/י את המפתח ידנית.</li>
        <li>הזן/י את הקוד בן 6 הספרות שמופיע באפליקציה.</li>
      </ol>
      {setupError ? (
        <p style={{ ...hintStyle, color: 'var(--danger)' }}>{setupError}</p>
      ) : !pending ? (
        <p style={hintStyle}>טוען…</p>
      ) : (
        <CodeForm busy={busy} error={error} submitLabel="הפעלה · Enable" onSubmit={verify}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <img src={pending.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ background: 'var(--white)', borderRadius: 8, padding: 8 }} />
            <code dir="ltr" style={{ fontSize: 12, wordBreak: 'break-all', textAlign: 'center', color: 'var(--nav-inactive-text)' }}>{pending.secret}</code>
          </div>
        </CodeForm>
      )}
      {!required && (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => void cancel()} style={linkStyle}>ביטול · Cancel</button>
        </div>
      )}
    </>
  );

  return required ? <GateLayout onSignOut={onSignOut ?? (() => {})}>{body}</GateLayout> : body;
}

/** Settings → two-factor section. */
export function MfaSettings({ required, onChanged }: { required: boolean; onChanged: () => void }) {
  const supabase = useContext(SupabaseContext);
  const [factorId, setFactorId] = useState<string | null | undefined>(undefined);
  const [enrolling, setEnrolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const { data } = await supabase.auth.mfa.listFactors();
    setFactorId(data?.totp[0]?.id ?? null);
  }
  useEffect(() => {
    void load();
  }, []);

  async function disable() {
    if (!factorId) return;
    setBusy(true);
    setError('');
    const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId });
    if (unenrollErr) {
      setError('לא ניתן לבטל כרגע. נסה/י שוב.');
      setBusy(false);
      return;
    }
    // The session still says aal2; refresh so it reflects the removed factor.
    await supabase.auth.refreshSession();
    setBusy(false);
    await load();
    onChanged();
  }

  if (factorId === undefined) return <div style={hintStyle}>טוען…</div>;

  if (enrolling) {
    return (
      <MfaEnroll
        required={false}
        onDone={() => {
          setEnrolling(false);
          void load();
          onChanged();
        }}
        onCancel={() => setEnrolling(false)}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <div style={{ fontSize: 13, color: 'var(--ink)' }}>
        {factorId ? 'פעיל ✓ · Enabled' : 'כבוי · Off'}
        {required && <span style={{ marginInlineStart: 8, fontSize: 12, color: 'var(--nav-inactive-text)' }}>(חובה לחשבון מנהל)</span>}
      </div>
      {factorId ? (
        !required && (
          <Button variant="secondary" size="sm" loading={busy} disabled={busy} onClick={() => void disable()}>
            כיבוי · Turn off
          </Button>
        )
      ) : (
        <Button size="sm" onClick={() => setEnrolling(true)}>הפעלה · Turn on</Button>
      )}
      {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}
    </div>
  );
}

const titleStyle: CSSProperties = { margin: '0 0 6px', fontSize: 18, fontWeight: 700, color: 'var(--ink)', textAlign: 'center' };
const hintStyle: CSSProperties = { margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.6 };
const linkStyle: CSSProperties = { background: 'none', border: 'none', color: 'var(--gold-deep)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0 };
