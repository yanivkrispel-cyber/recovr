import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton, QueryError, clickableDivProps } from 'ui';
import { t } from 'shared';
import { supabase } from '../App';

interface TodayItem {
  id: string;
  sets: number;
  reps: number;
  exercise: { name: string; name_en?: string };
  done: boolean;
}

interface Today {
  session_id: string;
  date: string;
  patient: { name: string; day: number };
  plan: { protocol_name: string; updated_recently: boolean };
  phase: { name: string; n: number };
  est_minutes: number;
  items: TodayItem[];
  progress: { done: number; total: number };
}

interface HomeProps {
  onStartExercise: (index: number) => void;
  onOpenProgress: () => void;
  onOpenEducation: () => void;
}

export default function Home({ onStartExercise, onOpenProgress, onOpenEducation }: HomeProps) {
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<Today>({
    queryKey: ['today'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('me-today', { method: 'GET' });
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Skeleton width={170} height={19} />
        <Skeleton width={120} height={12} />
        <Skeleton height={150} radius={16} />
        <Skeleton count={4} height={52} radius={12} />
      </div>
    );
  }

  if (error) {
    return (
      <QueryError
        title={t('error.generic.title')}
        body={t('error.generic.body')}
        retryLabel={t('error.generic.action')}
        onRetry={() => refetch()}
      />
    );
  }

  if (!data) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 10px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 17, color: 'var(--patient-text)' }}>אין תכנית פעילה</h1>
      </div>
    );
  }

  const firstIncompleteIdx = data.items.findIndex((i) => !i.done);
  const allDone = data.progress.total > 0 && data.progress.done === data.progress.total;
  const firstName = data.patient.name.split(' ')[0];
  const progressPct = data.progress.total === 0 ? 0 : Math.round((data.progress.done / data.progress.total) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {data.plan.updated_recently && !bannerDismissed && (
        <div style={{ background: 'var(--patient-card-light)', border: '1px solid rgba(201,162,75,.4)', borderRadius: 14, padding: '13px 15px', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--patient-gold)', marginTop: 5, flex: 'none' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--patient-text)' }}>התכנית שלך עודכנה</div>
            <div style={{ fontSize: 12, color: 'var(--patient-muted)', marginTop: 2, lineHeight: 1.5 }}>
              המטפל עדכן את תכנית השיקום שלך לאחרונה <span style={{ opacity: 0.8 }}>· Your plan was updated</span>
            </div>
          </div>
          <button onClick={() => setBannerDismissed(true)} aria-label="סגור · Dismiss" style={{ background: 'none', border: 'none', color: 'var(--patient-dim)', fontSize: 15, cursor: 'pointer', padding: 0, lineHeight: 1 }}>✕</button>
        </div>
      )}

      <div>
        <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 19, fontWeight: 700, color: 'var(--patient-text)' }}>
          בוקר טוב, {firstName} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--patient-muted)' }}>Good morning</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--patient-muted)', marginTop: 2 }}>
          יום {data.patient.day} · שלב {data.phase.n} <span style={{ opacity: 0.75 }}>Day {data.patient.day} · Phase {data.phase.n}</span>
        </div>
      </div>

      <div style={{ background: 'var(--patient-card)', border: '1px solid rgba(201,162,75,.45)', borderRadius: 16, padding: 20, color: 'var(--patient-text)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="18" height="15" viewBox="0 0 26 22" fill="none" aria-hidden="true">
            <path d="M1 21V5l6 6 6-10 6 10 6-6v16H1Z" stroke="var(--patient-gold)" strokeWidth={2} strokeLinejoin="round" />
          </svg>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>השיקום של היום · Today's Rehabilitation</div>
        </div>
        <div style={{ height: 1, background: 'linear-gradient(90deg,rgba(201,162,75,.6),rgba(201,162,75,0))' }} />
        <div style={{ fontSize: 12, color: 'var(--patient-muted)' }}>
          {data.progress.total} פעילויות · כ-{data.est_minutes} דקות <span>· {data.progress.total} activities, ~{data.est_minutes} min</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--patient-dim)' }}>
          מתוך {data.plan.protocol_name} · שלב {data.phase.n} — {data.phase.name}
        </div>
        {allDone ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 0 4px', textAlign: 'center' }}>
            <div style={{ fontSize: 26 }}>🎉</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--patient-text)' }}>סיימת להיום</div>
            <div style={{ fontSize: 12, color: 'var(--patient-muted)', lineHeight: 1.5 }}>
              האימון הבא שלך: מחר <span style={{ opacity: 0.8 }}>· You're done for today</span>
            </div>
          </div>
        ) : (
          <button
            onClick={() => onStartExercise(Math.max(0, firstIncompleteIdx))}
            style={{ background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)', border: 'none', borderRadius: 999, padding: 13, fontSize: 14, fontWeight: 700, letterSpacing: '0.03em', cursor: 'pointer', fontFamily: 'inherit', marginTop: 4, width: '100%' }}
          >
            {data.progress.done > 0 ? 'המשך' : 'התחל'} את התכנית · Start Today's Plan
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onOpenEducation} style={secondaryBtnStyle}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>ℹ אודות השלב</span>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--patient-muted)' }}>About phase</span>
        </button>
        <button onClick={onOpenProgress} style={secondaryBtnStyle}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>◔ ההתקדמות שלי</span>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--patient-muted)' }}>My Progress</span>
        </button>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--patient-muted)', marginBottom: 6 }}>
          <span>התקדמות היום · Today's progress</span>
          <span>{data.progress.done} / {data.progress.total}</span>
        </div>
        <div style={{ height: 8, background: 'rgba(243,234,217,0.18)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--patient-gold)', borderRadius: 999 }} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.items.map((item, idx) => (
          <div
            key={item.id}
            {...clickableDivProps(() => onStartExercise(idx))}
            style={{ background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
          >
            {item.done ? (
              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--patient-success)', color: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flex: 'none' }}>✓</span>
            ) : (
              <span style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px solid rgba(243,234,217,0.28)', flex: 'none' }} />
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--patient-text)' }}>
                {item.exercise.name} <span style={{ fontWeight: 400, color: 'var(--patient-muted)', fontSize: 11 }}>{item.exercise.name_en}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--patient-muted)' }}><bdi>{item.sets} × {item.reps}</bdi></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const secondaryBtnStyle = {
  flex: 1,
  minWidth: 0,
  background: 'var(--patient-card)',
  border: '1px solid var(--patient-border)',
  borderRadius: 12,
  padding: '11px 12px',
  color: 'var(--patient-text)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'right' as const,
  lineHeight: 1.35,
};
