import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { t } from 'shared';
import { EmptyState, Skeleton, clickableDivProps } from 'ui';
import { AuthContext, SupabaseContext } from '../App';
import AppShell from '../components/AppShell';

interface Conversation {
  patient_id: string;
  name: string;
  status: string;
  last_body: string;
  last_sender: 'clinician' | 'patient';
  last_sent_at: string;
  unread: number;
}

const hm = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });
const dm = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit' });

function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? hm.format(d) : dm.format(d);
}

/** Inbox: every patient conversation, newest first, unread highlighted. */
export default function Messages() {
  const { user } = useContext(AuthContext);
  const supabase = useContext(SupabaseContext);
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['inbox'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('messages?inbox=1', { method: 'GET' });
      if (error) throw error;
      return (data as { conversations: Conversation[] }).conversations;
    },
    refetchInterval: 30_000,
  });

  if (!user) return null;

  return (
    <AppShell user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 21, fontWeight: 700, color: 'var(--ink)' }}>
          {t('clinician.messages.title')} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>Messages</span>
        </div>

        <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
          {isLoading ? (
            <div style={{ padding: 16 }}><Skeleton count={5} height={44} /></div>
          ) : error ? (
            <div style={{ padding: 20 }}><EmptyState title={t('error.generic.title')} body={t('error.generic.body')} /></div>
          ) : !data || data.length === 0 ? (
            <div style={{ padding: 20 }}><EmptyState title={t('empty.messages.title')} body={t('clinician.messages.empty_body')} /></div>
          ) : (
            data.map((c, i) => {
              const unread = c.unread > 0;
              return (
                <div
                  key={c.patient_id}
                  {...clickableDivProps(() => navigate({ to: '/messages/$patientId', params: { patientId: c.patient_id } }))}
                  style={{ padding: '13px 16px', borderTop: i === 0 ? 'none' : '1px solid var(--shell-border-soft)', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'center' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: unread ? 700 : 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name}
                      </div>
                      <div style={{ flex: 'none', fontSize: 11, color: unread ? 'var(--gold-deep)' : 'var(--nav-inactive-text)', fontWeight: unread ? 700 : 400 }}>
                        {when(c.last_sent_at)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: unread ? 'var(--ink)' : 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.last_sender === 'clinician' && <span style={{ color: 'var(--nav-inactive-text)' }}>{t('clinician.messages.you')}: </span>}
                        {c.last_body}
                      </div>
                      {unread && (
                        <span
                          aria-label={t('clinician.messages.unread', { count: c.unread })}
                          style={{ flex: 'none', minWidth: 20, height: 20, padding: '0 6px', boxSizing: 'border-box', borderRadius: 10, background: 'var(--gold-deep)', color: 'var(--cream)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          {c.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </AppShell>
  );
}
