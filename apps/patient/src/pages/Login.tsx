import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, t, tZodError, type LoginInput } from 'shared';
import { Button, Input, Card, Logo } from 'ui';
import { supabase } from '../App';

export default function Login() {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isValid },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema), mode: 'onTouched' });

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
          <Logo height={46} style={{ display: 'block', margin: '0 auto' }} />
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
          <Button type="submit" loading={isSubmitting} disabled={!isValid || isSubmitting} style={{ width: '100%', justifyContent: 'center' }}>
            {t('auth.login.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
