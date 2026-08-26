import { useQuery } from '@tanstack/react-query';
import { Skeleton } from 'ui';
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
  phase: { name: string };
  items: TodayItem[];
  progress: { done: number; total: number };
}

interface HomeProps {
  onStartExercise: (index: number) => void;
}

export default function Home({ onStartExercise }: HomeProps) {
  const { data, isLoading } = useQuery<Today>({
    queryKey: ['today'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('me/today', { method: 'GET' });
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) {
    return (
      <div style={{ padding: 20, paddingTop: 60 }}>
        <Skeleton width="60%" height={28} />
        <div style={{ marginTop: 24 }}>
          <Skeleton count={4} height={72} radius={14} />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 24, paddingTop: 60, textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, color: 'var(--navy)' }}>אין אימון מתוכנן</h1>
      </div>
    );
  }

  const firstIncompleteIdx = data.items.findIndex((i) => !i.done);
  const progressPct = data.progress.total === 0 ? 0 : Math.round((data.progress.done / data.progress.total) * 100);

  return (
    <div>
      {/* Header */}
      <header style={{ padding: '20px 20px 16px', background: 'var(--cream)' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
            marginBottom: 4,
          }}
        >
          {data.date}
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 800,
            color: 'var(--navy)',
            fontFamily: 'var(--font-display)',
          }}
        >
          היום שלי
        </h1>
        <div style={{ marginTop: 8, fontSize: 14, color: 'var(--muted)' }}>
          {data.phase.name}
        </div>
      </header>

      {/* Progress ring */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: 20,
          background: 'var(--white)',
          margin: '0 20px 16px',
          borderRadius: 'var(--radius-panel)',
        }}
      >
        <ProgressRing value={progressPct} />
        <div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>התקדמות</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--navy)' }}>
            {data.progress.done} / {data.progress.total} תרגילים
          </div>
        </div>
      </div>

      {/* Exercise list */}
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 20px' }}>
        {data.items.map((item, idx) => (
          <li
            key={item.id}
            style={{
              padding: 16,
              background: 'var(--white)',
              border: '1px solid var(--line-soft)',
              borderRadius: 'var(--radius-card)',
              marginBottom: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              opacity: item.done ? 0.6 : 1,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: item.done ? 'var(--flag-green)' : 'var(--navy)',
                color: 'var(--cream)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {item.done ? '✓' : idx + 1}
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: 'var(--ink)',
                }}
              >
                {item.exercise.name}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  marginTop: 2,
                }}
              >
                {item.sets} × {item.reps}
              </div>
            </div>
            {!item.done && (
              <button
                onClick={() => onStartExercise(idx)}
                style={{
                  background: 'var(--gold)',
                  color: 'var(--navy)',
                  border: 'none',
                  borderRadius: 'var(--radius-pill)',
                  padding: '6px 14px',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                  minHeight: 44,
                  minWidth: 44,
                }}
              >
                התחל
              </button>
            )}
          </li>
        ))}
      </ul>

      {/* Primary CTA */}
      {firstIncompleteIdx >= 0 && (
        <div style={{ padding: '8px 20px 32px' }}>
          <button
            onClick={() => onStartExercise(firstIncompleteIdx)}
            style={{
              width: '100%',
              minHeight: 56,
              background: 'var(--navy)',
              color: 'var(--cream)',
              border: 'none',
              borderRadius: 'var(--radius-button)',
              fontSize: 16,
              fontWeight: 700,
              fontFamily: 'var(--font-ui)',
              cursor: 'pointer',
            }}
          >
            {data.progress.done > 0 ? 'המשך' : 'התחל'} את האימון
          </button>
        </div>
      )}
    </div>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 28;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64">
      <circle
        cx="32"
        cy="32"
        r={r}
        stroke="var(--line-soft)"
        strokeWidth="6"
        fill="none"
      />
      <circle
        cx="32"
        cy="32"
        r={r}
        stroke="var(--gold)"
        strokeWidth="6"
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 32 32)"
      />
      <text
        x="32"
        y="36"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fill="var(--navy)"
        fontFamily="var(--font-ui)"
      >
        {value}%
      </text>
    </svg>
  );
}
