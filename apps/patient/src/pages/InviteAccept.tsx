import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { patientAcceptSchema, t, tZodError, type PatientAcceptInput } from 'shared';
import { Button, Input, Card, Checkbox, Skeleton, EmptyState, QueryError } from 'ui';
import { supabase } from '../App';

interface InviteAcceptProps {
  token: string;
  onDone: () => void;
}

interface InvitePreview {
  name: string;
  clinician_name: string;
}

export default function InviteAccept({ token, onDone }: InviteAcceptProps) {
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<'expired' | 'not_found' | 'network' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting, isValid },
  } = useForm<PatientAcceptInput>({ resolver: zodResolver(patientAcceptSchema), mode: 'onTouched' });

  useEffect(() => {
    let cancelled = false;
    setInvite(null);
    setLoadError(null);
    supabase.functions
      .invoke(`patient-accept/patients/invite/${token}`, { method: 'GET' })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setLoadError('network');
          return;
        }
        if (data?.error) {
          setLoadError(data.error === 'token_expired' ? 'expired' : 'not_found');
          return;
        }
        setInvite(data);
      });
    return () => {
      cancelled = true;
    };
  }, [token, reloadKey]);

  async function onSubmit(input: PatientAcceptInput) {
    setSubmitError(null);
    const { data, error } = await supabase.functions.invoke(
      `patient-accept/patients/invite/${token}/accept`,
      { method: 'POST', body: { password: input.password, consent: input.consent } },
    );

    if (error || data?.error) {
      setSubmitError(
        data?.error === 'token_expired' ? t('valid.token.expired') : t('error.generic.body'),
      );
      return;
    }

    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: input.password,
    });
    if (signInErr) {
      setSubmitError(t('error.generic.body'));
      return;
    }

    onDone();
  }

  if (loadError) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', padding: 24 }}>
        {loadError === 'network' ? (
          <QueryError
            title={t('error.generic.title')}
            body={t('error.generic.body')}
            retryLabel={t('error.generic.action')}
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        ) : (
          <EmptyState
            title={loadError === 'expired' ? t('valid.token.expired') : t('error.notfound.title')}
            body={loadError === 'expired' ? undefined : t('error.notfound.body')}
          />
        )}
      </div>
    );
  }

  if (!invite) {
    return (
      <div style={{ padding: 24, paddingTop: 60 }}>
        <Skeleton width="70%" height={28} />
        <div style={{ marginTop: 24 }}>
          <Skeleton count={3} height={48} />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--cream)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        fontFamily: 'var(--font-ui)',
        direction: 'rtl',
      }}
    >
      <Card padding={28} style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 700,
              color: 'var(--navy)',
              fontFamily: 'var(--font-display)',
            }}
          >
            {t('auth.invite.title')}
          </h1>
          <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--muted)' }}>
            {t('auth.invite.body', { clinician: invite.clinician_name })}
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="סיסמה"
            type="password"
            autoComplete="new-password"
            {...register('password')}
            error={tZodError(errors.password?.message)}
          />
          <Input
            label="אימות סיסמה"
            type="password"
            autoComplete="new-password"
            {...register('confirmPassword')}
            error={tZodError(errors.confirmPassword?.message)}
          />

          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
            {t('disclaimer.clinical')}
          </p>

          <Checkbox
            label={t('auth.consent.label')}
            checked={!!watch('consent')}
            {...register('consent')}
          />
          {errors.consent && (
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>
              {tZodError(errors.consent.message)}
            </span>
          )}

          {submitError && (
            <span style={{ fontSize: 13, color: 'var(--danger)' }}>{submitError}</span>
          )}

          <Button type="submit" loading={isSubmitting} disabled={!isValid || isSubmitting} style={{ width: '100%', justifyContent: 'center' }}>
            {t('auth.invite.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
