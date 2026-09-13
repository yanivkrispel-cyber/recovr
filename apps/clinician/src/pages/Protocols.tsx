import { useContext, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t, type BodyRegion } from 'shared';
import { Badge, Button, EmptyState, Skeleton, useIsTablet } from 'ui';
import { AuthContext, SupabaseContext } from '../App';
import AppShell from '../components/AppShell';
import EditProtocol from '../components/EditProtocol';

interface ProtocolRow {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  body_region: BodyRegion | null;
  source: 'system' | 'clinic';
  version: string;
  is_active: boolean;
  is_editable: boolean;
  phase_count: number;
}

export default function Protocols() {
  const { user } = useContext(AuthContext);
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const isTablet = useIsTablet(); // T-22: tablet is view-only for v1

  const [editorId, setEditorId] = useState<string | null | 'new'>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const { data: protocols, isLoading, error } = useQuery({
    queryKey: ['protocol-library'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('protocols/manage', { method: 'GET' });
      if (error) throw error;
      return data as ProtocolRow[];
    },
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['protocol-library'] });
  }

  async function handleDuplicate(id: string) {
    setDuplicatingId(id);
    await supabase.functions.invoke(`protocols/${id}/duplicate`, { method: 'POST' });
    setDuplicatingId(null);
    invalidate();
  }

  async function handleArchive(row: ProtocolRow) {
    if (row.is_active) {
      if (!window.confirm(`${t('confirm.archive_protocol.title')}\n${t('confirm.archive_protocol.body')}`)) return;
    }
    setArchivingId(row.id);
    if (row.is_active) {
      await supabase.functions.invoke(`protocols/${row.id}`, { method: 'DELETE' });
    } else {
      await supabase.functions.invoke(`protocols/${row.id}/restore`, { method: 'POST' });
    }
    setArchivingId(null);
    invalidate();
  }

  if (!user) return null;

  const activeCount = protocols?.filter((p) => p.is_active).length ?? 0;
  const clinicCount = protocols?.filter((p) => p.source === 'clinic').length ?? 0;

  return (
    <AppShell user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em', fontSize: 21, fontWeight: 700, color: 'var(--ink)' }}>
              {t('clinician.protocol.title')} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>Protocol Library</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', marginTop: 4 }}>
              {activeCount} פעילים · {clinicCount} נוצרו על ידך
            </div>
          </div>
          {!isTablet && <Button onClick={() => setEditorId('new')}>+ פרוטוקול חדש · New Protocol</Button>}
        </div>

        <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2.2fr 1.4fr 0.7fr 0.7fr 1.3fr', padding: '12px 18px', fontSize: 11, color: 'var(--nav-inactive-text)', fontWeight: 600 }}>
            <div>פרוטוקול · Protocol</div><div>אזור · Region</div><div>שלבים</div><div>גרסה</div><div />
          </div>

          {isLoading ? (
            <div style={{ padding: 20 }}><Skeleton count={6} height={18} /></div>
          ) : error ? (
            <div style={{ padding: 20 }}><EmptyState title={t('error.generic.title')} body={t('error.generic.body')} /></div>
          ) : protocols?.length === 0 ? (
            <div style={{ padding: 44, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13, borderTop: '1px solid var(--shell-border-soft)' }}>
              לא נמצאו פרוטוקולים · No protocols found
            </div>
          ) : (
            protocols?.map((p) => (
              <div
                key={p.id}
                style={{
                  display: 'grid', gridTemplateColumns: '2.2fr 1.4fr 0.7fr 0.7fr 1.3fr', padding: '13px 18px',
                  borderTop: '1px solid var(--shell-border-soft)', alignItems: 'center', gap: 10,
                  opacity: p.is_active ? 1 : 0.55,
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    {p.name}
                    {p.source === 'clinic' && (
                      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', background: 'var(--nav-active-bg)', border: '1px solid rgba(140,100,35,0.4)', color: 'var(--gold-deep)', padding: '2px 7px', borderRadius: 5, whiteSpace: 'nowrap' }}>
                        נוצר על ידך
                      </span>
                    )}
                    {!p.is_active && <Badge tone="neutral">בארכיון · Archived</Badge>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)', marginTop: 2 }}>{p.name_en}</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{p.body_region?.name ?? '—'}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{p.phase_count}</div>
                <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>{p.version}</div>
                <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-start', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setEditorId(p.id)}
                    style={{ background: 'transparent', color: 'var(--ink-soft)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-pill)', padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                  >
                    {p.is_editable ? 'ערוך · Edit' : 'פרטים · Details'}
                  </button>
                  {!isTablet && (
                    <button
                      onClick={() => handleDuplicate(p.id)}
                      disabled={duplicatingId === p.id}
                      style={{ background: 'transparent', color: 'var(--gold-deep)', border: '1px solid rgba(140,100,35,0.5)', borderRadius: 'var(--radius-pill)', padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: duplicatingId === p.id ? 0.5 : 1 }}
                    >
                      שכפל · Duplicate
                    </button>
                  )}
                  {!isTablet && p.is_editable && (
                    <button
                      onClick={() => handleArchive(p)}
                      disabled={archivingId === p.id}
                      style={{
                        background: 'transparent', border: `1px solid ${p.is_active ? 'var(--flag-red)' : 'var(--shell-border)'}`,
                        color: p.is_active ? 'var(--flag-red)' : 'var(--ink-soft)', borderRadius: 'var(--radius-pill)',
                        padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                        whiteSpace: 'nowrap', opacity: archivingId === p.id ? 0.5 : 1,
                      }}
                    >
                      {p.is_active ? 'העבר לארכיון · Archive' : 'שחזר · Restore'}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <EditProtocol
        protocolId={editorId === 'new' ? null : editorId}
        open={editorId !== null}
        onClose={() => setEditorId(null)}
        onSaved={() => {
          invalidate();
          setEditorId(null);
        }}
      />
    </AppShell>
  );
}
