// T-30 where an exercise is used, plus quick attach to a protocol phase.
// T-32: every active protocol is offered. A clinic protocol is changed in
// place; a system protocol is changed for all clinics when the caller is a
// catalog curator, otherwise the server makes a private clinic copy first.
import { useContext, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from 'shared';
import { Button, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import type { CatalogExercise } from './catalogApi';
import { fieldLabelStyle, textInputStyle } from './catalogUi';

interface ProtocolRow {
  id: string;
  name: string;
  source: 'system' | 'clinic';
  is_editable: boolean;
  is_active: boolean;
}

export default function UsagePanel({ ex, readOnly, onChanged }: { ex: CatalogExercise; readOnly: boolean; onChanged: () => void }) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [protocolId, setProtocolId] = useState('');
  const [phaseN, setPhaseN] = useState('');
  const [saving, setSaving] = useState(false);
  const canAttach = !readOnly && ex.status === 'approved';
  const isCurator = ex.permissions.is_curator;

  const { data: protocols } = useQuery({
    queryKey: ['protocols-manage'],
    enabled: canAttach,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('protocols/manage', { method: 'GET' });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as ProtocolRow[];
    },
  });
  const active = (protocols ?? []).filter((p) => p.is_active);
  const clinicProtocols = active.filter((p) => p.is_editable);
  const systemProtocols = active.filter((p) => p.source === 'system');
  const selected = active.find((p) => p.id === protocolId);

  const { data: detail } = useQuery({
    queryKey: ['protocol-detail-for-attach', protocolId],
    enabled: !!protocolId,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`protocols/${protocolId}`, { method: 'GET' });
      if (error) throw error;
      return data as { phases: { n: number; name: string }[] };
    },
  });

  async function attach() {
    setSaving(true);
    const { data, error } = await supabase.functions.invoke(`protocols/${protocolId}/exercises`, {
      method: 'POST',
      body: { exercise_id: ex.id, phase_n: Number(phaseN) },
    });
    setSaving(false);
    const result = data as { error?: string; copied?: boolean; already_attached?: boolean; protocol_name?: string } | null;
    if (error || result?.error) {
      toast.show(t('error.save.body'), { tone: 'error' });
      return;
    }
    if (result?.already_attached) toast.show(t('catalog.usage.attach.already'), { tone: 'info' });
    else if (result?.copied) toast.show(t('catalog.usage.attach.copied', { name: result.protocol_name ?? '' }), { tone: 'success', duration: 5000 });
    else toast.show(t('catalog.usage.attach.done'), { tone: 'success' });
    setProtocolId('');
    setPhaseN('');
    if (result?.copied) queryClient.invalidateQueries({ queryKey: ['protocols-manage'] });
    onChanged();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={fieldLabelStyle}>{t('catalog.usage.protocols')}</div>
        {ex.usage.protocols.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBlockStart: 4 }}>{t('catalog.usage.none')}</div>
        ) : (
          <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ex.usage.protocols.map((p) => (
              <li key={p.protocol_id} style={{ fontSize: 13, color: 'var(--ink)' }}>
                {p.name}{' '}
                <span style={{ color: 'var(--muted)' }}>
                  · {t('catalog.usage.phase', { phases: p.phases.join(', ') })} · {t(p.is_clinic ? 'catalog.source.clinic' : 'catalog.source.system')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
        {ex.usage.active_plan_count > 0
          ? t('catalog.usage.plans', { n: ex.usage.active_plan_count })
          : t('catalog.usage.plans.none')}
      </div>

      {!readOnly && (
        canAttach ? (
          active.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBlockStart: 8, borderBlockStart: '1px dashed var(--line-soft)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 240px' }}>
                  <span style={fieldLabelStyle}>{t('catalog.usage.attach')} ({active.length})</span>
                  <select value={protocolId} onChange={(e) => { setProtocolId(e.target.value); setPhaseN(''); }} style={textInputStyle}>
                    <option value="">{t('catalog.usage.attach.protocol')}</option>
                    {clinicProtocols.length > 0 && (
                      <optgroup label={t('catalog.usage.attach.group.clinic')}>
                        {clinicProtocols.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                    {systemProtocols.length > 0 && (
                      <optgroup label={t('catalog.usage.attach.group.system')}>
                        {systemProtocols.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                </label>
                {protocolId && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 150px' }}>
                    <span style={fieldLabelStyle}>{t('catalog.usage.attach.phase')}</span>
                    <select value={phaseN} onChange={(e) => setPhaseN(e.target.value)} style={textInputStyle}>
                      <option value="">—</option>
                      {(detail?.phases ?? []).map((ph) => <option key={ph.n} value={ph.n}>{ph.n}. {ph.name}</option>)}
                    </select>
                  </label>
                )}
                <Button size="sm" disabled={!protocolId || !phaseN} loading={saving} onClick={attach}>
                  {t('catalog.usage.attach.submit')}
                </Button>
              </div>
              {selected?.source === 'system' && (
                <div style={{ fontSize: 12.5, lineHeight: 1.5, borderRadius: 10, padding: '8px 11px', background: isCurator ? 'var(--nav-active-bg)' : 'var(--paper)', color: isCurator ? 'var(--gold-deep)' : 'var(--ink-soft)', border: '1px solid var(--line-soft)' }}>
                  {t(isCurator ? 'catalog.usage.attach.hint.master' : 'catalog.usage.attach.hint.copy')}
                </div>
              )}
            </div>
          )
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('catalog.usage.attach.only_approved')}</div>
        )
      )}
    </div>
  );
}
