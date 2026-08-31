import { useContext, useState, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { t } from 'shared';
import { Badge, Button, EmptyState, Skeleton } from 'ui';
import type { Alert } from 'shared';
import { SupabaseContext, AuthContext } from '../App';
import AppShell from '../components/AppShell';

type PatientRow = {
  id: string;
  name: string;
  status: 'ontrack' | 'attention' | 'ready' | 'inactive';
  injury: string;
  phaseName: string;
  adherence: number;
  lastActivity: string;
};

const FILTERS = [
  ['all', 'הכל', 'All'],
  ['attention', 'תשומת לב', 'Attention'],
  ['ready', 'מוכנים לקידום', 'Ready'],
  ['inactive', 'לא פעיל', 'Inactive'],
] as const;

const statusLabel: Record<PatientRow['status'], string> = {
  ontrack: 'במסלול',
  attention: 'תשומת לב',
  ready: 'מוכן לקידום',
  inactive: 'לא פעיל',
};

function chipStyle(active: boolean): CSSProperties {
  return active
    ? { padding: '6px 15px', borderRadius: 'var(--radius-pill)', background: 'var(--gold-deep)', color: 'var(--cream)', fontSize: 12, fontWeight: 600, letterSpacing: '0.03em', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }
    : { padding: '6px 15px', borderRadius: 'var(--radius-pill)', background: 'transparent', border: '1px solid var(--line-input)', color: 'var(--nav-inactive-text)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' };
}

export default function Dashboard() {
  const { user } = useContext(AuthContext);
  const supabase = useContext(SupabaseContext);
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'attention' | 'ready' | 'inactive'>('all');
  const [notifOpen, setNotifOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: kpis, isLoading: kpisLoading, error: kpisError } = useQuery({
    queryKey: ['dashboard-kpis'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('dashboard', { method: 'GET' });
      if (error) throw error;
      return data as {
        active_patients: number;
        avg_adherence: number;
        attention_count: number;
        ready_count: number;
        completed_today: number;
      };
    },
  });

  const { data: patients, isLoading: patientsLoading, error: patientsError } = useQuery({
    queryKey: ['patients', filter],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`patients?filter=${filter}`, { method: 'GET' });
      if (error) throw error;
      return data as PatientRow[];
    },
  });

  const { data: alerts } = useQuery({
    queryKey: ['alerts'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('alerts?state=open', { method: 'GET' });
      if (error) throw error;
      return data as Alert[];
    },
  });

  const reviewAlert = useMutation({
    mutationFn: async (alertId: string) => {
      await supabase.functions.invoke(`alerts/${alertId}/review`, { method: 'POST' });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
  });

  if (!user) return null; // AppShell requires a signed-in user; App.tsx never routes here otherwise

  const kpiCards = [
    { label: 'מטופלים פעילים', labelEn: 'Active Patients', value: kpis?.active_patients ?? 0, color: 'var(--ink)' },
    { label: 'דורש תשומת לב', labelEn: 'Needs Attention', value: kpis?.attention_count ?? 0, color: 'var(--flag-red)' },
    { label: 'הושלם היום', labelEn: 'Completed Today', value: kpis?.completed_today ?? 0, color: 'var(--ink)' },
    { label: 'היענות ממוצעת', labelEn: 'Avg. Adherence', value: kpis ? `${kpis.avg_adherence}%` : '—', color: 'var(--flag-green)' },
  ];

  return (
    <AppShell user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 21, fontWeight: 700, color: 'var(--ink)' }}>
              {t('dashboard.greeting', { name: user.name })}{' '}
              <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>Good morning</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--nav-inactive-text)', marginTop: 4 }}>
              סקירה של המטופלים שלך <span style={{ opacity: 0.8 }}>· Overview of your patients</span>
            </div>
          </div>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setNotifOpen((v) => !v)}
              style={{
                width: 38, height: 38, borderRadius: 10, background: 'var(--shell-sidebar-bg)',
                border: '1px solid var(--shell-border)', fontSize: 16, cursor: 'pointer', position: 'relative',
              }}
              aria-label={t('clinician.alerts.title')}
            >
              🔔
              {(alerts?.length ?? 0) > 0 && (
                <span
                  style={{
                    position: 'absolute', top: -4, insetInlineEnd: -4, background: 'var(--flag-red)', color: 'var(--cream)',
                    fontSize: 10, fontWeight: 700, borderRadius: 'var(--radius-pill)', width: 16, height: 16,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {alerts!.length}
                </span>
              )}
            </button>
            {notifOpen && (
              <div
                style={{
                  position: 'absolute', top: 44, insetInlineEnd: 0, width: 280, background: 'var(--shell-sidebar-bg)',
                  border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-floating)',
                  padding: 8, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 4,
                }}
              >
                {(alerts?.length ?? 0) === 0 ? (
                  <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--nav-inactive-text)' }}>{t('empty.alerts.title')}</div>
                ) : (
                  alerts!.slice(0, 6).map((alert) => (
                    <div
                      key={alert.id}
                      onClick={() => reviewAlert.mutate(alert.id)}
                      style={{ padding: '10px 12px', borderRadius: 8, fontSize: 12, color: 'var(--ink-soft)', cursor: 'pointer', display: 'flex', gap: 9, alignItems: 'flex-start' }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--flag-red)', marginTop: 4, flex: 'none' }} />
                      <span>{alert.type}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {kpisError ? (
          <EmptyState
            title={t('error.generic.title')}
            body={t('error.generic.body')}
            action={<Button size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ['dashboard-kpis'] })}>{t('error.generic.action')}</Button>}
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            {kpiCards.map((kpi) => (
              <div key={kpi.label} style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-card)', padding: 18 }}>
                <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>
                  {kpi.label} <span style={{ opacity: 0.7 }}>{kpi.labelEn}</span>
                </div>
                <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 28, fontWeight: 700, color: kpi.color, marginTop: 6 }}>
                  {kpisLoading ? <Skeleton width={48} height={28} /> : kpi.value}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid var(--shell-border)' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {FILTERS.map(([key, label, labelEn]) => (
                <button key={key} onClick={() => setFilter(key)} style={chipStyle(filter === key)}>
                  {label} · {labelEn}
                </button>
              ))}
            </div>
            <Button size="sm" onClick={() => navigate({ to: '/patients' })}>
              + {t('clinician.patient.add')}
            </Button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.6fr 1fr 1fr 1fr 1.2fr', padding: '12px 18px', fontSize: 11, color: 'var(--nav-inactive-text)', fontWeight: 600 }}>
            <div>מטופל · Patient</div>
            <div>אבחנה · Condition</div>
            <div>שלב · Phase</div>
            <div>היענות · Adherence</div>
            <div>פעילות אחרונה</div>
            <div>סטטוס · Status</div>
          </div>

          {patientsLoading ? (
            <div style={{ padding: 20 }}>
              <Skeleton count={5} height={20} />
            </div>
          ) : patientsError ? (
            <div style={{ padding: 20 }}>
              <EmptyState
                title={t('error.generic.title')}
                body={t('error.generic.body')}
                action={<Button size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ['patients', filter] })}>{t('error.generic.action')}</Button>}
              />
            </div>
          ) : patients?.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13, borderTop: '1px solid var(--shell-border-soft)' }}>
              {filter === 'all' ? t('empty.patients.title') : t('empty.patients.filtered.title')}
            </div>
          ) : (
            patients?.map((row) => (
              <div
                key={row.id}
                onClick={() => navigate({ to: '/patients/$patientId', params: { patientId: row.id } })}
                style={{
                  display: 'grid', gridTemplateColumns: '2fr 1.6fr 1fr 1fr 1fr 1.2fr', padding: '14px 18px',
                  borderTop: '1px solid var(--shell-border-soft)', cursor: 'pointer', alignItems: 'center',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{row.name}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{row.injury}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{row.phaseName}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{row.adherence}%</div>
                <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>{row.lastActivity}</div>
                <div>
                  <Badge tone={row.status === 'attention' || row.status === 'inactive' ? 'attention' : 'success'}>
                    {statusLabel[row.status]}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </AppShell>
  );
}
