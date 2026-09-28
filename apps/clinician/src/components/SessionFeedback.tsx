import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SupabaseContext } from '../App';

// Per-exercise feedback the patient logs during a session (pain, difficulty,
// free-text note, skip reason) — GET patient-overview/patients/:id/sessions.

export interface SessionItemFeedback {
  id: string;
  exercise_id: string;
  name: string;
  name_en: string | null;
  sets_done: number | null;
  reps_done: number | null;
  load_used: number | null;
  pain_score: number | null;
  difficulty: 'easy' | 'medium' | 'hard' | null;
  skipped: boolean;
  skip_reason: string | null;
  note: string | null;
  logged_at: string;
  synced_at: string | null;
}

export interface SessionWithFeedback {
  id: string;
  date: string;
  status: string;
  items_planned: number;
  items_done: number;
  completion_ratio: number;
  items: SessionItemFeedback[];
}

export interface PatientSessions {
  feedback_seen_at: string | null;
  sessions: SessionWithFeedback[];
}

export interface UnseenFeedback {
  patient_id: string;
  count: number;
  latest_at: string;
}

export function usePatientSessions(patientId: string) {
  const supabase = useContext(SupabaseContext);
  return useQuery({
    queryKey: ['patient-sessions', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        `patient-overview/patients/${patientId}/sessions?limit=60`,
        { method: 'GET' },
      );
      if (error) throw error;
      return data as PatientSessions;
    },
  });
}

/** patient_id -> count of notes nobody at the clinic has opened yet. */
export function useUnseenFeedback() {
  const supabase = useContext(SupabaseContext);
  const { data } = useQuery({
    queryKey: ['unseen-feedback'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('patient-overview/feedback/unseen', { method: 'GET' });
      if (error) throw error;
      return data as UnseenFeedback[];
    },
    refetchInterval: 60_000,
  });
  return new Map((data ?? []).map((u) => [u.patient_id, u.count]));
}

export function isNewNote(item: SessionItemFeedback, seenAt: string | null): boolean {
  if (!item.note || !item.synced_at) return false;
  return !seenAt || new Date(item.synced_at) > new Date(seenAt);
}

export function NewNotePill({ count }: { count?: number }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--gold)', color: 'var(--navy)',
        borderRadius: 'var(--radius-pill)', padding: '1px 8px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
      }}
    >
      {count && count > 1 ? `${count} הערות חדשות` : 'הערה חדשה'}
    </span>
  );
}

const difficultyLabel: Record<string, string> = { easy: 'קל', medium: 'בינוני', hard: 'קשה' };

function painColor(pain: number): string {
  if (pain >= 6) return 'var(--flag-red)';
  if (pain >= 4) return 'var(--gold-deep)';
  return 'var(--flag-green)';
}

/** One session's exercises with everything the patient reported. */
export function SessionItemsDetail({ session, seenAt }: { session: SessionWithFeedback; seenAt: string | null }) {
  if (session.items.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', padding: '8px 0' }}>לא דווחו תרגילים באימון זה</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0 4px' }}>
      {session.items.map((item) => {
        const fresh = isNewNote(item, seenAt);
        const done = [
          item.sets_done != null && item.reps_done != null ? `${item.sets_done}×${item.reps_done}` : null,
          item.load_used != null ? `${item.load_used} ק״ג` : null,
        ].filter(Boolean).join(' · ');
        return (
          <div
            key={item.id}
            style={{
              background: fresh ? 'var(--pill-attention-bg)' : 'var(--shell-content-bg)',
              border: '1px solid var(--shell-border-soft)', borderRadius: 10, padding: '10px 12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
              <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{item.name}</span>
              {item.skipped ? (
                <span style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>דולג{item.skip_reason ? ` — ${item.skip_reason}` : ''}</span>
              ) : (
                done && <span style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>{done}</span>
              )}
              <span style={{ flex: 1 }} />
              {item.pain_score != null && (
                <span style={{ fontSize: 11, fontWeight: 700, color: painColor(item.pain_score) }}>כאב {item.pain_score}/10</span>
              )}
              {item.difficulty && (
                <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{difficultyLabel[item.difficulty] ?? item.difficulty}</span>
              )}
              {fresh && <NewNotePill />}
            </div>
            {item.note && (
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>“{item.note}”</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
