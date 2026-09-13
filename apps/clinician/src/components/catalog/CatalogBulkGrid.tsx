// T-30 bulk grid: dense table over the same search results as the workspace.
// Inline cells save one row at a time; the selection bar applies one value
// (or a status) to every selected row. Rows the caller can't change are
// skipped by the server and reported back.
import { useContext, useState, type CSSProperties } from 'react';
import {
  DIFFICULTY_LEVELS, EXERCISE_CATEGORIES, START_POSITIONS, difficultyLabel, exerciseCategoryLabel, startPositionLabel, t,
  type BodyRegion, type ExerciseStatus, type I18nKey,
} from 'shared';
import { Button, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import { bulkUpdate, mediaSrc, setStatus, type BulkResult, type CatalogItem, type Patch } from './catalogApi';
import { CompletenessRing, StatusBadge, smallButtonStyle } from './catalogUi';

const GRID = '34px 44px minmax(0, 2.4fr) minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 0.8fr) 44px';

const cellSelect: CSSProperties = {
  width: '100%', padding: '5px 6px', borderRadius: 8, border: '1px solid transparent', background: 'transparent',
  fontFamily: 'inherit', fontSize: 12.5, color: 'var(--ink)', cursor: 'pointer',
};

const REASON_KEY: Record<string, I18nKey> = {
  forbidden: 'catalog.bulk.reason.forbidden',
  master_field: 'catalog.bulk.reason.master_field',
  missing_body_region: 'catalog.bulk.reason.missing_body_region',
  not_found: 'catalog.bulk.reason.not_found',
};

export default function CatalogBulkGrid({
  items, regions, isCurator, readOnly, onApplied, onOpen, footer,
}: {
  items: CatalogItem[];
  regions: BodyRegion[];
  isCurator: boolean;
  readOnly: boolean;
  onApplied: () => void;
  onOpen: (id: string) => void;
  footer: React.ReactNode;
}) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const selectedIds = items.filter((i) => selected.has(i.id)).map((i) => i.id);

  function report(res: BulkResult) {
    if (res.updated > 0) toast.show(t('catalog.bulk.done', { updated: res.updated }), { tone: 'success' });
    if (res.skipped.length > 0) {
      const counts = new Map<string, number>();
      for (const s of res.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
      const reasons = [...counts].map(([r, n]) => `${REASON_KEY[r] ? t(REASON_KEY[r]) : r} (${n})`).join(', ');
      toast.show(t('catalog.bulk.skipped', { n: res.skipped.length, reasons }), { tone: 'error', duration: 5000 });
    }
  }

  async function apply(ids: string[], patch: Patch) {
    setWorking(true);
    try {
      report(await bulkUpdate(supabase, ids, patch));
      onApplied();
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    } finally {
      setWorking(false);
    }
  }

  async function applyStatus(status: ExerciseStatus) {
    setWorking(true);
    try {
      report(await setStatus(supabase, selectedIds, status));
      onApplied();
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    } finally {
      setWorking(false);
    }
  }

  const canEditRow = (i: CatalogItem) => !readOnly && (i.is_clinic_owned || isCurator);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      {/* Always rendered (disabled when nothing is selected): a bar that
          appears on the first tick would shift every row under the cursor. */}
      {!readOnly && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px', background: selectedIds.length ? 'var(--nav-active-bg)' : 'var(--shell-sidebar-bg)', borderBlockEnd: '1px solid var(--shell-border)' }}>
          <strong style={{ fontSize: 13, color: selectedIds.length ? 'var(--gold-deep)' : 'var(--muted)', minWidth: 70 }}>{t('catalog.bulk.selected', { n: selectedIds.length })}</strong>
          <BulkSelect
            label={t('catalog.bulk.set', { field: t('catalog.field.body_region') })}
            options={regions.map((r) => ({ value: r.id, label: r.name }))}
            disabled={working || selectedIds.length === 0}
            onPick={(v) => apply(selectedIds, { body_region_id: v })}
          />
          <BulkSelect
            label={t('catalog.bulk.set', { field: t('catalog.field.category') })}
            options={EXERCISE_CATEGORIES.map((c) => ({ value: c as string, label: exerciseCategoryLabel(c) }))}
            disabled={working || selectedIds.length === 0}
            onPick={(v) => apply(selectedIds, { category: v })}
          />
          <BulkSelect
            label={t('catalog.bulk.set', { field: t('catalog.field.start_position') })}
            options={START_POSITIONS.map((p) => ({ value: p as string, label: startPositionLabel(p) }))}
            disabled={working || selectedIds.length === 0}
            onPick={(v) => apply(selectedIds, { start_position: v })}
          />
          <BulkSelect
            label={t('catalog.bulk.set', { field: t('catalog.field.difficulty') })}
            options={DIFFICULTY_LEVELS.map((d) => ({ value: String(d), label: difficultyLabel(d) }))}
            disabled={working || selectedIds.length === 0}
            onPick={(v) => apply(selectedIds, { difficulty: Number(v) })}
          />
          <span style={{ width: 1, height: 22, background: 'var(--shell-border)' }} />
          <Button size="sm" disabled={working || selectedIds.length === 0} onClick={() => applyStatus('approved')}>{t('catalog.status.action.approve')}</Button>
          <Button size="sm" variant="secondary" disabled={working || selectedIds.length === 0} onClick={() => applyStatus('in_review')}>{t('catalog.status.action.submit')}</Button>
          <Button size="sm" variant="secondary" disabled={working || selectedIds.length === 0} onClick={() => applyStatus('draft')}>{t('catalog.status.action.to_draft')}</Button>
          <Button size="sm" variant="secondary" disabled={working || selectedIds.length === 0} onClick={() => applyStatus('archived')}>{t('catalog.status.action.archive')}</Button>
          <button type="button" style={{ ...smallButtonStyle, marginInlineStart: 'auto' }} disabled={selectedIds.length === 0} onClick={() => setSelected(new Set())}>{t('catalog.bulk.clear')}</button>
        </div>
      )}

      <div role="table" style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
        <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, alignItems: 'center', padding: '9px 14px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', position: 'sticky', insetBlockStart: 0, background: 'var(--shell-sidebar-bg)', zIndex: 1, borderBlockEnd: '1px solid var(--shell-border)' }}>
          <input
            type="checkbox"
            aria-label={t('catalog.bulk.select_all')}
            checked={allSelected}
            disabled={readOnly}
            onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
          />
          <span />
          <span>{t('catalog.bulk.col.exercise')}</span>
          <span>{t('catalog.field.body_region')}</span>
          <span>{t('catalog.field.category')}</span>
          <span>{t('catalog.field.start_position')}</span>
          <span>{t('catalog.field.difficulty')}</span>
          <span>{t('catalog.filter.status')}</span>
          <span>%</span>
        </div>

        {items.map((i) => {
          const editable = canEditRow(i);
          const checked = selected.has(i.id);
          return (
            <div
              role="row"
              key={i.id}
              style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, alignItems: 'center', padding: '6px 14px', borderBlockEnd: '1px solid var(--shell-border-soft)', background: checked ? 'var(--nav-active-bg)' : 'transparent' }}
            >
              <input
                type="checkbox"
                aria-label={i.name}
                checked={checked}
                disabled={readOnly}
                onChange={() => setSelected((s) => {
                  const n = new Set(s);
                  if (n.has(i.id)) n.delete(i.id); else n.add(i.id);
                  return n;
                })}
              />
              <span style={{ width: 36, height: 36, borderRadius: 8, overflow: 'hidden', background: 'var(--shell-sidebar-bg)', display: 'inline-flex' }}>
                {i.thumb_url && <img src={mediaSrc(i.thumb_url)} alt="" width={36} height={36} loading="lazy" style={{ objectFit: 'cover' }} />}
              </span>
              <button
                type="button"
                onClick={() => onOpen(i.id)}
                style={{ background: 'none', border: 'none', padding: 0, textAlign: 'start', cursor: 'pointer', fontFamily: 'inherit', minWidth: 0 }}
              >
                <div dir="auto" style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', textAlign: 'start', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</div>
                <div dir="ltr" style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'end' }}>{i.name_en}</div>
              </button>
              <select
                aria-label={t('catalog.field.body_region')}
                value={i.body_region?.id ?? ''}
                disabled={!editable || working}
                onChange={(e) => apply([i.id], { body_region_id: e.target.value || null })}
                style={{ ...cellSelect, color: i.body_region ? 'var(--ink)' : 'var(--danger)' }}
              >
                <option value="">—</option>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <select
                aria-label={t('catalog.field.category')}
                value={i.category}
                disabled={!editable || working}
                onChange={(e) => apply([i.id], { category: e.target.value })}
                style={cellSelect}
              >
                {EXERCISE_CATEGORIES.map((c) => <option key={c} value={c}>{exerciseCategoryLabel(c)}</option>)}
              </select>
              <select
                aria-label={t('catalog.field.start_position')}
                value={i.start_position ?? ''}
                disabled={!editable || working}
                onChange={(e) => apply([i.id], { start_position: e.target.value || null })}
                style={cellSelect}
              >
                <option value="">—</option>
                {START_POSITIONS.map((p) => <option key={p} value={p}>{startPositionLabel(p)}</option>)}
              </select>
              <select
                aria-label={t('catalog.field.difficulty')}
                value={i.difficulty ?? ''}
                disabled={!editable || working}
                onChange={(e) => apply([i.id], { difficulty: e.target.value ? Number(e.target.value) : null })}
                style={cellSelect}
              >
                <option value="">—</option>
                {DIFFICULTY_LEVELS.map((d) => <option key={d} value={d}>{difficultyLabel(d)}</option>)}
              </select>
              <span><StatusBadge status={i.status} compact /></span>
              <CompletenessRing score={i.completeness} size={30} />
            </div>
          );
        })}
        {footer}
      </div>
    </div>
  );
}

function BulkSelect({ label, options, onPick, disabled }: { label: string; options: { value: string; label: string }[]; onPick: (v: string) => void; disabled: boolean }) {
  return (
    <select
      value=""
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
      style={{ padding: '6px 8px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--shell-border)', background: 'var(--white)', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--ink-soft)' }}
    >
      <option value="">{label}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
