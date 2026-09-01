import { useContext, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { t } from 'shared';
import { Badge, Button, EmptyState, Skeleton, clickableDivProps } from 'ui';
import { AuthContext, SupabaseContext } from '../App';
import AppShell from '../components/AppShell';

type PatientRow = {
  id: string;
  name: string;
  nameEn: string | null;
  status: 'ontrack' | 'attention' | 'ready' | 'inactive';
  injury: string;
  phase: number;
  day: number;
  adherence: number;
};

const statusLabel: Record<PatientRow['status'], string> = {
  ontrack: 'במסלול · On track',
  attention: 'תשומת לב · Attention',
  ready: 'מוכן לקידום · Ready',
  inactive: 'לא פעיל · Inactive',
};

export default function PatientList() {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();
  const supabase = useContext(SupabaseContext);
  const [query, setQuery] = useState('');

  const { data: patients, isLoading, error } = useQuery({
    queryKey: ['patients', 'all'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('patients?filter=all', { method: 'GET' });
      if (error) throw error;
      return data as PatientRow[];
    },
  });

  const filtered = useMemo(() => {
    if (!patients) return patients;
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter((p) => p.name.includes(query.trim()) || (p.nameEn ?? '').toLowerCase().includes(q));
  }, [patients, query]);

  if (!user) return null;

  return (
    <AppShell user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 21, fontWeight: 700, color: 'var(--ink)' }}>
              {t('clinician.patients.title')} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>Patients</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', marginTop: 4 }}>
              {patients?.length ?? 0} מטופלים פעילים · active patients
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חפש מטופל... · Search patients..."
              style={{ width: 230, padding: '9px 12px', border: '1px solid var(--shell-border)', borderRadius: 9, fontFamily: 'inherit', fontSize: 13, background: 'var(--shell-sidebar-bg)' }}
            />
            <Button size="sm" onClick={() => {/* TODO: open add patient modal */}}>
              + {t('clinician.patient.add')}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', padding: 18 }}>
                <Skeleton count={3} height={16} />
              </div>
            ))}
          </div>
        ) : error ? (
          <EmptyState
            title={t('error.generic.title')}
            body={t('error.generic.body')}
            action={<Button size="sm" onClick={() => window.location.reload()}>{t('error.generic.action')}</Button>}
          />
        ) : (filtered?.length ?? 0) === 0 ? (
          query ? (
            <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px dashed var(--placeholder)', borderRadius: 'var(--radius-card)', padding: 36, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13 }}>
              לא נמצאו מטופלים · No patients found
            </div>
          ) : (
            <EmptyState title={t('empty.patients.title')} body={t('empty.patients.body')} action={<Button size="sm">{t('empty.patients.action')}</Button>} />
          )
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {filtered!.map((p) => (
              <div
                key={p.id}
                {...clickableDivProps(() => navigate({ to: '/patients/$patientId', params: { patientId: p.id } }))}
                style={{
                  background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)',
                  padding: 18, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>{p.nameEn}</div>
                  </div>
                  <Badge tone={p.status === 'attention' || p.status === 'inactive' ? 'attention' : 'success'}>{statusLabel[p.status]}</Badge>
                </div>

                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{p.injury}</div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', border: '1px solid rgba(140,100,35,0.5)', color: 'var(--gold-deep)', padding: '3px 9px', borderRadius: 'var(--radius-pill)' }}>
                    שלב {p.phase}
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', border: '1px solid rgba(34,28,20,0.22)', color: 'var(--nav-inactive-text)', padding: '3px 9px', borderRadius: 6 }}>
                    יום {p.day}
                  </span>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--nav-inactive-text)', marginBottom: 5 }}>
                    <span>היענות · Adherence</span>
                    <span>{p.adherence}%</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--sand)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 'var(--radius-pill)', width: `${p.adherence}%`, background: p.adherence < 70 ? 'var(--flag-red)' : 'var(--gold-deep)' }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
