import { useState, useContext } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, t, tZodError, type LoginInput } from 'shared';
import { SupabaseContext } from '../App';
import { Button } from 'ui';
import { Input } from 'ui';
import { Card } from 'ui';
import { Logo } from 'ui';

export default function Login() {
  const supabase = useContext(SupabaseContext);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isValid },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema), mode: 'onTouched' });

  const [resetSent, setResetSent] = useState(false);

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
        minHeight: '100dvh',
        background: 'var(--sand)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        fontFamily: 'var(--font-ui)',
      }}
    >
      <Card
        padding={32}
        style={{ width: '100%', maxWidth: 400 }}
      >
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <Logo height={88} style={{ display: 'block', margin: '0 auto' }} />
          <p style={{ margin: '14px 0 0', fontSize: 14, color: 'var(--muted)' }}>
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
          <Button
            type="submit"
            loading={isSubmitting}
            disabled={!isValid || isSubmitting}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {t('auth.login.submit')}
          </Button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <a
            href="#"
            style={{
              color: 'var(--gold-deep)',
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            {t('auth.forgot.link')}
          </a>
        </div>
      </Card>
    </div>
  );
}
