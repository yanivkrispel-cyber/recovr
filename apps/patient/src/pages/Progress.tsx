import { useQuery } from '@tanstack/react-query';
import { Skeleton, QueryError } from 'ui';
import { t } from 'shared';
import { supabase } from '../App';

interface AdherenceDay {
  date: string;
  planned: boolean;
  completed: boolean;
  completion_ratio: number;
}

interface PainPoint {
  date: string;
  max_pain: number;
}

interface PhasePoint {
  n: number;
  name: string;
  name_en?: string;
  duration_days: number | null;
  status: 'done' | 'current' | 'todo';
  started_at: string | null;
}

interface ProgressData {
  adherence_pct: number | null;
  adherence_series: AdherenceDay[];
  pain_trend: PainPoint[];
  phase_timeline: PhasePoint[];
}

interface ProgressProps {
  onBack: () => void;
}

const WINDOW_DAYS = 30;

function painColor(pain: number): string {
  if (pain >= 6) return 'var(--patient-danger)';
  if (pain <= 3) return 'var(--patient-success)';
  return 'var(--patient-muted)';
}

export default function Progress({ onBack }: ProgressProps) {
  const { data, isLoading, error, refetch } = useQuery<ProgressData>({
    queryKey: ['progress'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`me-progress?window=${WINDOW_DAYS}`, {
        method: 'GET',
      });
      if (error) throw error;
      return data;
    },
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button
        onClick={onBack}
        style={{ background: 'none', border: 'none', color: 'var(--patient-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0, textAlign: 'right' }}
      >
        → חזרה · Back
      </button>
      <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 19, fontWeight: 700, color: 'var(--patient-text)' }}>
        ההתקדמות שלי <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--patient-muted)' }}>Your Progress</span>
      </div>

      {isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Skeleton height={80} radius={14} />
          <Skeleton height={110} radius={12} />
          <Skeleton height={110} radius={12} />
          <Skeleton height={90} radius={12} />
        </div>
      )}

      {!isLoading && error && (
        <QueryError
          title={t('error.generic.title')}
          body={t('error.generic.body')}
          retryLabel={t('error.generic.action')}
          onRetry={() => refetch()}
        />
      )}

      {data && (
        <>
          <AdherenceCard adherencePct={data.adherence_pct} series={data.adherence_series} />
          <PainTrendCard points={data.pain_trend} />
          <PhaseTimelineCard phases={data.phase_timeline} />
        </>
      )}

      <button
        onClick={() => window.location.assign('/m/program/print')}
        style={{ background: 'transparent', border: '1px solid var(--patient-border)', borderRadius: 12, padding: '13px 16px', color: 'var(--patient-text)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'right' }}
      >
        תוכנית מודפסת <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--patient-muted)' }}>· Printable program</span>
      </button>
    </div>
  );
}

function AdherenceCard({ adherencePct, series }: { adherencePct: number | null; series: AdherenceDay[] }) {
  const hasData = series.some((d) => d.planned);

  return (
    <div style={{ background: 'var(--patient-card)', border: '1px solid rgba(201,162,75,.45)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--patient-text)' }}>
          {t('patient.progress.adherence')} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--patient-muted)' }}>Adherence · 30 ימים</span>
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: adherencePct !== null && adherencePct < 70 ? 'var(--patient-danger)' : 'var(--patient-gold)' }}>
          {adherencePct !== null ? `${adherencePct}%` : '—'}
        </div>
      </div>

      {hasData ? (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 40 }}>
          {series.map((d) => (
            <div
              key={d.date}
              title={d.date}
              style={{
                flex: 1,
                minWidth: 2,
                height: d.planned ? Math.max(4, Math.round(d.completion_ratio * 40)) : 4,
                borderRadius: 2,
                background: !d.planned ? 'rgba(243,234,217,0.08)' : d.completed ? 'var(--patient-gold)' : 'rgba(228,169,156,0.55)',
              }}
            />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--patient-muted)', lineHeight: 1.5 }}>
          {t('empty.progress.title')} <span style={{ opacity: 0.8 }}>· {t('empty.progress.body')}</span>
        </div>
      )}
    </div>
  );
}

function PainTrendCard({ points }: { points: PainPoint[] }) {
  return (
    <div style={{ background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--patient-text)' }}>
        {t('patient.progress.pain_trend')} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--patient-muted)' }}>Pain trend</span>
      </div>
      {points.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--patient-muted)' }}>{t('empty.progress.title')}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }}>
          {points.map((p) => (
            <div key={p.date} title={`${p.date}: ${p.max_pain}/10`} style={{ flex: 1, minWidth: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <div
                style={{
                  width: '100%',
                  height: Math.max(3, Math.round((p.max_pain / 10) * 44)),
                  borderRadius: 2,
                  background: painColor(p.max_pain),
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhaseTimelineCard({ phases }: { phases: PhasePoint[] }) {
  return (
    <div style={{ background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--patient-text)', marginBottom: 14 }}>
        {t('patient.progress.phase_timeline')} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--patient-muted)' }}>Phase timeline</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        {phases.map((p) => (
          <div key={p.n} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1 }}>
            {p.status === 'done' && (
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>✓</div>
            )}
            {p.status === 'current' && (
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{p.n}</div>
            )}
            {p.status === 'todo' && (
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--patient-card-light)', color: 'var(--patient-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>{p.n}</div>
            )}
            <div style={{ fontSize: 9, color: 'var(--patient-muted)' }}>שלב {p.n}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
