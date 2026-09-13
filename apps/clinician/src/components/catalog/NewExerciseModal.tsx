// T-30 create an exercise: the essentials only, with a live duplicate check;
// everything else is filled in the editor it opens into.
import { useContext, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EXERCISE_CATEGORIES, exerciseCategoryLabel, t, type BodyRegion } from 'shared';
import { Button, Modal, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import { createExercise, findSimilar } from './catalogApi';
import { Segmented, StatusBadge, fieldLabelStyle, linkButtonStyle, textInputStyle } from './catalogUi';

export default function NewExerciseModal({
  open, onClose, regions, isCurator, onCreated, onOpenExisting,
}: {
  open: boolean;
  onClose: () => void;
  regions: BodyRegion[];
  isCurator: boolean;
  onCreated: (id: string) => void;
  onOpenExisting: (id: string) => void;
}) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [regionId, setRegionId] = useState('');
  const [category, setCategory] = useState<string>('Strength');
  const [scope, setScope] = useState<'clinic' | 'master'>('clinic');
  const [saving, setSaving] = useState(false);
  const [debounced, setDebounced] = useState({ name: '', nameEn: '' });

  useEffect(() => {
    if (!open) return;
    setName('');
    setNameEn('');
    setRegionId('');
    setCategory('Strength');
    setScope('clinic');
  }, [open]);

  useEffect(() => {
    const h = setTimeout(() => setDebounced({ name: name.trim(), nameEn: nameEn.trim() }), 400);
    return () => clearTimeout(h);
  }, [name, nameEn]);

  const { data: similar } = useQuery({
    queryKey: ['catalog-similar-new', debounced],
    enabled: open && (debounced.name.length >= 3 || debounced.nameEn.length >= 3),
    queryFn: () => findSimilar(supabase, debounced.name, debounced.nameEn),
  });

  async function create() {
    setSaving(true);
    try {
      const res = await createExercise(supabase, {
        name: name.trim(),
        name_en: nameEn.trim() || null,
        category,
        ...(regionId ? { body_region_id: regionId } : {}),
      }, scope);
      onCreated(res.id);
      onClose();
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('catalog.new.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('clinician.plan.discard')}</Button>
          <Button disabled={!name.trim()} loading={saving} onClick={create}>{t('catalog.new.create')}</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void create();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabelStyle}>{t('catalog.field.name')}</span>
          <input autoFocus dir="rtl" value={name} onChange={(e) => setName(e.target.value)} style={textInputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabelStyle}>{t('catalog.field.name_en')}</span>
          <input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} style={{ ...textInputStyle, direction: 'ltr', textAlign: 'left' }} />
        </label>

        {similar && similar.items.length > 0 && (
          <div style={{ fontSize: 12.5, background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 10, padding: '9px 12px' }}>
            <div style={{ fontWeight: 700, marginBlockEnd: 5 }}>{t('catalog.similar.title')}</div>
            {similar.items.map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBlock: 2 }}>
                <span style={{ flex: 1 }}>{s.name} <span dir="ltr" style={{ color: 'var(--muted)' }}>{s.name_en}</span></span>
                <StatusBadge status={s.status} compact />
                <button type="button" style={linkButtonStyle} onClick={() => { onOpenExisting(s.id); onClose(); }}>
                  {t('catalog.similar.open')}
                </button>
              </div>
            ))}
          </div>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabelStyle}>{t('catalog.field.body_region')}</span>
          <select value={regionId} onChange={(e) => setRegionId(e.target.value)} style={textInputStyle}>
            <option value="">{t('catalog.field.body_region.none')}</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={fieldLabelStyle}>{t('catalog.field.category')}</span>
          <Segmented
            options={EXERCISE_CATEGORIES.map((c) => ({ value: c as string, label: exerciseCategoryLabel(c) }))}
            value={category}
            onChange={(v) => v && setCategory(v)}
          />
        </div>
        {isCurator && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={fieldLabelStyle}>{t('catalog.new.scope')}</span>
            <Segmented
              options={[
                { value: 'clinic', label: t('catalog.new.scope.clinic') },
                { value: 'master', label: t('catalog.new.scope.master') },
              ]}
              value={scope}
              onChange={(v) => v && setScope(v as 'clinic' | 'master')}
            />
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('catalog.new.hint')}</div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
