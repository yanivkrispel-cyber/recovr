import { useContext, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useIsPhone } from 'ui';
import { SupabaseContext } from '../App';
import { PhoneThread } from '../components/MessageThread';

/** Height/offset of the visible area. On iOS the on-screen keyboard shrinks the
 *  visual viewport but not the layout one, so a 100dvh layout would leave the
 *  composer under the keyboard; sizing to the visual viewport keeps it above. */
function useVisualViewport(): { height: number; top: number } {
  const read = () => ({ height: window.visualViewport?.height ?? window.innerHeight, top: window.visualViewport?.offsetTop ?? 0 });
  const [vv, setVv] = useState(read);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const update = () => setVv(read());
    v.addEventListener('resize', update);
    v.addEventListener('scroll', update);
    return () => {
      v.removeEventListener('resize', update);
      v.removeEventListener('scroll', update);
    };
  }, []);
  return vv;
}

/** /messages/$patientId — full-screen conversation on a phone. On desktop the
 *  thread lives in the patient page's Messages tab, so this redirects there
 *  (it's also where message notifications land). */
export default function Chat() {
  const { patientId } = useParams({ from: '/messages/$patientId' });
  const isPhone = useIsPhone();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isPhone) navigate({ to: '/patients/$patientId', params: { patientId }, search: { tab: 'messages' }, replace: true });
  }, [isPhone, patientId, navigate]);

  if (!isPhone) return null;
  return <PhoneChat patientId={patientId} />;
}

function PhoneChat({ patientId }: { patientId: string }) {
  const supabase = useContext(SupabaseContext);
  const router = useRouter();
  const vv = useVisualViewport();

  // Name for the header; the overview is usually cached from the patient page.
  const { data } = useQuery({
    queryKey: ['patient-overview', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`patient-overview/patients/${patientId}`, { method: 'GET' });
      if (error) throw error;
      return data as { patient: { name: string } };
    },
  });
  const name = data?.patient.name ?? '';

  function back() {
    if (window.history.length > 1) router.history.back();
    else router.navigate({ to: '/messages' });
  }

  return (
    <div
      style={{
        position: 'fixed', insetInline: 0, top: vv.top, height: vv.height,
        display: 'flex', flexDirection: 'column',
        background: 'var(--shell-content-bg)', fontFamily: 'var(--font-ui)',
      }}
    >
      <header
        style={{
          flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
          padding: 'calc(6px + env(safe-area-inset-top)) 8px 6px',
          background: 'var(--shell-sidebar-bg)', borderBottom: '1px solid var(--shell-border)',
        }}
      >
        <button
          onClick={back}
          aria-label="חזרה"
          style={{ width: 40, height: 40, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {/* Chevron pointing right = back in RTL. */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        <Link
          to="/patients/$patientId"
          params={{ patientId }}
          style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'var(--ink)' }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || '…'}</div>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>לכרטיס המטופל</div>
        </Link>
      </header>
      <PhoneThread patientId={patientId} patientName={name} />
    </div>
  );
}
