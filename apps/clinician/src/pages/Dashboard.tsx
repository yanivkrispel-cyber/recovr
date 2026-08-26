import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { t } from 'shared';
import { Card } from 'ui';
import { Table } from 'ui';
import { Badge, Pill } from 'ui';
import { Button } from 'ui';
import { Skeleton } from 'ui';
import { EmptyState } from 'ui';
import type { User, Patient, Alert, Plan } from 'shared';

interface DashboardProps {
  user: User;
}

type PatientRow = {
  id: string;
  name: string;
  status: 'ontrack' | 'attention' | 'ready' | 'inactive';
  injury: string;
  phaseName: string;
  adherence: number;
  lastActivity: string;
};

export default function Dashboard({ user }: DashboardProps) {
  const [filter, setFilter] = useState<'all' | 'attention' | 'ready' | 'inactive'>('all');
  const queryClient = useQueryClient();

  const { data: kpis, isLoading: kpisLoading } = useQuery({
    queryKey: ['dashboard-kpis'],
    queryFn: async () => {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY,
      );
      const { data, error } = await supabase.functions.invoke('dashboard', {
        method: 'GET',
      });
      if (error) throw error;
      return data as {
        active_patients: number;
        avg_adherence: number;
        attention_count: number;
        ready_count: number;
      };
    },
  });

  const { data: patients, isLoading: patientsLoading } = useQuery({
    queryKey: ['patients', filter],
    queryFn: async () => {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY,
      );
      const { data, error } = await supabase.functions.invoke(`patients?filter=${filter}`, {
        method: 'GET',
      });
      if (error) throw error;
      return data as PatientRow[];
    },
  });

  const { data: alerts, isLoading: alertsLoading } = useQuery({
    queryKey: ['alerts'],
    queryFn: async () => {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY,
      );
      const { data, error } = await supabase.functions.invoke('alerts?state=open', {
        method: 'GET',
      });
      if (error) throw error;
      return data as Alert[];
    },
  });

  const reviewAlert = useMutation({
    mutationFn: async (alertId: string) => {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY,
      );
      await supabase.functions.invoke(`alerts/${alertId}/review`, { method: 'POST' });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
  });

  const statusBadge = (status: PatientRow['status']) => {
    const map = {
      ontrack: { label: 'במסלול', tone: 'gold' as const },
      attention: { label: 'תשומת לב', tone: 'danger' as const },
      ready: { label: 'מוכן לקידום', tone: 'gold' as const },
      inactive: { label: 'לא פעיל', tone: 'danger' as const },
    };
    const { label, tone } = map[status];
    return <Badge tone={tone}>{label}</Badge>;
  };

  const columns = [
    { key: 'name', header: 'מטופל', width: '25%' },
    { key: 'injury', header: 'פציעה', width: '20%' },
    {
      key: 'phase',
      header: 'שלב נוכחי',
      render: (row: PatientRow) => (
        <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{row.phaseName}</span>
      ),
    },
    {
      key: 'adherence',
      header: 'היענות',
      align: 'center' as const,
      render: (row: PatientRow) => (
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: row.adherence >= 70 ? 'var(--flag-green)' : 'var(--danger)',
          }}
        >
          {row.adherence}%
        </span>
      ),
    },
    {
      key: 'status',
      header: 'סטטוס',
      render: (row: PatientRow) => statusBadge(row.status),
    },
    {
      key: 'lastActivity',
      header: 'פעילות אחרונה',
      align: 'end' as const,
      render: (row: PatientRow) => (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{row.lastActivity}</span>
      ),
    },
  ];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--sand)',
        fontFamily: 'var(--font-ui)',
        dir: 'rtl',
      }}
    >
      {/* Header */}
      <header
        style={{
          background: 'var(--navy)',
          color: 'var(--cream)',
          padding: '16px 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <path d="M14 4L4 8v6c0 5.5 4.3 10.6 10 12 5.7-1.4 10-6.5 10-12V8L14 4z" fill="var(--gold)" />
          </svg>
          <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
            RecoveryOS
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 14, color: 'var(--navy-muted)' }}>{user.name}</span>
          <button
            onClick={() => {
              import('@supabase/supabase-js').then(({ createClient }) => {
                createClient(
                  import.meta.env.VITE_SUPABASE_URL,
                  import.meta.env.VITE_SUPABASE_ANON_KEY,
                ).auth.signOut();
              });
            }}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'var(--cream)',
              padding: '6px 14px',
              borderRadius: 'var(--radius-button)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {t('auth.logout')}
          </button>
        </div>
      </header>

      <main style={{ padding: 28 }}>
        <h1 style={{ margin: '0 0 24px', fontSize: 22, fontWeight: 700, color: 'var(--navy)', fontFamily: 'var(--font-display)' }}>
          {t('clinician.dashboard.title')}
        </h1>

        {/* KPI cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 16,
            marginBottom: 28,
          }}
        >
          {[
            { label: 'מטופלים פעילים', value: kpis?.active_patients ?? 0, color: 'var(--navy)' },
            { label: 'היענות ממוצעת', value: kpis ? `${kpis.avg_adherence}%` : '—', color: 'var(--flag-green)' },
            { label: 'דורשים תשומת לב', value: kpis?.attention_count ?? 0, color: 'var(--danger)' },
            { label: 'מוכנים לקידום', value: kpis?.ready_count ?? 0, color: 'var(--gold)' },
          ].map((kpi) => (
            <Card key={kpi.label} padding={20}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
                {kpi.label}
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: kpi.color, fontFamily: 'var(--font-display)' }}>
                {kpisLoading ? <Skeleton width={48} height={32} /> : kpi.value}
              </div>
            </Card>
          ))}
        </div>

        {/* Alert inbox */}
        {(alerts?.length ?? 0) > 0 && (
          <Card padding={20} style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>
                {t('clinician.alerts.title')} ({alerts?.length})
              </h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {alerts?.slice(0, 5).map((alert) => (
                <div
                  key={alert.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    background: 'var(--warn-bg)',
                    borderRadius: 'var(--radius-card)',
                    border: '1px solid var(--warn-line)',
                  }}
                >
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                      {alert.type}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--muted)', marginInlineStart: 8 }}>
                      {new Date(alert.created_at).toLocaleDateString('he-IL')}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => reviewAlert.mutate(alert.id)}
                  >
                    {t('clinician.alerts.review')}
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Patient table */}
        <Card padding={20}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>
              {t('clinician.patients.title')}
            </h2>
            <Button
              size="sm"
              onClick={() => {/* TODO: open add patient modal */}}
            >
              + {t('clinician.patient.add')}
            </Button>
          </div>

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {([
              ['all', 'הכול'],
              ['attention', 'תשומת לב'],
              ['ready', 'מוכנים לקידום'],
              ['inactive', 'לא פעילים'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 'var(--radius-pill)',
                  border: filter === key ? '1px solid var(--navy)' : '1px solid var(--line)',
                  background: filter === key ? 'var(--navy)' : 'var(--white)',
                  color: filter === key ? 'var(--cream)' : 'var(--ink-soft)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  transition: 'var(--motion-hover)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {patientsLoading ? (
            <div style={{ padding: 20 }}>
              <Skeleton count={5} height={20} />
            </div>
          ) : patients?.length === 0 ? (
            <EmptyState
              title={t('empty.patients.title')}
              body={t('empty.patients.body')}
              action={
                <Button size="sm">{t('empty.patients.action')}</Button>
              }
            />
          ) : (
            <Table
              columns={columns}
              rows={patients ?? []}
              rowKey={(r) => r.id}
              onRowClick={(row) => {
                // Navigate to patient overview — TODO: router integration
                window.location.href = `/app/patients/${row.id}`;
              }}
            />
          )}
        </Card>
      </main>
    </div>
  );
}
