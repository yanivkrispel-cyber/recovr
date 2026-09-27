import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Skeleton } from 'ui';
import { SupabaseContext } from '../App';

export interface ThreadMessage {
  id: string;
  sender_type: 'clinician' | 'patient';
  body: string;
  sent_at: string;
  read_at: string | null;
}

/** Thread data + send, shared by the desktop tab and the phone chat screen. */
function useThread(patientId: string) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');

  const query = useQuery<{ messages: ThreadMessage[] }>({
    queryKey: ['messages', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`messages?patient_id=${patientId}`, { method: 'GET' });
      if (error) throw error;
      return data as { messages: ThreadMessage[] };
    },
    refetchInterval: 15_000,
  });

  // Fetching the thread marks the patient's messages read server-side, so the
  // unread badge and the inbox are stale after every fetch.
  useEffect(() => {
    if (!query.dataUpdatedAt) return;
    queryClient.invalidateQueries({ queryKey: ['messages-unread'] });
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
  }, [query.dataUpdatedAt, queryClient]);

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

  return { messages: query.data?.messages ?? [], isLoading: query.isLoading, draft, setDraft, send };
}

const timeFormat = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Bubble({ m, fontSize = 13 }: { m: ThreadMessage; fontSize?: number }) {
  const mine = m.sender_type === 'clinician';
  return (
    <div style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
      <div
        style={{
          background: mine ? 'var(--gold-deep)' : 'var(--sand)',
          color: mine ? 'var(--cream)' : 'var(--ink)',
          borderRadius: 12,
          padding: '8px 12px',
          fontSize,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {m.body}
      </div>
      <div style={{ fontSize: 10, color: 'var(--nav-inactive-text)', marginTop: 3, textAlign: mine ? 'left' : 'right' }}>
        {timeFormat.format(new Date(m.sent_at))}
        {mine && m.read_at ? ' · נקרא' : ''}
      </div>
    </div>
  );
}

/** Desktop: the Messages tab on the patient page. */
export function MessagesTab({ patientId, patientName }: { patientId: string; patientName: string }) {
  const { messages, isLoading, draft, setDraft, send } = useThread(patientId);

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
          messages.map((m) => <Bubble key={m.id} m={m} />)
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

/** Phone: the thread filling its container — messages scroll, pinned to the
 *  newest, composer at the bottom. The parent sizes it (see Chat page). */
export function PhoneThread({ patientId, patientName }: { patientId: string; patientName: string }) {
  const { messages, isLoading, draft, setDraft, send } = useThread(patientId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastId = messages[messages.length - 1]?.id;

  // Open at the newest message, and follow new ones.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, isLoading]);

  // Grow the composer with its content, up to ~5 lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // border-box: scrollHeight excludes the 1px borders.
    const full = el.scrollHeight + 2;
    el.style.height = `${Math.min(full, 120)}px`;
    el.style.overflowY = full > 120 ? 'auto' : 'hidden';
  }, [draft]);

  function submit() {
    const body = draft.trim();
    if (body && !send.isPending) send.mutate(body);
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '14px 14px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {isLoading ? (
          <Skeleton count={4} height={40} />
        ) : messages.length === 0 ? (
          <div style={{ margin: 'auto', padding: '40px 10px', textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 14 }}>
            אין הודעות עם {patientName} עדיין
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} m={m} fontSize={15} />)
        )}
      </div>

      {send.isError && (
        <div role="alert" style={{ background: 'var(--pill-attention-bg)', color: 'var(--flag-red)', fontSize: 12, padding: '6px 12px', textAlign: 'center' }}>
          ההודעה לא נשלחה — נסה שוב
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          padding: '8px 12px calc(8px + env(safe-area-inset-bottom))',
          borderTop: '1px solid var(--shell-border)',
          background: 'var(--shell-sidebar-bg)',
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="כתוב הודעה למטופל…"
          maxLength={4000}
          rows={1}
          style={{ flex: 1, resize: 'none', boxSizing: 'border-box', overflowY: 'hidden', padding: '9px 13px', borderRadius: 18, border: '1px solid var(--shell-border)', background: 'var(--cream)', fontFamily: 'inherit', fontSize: 16, lineHeight: 1.35, maxHeight: 120 }}
        />
        <button
          type="submit"
          disabled={!draft.trim() || send.isPending}
          aria-label="שלח"
          style={{
            flex: 'none', width: 40, height: 40, borderRadius: '50%', border: 'none',
            background: 'var(--gold-deep)', color: 'var(--cream)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: !draft.trim() || send.isPending ? 0.45 : 1,
          }}
        >
          {/* Paper plane, mirrored to point left in RTL. */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: 'scaleX(-1)' }}>
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4 20-7z" />
          </svg>
        </button>
      </form>
    </div>
  );
}
