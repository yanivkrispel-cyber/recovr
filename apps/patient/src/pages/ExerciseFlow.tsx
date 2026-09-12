import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { OfflineQueue, uuidv7 } from 'offline';
import { sessionItemSchema, type SessionItemInput } from 'shared';
import { YouTubeFacade, useOnlineStatus } from 'ui';
import { supabase } from '../App';
import { secondaryLabel } from '../lib/label';
import FeedbackForm from '../components/FeedbackForm';

const queue = new OfflineQueue(
  async (entries) => {
    await supabase.functions.invoke(`me-sessions-items/${entries[0]?.session_id}/items`, {
      method: 'POST',
      body: { items: entries.map((e) => e.item) },
    });
  },
  { retryDelayMs: 30_000, maxAttempts: 5 },
);

interface ExerciseFlowProps {
  index: number;
  onAdvance: (nextIndex: number) => void;
  onComplete: () => void;
  onCancel: () => void;
}

interface ExerciseMedia {
  kind: 'image' | 'gif' | 'video';
  url: string;
  thumb_url: string | null;
  width: number | null;
  height: number | null;
}

interface TodayItem {
  id: string;
  sets: number;
  reps: number;
  exercise: { name: string; name_en?: string; instructions?: string; media?: ExerciseMedia[] };
  done: boolean;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

function mediaSrc(u: string): string {
  return u.startsWith('http') ? u : `${SUPABASE_URL}${u}`;
}

// Verified media only reaches here (the me-today RPC filters on verified_at);
// with nothing verified yet the array is empty and this renders the labeled
// placeholder frame.
function ExerciseMediaFrame({
  media,
  name,
  compact,
}: {
  media?: ExerciseMedia[];
  name: string;
  compact?: boolean;
}) {
  // The GIF is the rep-loop visual — tiny, autoplays instantly, no network
  // cost on every set. A YouTube video (kind='video', url is an id — see
  // packages/shared/src/youtube.ts) is supplementary instructional content,
  // surfaced separately below, never as this frame's image src.
  const primary = media?.find((m) => m.kind !== 'video' && m.kind === 'gif')
    ?? media?.find((m) => m.kind !== 'video')
    ?? null;

  if (!primary) {
    return (
      <div
        style={{
          width: '100%',
          height: compact ? 96 : 160,
          background: 'var(--patient-card-light)',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--patient-dim)',
          fontSize: 13,
        }}
      >
        וידאו · VIDEO
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        background: 'var(--patient-card-light)',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <img
        src={mediaSrc(primary.url)}
        alt={name}
        style={{ height: compact ? 128 : 200, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }}
      />
    </div>
  );
}

// Supplementary instructional video — shown collapsed as a labeled toggle so
// it never costs a network request unless the patient actually wants it, and
// hidden entirely offline since a YouTube embed can't load without a
// connection (the GIF above already covers the offline case).
function ExerciseVideoSection({ media, name }: { media?: ExerciseMedia[]; name: string }) {
  const [open, setOpen] = useState(false);
  const online = useOnlineStatus();
  const video = media?.find((m) => m.kind === 'video');
  if (!video || !online) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: '1px solid var(--patient-card-light)',
          borderRadius: 999,
          padding: '8px 14px',
          color: 'var(--patient-text)',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
          alignSelf: 'flex-start',
        }}
      >
        ▶ צפו בסרטון ההדרכה · Watch tutorial video
      </button>
    );
  }

  return <YouTubeFacade youtubeId={video.url} title={name} height={200} />;
}

interface Today {
  session_id: string;
  items: TodayItem[];
}

type Phase = 'detail' | 'active' | 'feedback';

interface FlowPosition {
  phase: Phase;
  currentSet: number;
  restEndsAt: number | null;
}

function positionKey(sessionId: string, index: number) {
  return `rehab:flow:${sessionId}:${index}`;
}

function loadPosition(sessionId: string, index: number): FlowPosition | null {
  try {
    const raw = localStorage.getItem(positionKey(sessionId, index));
    return raw ? (JSON.parse(raw) as FlowPosition) : null;
  } catch {
    return null;
  }
}

function savePosition(sessionId: string, index: number, pos: FlowPosition) {
  try {
    localStorage.setItem(positionKey(sessionId, index), JSON.stringify(pos));
  } catch {
    // storage unavailable — position just won't be restored
  }
}

function clearPosition(sessionId: string, index: number) {
  try {
    localStorage.removeItem(positionKey(sessionId, index));
  } catch {
    // ignore
  }
}

// `items[i].done` is server-reported and only updates once a queued item has
// actually synced — while offline (or before the next sync) it stays stale
// for anything just logged this session. `locallyDone` (derived from the
// offline queue itself, see getQueuedPlanExerciseIds) fills that gap so a
// fully-offline session still advances correctly and terminates instead of
// wrapping back to an exercise that was, in fact, already logged.
function findNextIncomplete(
  items: TodayItem[],
  fromIndex: number,
  locallyDone: Set<string>,
): number | null {
  const isDone = (item: TodayItem) => item.done || locallyDone.has(item.id);
  for (let i = fromIndex + 1; i < items.length; i++) if (!isDone(items[i])) return i;
  for (let i = 0; i < fromIndex; i++) if (!isDone(items[i])) return i;
  return null;
}

export default function ExerciseFlow({ index, onAdvance, onComplete, onCancel }: ExerciseFlowProps) {
  const queryClient = useQueryClient();

  const { data } = useQuery<Today>({
    queryKey: ['today'],
    queryFn: async () => {
      const { data } = await supabase.functions.invoke('me-today', { method: 'GET' });
      return data;
    },
  });

  const sessionId = data?.session_id;

  const [phase, setPhase] = useState<Phase>('detail');
  const [currentSet, setCurrentSet] = useState(1);
  const [restEndsAt, setRestEndsAt] = useState<number | null>(null);

  // `data` (and so sessionId) isn't available on the render that mounts this
  // component — it loads async — so the saved position has to be applied once
  // it arrives rather than via useState's mount-only initializer.
  const appliedRestoreRef = useRef(false);
  useEffect(() => {
    if (!sessionId || appliedRestoreRef.current) return;
    appliedRestoreRef.current = true;
    const restored = loadPosition(sessionId, index);
    if (restored) {
      setPhase(restored.phase);
      setCurrentSet(restored.currentSet);
      setRestEndsAt(restored.restEndsAt);
    }
  }, [sessionId, index]);

  useEffect(() => {
    if (!sessionId || !appliedRestoreRef.current) return;
    savePosition(sessionId, index, { phase, currentSet, restEndsAt });
  }, [sessionId, index, phase, currentSet, restEndsAt]);

  const logItem = useMutation({
    // networkMode: 'always' (see main.tsx) — this mutation's actual work is
    // a local IndexedDB write; the queue is what defers the network call.
    mutationFn: async (input: { session_id: string; item: SessionItemInput }) => {
      const full = sessionItemSchema.parse(input.item);
      // Always queue to IndexedDB; queue flushes on reconnect
      await queue.enqueue(input.session_id, full);
    },
  });

  if (!data?.items[index]) return null;
  const item = data.items[index];
  const items = data.items;
  const activeSessionId = data.session_id;
  const totalSets = item.sets;

  function handleFinishSet() {
    if (currentSet < totalSets) {
      setRestEndsAt(Date.now() + 60_000);
    } else {
      setPhase('feedback');
    }
  }

  function handleRestDone() {
    setRestEndsAt(null);
    setCurrentSet((s) => s + 1);
  }

  function handleCancel() {
    if (sessionId) clearPosition(sessionId, index);
    onCancel();
  }

  async function handleFeedbackComplete(feedback: { pain: number; difficulty: 'easy' | 'medium' | 'hard'; note?: string }) {
    await logItem.mutateAsync({
      session_id: activeSessionId,
      item: {
        id: uuidv7(),
        plan_exercise_id: item.id,
        sets_done: totalSets,
        reps_done: item.reps,
        pain_score: feedback.pain,
        difficulty: feedback.difficulty,
        note: feedback.note,
        skipped: false,
        logged_at: new Date().toISOString(),
      },
    });
    clearPosition(activeSessionId, index);
    // Don't await this: server `done` flags only update once this sync
    // actually lands, which won't happen at all while offline. Advancing is
    // decided below from the local queue instead; this call just keeps the
    // cache fresh for once connectivity returns.
    void queryClient.invalidateQueries({ queryKey: ['today'] });

    const locallyDone = await queue.getQueuedPlanExerciseIds(activeSessionId);
    const nextIndex = findNextIncomplete(items, index, locallyDone);
    if (nextIndex !== null) {
      onAdvance(nextIndex);
    } else {
      onComplete();
    }
  }

  return (
    <div>
      {phase === 'detail' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <button
            onClick={handleCancel}
            style={{ background: 'transparent', border: 'none', color: 'var(--patient-muted)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', padding: 0, textAlign: 'right' }}
          >
            → חזרה · Back
          </button>
          <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 18, fontWeight: 700, color: 'var(--patient-text)' }}>
            {item.exercise.name} {secondaryLabel(item.exercise.name, item.exercise.name_en) && <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--patient-muted)' }}>{secondaryLabel(item.exercise.name, item.exercise.name_en)}</span>}
          </div>

          <ExerciseMediaFrame media={item.exercise.media} name={item.exercise.name} />
          <ExerciseVideoSection media={item.exercise.media} name={item.exercise.name} />

          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--patient-text)' }}>
            <bdi>{item.sets} × {item.reps}</bdi>
          </div>

          {item.exercise.instructions && (
            <p style={{ fontSize: 13, color: 'var(--patient-muted)', lineHeight: 1.6, margin: 0 }}>
              {item.exercise.instructions}
            </p>
          )}

          <button
            onClick={() => setPhase('active')}
            style={{
              width: '100%',
              minHeight: 56,
              background: 'var(--patient-gold)',
              color: 'var(--patient-gold-ink)',
              border: 'none',
              borderRadius: 999,
              fontSize: 16,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Start Exercise · התחל תרגיל
          </button>
        </div>
      )}

      {phase === 'active' && (
        <div style={{ textAlign: 'center', paddingTop: 20 }}>
          <h2
            style={{
              fontSize: 20,
              color: 'var(--patient-text)',
              fontFamily: 'var(--font-display)',
              margin: '0 0 8px',
            }}
          >
            {item.exercise.name}
          </h2>
          <div style={{ margin: '12px 0 4px' }}>
            <ExerciseMediaFrame media={item.exercise.media} name={item.exercise.name} compact />
          </div>
          <div style={{ fontSize: 64, fontWeight: 800, color: 'var(--patient-gold)', fontFamily: 'var(--font-display)', margin: '24px 0' }}>
            <bdi>{currentSet} / {totalSets}</bdi>
          </div>
          <div style={{ fontSize: 16, color: 'var(--patient-muted)', marginBottom: 48 }}>
            סט {currentSet}
          </div>

          {restEndsAt !== null ? (
            <RestTimer endsAt={restEndsAt} onDone={handleRestDone} />
          ) : (
            <button
              onClick={handleFinishSet}
              style={{
                width: '100%',
                minHeight: 64,
                background: 'var(--patient-gold)',
                color: 'var(--patient-gold-ink)',
                border: 'none',
                borderRadius: 999,
                fontSize: 18,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
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

function RestTimer({ endsAt, onDone }: { endsAt: number; onDone: () => void }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
    function tick() {
      const secs = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0 && !firedRef.current) {
        firedRef.current = true;
        onDone();
      }
    }
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [endsAt, onDone]);

  return (
    <div>
      <div style={{ fontSize: 14, color: 'var(--patient-muted)', marginBottom: 8 }}>מנוחה</div>
      <div
        style={{
          fontSize: 56,
          fontWeight: 800,
          color: 'var(--patient-text)',
          fontFamily: 'var(--font-display)',
        }}
      >
        {remaining}
      </div>
      <button
        onClick={onDone}
        style={{
          marginTop: 32,
          padding: '12px 24px',
          background: 'transparent',
          border: '1px solid var(--patient-border)',
          borderRadius: 999,
          color: 'var(--patient-muted)',
          cursor: 'pointer',
          fontSize: 14,
          fontFamily: 'inherit',
        }}
      >
        דלג מנוחה
      </button>
    </div>
  );
}
