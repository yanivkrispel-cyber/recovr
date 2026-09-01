import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Skeleton, QueryError } from 'ui';
import { t } from 'shared';
import { supabase } from '../App';

interface Message {
  id: string;
  sender_type: 'clinician' | 'patient';
  body: string;
  sent_at: string;
  read_at: string | null;
}

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export default function Messages({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error, refetch } = useQuery<{ messages: Message[] }>({
    queryKey: ['me-messages'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('me-messages', { method: 'GET' });
      if (error) throw error;
      return data;
    },
    refetchInterval: 15_000,
  });

  useEffect(() => {
    // opening the thread marks clinician messages read
    qc.invalidateQueries({ queryKey: ['me-messages-unread'] });
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [data, qc]);

  const send = useMutation({
    mutationFn: async (body: string) => {
      const { data, error } = await supabase.functions.invoke('me-messages', { method: 'POST', body: { body } });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data as Message;
    },
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['me-messages'] });
    },
  });

  const messages = data?.messages ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--patient-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0, textAlign: 'right' }}>
        → חזרה · Back
      </button>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700, color: 'var(--patient-text)' }}>
        הודעות <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--patient-muted)' }}>Messages</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 4 }}>
        {isLoading ? (
          <Skeleton count={4} height={44} radius={12} />
        ) : error ? (
          <QueryError
            title={t('error.generic.title')}
            body={t('error.generic.body')}
            retryLabel={t('error.generic.action')}
            onRetry={() => refetch()}
          />
        ) : messages.length === 0 ? (
          <div style={{ padding: '48px 10px', textAlign: 'center', color: 'var(--patient-muted)', fontSize: 13 }}>
            {t('empty.messages.title')}
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.sender_type === 'patient';
            return (
              <div key={m.id} style={{ alignSelf: mine ? 'flex-start' : 'flex-end', maxWidth: '82%' }}>
                <div
                  style={{
                    background: mine ? 'var(--patient-gold)' : 'var(--patient-card)',
                    color: mine ? 'var(--patient-gold-ink)' : 'var(--patient-text)',
                    border: mine ? 'none' : '1px solid var(--patient-border)',
                    borderRadius: 14,
                    padding: '9px 13px',
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {m.body}
                </div>
                <div style={{ fontSize: 10, color: 'var(--patient-dim)', marginTop: 3, textAlign: mine ? 'left' : 'right' }}>
                  {fmtTime(m.sent_at)}
                  {mine && m.read_at ? ' · נקרא' : ''}
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      {send.isError && (
        <div style={{ fontSize: 12, color: 'var(--patient-danger)', flex: 'none' }}>
          {t('error.generic.body')}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const body = draft.trim();
          if (body) send.mutate(body);
        }}
        style={{ display: 'flex', gap: 8, flex: 'none' }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="כתוב/י הודעה…"
          maxLength={4000}
          style={{ flex: 1, padding: '11px 13px', borderRadius: 999, border: '1px solid var(--patient-border)', background: 'var(--patient-card)', color: 'var(--patient-text)', fontFamily: 'inherit', fontSize: 13 }}
        />
        <button
          type="submit"
          disabled={!draft.trim() || send.isPending}
          style={{ flex: 'none', background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)', border: 'none', borderRadius: 999, padding: '0 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: !draft.trim() || send.isPending ? 0.5 : 1 }}
        >
          שלח
        </button>
      </form>
    </div>
  );
}
