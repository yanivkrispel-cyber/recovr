import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from 'offline';
import { pickPatientMedia, sessionItemSchema, type SessionItemInput } from 'shared';
import { YouTubeFacade, useOnlineStatus } from 'ui';
import { secondaryLabel } from '../lib/label';
import type { ExerciseMode } from '../App';
import FeedbackForm from '../components/FeedbackForm';
import { sessionQueue } from '../lib/sessionQueue';
import { TODAY_KEY, fetchToday, markDoneLocally } from '../lib/today';
import { unlockAudio, playTick, playStart, vibrate, isMuted, setMuted } from '../lib/cues';

interface ExerciseFlowProps {
  index: number;
  mode: ExerciseMode;
  onAdvance: (nextIndex: number) => void;
  /** Nothing left for today — show the completion screen. */
  onComplete: () => void;
  /** Single mode: this one exercise is logged, back to Home. */
  onSingleDone: (planExerciseId: string) => void;
  onCancel: () => void;
}

interface ExerciseMedia {
  kind: 'image' | 'gif' | 'video' | 'clip';
  url: string;
  thumb_url: string | null;
  /** MP4 rendition of an animated GIF (0053) — played instead of the GIF. */
  loop_url?: string | null;
  width: number | null;
  height: number | null;
  start_sec?: number | null;
  end_sec?: number | null;
}

interface TodayItem {
  id: string;
  sets: number | null;
  reps: number | null;
  hold_sec?: number | null;
  rest_sec?: number | null;
  side?: 'left' | 'right' | 'bilateral' | null;
  load?: number | null;
  load_unit?: string | null;
  tempo?: string | null;
  clinician_note?: string | null;
  exercise: {
    name: string; name_en?: string; instructions?: string; instruction_steps?: string[]; key_cues?: string[];
    media?: ExerciseMedia[];
  };
  done: boolean;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

function mediaSrc(u: string): string {
  return u.startsWith('http') ? u : `${SUPABASE_URL}${u}`;
}

// The exercise's single media slot — same place and same size on every
// exercise, so the screen never shifts. What fills it is pickPatientMedia's
// rule: YouTube (kind='video', url is an id — see packages/shared/src/youtube.ts)
// when online, else the first GIF/clip in the clinic's order (T-31), else a
// photo, else the slot stays an empty box. Verified media only reaches here
// (the me-today RPC filters on verified_at).
function ExerciseMediaFrame({
  media,
  name,
  compact,
}: {
  media?: ExerciseMedia[];
  name: string;
  compact?: boolean;
}) {
  const online = useOnlineStatus();
  const shown = pickPatientMedia(media, online);
  const height = compact ? 128 : 200;

  return (
    <div
      style={{
        width: '100%',
        height,
        background: 'var(--patient-card-light)',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {!shown ? null : shown.kind === 'video' ? (
        <YouTubeFacade youtubeId={shown.url} title={name} height={height} startSec={shown.start_sec} endSec={shown.end_sec} style={{ borderRadius: 0 }} />
      ) : shown.kind === 'clip' ? (
        <ClipLoop media={shown} name={name} height={height} />
      ) : shown.kind === 'gif' && shown.loop_url ? (
        <GifLoop media={shown} name={name} height={height} />
      ) : (
        <img
          src={mediaSrc(shown.url)}
          alt={name}
          style={{ height, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }}
        />
      )}
    </div>
  );
}

// A GIF with an MP4 rendition (loop_url, ~10% of the bytes) plays the video.
// If it can't autoplay (iOS Low Power Mode, data saver) or fails to load, it
// swaps back to the GIF itself so the movement is still shown animated.
function GifLoop({ media, name, height }: { media: ExerciseMedia; name: string; height: number }) {
  const [fallback, setFallback] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // Only a real "can't play here" falls back. An AbortError is transient —
    // Chrome pauses video-only media in a hidden tab to save power, and an
    // interrupted load rejects the same way — and autoplay resumes on its own.
    const p = v.play();
    if (p) {
      p.catch((e: unknown) => {
        const name = e instanceof DOMException ? e.name : '';
        if (name === 'NotAllowedError' || name === 'NotSupportedError') setFallback(true);
      });
    }
  }, []);

  if (fallback) {
    return (
      <img
        src={mediaSrc(media.url)}
        alt={name}
        style={{ height, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }}
      />
    );
  }
  return (
    <video
      ref={ref}
      src={mediaSrc(media.loop_url!)}
      poster={media.thumb_url ? mediaSrc(media.thumb_url) : undefined}
      aria-label={name}
      muted
      loop
      autoPlay
      playsInline
      disablePictureInPicture
      onError={() => setFallback(true)}
      style={{ height, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }}
    />
  );
}

// An uploaded clip plays like the GIF it replaces: muted, looping, inline.
// A trim window (start_sec/end_sec) loops just that part.
function ClipLoop({ media, name, height }: { media: ExerciseMedia; name: string; height: number }) {
  const start = media.start_sec ?? 0;
  const end = media.end_sec ?? null;
  return (
    <video
      src={mediaSrc(media.url)}
      poster={media.thumb_url ? mediaSrc(media.thumb_url) : undefined}
      aria-label={name}
      muted
      loop={end == null && start === 0}
      autoPlay
      playsInline
      onLoadedMetadata={(e) => { if (start > 0) e.currentTarget.currentTime = start; }}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        if (end != null && v.currentTime >= end) v.currentTime = start;
      }}
      onEnded={(e) => {
        const v = e.currentTarget;
        v.currentTime = start;
        void v.play();
      }}
      style={{ height, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }}
    />
  );
}

interface Today {
  session_id: string;
  items: TodayItem[];
  progress: { done: number; total: number };
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

export default function ExerciseFlow({ index, mode, onAdvance, onComplete, onSingleDone, onCancel }: ExerciseFlowProps) {
  const queryClient = useQueryClient();

  const { data } = useQuery<Today | null>({
    queryKey: TODAY_KEY,
    queryFn: () => fetchToday<Today>(),
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
      await sessionQueue.enqueue(input.session_id, full);
    },
  });

  if (!data?.items[index]) return null;
  const item = data.items[index];
  const items = data.items;
  const activeSessionId = data.session_id;
  const totalSets = Math.max(1, item.sets ?? 1);
  // The clinician's prescribed rest; 60s only when the plan doesn't say.
  const restMs = (item.rest_sec && item.rest_sec > 0 ? item.rest_sec : 60) * 1000;

  function handleFinishSet() {
    if (currentSet < totalSets) {
      // This tap is the gesture iOS needs before the end-of-rest cue can sound.
      unlockAudio();
      setRestEndsAt(Date.now() + restMs);
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
        reps_done: item.reps ?? undefined,
        pain_score: feedback.pain,
        difficulty: feedback.difficulty,
        note: feedback.note,
        skipped: false,
        logged_at: new Date().toISOString(),
      },
    });
    clearPosition(activeSessionId, index);
    // Mark it done in the cache right away. Refetching here would race the
    // queue's flush and bring back the server's not-yet-updated `done: false`;
    // App refetches ['today'] once the flush has actually landed.
    markDoneLocally(queryClient, item.id);

    const locallyDone = await sessionQueue.getQueuedPlanExerciseIds(activeSessionId);
    const nextIndex = findNextIncomplete(items, index, locallyDone);
    if (nextIndex === null) {
      onComplete();
    } else if (mode === 'single') {
      onSingleDone(item.id);
    } else {
      onAdvance(nextIndex);
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

          {item.done && (
            <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--patient-success)', background: 'rgba(127,185,140,.16)', borderRadius: 999, padding: '4px 10px' }}>
              ✓ בוצע היום <span style={{ fontWeight: 400, opacity: 0.8 }}>· Done today</span>
            </div>
          )}

          <ExerciseMediaFrame media={item.exercise.media} name={item.exercise.name} />

          <Dosage item={item} />
          {item.clinician_note && <ClinicianNote note={item.clinician_note} />}

          {item.exercise.instruction_steps && item.exercise.instruction_steps.length > 0 ? (
            <ol style={{ fontSize: 13, color: 'var(--patient-muted)', lineHeight: 1.6, margin: 0, paddingInlineStart: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {item.exercise.instruction_steps.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
          ) : item.exercise.instructions && (
            <p style={{ fontSize: 13, color: 'var(--patient-muted)', lineHeight: 1.6, margin: 0 }}>
              {item.exercise.instructions}
            </p>
          )}

          {item.exercise.key_cues && item.exercise.key_cues.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {item.exercise.key_cues.map((cue, i) => (
                <span key={i} style={{ fontSize: 12, color: 'var(--patient-text)', background: 'var(--patient-card-light)', borderRadius: 999, padding: '4px 10px' }}>
                  {cue}
                </span>
              ))}
            </div>
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
            {item.done ? 'Do it again · בצע שוב' : 'Start Exercise · התחל תרגיל'}
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
          <div style={{ fontSize: 13, color: 'var(--patient-muted)', marginTop: 20 }}>
            סט <bdi>{currentSet}</bdi> מתוך <bdi>{totalSets}</bdi> <span style={{ opacity: 0.75 }}>· Set {currentSet} of {totalSets}</span>
          </div>
          {/* What to do in this set — the number the patient is counting to. */}
          <div style={{ fontSize: 56, fontWeight: 800, color: 'var(--patient-gold)', fontFamily: 'var(--font-display)', lineHeight: 1.1, margin: '6px 0 2px' }}>
            <bdi>{item.reps ?? item.hold_sec ?? `${currentSet}/${totalSets}`}</bdi>
          </div>
          <div style={{ fontSize: 15, color: 'var(--patient-text)', fontWeight: 600, marginBottom: 12 }}>
            {item.reps ? 'חזרות · reps' : item.hold_sec ? 'שניות החזקה · sec hold' : ''}
          </div>
          <PrescriptionChips item={item} centered />
          {item.clinician_note && (
            <div style={{ margin: '14px 0 0', textAlign: 'start' }}>
              <ClinicianNote note={item.clinician_note} />
            </div>
          )}
          {item.hold_sec && restEndsAt === null ? <HoldTimer seconds={item.hold_sec} /> : null}
          <div style={{ height: 28 }} />

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

const SIDE_LABEL: Record<NonNullable<TodayItem['side']>, string> = {
  right: 'צד ימין · Right side',
  left: 'צד שמאל · Left side',
  bilateral: 'שני הצדדים · Both sides',
};

function chipTexts(item: TodayItem): string[] {
  const chips: string[] = [];
  if (item.side) chips.push(SIDE_LABEL[item.side]);
  // With reps the hold is per rep; without reps it's the headline number.
  if (item.hold_sec && item.reps) chips.push(`החזקה ${item.hold_sec} שנ׳ בכל חזרה`);
  if (item.load) chips.push(`משקל ${item.load}${item.load_unit ? ` ${item.load_unit}` : ''}`);
  if (item.tempo) chips.push(`קצב ${item.tempo}`);
  if (item.rest_sec) chips.push(`מנוחה ${item.rest_sec} שנ׳ בין סטים`);
  return chips;
}

function PrescriptionChips({ item, centered }: { item: TodayItem; centered?: boolean }) {
  const chips = chipTexts(item);
  if (chips.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: centered ? 'center' : 'flex-start' }}>
      {chips.map((c) => (
        <span key={c} style={{ fontSize: 12, color: 'var(--patient-text)', border: '1px solid var(--patient-border)', borderRadius: 999, padding: '4px 10px' }}>
          {c}
        </span>
      ))}
    </div>
  );
}

// "3 סטים × 10 חזרות" (or a hold time) plus the chips — the full
// prescription on the detail screen, before the patient starts.
function Dosage({ item }: { item: TodayItem }) {
  const sets = item.sets ?? 1;
  const per = item.reps ? `${item.reps} חזרות` : item.hold_sec ? `${item.hold_sec} שנ׳ החזקה` : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--patient-text)' }}>
        <bdi>{sets}</bdi> {sets === 1 ? 'סט' : 'סטים'}
        {per && (
          <>
            {' × '}
            <bdi>{per}</bdi>
          </>
        )}
      </div>
      <PrescriptionChips item={item} />
    </div>
  );
}

function ClinicianNote({ note }: { note: string }) {
  return (
    <div style={{ background: 'var(--patient-card-light)', borderInlineStart: '3px solid var(--patient-gold)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--patient-gold)', marginBottom: 3 }}>הערת המטפל · From your clinician</div>
      <div style={{ fontSize: 13, color: 'var(--patient-text)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{note}</div>
    </div>
  );
}

// Optional countdown for a prescribed hold — tap at the start of each hold.
// Deadline-based like RestTimer, so a backgrounded tab doesn't drift.
function HoldTimer({ seconds }: { seconds: number }) {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    if (endsAt === null) return;
    const deadline = endsAt;
    function tick() {
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) {
        vibrate([200, 100, 200]);
        setEndsAt(null);
      }
    }
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [endsAt]);

  const running = endsAt !== null;
  return (
    <button
      onClick={() => {
        setRemaining(seconds);
        setEndsAt(running ? null : Date.now() + seconds * 1000);
      }}
      style={{
        marginTop: 16,
        padding: '10px 20px',
        background: running ? 'var(--patient-card-light)' : 'transparent',
        border: '1px solid var(--patient-gold)',
        borderRadius: 999,
        color: 'var(--patient-text)',
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: 600,
        fontFamily: 'inherit',
        minWidth: 190,
      }}
    >
      {running ? (
        <>
          ⏱ <bdi>{remaining}</bdi> · עצור
        </>
      ) : (
        <>
          ▶ טיימר החזקה · <bdi>{seconds}</bdi> שנ׳
        </>
      )}
    </button>
  );
}

function RestTimer({ endsAt, onDone }: { endsAt: number; onDone: () => void }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
  const [muted, setMutedState] = useState(isMuted);
  const firedRef = useRef(false);
  const lastTickRef = useRef<number | null>(null);
  // onDone is a fresh closure each render; keep it out of the effect's deps so
  // the countdown (and its tick bookkeeping) only restarts on a new deadline.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    firedRef.current = false;
    lastTickRef.current = null;
    function tick() {
      const now = Date.now();
      const secs = Math.max(0, Math.ceil((endsAt - now) / 1000));
      setRemaining(secs);
      if (secs > 0 && secs <= 5 && lastTickRef.current !== secs) {
        lastTickRef.current = secs;
        playTick();
      }
      if (secs <= 0 && !firedRef.current) {
        firedRef.current = true;
        // Only cue when we're actually at the deadline — not when a reload
        // restores an already-expired rest or a backgrounded tab wakes late.
        if (now - endsAt < 1500) {
          playStart();
          vibrate(80);
        }
        onDoneRef.current();
      }
    }
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [endsAt]);

  function toggleMuted() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) unlockAudio();
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, color: 'var(--patient-muted)', marginBottom: 8 }}>
        מנוחה
        <button
          onClick={toggleMuted}
          aria-label={muted ? 'הפעל צליל' : 'השתק צליל'}
          aria-pressed={muted}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, padding: 4, lineHeight: 1, opacity: muted ? 0.55 : 0.9 }}
        >
          {muted ? '🔕' : '🔔'}
        </button>
      </div>
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
