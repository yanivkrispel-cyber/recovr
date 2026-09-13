// T-30 where an exercise is used, plus quick attach to one of the clinic's
// own protocols (moved here from the old create/edit form).
import { useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t } from 'shared';
import { Button, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import type { CatalogExercise } from './catalogApi';
import { fieldLabelStyle, textInputStyle } from './catalogUi';

interface EditableProtocol {
  id: string;
  name: string;
  is_editable: boolean;
  is_active: boolean;
}

export default function UsagePanel({ ex, readOnly, onChanged }: { ex: CatalogExercise; readOnly: boolean; onChanged: () => void }) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const [protocolId, setProtocolId] = useState('');
  const [phaseN, setPhaseN] = useState('');
  const [saving, setSaving] = useState(false);
  const canAttach = !readOnly && ex.status === 'approved';

  const { data: protocols } = useQuery({
    queryKey: ['protocols-manage'],
    enabled: canAttach,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('protocols/manage', { method: 'GET' });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as EditableProtocol[];
    },
  });
  const editable = (protocols ?? []).filter((p) => p.is_editable && p.is_active);

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
    if (error || (data as { error?: string })?.error) {
      toast.show(t('error.save.body'), { tone: 'error' });
      return;
    }
    toast.show(t('catalog.usage.attach.done'), { tone: 'success' });
    setProtocolId('');
    setPhaseN('');
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
                <span style={{ color: 'var(--muted)' }}>· {t('catalog.usage.phase', { phases: p.phases.join(', ') })}</span>
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
          editable.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', paddingBlockStart: 6, borderBlockStart: '1px dashed var(--line-soft)' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}>
                <span style={fieldLabelStyle}>{t('catalog.usage.attach')}</span>
                <select value={protocolId} onChange={(e) => { setProtocolId(e.target.value); setPhaseN(''); }} style={textInputStyle}>
                  <option value="">{t('catalog.usage.attach.protocol')}</option>
                  {editable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              {protocolId && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 140px' }}>
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
          )
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('catalog.usage.attach.only_approved')}</div>
        )
      )}
    </div>
  );
}
