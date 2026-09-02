import { useContext, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { t } from 'shared';
import { Badge, Button, Skeleton, EmptyState, Tab, Tabs, clickableDivProps, useIsTablet } from 'ui';
import { AuthContext, SupabaseContext } from '../App';
import AppShell from '../components/AppShell';
import EditPlan from '../components/EditPlan';
import MeasurementPanel, { type JointEntry } from '../components/MeasurementPanel';
import { computeFlag, flagColor, gapFlag, REGION_JOINT, ROM_JOINT_HE, ROM_JOINT_ORDER, sideGap, type FlagState } from '../lib/romFlags';

interface Criterion {
  id: string;
  type: string;
  label: string;
  operator: string;
  value: number;
  unit: string | null;
  is_met: boolean;
  met_at: string | null;
}

interface OverviewData {
  patient: {
    id: string;
    name: string;
    name_en: string | null;
    sport: string | null;
    position: string | null;
    status: string;
  };
  plan: {
    protocol_name: string;
    protocol_slug: string;
    current_phase_n: number;
    phase_name: string;
    phase_goals: { he: string; en?: string }[];
    started_at: string;
    day: number;
    status: string;
  } | null;
  criteria: Criterion[];
  alerts: { id: string; type: string; severity: string; state: string; created_at: string }[];
  today: { date: string; status: string; items_planned: number; items_done: number; completion_ratio: number } | null;
  recent_activity: { date: string; status: string; completion_ratio: number }[];
  phase_transitions: { id: string; from_phase_n: number; to_phase_n: number; direction: string; approved_at: string; override_reason: string | null }[];
  adherence: number;
  pain_trend: { from: number; to: number } | null;
  rom_latest: number | null;
}

interface PlanExerciseRow {
  id: string;
  name: string;
  name_en: string | null;
  sets: number | null;
  reps: number | null;
  rest_sec: number | null;
  frequency_days_per_week: number | null;
  removed_reason: string | null;
  deleted_at: string | null;
}

interface PlanPhaseData {
  n: number;
  exercises: PlanExerciseRow[];
}

interface PlanData {
  phases: PlanPhaseData[];
  protocol_phases: { n: number; name: string }[];
}

const sessionStatusLabel: Record<string, string> = {
  planned: 'מתוכנן',
  partial: 'הושלם חלקית',
  completed: 'הושלם',
  skipped: 'דולג',
};

function formatRelativeDate(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'היום';
  if (sameDay(d, yesterday)) return 'אתמול';
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
}

export default function PatientOverview() {
  const { user } = useContext(AuthContext);
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { patientId } = useParams({ from: '/patients/$patientId' });
  const [editOpen, setEditOpen] = useState(false);
  const isTablet = useIsTablet(); // T-22: tablet is view-only for v1

  const { data, isLoading, error } = useQuery({
    queryKey: ['patient-overview', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        `patient-overview/patients/${patientId}`,
        { method: 'GET' },
      );
      if (error) throw error;
      return data as OverviewData;
    },
  });

  const { data: deletionRequests } = useQuery<{ patient_id: string; requested_at: string; reason: string | null }[]>({
    queryKey: ['deletion-requests'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('deletion-requests', { method: 'GET' });
      if (error) throw error;
      return (data as { patient_id: string; requested_at: string; reason: string | null }[]) ?? [];
    },
  });
  const pendingDeletion = deletionRequests?.find((r) => r.patient_id === patientId) ?? null;

  const anonymize = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('deletion-requests', {
        method: 'POST',
        body: { patient_id: patientId },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deletion-requests'] });
      queryClient.invalidateQueries({ queryKey: ['patient-overview', patientId] });
    },
  });

  if (!user) return null;

  return (
    <AppShell user={user}>
      {isLoading ? (
        <div>
          <Skeleton width="40%" height={28} />
          <div style={{ marginTop: 24 }}>
            <Skeleton count={5} height={20} />
          </div>
        </div>
      ) : error || !data ? (
        <EmptyState title={t('error.notfound.title')} body={t('error.notfound.body')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {pendingDeletion && (
            <div style={{ border: '1px solid var(--flag-red)', background: 'rgba(158,59,46,0.06)', borderRadius: 'var(--radius-card)', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--flag-red)' }}>
                המטופל ביקש מחיקת נתונים ({new Date(pendingDeletion.requested_at).toLocaleDateString('he-IL')})
                {pendingDeletion.reason ? ` · ${pendingDeletion.reason}` : ''}
              </div>
              <Button
                size="sm"
                variant="danger"
                disabled={anonymize.isPending}
                loading={anonymize.isPending}
                onClick={() => {
                  if (window.confirm(`${t('confirm.anonymize.title')}\n${t('confirm.anonymize.body')}`)) {
                    anonymize.mutate();
                  }
                }}
              >
                בצע מחיקה
              </Button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <button
                onClick={() => navigate({ to: '/dashboard' })}
                style={{ background: 'none', border: 'none', color: 'var(--nav-inactive-text)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', padding: 0, marginBottom: 8 }}
              >
                → {t('clinician.dashboard.title')} · Back to Dashboard
              </button>
              <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>
                {data.patient.name} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>{data.patient.name_en}</span>
              </div>
              {data.plan && (
                <>
                  <div style={{ fontSize: 13, color: 'var(--nav-inactive-text)', marginTop: 4 }}>{data.plan.protocol_name}</div>
                  <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', marginTop: 4 }}>
                    יום {data.plan.day} · שלב {data.plan.current_phase_n} — {data.plan.phase_name}
                  </div>
                </>
              )}
            </div>
            {!isTablet && <Button onClick={() => setEditOpen(true)}>{t('clinician.plan.edit')}</Button>}
          </div>

          <Tabs defaultValue="overview">
            <Tab value="overview" label="סקירה · Overview">
              <OverviewTab data={data} patientId={patientId} />
            </Tab>
            <Tab value="plan" label="תכנית · Plan">
              <PlanTab data={data} patientId={patientId} onEditPlan={() => setEditOpen(true)} isTablet={isTablet} />
            </Tab>
            <Tab value="progress" label="התקדמות · Progress">
              <ProgressTab data={data} patientId={patientId} />
            </Tab>
            <Tab value="assessments" label={t('clinician.assessments.title')}>
              <AssessmentsTab patientId={patientId} patientName={data.patient.name} protocolSlug={data.plan?.protocol_slug ?? null} isTablet={isTablet} />
            </Tab>
            <Tab value="history" label={t('clinician.history.title')}>
              <HistoryTab data={data} />
            </Tab>
            <Tab value="messages" label="הודעות · Messages">
              <MessagesTab patientId={patientId} patientName={data.patient.name} />
            </Tab>
          </Tabs>

          <EditPlan
            patientId={patientId}
            open={editOpen}
            onClose={() => setEditOpen(false)}
            onSaved={() => queryClient.invalidateQueries({ queryKey: ['patient-overview', patientId] })}
          />
        </div>
      )}
    </AppShell>
  );
}

function kpiCardStyle(): CSSProperties {
  return { background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-card)', padding: 16 };
}

function OverviewTab({ data, patientId }: { data: OverviewData; patientId: string }) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();

  const reviewAlert = useMutation({
    mutationFn: async (alertId: string) => {
      await supabase.functions.invoke(`alerts/${alertId}/review`, { method: 'POST' });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['patient-overview', patientId] }),
  });

  if (!data.plan) {
    return (
      <div style={{ paddingTop: 20 }}>
        <EmptyState title={t('empty.plan.title')} body={t('empty.plan.body')} />
      </div>
    );
  }

  const topAlert = data.alerts[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <div style={kpiCardStyle()}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>היענות · Adherence</div>
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--ink)', marginTop: 6 }}>
            {data.adherence}%
          </div>
        </div>
        <div style={kpiCardStyle()}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>מגמת כאב · Pain trend</div>
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--flag-green)', marginTop: 6 }}>
            {data.pain_trend ? `${data.pain_trend.from} → ${data.pain_trend.to}` : '—'}
          </div>
        </div>
        <div style={kpiCardStyle()}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>טווח תנועה · ROM</div>
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--ink)', marginTop: 6 }}>
            {data.rom_latest != null ? `${data.rom_latest}°` : '—'}
          </div>
        </div>
        <div style={kpiCardStyle()}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>כוח · Strength</div>
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--ink)', marginTop: 6 }}>
            —
          </div>
        </div>
      </div>

      {topAlert && (
        <div style={{ background: 'var(--pill-attention-bg)', border: '1px solid #E9BFB2', borderRadius: 'var(--radius-card)', padding: '16px 18px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--flag-red)', fontSize: 13 }}>דורש בדיקה · Needs Review</div>
            <div style={{ fontSize: 13, color: '#5A2C21', marginTop: 4 }}>{topAlert.type}</div>
          </div>
          <Button size="sm" variant="danger" onClick={() => reviewAlert.mutate(topAlert.id)} disabled={reviewAlert.isPending}>
            בדוק · Review
          </Button>
        </div>
      )}

      <div style={kpiCardStyle()}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', marginBottom: 10 }}>מטרות נוכחיות · Current goals</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--ink-soft)' }}>
          {data.plan.phase_goals.length === 0 ? (
            <span style={{ color: 'var(--nav-inactive-text)' }}>אין מטרות מוגדרות לשלב זה</span>
          ) : (
            data.plan.phase_goals.map((g, i) => (
              <div key={i}>✓ {g.he} <span style={{ color: 'var(--nav-inactive-text)' }}>· {g.en}</span></div>
            ))
          )}
        </div>
      </div>

      <div style={kpiCardStyle()}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', marginBottom: 6 }}>פעילות היום · Today's activity</div>
        {!data.today ? (
          <div style={{ fontSize: 13, color: 'var(--nav-inactive-text)' }}>אין אימון מתוכנן היום</div>
        ) : (
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 20, fontWeight: 700, color: 'var(--flag-green)' }}>
            {data.today.items_done} / {data.today.items_planned}
          </div>
        )}
      </div>

      <div style={kpiCardStyle()}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', marginBottom: 10 }}>פעילות אחרונה · Recent activity</div>
        {data.recent_activity.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nav-inactive-text)' }}>אין פעילות עדיין</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            {data.recent_activity.slice(0, 3).map((s, i) => (
              <div key={i}>
                <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{formatRelativeDate(s.date)}</span>{' '}
                <span style={{ color: 'var(--nav-inactive-text)' }}>
                  — {sessionStatusLabel[s.status] ?? s.status} ({Math.round(s.completion_ratio * 100)}%)
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanTab({ data, patientId, onEditPlan, isTablet }: { data: OverviewData; patientId: string; onEditPlan: () => void; isTablet: boolean }) {
  const supabase = useContext(SupabaseContext);

  const { data: plan, isLoading } = useQuery({
    queryKey: ['plan', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`plan/patients/${patientId}/plan`, { method: 'GET' });
      if (error) throw error;
      return data as PlanData;
    },
    enabled: !!data.plan,
  });

  if (!data.plan) {
    return (
      <div style={{ paddingTop: 20 }}>
        <EmptyState
          title="אין תכנית שיקום פעילה"
          body="השלב הנוכחי ריק מתרגילים. הוסף תרגילים או בחר פרוטוקול חדש."
          action={!isTablet ? <Button size="sm" onClick={onEditPlan}>צור תכנית · Create a plan</Button> : undefined}
        />
      </div>
    );
  }

  const currentPhaseN = data.plan.current_phase_n;
  const phaseExercises = plan?.phases.find((p) => p.n === currentPhaseN)?.exercises ?? [];
  const activeExercises = phaseExercises.filter((e) => !e.deleted_at);
  const removedExercises = phaseExercises.filter((e) => e.deleted_at);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 18 }}>
      <div style={kpiCardStyle()}>
        {isLoading ? (
          <Skeleton count={1} height={26} />
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            {(plan?.protocol_phases ?? []).map((p) => {
              const done = p.n < currentPhaseN;
              const current = p.n === currentPhaseN;
              return (
                <div key={p.n} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1 }}>
                  <div
                    style={{
                      width: 26, height: 26, borderRadius: '50%',
                      background: done || current ? 'var(--gold-deep)' : 'var(--sand)',
                      color: done || current ? 'var(--cream)' : 'var(--placeholder)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: done ? 13 : 12, fontWeight: current ? 700 : 400,
                    }}
                  >
                    {done ? '✓' : p.n}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--nav-inactive-text)' }}>שלב {p.n}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={kpiCardStyle()}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>
          שלב {currentPhaseN} · {data.plan.phase_name} <span style={{ fontWeight: 400, color: 'var(--nav-inactive-text)', fontSize: 12 }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, fontSize: 13, color: 'var(--ink-soft)' }}>
          {data.plan.phase_goals.map((g, i) => (
            <div key={i}>✓ {g.he} <span style={{ color: 'var(--nav-inactive-text)' }}>· {g.en}</span></div>
          ))}
        </div>
      </div>

      <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--shell-border)' }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>תרגילים · Exercises</div>
          {!isTablet && (
            <button
              onClick={onEditPlan}
              style={{ background: 'transparent', color: 'var(--gold-deep)', border: '1px solid rgba(140,100,35,0.5)', borderRadius: 'var(--radius-pill)', letterSpacing: '0.04em', padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              + הוסף תרגיל · Add Exercise
            </button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.4fr 0.4fr', padding: '10px 18px', fontSize: 11, color: 'var(--nav-inactive-text)', fontWeight: 600 }}>
          <div>תרגיל · Exercise</div><div>מרשם · Prescription</div><div>תדירות · Frequency</div><div>סטטוס · Status</div><div /><div />
        </div>

        {isLoading ? (
          <div style={{ padding: 16 }}><Skeleton count={3} height={18} /></div>
        ) : activeExercises.length === 0 ? (
          <div style={{ padding: '48px 32px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>אין תרגילים בשלב זה</div>
          </div>
        ) : (
          activeExercises.map((ex) => (
            <div key={ex.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.4fr 0.4fr', padding: '12px 18px', borderTop: '1px solid var(--shell-border-soft)', alignItems: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--gold-deep)', fontWeight: 600 }}>
                {ex.name} <span style={{ fontWeight: 400, color: 'var(--nav-inactive-text)', fontSize: 11 }}>{ex.name_en}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{ex.sets ?? '—'} × {ex.reps ?? '—'}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{ex.frequency_days_per_week ? `${ex.frequency_days_per_week}x/שבוע` : '—'}</div>
              <div>
                <span style={{ border: '1px solid rgba(140,100,35,0.55)', color: 'var(--gold-deep)', fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', padding: '3px 9px', borderRadius: 6 }}>
                  פעיל
                </span>
              </div>
              {!isTablet && (
                <button
                  onClick={onEditPlan}
                  title="ערוך · Edit"
                  aria-label="ערוך תרגיל · Edit exercise"
                  style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: 'var(--nav-inactive-text)', cursor: 'pointer', textAlign: 'center', fontFamily: 'inherit' }}
                >
                  ✎
                </button>
              )}
              {!isTablet && (
                <button
                  onClick={onEditPlan}
                  title="הסר מהתכנית · Remove"
                  aria-label="הסר תרגיל מהתכנית · Remove exercise from plan"
                  style={{ background: 'none', border: 'none', padding: 0, fontSize: 14, lineHeight: 1, color: 'var(--flag-red)', cursor: 'pointer', textAlign: 'center', fontFamily: 'inherit' }}
                >
                  ✕
                </button>
              )}
            </div>
          ))
        )}

        {removedExercises.length > 0 && (
          <div style={{ borderTop: '1px solid var(--shell-border)', background: 'var(--shell-content-bg)', padding: '14px 18px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)', marginBottom: 10 }}>
              {removedExercises.length} הוסרו משלב זה · Removed from this phase
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {removedExercises.map((ex) => (
                <div key={ex.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border-soft)', borderRadius: 'var(--radius-card)', padding: '9px 12px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)', textDecoration: 'line-through', textDecorationColor: 'rgba(74,64,50,0.4)' }}>
                      {ex.name} <span style={{ fontWeight: 400, color: 'var(--nav-inactive-text)', fontSize: 10, textDecoration: 'none' }}>{ex.name_en}</span>
                    </div>
                    {ex.removed_reason && <div style={{ fontSize: 10, color: 'var(--nav-inactive-text)', marginTop: 3 }}>{ex.removed_reason}</div>}
                  </div>
                  {!isTablet && (
                    <button
                      onClick={onEditPlan}
                      style={{ flex: 'none', background: 'transparent', color: 'var(--gold-deep)', border: '1px solid rgba(140,100,35,0.45)', borderRadius: 'var(--radius-pill)', padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      ↩ החזר · Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressTab({ data, patientId }: { data: OverviewData; patientId: string }) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();

  const toggleCriterion = useMutation({
    mutationFn: async ({ id, isMet }: { id: string; isMet: boolean }) => {
      await supabase.functions.invoke(`criteria/patients/${patientId}/criteria/${id}`, {
        method: 'POST',
        body: { is_met: isMet },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['patient-overview', patientId] }),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        <div style={kpiCardStyle()}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>כאב · Pain</div>
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--flag-green)', marginTop: 6 }}>
            {data.pain_trend ? `${data.pain_trend.from} → ${data.pain_trend.to}` : '—'}
          </div>
        </div>
        <div style={kpiCardStyle()}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>ROM</div>
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--flag-green)', marginTop: 6 }}>
            {data.rom_latest != null ? `${data.rom_latest}°` : '—'}
          </div>
        </div>
        <div style={kpiCardStyle()}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>כוח · Strength</div>
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 22, fontWeight: 700, color: 'var(--ink)', marginTop: 6 }}>
            —
          </div>
        </div>
      </div>

      <div style={{ ...kpiCardStyle(), padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>קריטריוני התקדמות · Progression Criteria</div>
          <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', marginTop: 4 }}>
            {data.criteria.filter((c) => c.is_met).length} / {data.criteria.length} הושלמו · completed
          </div>
        </div>
      </div>

      {data.criteria.length > 0 && (
        <div style={kpiCardStyle()}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.criteria.map((c) => {
              // time/pain are recomputed live on every read (app.recompute_criteria)
              // — a manual toggle would just be overwritten on the next load, so
              // only expose one for the types that stay clinician-set.
              const manuallySettable = c.type !== 'time' && c.type !== 'pain';
              return (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: 'var(--ink)' }}>{c.label}</span>
                  {manuallySettable ? (
                    <button
                      onClick={() => toggleCriterion.mutate({ id: c.id, isMet: !c.is_met })}
                      disabled={toggleCriterion.isPending}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    >
                      <Badge tone={c.is_met ? 'success' : 'neutral'}>{c.is_met ? 'הושג' : 'לא הושג'}</Badge>
                    </button>
                  ) : (
                    <Badge tone={c.is_met ? 'success' : 'neutral'}>{c.is_met ? 'הושג' : 'לא הושג'}</Badge>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function trendSparkline(history: JointEntry['history']): { points: string; delta: number | null } {
  if (history.length < 2) return { points: '', delta: null };
  const chrono = [...history].reverse(); // history is DESC by measured_at; sparkline reads oldest->newest
  const values = chrono.map((h) => h.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 60;
      const y = 18 - ((v - min) / range) * 16;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return { points, delta: Math.round((values[values.length - 1] - values[0]) * 10) / 10 };
}

function AssessmentsTab({ patientId, patientName, protocolSlug, isTablet }: { patientId: string; patientName: string; protocolSlug: string | null; isTablet: boolean }) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const defaultJoint = (protocolSlug && REGION_JOINT[protocolSlug]) || 'knee';
  const [joint, setJoint] = useState(defaultJoint);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const [visitCount, setVisitCount] = useState(0);
  const [affectedSide, setAffectedSide] = useState<'involved' | 'healthy'>('involved');

  const { data, isLoading, error } = useQuery({
    queryKey: ['patient-measurements', patientId, joint],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        `measurements/patients/${patientId}/measurements?joint=${joint}`,
        { method: 'GET' },
      );
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as JointEntry[];
    },
  });

  const startVisit = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        `assessment-visits/patients/${patientId}/assessment-visits`,
        { method: 'POST' },
      );
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as { visit_id: string };
    },
    onSuccess: (result) => {
      setVisitId(result.visit_id);
      setVisitCount(0);
    },
  });

  const saveVisit = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        `assessment-visits/assessment-visits/${visitId}/save`,
        { method: 'PATCH', body: { patient_id: patientId } },
      );
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      setVisitId(null);
      setVisitCount(0);
    },
  });

  const selectedEntry = data?.find((e) => e.definition.code === selectedCode) ?? null;
  const lastMeasuredAt = data
    ?.flatMap((e) => [e.involved, e.healthy].filter((r): r is NonNullable<typeof e.involved> => !!r))
    .sort((a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime())[0]?.measured_at;

  const { data: status } = useQuery<{ due_at: string; days_overdue: number; overdue: boolean; interval_days: number }>({
    queryKey: ['assessment-status', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        `measurements/patients/${patientId}/assessment-status`,
        { method: 'GET' },
      );
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data as { due_at: string; days_overdue: number; overdue: boolean; interval_days: number };
    },
  });

  return (
    <div style={{ paddingTop: 18 }}>
      {status && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 'var(--radius-card)',
            border: `1px solid ${status.overdue ? 'var(--flag-red)' : 'var(--shell-border)'}`,
            background: status.overdue ? 'rgba(158,59,46,0.06)' : 'var(--shell-sidebar-bg)',
            padding: '10px 14px',
            fontSize: 12,
            color: status.overdue ? 'var(--flag-red)' : 'var(--nav-inactive-text)',
          }}
        >
          {status.overdue
            ? `הערכה באיחור של ${status.days_overdue} ימים · מועד יעד ${new Date(status.due_at).toLocaleDateString('he-IL')}`
            : `הערכה הבאה עד ${new Date(status.due_at).toLocaleDateString('he-IL')} · כל ${status.interval_days} ימים`}
        </div>
      )}
      <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, padding: '14px 18px', borderBottom: '1px solid var(--shell-border)' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>
              טווח תנועה <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>Range of motion</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
              <span style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>
                {ROM_JOINT_HE[joint]}
                {lastMeasuredAt ? ` · מדידה אחרונה ${new Date(lastMeasuredAt).toLocaleDateString('he-IL')}` : ' · אין מדידות עדיין'}
                {` · מודד: ${affectedSide === 'involved' ? 'צד פגוע' : 'צד בריא'}`}
              </span>
              <button
                onClick={() => setAffectedSide((s) => (s === 'involved' ? 'healthy' : 'involved'))}
                style={{ background: 'transparent', border: '1px solid rgba(34,28,20,0.2)', color: 'var(--nav-inactive-text)', borderRadius: 'var(--radius-pill)', padding: '3px 9px', fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                החלף צד פגוע
              </button>
            </div>
          </div>
          {!isTablet && (
            <div style={{ display: 'flex', gap: 8 }}>
              {visitId ? (
                <>
                  <span style={{ alignSelf: 'center', fontSize: 11, color: 'var(--nav-inactive-text)', whiteSpace: 'nowrap' }}>{visitCount} מדידות במפגש</span>
                  <button onClick={() => setVisitId(null)} style={ghostRoundBtn}>בטל</button>
                  <Button size="sm" onClick={() => saveVisit.mutate()} disabled={saveVisit.isPending} loading={saveVisit.isPending}>סיים ושמור מפגש</Button>
                </>
              ) : (
                <Button size="sm" onClick={() => startVisit.mutate()} disabled={startVisit.isPending}>מפגש הערכה חדש</Button>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '11px 18px', borderBottom: '1px solid var(--shell-border-soft)' }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>מפרק נבדק</span>
          {ROM_JOINT_ORDER.map((j) => (
            <button
              key={j}
              onClick={() => setJoint(j)}
              style={j === joint
                ? { padding: '6px 15px', borderRadius: 'var(--radius-pill)', background: 'var(--gold-deep)', color: 'var(--cream)', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }
                : { padding: '6px 15px', borderRadius: 'var(--radius-pill)', background: 'transparent', border: '1px solid rgba(34,28,20,0.2)', color: 'var(--nav-inactive-text)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {ROM_JOINT_HE[j]}
            </button>
          ))}
          {joint === defaultJoint && <span style={{ fontSize: 10, color: 'var(--nav-inactive-text)' }}>• מפרק הפרוטוקול</span>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.7fr 0.8fr 0.8fr 1fr 1.2fr 0.9fr', padding: '10px 18px', fontSize: 11, color: 'var(--nav-inactive-text)', fontWeight: 600, background: 'var(--shell-content-bg)' }}>
          <div>תנועה · Motion</div><div>פגוע</div><div>בריא</div><div>סימטריה</div><div>מול נורמה ויעד</div><div>מגמה</div>
        </div>

        {isLoading ? (
          <div style={{ padding: 20 }}><Skeleton count={4} height={18} /></div>
        ) : error ? (
          <div style={{ padding: 20 }}><EmptyState title={t('error.generic.title')} body={t('error.generic.body')} /></div>
        ) : !data || data.length === 0 ? (
          <div style={{ padding: 40 }}><EmptyState title={t('empty.assessments.title')} body={t('empty.assessments.body')} /></div>
        ) : (
          data.map((entry) => {
            const { definition: def, involved, healthy, history } = entry;
            const bilat = def.flags.bilat !== false;
            const unit = def.unit === 'cm' ? ' ס״מ' : def.unit === 'deg' ? '°' : '';
            const flag = computeFlag(def, involved?.value ?? null, bilat ? healthy?.value ?? null : null, involved?.pass ?? null);

            let symLabel = '—';
            let symState: FlagState = 'neutral';
            if (!bilat) {
              symLabel = 'דו-צדדי';
            } else if (def.unit === 'cm' && involved && healthy) {
              const g = sideGap(involved.value, healthy.value);
              symLabel = `פער ${g} ס״מ`;
              symState = gapFlag(def, involved.value, healthy.value);
            } else if (def.unit === 'deg' && involved && healthy && healthy.value !== 0) {
              const lsi = Math.round((involved.value / healthy.value) * 100);
              symLabel = `LSI ${lsi}%`;
              symState = lsi >= 90 ? 'green' : 'red';
            }

            const barPct = involved && def.scale ? Math.max(0, Math.min(100, (Math.abs(involved.value) / def.scale) * 100)) : 0;
            const normPct = involved && def.norm ? Math.round((involved.value / def.norm) * 100) : null;
            const { points, delta } = trendSparkline(history);

            return (
              <div
                key={def.code}
                {...clickableDivProps(() => setSelectedCode(def.code))}
                style={{ display: 'grid', gridTemplateColumns: '1.7fr 0.8fr 0.8fr 1fr 1.2fr 0.9fr', padding: '13px 18px', borderTop: '1px solid var(--shell-border-soft)', alignItems: 'center', cursor: 'pointer' }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                    {def.name_he}
                    {def.protocol_tip && <span title={def.protocol_tip} style={{ fontSize: 10, color: 'var(--gold-deep)', cursor: 'help' }}> ⓘ</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)', marginTop: 2 }}>
                    {def.name_en}{def.norm != null ? ` · נורמה ${def.norm}${unit}` : ''}
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700, color: 'var(--ink)' }}>
                  {involved ? `${involved.value}${unit}` : '—'}
                </div>
                <div style={{ fontSize: 14, color: 'var(--ink-soft)' }}>
                  {bilat ? (healthy ? `${healthy.value}${unit}` : '—') : '—'}
                </div>
                <div>
                  <span style={{ display: 'inline-block', whiteSpace: 'nowrap', background: symState === 'red' ? 'var(--pill-attention-bg)' : symState === 'green' ? 'var(--pill-good-bg)' : 'var(--sand)', color: symState === 'red' ? 'var(--flag-red)' : symState === 'green' ? 'var(--flag-green)' : 'var(--nav-inactive-text)', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '4px 10px', borderRadius: 'var(--radius-pill)' }}>
                    {symLabel}
                  </span>
                </div>
                <div>
                  <div style={{ position: 'relative', height: 8, borderRadius: 'var(--radius-pill)', background: 'var(--shell-border-soft)', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', insetInlineStart: 0, top: 0, bottom: 0, width: `${barPct}%`, background: flagColor(flag) }} />
                  </div>
                  {def.target != null && <div style={{ fontSize: 10, color: 'var(--nav-inactive-text)', marginTop: 5 }}>יעד השלב {def.target}{unit}</div>}
                  {normPct != null && <div style={{ fontSize: 10, color: 'var(--gold-deep)', marginTop: 2 }}>{normPct}% מנורמה</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {points ? (
                    <>
                      <svg viewBox="0 0 60 20" style={{ width: 60, height: 20, overflow: 'visible' }}>
                        <polyline points={points} fill="none" stroke="var(--flag-green)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
                      </svg>
                      {delta != null && (
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--flag-green)', whiteSpace: 'nowrap' }}>
                          {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)}{unit}
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>—</span>
                  )}
                </div>
              </div>
            );
          })
        )}

        <div style={{ borderTop: '1px solid var(--shell-border-soft)', padding: '11px 18px', background: 'var(--shell-content-bg)' }}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>מעלות אינן מוצגות למטופל · Degrees are clinician-only</div>
        </div>
      </div>

      <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px dashed var(--placeholder)', borderRadius: 'var(--radius-card)', padding: 32, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13, marginTop: 14 }}>
        אין הערכות מתוזמנות · No assessments scheduled
      </div>

      {selectedEntry && (
        <MeasurementPanel
          patientId={patientId}
          patientName={patientName}
          entry={selectedEntry}
          visitId={visitId}
          readOnly={isTablet}
          onClose={() => setSelectedCode(null)}
          onSaved={() => {
            if (visitId) setVisitCount((c) => c + 1);
            queryClient.invalidateQueries({ queryKey: ['patient-measurements', patientId, joint] });
            setSelectedCode(null);
          }}
        />
      )}
    </div>
  );
}

const ghostRoundBtn: CSSProperties = {
  background: 'transparent', color: 'var(--ink-soft)', border: '1px solid rgba(34,28,20,0.24)',
  borderRadius: 'var(--radius-pill)', padding: '8px 12px', fontSize: 12, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
};

function HistoryTab({ data }: { data: OverviewData }) {
  const events = [
    ...data.recent_activity.map((s) => ({
      at: s.date,
      label: `${sessionStatusLabel[s.status] ?? s.status} (${Math.round(s.completion_ratio * 100)}%)`,
    })),
    ...data.phase_transitions.map((pt) => ({
      at: pt.approved_at,
      label: `מעבר שלב ${pt.from_phase_n} → ${pt.to_phase_n} (${pt.direction === 'forward' ? 'קדימה' : 'אחורה'})`,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div style={{ paddingTop: 18 }}>
      <div style={kpiCardStyle()}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', marginBottom: 10 }}>היסטוריה מלאה · Full History</div>
        {events.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nav-inactive-text)' }}>אין היסטוריה עדיין</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            {events.map((e, i) => (
              <div key={i}>
                <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{formatRelativeDate(e.at)}</span>{' '}
                <span style={{ color: 'var(--nav-inactive-text)' }}>— {e.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ThreadMessage {
  id: string;
  sender_type: 'clinician' | 'patient';
  body: string;
  sent_at: string;
  read_at: string | null;
}

function MessagesTab({ patientId, patientName }: { patientId: string; patientName: string }) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');

  const { data, isLoading } = useQuery<{ messages: ThreadMessage[] }>({
    queryKey: ['messages', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`messages?patient_id=${patientId}`, { method: 'GET' });
      if (error) throw error;
      return data as { messages: ThreadMessage[] };
    },
    refetchInterval: 15_000,
  });

  const send = useMutation({
    mutationFn: async (body: string) => {
      const { data, error } = await supabase.functions.invoke('messages', {
        method: 'POST',
        body: { patient_id: patientId, body },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data;
    },
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['messages', patientId] });
      queryClient.invalidateQueries({ queryKey: ['messages-unread'] });
    },
  });

  const messages = data?.messages ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 620 }}>
      <div
        style={{
          border: '1px solid var(--shell-border)',
          borderRadius: 'var(--radius-panel)',
          background: 'var(--shell-sidebar-bg)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          maxHeight: 460,
          overflow: 'auto',
        }}
      >
        {isLoading ? (
          <Skeleton count={4} height={40} />
        ) : messages.length === 0 ? (
          <div style={{ padding: '40px 10px', textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13 }}>
            אין הודעות עם {patientName} עדיין
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.sender_type === 'clinician';
            return (
              <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                <div
                  style={{
                    background: mine ? 'var(--gold-deep)' : 'var(--sand)',
                    color: mine ? 'var(--cream)' : 'var(--ink)',
                    borderRadius: 12,
                    padding: '8px 12px',
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {m.body}
                </div>
                <div style={{ fontSize: 10, color: 'var(--nav-inactive-text)', marginTop: 3, textAlign: mine ? 'left' : 'right' }}>
                  {new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(m.sent_at))}
                  {mine && m.read_at ? ' · נקרא' : ''}
                </div>
              </div>
            );
          })
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const body = draft.trim();
          if (body) send.mutate(body);
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="כתוב הודעה למטופל…"
          maxLength={4000}
          style={{ flex: 1, padding: '10px 13px', borderRadius: 9, border: '1px solid var(--shell-border)', background: 'var(--cream)', fontFamily: 'inherit', fontSize: 13 }}
        />
        <Button type="submit" size="sm" disabled={!draft.trim() || send.isPending}>
          שלח
        </Button>
      </form>
    </div>
  );
}
