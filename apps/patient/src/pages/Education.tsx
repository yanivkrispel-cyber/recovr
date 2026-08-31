import { useQuery } from '@tanstack/react-query';
import { Skeleton } from 'ui';
import { t } from 'shared';
import { supabase } from '../App';

interface Goal {
  he: string;
  en?: string;
}

interface EducationData {
  phase_n: number;
  phase_name: string;
  phase_name_en?: string;
  goals: Goal[];
  exercise_count: number;
  est_minutes: number;
}

interface EducationProps {
  onBack: () => void;
}

export default function Education({ onBack }: EducationProps) {
  const { data, isLoading } = useQuery<EducationData>({
    queryKey: ['education'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('me-education', { method: 'GET' });
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
      <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 18, fontWeight: 700, color: 'var(--patient-text)' }}>
        אודות השלב <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--patient-muted)' }}>About this phase</span>
      </div>

      {isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Skeleton height={50} radius={12} />
          <Skeleton height={80} radius={12} />
          <Skeleton height={60} radius={12} />
          <Skeleton height={70} radius={12} />
        </div>
      )}

      {!isLoading && !data && (
        <div style={{ padding: '60px 10px', textAlign: 'center', color: 'var(--patient-muted)', fontSize: 13 }}>
          {t('error.generic.body')}
        </div>
      )}

      {data && (
        <>
          <div style={{ background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--patient-text)' }}>
              {data.phase_name} {data.phase_name_en && <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--patient-muted)' }}>{data.phase_name_en}</span>}
            </div>
          </div>

          <div style={{ background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--patient-muted)' }}>
              על מה אנחנו עובדים <span style={{ opacity: 0.8 }}>· What we're working on</span>
            </div>
            {data.goals.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--patient-muted)' }}>—</div>
            ) : (
              data.goals.map((g, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--patient-text)', opacity: 0.9 }}>
                  • {g.he} {g.en && <span style={{ color: 'var(--patient-muted)' }}>· {g.en}</span>}
                </div>
              ))
            )}
          </div>

          <div style={{ background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--patient-muted)', marginBottom: 6 }}>
              למה לצפות <span style={{ opacity: 0.8 }}>· What to expect</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--patient-text)', opacity: 0.9 }}>
              כ-{data.exercise_count} תרגילים ביום, כ-{data.est_minutes} דקות בממוצע
              <span style={{ color: 'var(--patient-muted)' }}> · About {data.exercise_count} exercises daily, ~{data.est_minutes} minutes on average.</span>
            </div>
          </div>

          <div style={{ background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--patient-muted)', marginBottom: 6 }}>
              דברים לשים לב אליהם <span style={{ opacity: 0.8 }}>· Things to keep in mind</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--patient-text)', opacity: 0.9 }}>
              בצע בעדינות והפסק אם מופיע כאב חד. דווח למטפל על שינויים
              <span style={{ color: 'var(--patient-muted)' }}> · Move gently and stop if sharp pain appears. Report changes to your clinician.</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
