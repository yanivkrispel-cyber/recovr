import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { OfflineQueue, uuidv7 } from 'offline';
import { sessionItemSchema, type SessionItemInput } from 'shared';
import { supabase } from '../App';
import FeedbackForm from '../components/FeedbackForm';

const queue = new OfflineQueue(
  async (entries) => {
    await supabase.functions.invoke(`me/sessions/${entries[0]?.session_id}/items`, {
      method: 'POST',
      body: { items: entries.map((e) => e.item) },
    });
  },
  { retryDelayMs: 30_000, maxAttempts: 5 },
);

interface ExerciseFlowProps {
  index: number;
  onComplete: () => void;
  onCancel: () => void;
}

interface TodayItem {
  id: string;
  sets: number;
  reps: number;
  exercise: { name: string; name_en?: string; instructions?: string };
}

interface Today {
  session_id: string;
  items: TodayItem[];
}

type Phase = 'detail' | 'active' | 'feedback';

export default function ExerciseFlow({ index, onComplete, onCancel }: ExerciseFlowProps) {
  const [phase, setPhase] = useState<Phase>('detail');
  const [currentSet, setCurrentSet] = useState(1);
  const [resting, setResting] = useState(false);
  const queryClient = useQueryClient();

  const { data } = useQuery<Today>({
    queryKey: ['today'],
    queryFn: async () => {
      const { data } = await supabase.functions.invoke('me/today', { method: 'GET' });
      return data;
    },
  });

  if (!data?.items[index]) return null;
  const item = data.items[index];
  const totalSets = item.sets;

  const logItem = useMutation({
    mutationFn: async (input: Partial<SessionItemInput>) => {
      const full: SessionItemInput = sessionItemSchema.parse({
        id: uuidv7(),
        plan_exercise_id: item.id,
        ...input,
        skipped: input.skipped ?? false,
        logged_at: new Date().toISOString(),
      });
      // Always queue to IndexedDB; queue flushes on reconnect
      await queue.enqueue(data.session_id, full);
    },
  });

  async function handleFinishSet() {
    if (currentSet < totalSets) {
      setResting(true);
      // 60-second rest timer
      setTimeout(() => {
        setResting(false);
        setCurrentSet((s) => s + 1);
      }, 60_000);
    } else {
      setPhase('feedback');
    }
  }

  async function handleFeedbackComplete() {
    // Log final set + complete
    await logItem.mutateAsync({
      sets_done: totalSets,
      reps_done: item.reps,
    });
    queryClient.invalidateQueries({ queryKey: ['today'] });
    onComplete();
  }

  return (
    <div style={{ padding: 20, paddingTop: 60 }}>
      {phase === 'detail' && (
        <div>
          <button
            onClick={onCancel}
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }}
          >
            ← חזרה
          </button>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: 'var(--navy)',
              fontFamily: 'var(--font-display)',
              margin: '16px 0 8px',
            }}
          >
            {item.exercise.name}
          </h1>
          {item.exercise.name_en && (
            <div
              style={{
                fontFamily: 'var(--font-accent)',
                fontStyle: 'italic',
                color: 'var(--gold)',
                fontSize: 14,
                marginBottom: 16,
              }}
            >
              {item.exercise.name_en}
            </div>
          )}

          {/* Placeholder for media (T-14) */}
          <div
            style={{
              width: '100%',
              aspectRatio: '4 / 3',
              background: 'var(--line-soft)',
              borderRadius: 'var(--radius-card)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted-2)',
              fontSize: 13,
              marginBottom: 16,
              border: '1px solid var(--line)',
            }}
          >
            סרטון הדרכה
          </div>

          {item.exercise.instructions && (
            <p style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.6, marginBottom: 24 }}>
              {item.exercise.instructions}
            </p>
          )}

          <div
            style={{
              background: 'var(--white)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-card)',
              padding: 16,
              marginBottom: 24,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              מינון
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--navy)', marginTop: 4 }}>
              {item.sets} × {item.reps}
            </div>
          </div>

          <button
            onClick={() => setPhase('active')}
            style={{
              width: '100%',
              minHeight: 56,
              background: 'var(--navy)',
              color: 'var(--cream)',
              border: 'none',
              borderRadius: 'var(--radius-button)',
              fontSize: 16,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            התחל
          </button>
        </div>
      )}

      {phase === 'active' && (
        <div style={{ textAlign: 'center' }}>
          <h2
            style={{
              fontSize: 20,
              color: 'var(--navy)',
              fontFamily: 'var(--font-display)',
              margin: '0 0 8px',
            }}
          >
            {item.exercise.name}
          </h2>
          <div style={{ fontSize: 64, fontWeight: 800, color: 'var(--gold)', fontFamily: 'var(--font-display)', margin: '40px 0' }}>
            {currentSet} / {totalSets}
          </div>
          <div style={{ fontSize: 16, color: 'var(--muted)', marginBottom: 48 }}>
            סט {currentSet}
          </div>

          {resting ? (
            <RestTimer onDone={() => setResting(false)} />
          ) : (
            <button
              onClick={handleFinishSet}
              style={{
                width: '100%',
                minHeight: 64,
                background: 'var(--gold)',
                color: 'var(--navy)',
                border: 'none',
                borderRadius: 'var(--radius-button)',
                fontSize: 18,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {currentSet < totalSets ? 'סיימתי סט — מנוחה' : 'סיימתי — משוב'}
            </button>
          )}
        </div>
      )}

      {phase === 'feedback' && (
        <FeedbackForm
          onSubmit={handleFeedbackComplete}
          loading={logItem.isPending}
        />
      )}
    </div>
  );
}

function RestTimer({ onDone }: { onDone: () => void }) {
  const [seconds, setSeconds] = useState(60);

  useEffect(() => {
    if (seconds === 0) {
      onDone();
      return;
    }
    const id = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [seconds, onDone]);

  return (
    <div>
      <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 8 }}>מנוחה</div>
      <div
        style={{
          fontSize: 56,
          fontWeight: 800,
          color: 'var(--navy)',
          fontFamily: 'var(--font-display)',
        }}
      >
        {seconds}
      </div>
      <button
        onClick={onDone}
        style={{
          marginTop: 32,
          padding: '12px 24px',
          background: 'transparent',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-button)',
          color: 'var(--muted)',
          cursor: 'pointer',
          fontSize: 14,
        }}
      >
        דלג מנוחה
      </button>
    </div>
  );
}
