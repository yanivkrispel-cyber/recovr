import { useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Skeleton, EmptyState } from 'ui';
import { t, thresholdOptions, type Units } from 'shared';
import { AuthContext, SupabaseContext } from '../App';
import AppShell from '../components/AppShell';

interface Settings {
  adherence_threshold: number;
  units: Units;
  assessment_interval_days: number;
  alerts: {
    adherence_drop: boolean;
    pain_spike: boolean;
    ready_for_advance: boolean;
    inactive: boolean;
    assessment_overdue: boolean;
  };
  weekly_digest: boolean;
}

const ALERT_LABELS: Record<keyof Settings['alerts'], string> = {
  adherence_drop: 'ירידה בהיענות',
  pain_spike: 'דיווח כאב גבוה',
  ready_for_advance: 'מוכן למעבר שלב',
  inactive: 'חוסר פעילות',
  assessment_overdue: 'הערכה באיחור',
};

export default function Settings() {
  const { user } = useContext(AuthContext);
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Settings | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('settings', { method: 'GET' });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data as Settings;
    },
  });

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: async (patch: Partial<Settings>) => {
      const { data, error } = await supabase.functions.invoke('settings', { method: 'PATCH', body: patch });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data as Settings;
    },
    onSuccess: (next) => {
      setForm(next);
      queryClient.setQueryData(['settings'], next);
      setSavedAt(Date.now());
    },
  });

  if (!user) return null;

  return (
    <AppShell user={user}>
      <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>
          הגדרות <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>Settings</span>
        </div>

        {isLoading || !form ? (
          <Skeleton count={6} height={22} />
        ) : error ? (
          <EmptyState title={t('error.generic.title')} body={t('error.generic.body')} />
        ) : (
          <>
            <Section title="סף היענות · Adherence threshold" hint="מתחת לסף נשלחת התראת ירידת היענות (RULES §1).">
              <select
                value={form.adherence_threshold}
                onChange={(e) => save.mutate({ adherence_threshold: Number(e.target.value) })}
                style={selectStyle}
              >
                {thresholdOptions().map((n) => (
                  <option key={n} value={n}>{n}%</option>
                ))}
              </select>
            </Section>

            <Section title="יחידות · Units" hint="תצוגת מדידות אורך.">
              <div style={{ display: 'flex', gap: 8 }}>
                {(['metric', 'imperial'] as Units[]).map((u) => (
                  <button
                    key={u}
                    onClick={() => save.mutate({ units: u })}
                    style={chipStyle(form.units === u)}
                  >
                    {u === 'metric' ? 'מטרי (ס״מ)' : 'אימפריאלי (אינץ׳)'}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="מרווח הערכות · Assessment interval" hint="ימים עד שהערכה נחשבת באיחור.">
              <select
                value={form.assessment_interval_days}
                onChange={(e) => save.mutate({ assessment_interval_days: Number(e.target.value) })}
                style={selectStyle}
              >
                {[7, 14, 21, 28, 42, 60, 90].map((n) => (
                  <option key={n} value={n}>{n} ימים</option>
                ))}
              </select>
            </Section>

            <Section title="התראות · Alerts" hint="דיווח כאב גבוה תמיד פעיל ואינו ניתן לכיבוי.">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(Object.keys(ALERT_LABELS) as (keyof Settings['alerts'])[]).map((k) => {
                  const locked = k === 'pain_spike';
                  return (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--ink)', opacity: locked ? 0.6 : 1 }}>
                      <input
                        type="checkbox"
                        checked={form.alerts[k]}
                        disabled={locked || save.isPending}
                        onChange={(e) => save.mutate({ alerts: { ...form.alerts, [k]: e.target.checked } })}
                      />
                      {ALERT_LABELS[k]}
                    </label>
                  );
                })}
              </div>
            </Section>

            <Section title="סיכום שבועי במייל · Weekly digest" hint="נשלח בראשון 08:00, ללא שמות או נתונים קליניים.">
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--ink)' }}>
                <input
                  type="checkbox"
                  checked={form.weekly_digest}
                  disabled={save.isPending}
                  onChange={(e) => save.mutate({ weekly_digest: e.target.checked })}
                />
                שלח לי סיכום שבועי
              </label>
            </Section>

            <div style={{ fontSize: 12, color: save.isError ? 'var(--flag-red)' : 'var(--nav-inactive-text)', minHeight: 16 }}>
              {save.isPending ? 'שומר…' : save.isError ? 'שמירה נכשלה' : savedAt ? 'נשמר ✓' : ''}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--shell-border-soft)', paddingBottom: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>{hint}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

const selectStyle: CSSProperties = {
  padding: '8px 12px',
  border: '1px solid var(--shell-border)',
  borderRadius: 8,
  background: 'var(--cream)',
  fontFamily: 'inherit',
  fontSize: 13,
};

function chipStyle(active: boolean): CSSProperties {
  return active
    ? { padding: '7px 15px', borderRadius: 'var(--radius-pill)', background: 'var(--gold-deep)', color: 'var(--cream)', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }
    : { padding: '7px 15px', borderRadius: 'var(--radius-pill)', background: 'transparent', border: '1px solid var(--line-input)', color: 'var(--nav-inactive-text)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' };
}
