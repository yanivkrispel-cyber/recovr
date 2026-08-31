import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, t, tZodError, type LoginInput } from 'shared';
import { Button, Input, Card } from 'ui';
import { supabase } from '../App';

export default function Login() {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(data: LoginInput) {
    const { error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });
    if (error) {
      setError('password', { message: t('valid.login.failed') });
    }
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
      <Card padding={32} style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            style={{
              width: 48,
              height: 48,
              background: 'var(--navy)',
              borderRadius: 12,
              margin: '0 auto 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M14 4L4 8v6c0 5.5 4.3 10.6 10 12 5.7-1.4 10-6.5 10-12V8L14 4z" fill="var(--gold)" />
            </svg>
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--navy)', fontFamily: 'var(--font-display)' }}>
            RecoveryOS
          </h1>
          <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--muted)' }}>
            {t('auth.login.title')}
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="אימייל"
            type="email"
            autoComplete="email"
            {...register('email')}
            error={tZodError(errors.email?.message)}
          />
          <Input
            label="סיסמה"
            type="password"
            autoComplete="current-password"
            {...register('password')}
            error={tZodError(errors.password?.message)}
          />
          <Button type="submit" loading={isSubmitting} style={{ width: '100%', justifyContent: 'center' }}>
            {t('auth.login.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
