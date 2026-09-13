// T-30 change history for one exercise, with restore.
import { useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  difficultyLabel, exerciseCategoryLabel, exerciseStatusLabel, startPositionLabel, t, type BodyRegion, type I18nKey,
} from 'shared';
import { Skeleton, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import { getHistory, restoreRevision, type HistoryEntry } from './catalogApi';
import { linkButtonStyle, smallButtonStyle } from './catalogUi';

const FIELD_LABEL: Record<string, I18nKey> = {
  name: 'catalog.field.name', name_en: 'catalog.field.name_en', aliases: 'catalog.field.aliases',
  body_region_id: 'catalog.field.body_region', category: 'catalog.field.category',
  start_position: 'catalog.field.start_position', difficulty: 'catalog.field.difficulty',
  is_bilateral: 'catalog.field.is_bilateral', muscles: 'catalog.field.muscles', equipment: 'catalog.field.equipment',
  description: 'catalog.field.description', instructions: 'catalog.field.instructions', key_cues: 'catalog.field.key_cues',
  common_mistakes: 'catalog.field.common_mistakes', safety_notes: 'catalog.field.safety_notes',
  contraindications: 'catalog.field.contraindications', status: 'catalog.filter.status',
};

const ACTION_LABEL: Record<HistoryEntry['action'], I18nKey> = {
  create: 'catalog.history.action.create', update: 'catalog.history.action.update', status: 'catalog.history.action.status',
  revert: 'catalog.history.action.revert', restore: 'catalog.history.action.restore', duplicate: 'catalog.history.action.duplicate',
};

function formatValue(field: string, v: unknown, regions: BodyRegion[]): string {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return t('catalog.history.empty_value');
  if (Array.isArray(v)) return v.join(' · ');
  if (field === 'body_region_id') return regions.find((r) => r.id === v)?.name ?? String(v);
  if (field === 'category') return exerciseCategoryLabel(String(v));
  if (field === 'status') return exerciseStatusLabel(String(v));
  if (field === 'start_position') return startPositionLabel(String(v));
  if (field === 'difficulty') return difficultyLabel(Number(v));
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  const s = String(v);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

export default function ExerciseHistory({
  exerciseId, readOnly, regions, onRestored,
}: {
  exerciseId: string;
  readOnly: boolean;
  regions: BodyRegion[];
  onRestored: () => void;
}) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['catalog-history', exerciseId],
    enabled: open,
    queryFn: () => getHistory(supabase, exerciseId),
  });

  if (!open) {
    return (
      <button type="button" style={{ ...smallButtonStyle, alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        {t('catalog.section.history')}…
      </button>
    );
  }
  if (isLoading) return <Skeleton count={3} height={16} />;
  const items = data?.items ?? [];
  if (items.length === 0) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('catalog.history.empty')}</div>;

  async function restore(id: string) {
    setRestoring(id);
    try {
      await restoreRevision(supabase, id);
      toast.show(t('catalog.history.restored'), { tone: 'success' });
      onRestored();
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    } finally {
      setRestoring(null);
    }
  }

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((h) => (
        <li key={h.id} style={{ borderInlineStart: '2px solid var(--line)', paddingInlineStart: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
            <strong style={{ color: 'var(--ink)' }}>{t(ACTION_LABEL[h.action])}</strong>
            {h.scope !== 'clinic' && (
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gold-deep)', background: 'var(--nav-active-bg)', borderRadius: 'var(--radius-pill)', padding: '1px 7px' }}>
                {t(h.scope === 'master' ? 'catalog.history.scope.master' : 'catalog.history.scope.override')}
              </span>
            )}
            <span style={{ color: 'var(--muted)' }}>
              {h.by_catalog_team ? t('catalog.history.team') : h.changed_by_name ?? ''} · {new Date(h.changed_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
            </span>
            {h.restorable && !readOnly && (
              <button type="button" style={{ ...linkButtonStyle, marginInlineStart: 'auto' }} disabled={restoring !== null} onClick={() => restore(h.id)}>
                {restoring === h.id ? t('catalog.save.saving') : t('catalog.history.restore')}
              </button>
            )}
          </div>
          {h.action !== 'duplicate' && (
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {Object.entries(h.changes).map(([field, c]) => (
                <li key={field} style={{ fontSize: 12, color: 'var(--ink-soft)', overflowWrap: 'anywhere' }}>
                  <span style={{ fontWeight: 600 }}>{FIELD_LABEL[field] ? t(FIELD_LABEL[field]) : field}:</span>{' '}
                  {h.action !== 'create' && (
                    <>
                      <span style={{ color: 'var(--muted)', textDecoration: 'line-through' }}>{formatValue(field, c.from, regions)}</span>
                      {' ← '}
                    </>
                  )}
                  <span>{formatValue(field, c.to, regions)}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}
