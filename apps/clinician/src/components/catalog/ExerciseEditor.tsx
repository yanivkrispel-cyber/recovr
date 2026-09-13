// T-30 exercise editor pane: every field of one exercise, saved as you go.
//
// Saving model: each edit goes into a pending patch; text fields flush after
// a short pause, structured fields (selects, toggles, tags) immediately.
// Flushes are serialized and carry the revision the editor last saw, so a
// concurrent change elsewhere surfaces as a conflict instead of being
// silently overwritten. Undo replays the previous values as a new save.
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DIFFICULTY_LEVELS, EXERCISE_CATEGORIES, START_POSITIONS, difficultyLabel, exerciseCategoryLabel, parseYouTubeId,
  startPositionLabel, t, type BodyRegion, type ContentField, type ExerciseStatus,
} from 'shared';
import { Button, EmptyState, Skeleton, Toggle, YouTubeFacade, useToast } from 'ui';
import { SupabaseContext } from '../../App';
import {
  CatalogApiError, MASTER_ONLY_FIELDS, deleteExercise, duplicateExercise, editableFrom, findSimilar,
  getCatalogExercise, mediaSrc, revertOverride, saveExercise, setStatus,
  type CatalogExercise, type CatalogItem, type EditableFields, type EditableKey, type Patch,
} from './catalogApi';
import {
  CompletenessMeter, CueListEditor, Section, Segmented, StatusBadge, TagInput, fieldLabelStyle, linkButtonStyle,
  smallButtonStyle, textInputStyle, textareaStyle,
} from './catalogUi';
import ExerciseHistory from './ExerciseHistory';
import PatientPreview from './PatientPreview';
import UsagePanel from './UsagePanel';

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

const TEXT_DEBOUNCE_MS = 800;

const MISSING_TARGET: Record<string, string> = {
  name_he: 'f-name', name_en: 'f-name_en', body_region: 'f-body_region_id', instructions_he: 'f-instructions',
  description: 'f-description', key_cues: 'f-key_cues', safety: 'f-safety_notes', muscles: 'f-muscles',
  start_position: 'f-start_position', difficulty: 'f-difficulty', media: 'sec-media',
};

const SECTIONS = [
  ['sec-identity', 'catalog.section.identity'],
  ['sec-classification', 'catalog.section.classification'],
  ['sec-content', 'catalog.section.content'],
  ['sec-media', 'catalog.section.media'],
  ['sec-usage', 'catalog.section.usage'],
  ['sec-history', 'catalog.section.history'],
] as const;

const API_ERROR_COPY: Record<string, string> = {
  name_required: t('valid.required'),
  too_long: t('error.save.body'),
};

export interface ExerciseEditorProps {
  exerciseId: string;
  regions: BodyRegion[];
  equipmentSuggestions: string[];
  readOnly: boolean;
  onItemChanged: (id: string, patch: Partial<CatalogItem>) => void;
  onSelect: (id: string) => void;
  onListInvalidate: () => void;
  onDeleted: () => void;
}

export default function ExerciseEditor(props: ExerciseEditorProps) {
  const supabase = useContext(SupabaseContext);
  const { exerciseId } = props;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['catalog-exercise', exerciseId],
    queryFn: () => getCatalogExercise(supabase, exerciseId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return <div style={{ padding: 24 }}><Skeleton count={8} height={22} /></div>;
  }
  if (error || !data) {
    return <div style={{ padding: 24 }}><EmptyState title={t('error.generic.title')} body={t('error.generic.body')} /></div>;
  }
  // keyed so a (re)load starts from clean editor state
  return <EditorBody key={`${data.id}:${data.updated_at}:${data.status}`} {...props} ex={data} reload={() => refetch()} />;
}

function EditorBody({
  ex, reload, regions, equipmentSuggestions, readOnly, onItemChanged, onSelect, onListInvalidate, onDeleted,
}: ExerciseEditorProps & { ex: CatalogExercise; reload: () => void }) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const toast = useToast();

  const [draft, setDraft] = useState<EditableFields>(() => editableFrom(ex));
  const [completeness, setCompleteness] = useState({ score: ex.completeness, missing: ex.missing as string[] });
  const [overridden, setOverridden] = useState<ContentField[]>(ex.overridden_fields);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [undoCount, setUndoCount] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [showMaster, setShowMaster] = useState<Record<string, boolean>>({});

  const overrideTarget = !ex.is_clinic_owned && !ex.permissions.can_edit_master;
  const revision = useRef({ row: ex.revision, override: ex.override_revision });
  const lastSaved = useRef<EditableFields>(editableFrom(ex));
  const pending = useRef<Patch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const undoStack = useRef<Patch[]>([]);
  const replayingUndo = useRef(false);
  const alive = useRef(true);

  const canEdit = useCallback(
    (k: EditableKey) => !readOnly && (MASTER_ONLY_FIELDS.includes(k) ? ex.permissions.can_edit_master : ex.permissions.can_edit_content),
    [readOnly, ex.permissions],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    const patch = pending.current;
    const keys = Object.keys(patch) as EditableKey[];
    if (keys.length === 0) return;
    pending.current = {};
    const before: Patch = {};
    for (const k of keys) (before as Record<string, unknown>)[k] = lastSaved.current[k];
    const isUndo = replayingUndo.current;
    replayingUndo.current = false;
    setSaveState('saving');

    inflight.current = (async () => {
      try {
        const res = await saveExercise(supabase, ex.id, patch, overrideTarget ? revision.current.override : revision.current.row);
        if (res.revision != null) revision.current.row = res.revision;
        if (res.override_revision != null) revision.current.override = res.override_revision;
        lastSaved.current = { ...lastSaved.current, ...patch };
        if (res.changed && !isUndo) {
          undoStack.current.push(before);
          if (undoStack.current.length > 50) undoStack.current.shift();
        }
        if (!alive.current) return;
        setUndoCount(undoStack.current.length);
        setCompleteness({ score: res.completeness, missing: res.missing });
        if (res.overridden_fields) setOverridden(res.overridden_fields);
        setSaveState('saved');
        const region = 'body_region_id' in patch ? regions.find((r) => r.id === patch.body_region_id) ?? null : undefined;
        onItemChanged(ex.id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.name_en !== undefined ? { name_en: patch.name_en } : {}),
          ...(patch.category !== undefined ? { category: patch.category } : {}),
          ...(patch.start_position !== undefined ? { start_position: patch.start_position } : {}),
          ...(patch.difficulty !== undefined ? { difficulty: patch.difficulty } : {}),
          ...(region !== undefined ? { body_region: region } : {}),
          ...(res.overridden_fields ? { has_override: res.overridden_fields.length > 0 } : {}),
          completeness: res.completeness,
          missing: res.missing,
        });
        queryClient.invalidateQueries({ queryKey: ['catalog-history', ex.id] });
      } catch (e) {
        const body = e instanceof CatalogApiError ? e.body : { error: 'internal_error' };
        if (body.error === 'conflict') {
          pending.current = { ...patch, ...pending.current };
          if (alive.current) setSaveState('conflict');
        } else if (body.error === 'validation_failed' || body.error === 'forbidden') {
          // the server refused this value: put the field back to what's saved
          if (alive.current) {
            setDraft((d) => ({ ...d, ...before }));
            setSaveState('error');
            toast.show(API_ERROR_COPY[body.message ?? ''] ?? t('error.save.body'), { tone: 'error', duration: 4000 });
          }
        } else {
          pending.current = { ...patch, ...pending.current };
          if (alive.current) setSaveState('error');
        }
      } finally {
        inflight.current = null;
        if (again.current) {
          again.current = false;
          void flush();
        }
      }
    })();
    return inflight.current;
  }, [supabase, ex.id, overrideTarget, regions, onItemChanged, queryClient, toast]);

  // Leaving this exercise (or the page): save whatever is still pending.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      void flush();
    };
  }, [flush]);

  const setField = useCallback(<K extends EditableKey>(k: K, v: EditableFields[K], mode: 'debounce' | 'now' | 'local' = 'now') => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (mode === 'local') return;
    (pending.current as Record<string, unknown>)[k] = v;
    if (timer.current) clearTimeout(timer.current);
    if (mode === 'now') void flush();
    else timer.current = setTimeout(() => void flush(), TEXT_DEBOUNCE_MS);
  }, [flush]);

  const undo = useCallback(() => {
    const before = undoStack.current.pop();
    setUndoCount(undoStack.current.length);
    if (!before) return;
    setDraft((d) => ({ ...d, ...before }));
    pending.current = { ...pending.current, ...before };
    replayingUndo.current = true;
    void flush();
  }, [flush]);

  // Ctrl/Cmd+Z outside text fields undoes the last saved change (inside a
  // field the browser's own undo applies).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (undoStack.current.length === 0) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  // Duplicate warning while the name is being edited.
  const [similarQuery, setSimilarQuery] = useState({ name: '', name_en: '' });
  useEffect(() => {
    if (!ex.permissions.can_edit_master || readOnly) return;
    if (draft.name === ex.name && (draft.name_en ?? '') === (ex.name_en ?? '')) return;
    const h = setTimeout(() => setSimilarQuery({ name: draft.name, name_en: draft.name_en ?? '' }), 600);
    return () => clearTimeout(h);
  }, [draft.name, draft.name_en, ex.name, ex.name_en, ex.permissions.can_edit_master, readOnly]);
  const { data: similar } = useQuery({
    queryKey: ['catalog-similar', ex.id, similarQuery],
    enabled: !!(similarQuery.name || similarQuery.name_en),
    queryFn: () => findSimilar(supabase, similarQuery.name, similarQuery.name_en, ex.id),
  });

  async function settle() {
    await flush();
    if (inflight.current) await inflight.current;
  }

  async function changeStatus(status: ExerciseStatus) {
    setBusy(status);
    try {
      await settle();
      const res = await setStatus(supabase, [ex.id], status);
      if (res.skipped.length > 0) {
        const reason = res.skipped[0].reason;
        toast.show(reason === 'missing_body_region' ? t('catalog.status.approve_needs_region') : t('error.save.body'), { tone: 'error', duration: 4000 });
      } else {
        onItemChanged(ex.id, { status });
        reload();
      }
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function handleDuplicate() {
    setBusy('duplicate');
    try {
      await settle();
      const res = await duplicateExercise(supabase, ex.id);
      onListInvalidate();
      onSelect(res.id);
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
      if (alive.current) setBusy(null);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`${t('confirm.delete_exercise.title')}\n${t('confirm.delete_exercise.body')}`)) return;
    setBusy('delete');
    try {
      await deleteExercise(supabase, ex.id);
      onDeleted();
    } catch (e) {
      const inUse = e instanceof CatalogApiError && e.body.message === 'in_use';
      toast.show(inUse ? t('catalog.action.delete.in_use') : t('error.save.body'), { tone: 'error', duration: 4500 });
      if (alive.current) setBusy(null);
    }
  }

  async function handleRevert(field: ContentField) {
    try {
      await settle();
      const res = await revertOverride(supabase, ex.id, [field]);
      if (res.override_revision != null) revision.current.override = res.override_revision;
      const masterValue = ex.master?.[field] ?? (field === 'key_cues' ? [] : null);
      setDraft((d) => ({ ...d, [field]: masterValue }));
      lastSaved.current = { ...lastSaved.current, [field]: masterValue };
      setOverridden((o) => o.filter((f) => f !== field));
      if (res.completeness != null) setCompleteness({ score: res.completeness, missing: res.missing });
      onItemChanged(ex.id, { completeness: res.completeness, missing: res.missing, has_override: overridden.length > 1 });
      queryClient.invalidateQueries({ queryKey: ['catalog-history', ex.id] });
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    }
  }

  function jumpTo(key: string) {
    const el = document.getElementById(MISSING_TARGET[key] ?? key);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusable = el.matches('input,textarea,select,button') ? el : el.querySelector<HTMLElement>('input,textarea,select,button');
    focusable?.focus({ preventScroll: true });
  }

  const primaryMedia = ex.media.find((m) => m.kind === 'gif' && m.url) ?? ex.media.find((m) => m.kind === 'image' && m.url) ?? null;
  const video = ex.media.find((m) => m.kind === 'video') ?? null;
  const regionOptions = useMemo(() => regions.map((r) => ({ value: r.id, label: r.name })), [regions]);

  const statusActions: { status: ExerciseStatus; label: string; primary?: boolean; disabledReason?: string }[] = (() => {
    const approve = {
      status: 'approved' as const, label: t('catalog.status.action.approve'), primary: true,
      disabledReason: draft.body_region_id ? undefined : t('catalog.status.approve_needs_region'),
    };
    switch (ex.status) {
      case 'draft': return [approve, { status: 'in_review', label: t('catalog.status.action.submit') }];
      case 'in_review': return [approve, { status: 'draft', label: t('catalog.status.action.to_draft') }];
      case 'approved': return [{ status: 'archived', label: t('catalog.status.action.archive') }, { status: 'draft', label: t('catalog.status.action.to_draft') }];
      case 'archived': return [{ status: 'draft', label: t('catalog.status.action.restore') }];
    }
  })();

  // --- field renderers -------------------------------------------------------
  // a render helper, not a component: a component declared in here would
  // remount its inputs on every keystroke
  function field({ k, label, hint, children, wide = true }: { k: EditableKey; label: string; hint?: string; children: ReactNode; wide?: boolean }) {
    const isContent = !MASTER_ONLY_FIELDS.includes(k);
    const isOverridden = !ex.is_clinic_owned && isContent && overridden.includes(k as ContentField);
    const locked = !readOnly && !canEdit(k);
    const masterValue = ex.master?.[k as ContentField];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: wide ? '1 / -1' : undefined }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label htmlFor={`f-${k}`} style={fieldLabelStyle}>{label}</label>
          {hint && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{hint}</span>}
          {locked && <span title={t('catalog.master.locked')} style={{ fontSize: 11, color: 'var(--muted)' }}>🔒 {t('catalog.master.locked')}</span>}
          {isOverridden && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginInlineStart: 'auto' }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gold-deep)', background: 'var(--nav-active-bg)', borderRadius: 'var(--radius-pill)', padding: '2px 8px' }}>
                {t('catalog.override.badge')}
              </span>
              <button type="button" style={linkButtonStyle} onClick={() => setShowMaster((s) => ({ ...s, [k]: !s[k] }))}>
                {t('catalog.override.show_master')}
              </button>
              {!readOnly && (
                <button type="button" style={linkButtonStyle} onClick={() => handleRevert(k as ContentField)}>
                  {t('catalog.override.revert')}
                </button>
              )}
            </span>
          )}
        </div>
        {children}
        {isOverridden && showMaster[k] && (
          <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', background: 'var(--paper)', border: '1px dashed var(--line)', borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
            {Array.isArray(masterValue)
              ? (masterValue.length ? masterValue.join(' · ') : t('catalog.override.master_empty'))
              : (masterValue || t('catalog.override.master_empty'))}
          </div>
        )}
      </div>
    );
  }

  const textArea = (k: 'description' | 'instructions' | 'common_mistakes' | 'safety_notes' | 'contraindications', rows = 3) => (
    <textarea
      id={`f-${k}`}
      dir="auto"
      value={draft[k] ?? ''}
      disabled={!canEdit(k)}
      rows={rows}
      onChange={(e) => setField(k, e.target.value, 'debounce')}
      onBlur={() => void flush()}
      style={{ ...textareaStyle, background: canEdit(k) ? 'var(--white)' : 'var(--paper)' }}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {/* Header */}
      <div style={{ position: 'sticky', insetBlockStart: 0, zIndex: 'var(--z-sticky)', background: 'var(--white)', paddingBlock: '16px 0', paddingInline: 22, borderBlockEnd: '1px solid var(--shell-border-soft)' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div style={{ width: 64, height: 64, flex: 'none', borderRadius: 12, overflow: 'hidden', background: 'var(--shell-sidebar-bg)', border: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {primaryMedia?.url
              ? <img src={mediaSrc(primaryMedia.url)} alt="" width={64} height={64} style={{ objectFit: 'contain' }} />
              : <span aria-hidden style={{ fontSize: 22, color: 'var(--muted-2)' }}>◌</span>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 dir="auto" style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700, color: 'var(--ink)', overflowWrap: 'anywhere' }}>{draft.name}</h2>
              <StatusBadge status={ex.status} />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
                {ex.is_clinic_owned ? t('catalog.source.clinic') : t('catalog.source.system')}
                {!ex.is_clinic_owned && overridden.length > 0 && ` · ${t('catalog.override.badge')}`}
              </span>
            </div>
            <div dir="ltr" style={{ fontSize: 12.5, color: 'var(--muted)', marginBlockStart: 2, textAlign: 'end' }}>{draft.name_en}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBlockStart: 3 }}>
              {ex.status === 'approved' ? t('catalog.status.hint.approved') : t('catalog.status.hint.not_approved')}
            </div>
          </div>
          <SaveIndicator state={saveState} onRetry={() => void flush()} />
        </div>

        {!readOnly && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBlockStart: 12 }}>
            {ex.permissions.can_change_status && statusActions.map((a) => (
              <Button
                key={a.status}
                size="sm"
                variant={a.primary ? 'primary' : 'secondary'}
                loading={busy === a.status}
                disabled={!!busy || !!a.disabledReason}
                title={a.disabledReason}
                onClick={() => changeStatus(a.status)}
              >
                {a.label}
              </Button>
            ))}
            <span style={{ flex: 1 }} />
            <button type="button" style={{ ...smallButtonStyle, opacity: undoCount ? 1 : 0.4 }} disabled={!undoCount} onClick={undo} title="Ctrl+Z">
              ↶ {t('catalog.undo')}
            </button>
            <button type="button" style={smallButtonStyle} onClick={() => setPreviewOpen(true)}>{t('catalog.action.preview')}</button>
            <button type="button" style={smallButtonStyle} disabled={!!busy} onClick={handleDuplicate}>{t('catalog.action.duplicate')}</button>
            {ex.permissions.can_delete && (
              <button type="button" style={{ ...smallButtonStyle, color: 'var(--danger)', borderColor: 'var(--warn-line)' }} disabled={!!busy} onClick={handleDelete}>
                {t('catalog.action.delete')}
              </button>
            )}
          </div>
        )}

        <div style={{ marginBlockStart: 12 }}>
          <CompletenessMeter score={completeness.score} missing={completeness.missing} onJump={jumpTo} />
        </div>

        <nav aria-label={t('catalog.title')} style={{ display: 'flex', gap: 2, marginBlockStart: 10, overflowX: 'auto' }}>
          {SECTIONS.map(([id, key]) => (
            <button
              key={id}
              type="button"
              onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              style={{ background: 'none', border: 'none', borderBlockEnd: '2px solid transparent', padding: '8px 10px', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
            >
              {t(key)}
            </button>
          ))}
        </nav>
      </div>

      {saveState === 'conflict' && (
        <div role="alert" style={{ margin: '14px 22px 0', padding: '10px 12px', borderRadius: 10, background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', color: 'var(--danger)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>{t('catalog.save.conflict')}</span>
          <Button size="sm" variant="secondary" onClick={reload}>{t('catalog.save.reload')}</Button>
        </div>
      )}

      <div style={{ paddingInline: 22, paddingBlockEnd: 40 }}>
        {!ex.is_clinic_owned && !readOnly && (
          ex.permissions.can_edit_master ? (
            <div style={{ marginBlockStart: 14, fontSize: 12.5, color: 'var(--gold-deep)', background: 'var(--nav-active-bg)', borderRadius: 10, padding: '9px 12px' }}>
              {t('catalog.master.curator')}
            </div>
          ) : (
            <div style={{ marginBlockStart: 14, fontSize: 12.5, color: 'var(--ink-soft)', background: 'var(--paper)', border: '1px solid var(--line-soft)', borderRadius: 10, padding: '10px 12px', lineHeight: 1.55 }}>
              {t('catalog.master.banner')}{' '}
              <button type="button" style={linkButtonStyle} onClick={handleDuplicate}>{t('catalog.master.banner.duplicate')}</button>
            </div>
          )
        )}

        <Section id="sec-identity" title={t('catalog.section.identity')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {field({ k: "name", label: t('catalog.field.name'), wide: false, children: (
              <input
                id="f-name"
                dir="auto"
                value={draft.name}
                disabled={!canEdit('name')}
                onChange={(e) => setField('name', e.target.value, e.target.value.trim() ? 'debounce' : 'local')}
                onBlur={() => {
                  if (!draft.name.trim()) setDraft((d) => ({ ...d, name: lastSaved.current.name }));
                  void flush();
                }}
                style={{ ...textInputStyle, fontWeight: 600, background: canEdit('name') ? 'var(--white)' : 'var(--paper)' }}
              />
            ) })}
            {field({ k: "name_en", label: t('catalog.field.name_en'), wide: false, children: (
              <input
                id="f-name_en"
                dir="ltr"
                value={draft.name_en ?? ''}
                disabled={!canEdit('name_en')}
                onChange={(e) => setField('name_en', e.target.value, 'debounce')}
                onBlur={() => void flush()}
                style={{ ...textInputStyle, background: canEdit('name_en') ? 'var(--white)' : 'var(--paper)' }}
              />
            ) })}
          </div>
          {similar && similar.items.length > 0 && (
            <div style={{ fontSize: 12.5, background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 10, padding: '9px 12px' }}>
              <div style={{ fontWeight: 700, color: 'var(--ink)', marginBlockEnd: 5 }}>{t('catalog.similar.title')}</div>
              {similar.items.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBlock: 2 }}>
                  <span style={{ flex: 1 }}>{s.name} <span dir="ltr" style={{ color: 'var(--muted)' }}>{s.name_en}</span></span>
                  <StatusBadge status={s.status} compact />
                  <button type="button" style={linkButtonStyle} onClick={() => onSelect(s.id)}>{t('catalog.similar.open')}</button>
                </div>
              ))}
            </div>
          )}
          {field({ k: "aliases", label: t('catalog.field.aliases'), hint: t('catalog.field.aliases.hint'), children: (
            <TagInput id="f-aliases" value={draft.aliases} disabled={!canEdit('aliases')} onChange={(v) => setField('aliases', v)} />
          ) })}
        </Section>

        <Section id="sec-classification" title={t('catalog.section.classification')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {field({ k: "body_region_id", label: t('catalog.field.body_region'), wide: false, children: (
              <select
                id="f-body_region_id"
                value={draft.body_region_id ?? ''}
                disabled={!canEdit('body_region_id')}
                onChange={(e) => setField('body_region_id', e.target.value || null)}
                style={textInputStyle}
              >
                <option value="">{t('catalog.field.body_region.none')}</option>
                {regionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) })}
            {field({ k: "start_position", label: t('catalog.field.start_position'), wide: false, children: (
              <select
                id="f-start_position"
                value={draft.start_position ?? ''}
                disabled={!canEdit('start_position')}
                onChange={(e) => setField('start_position', e.target.value || null)}
                style={textInputStyle}
              >
                <option value="">{t('catalog.field.none')}</option>
                {START_POSITIONS.map((p) => <option key={p} value={p}>{startPositionLabel(p)}</option>)}
              </select>
            ) })}
          </div>
          {field({ k: "category", label: t('catalog.field.category'), children: (
            <Segmented
              options={EXERCISE_CATEGORIES.map((c) => ({ value: c as string, label: exerciseCategoryLabel(c) }))}
              value={draft.category}
              disabled={!canEdit('category')}
              onChange={(v) => v && setField('category', v)}
            />
          ) })}
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div id="f-difficulty">
              {field({ k: "difficulty", label: t('catalog.field.difficulty'), children: (
                <Segmented
                  options={DIFFICULTY_LEVELS.map((d) => ({ value: d as number, label: difficultyLabel(d) }))}
                  value={draft.difficulty}
                  allowClear
                  disabled={!canEdit('difficulty')}
                  onChange={(v) => setField('difficulty', v)}
                />
              ) })}
            </div>
            <div style={{ paddingBlockEnd: 4 }}>
              <Toggle
                label={t('catalog.field.is_bilateral')}
                checked={draft.is_bilateral}
                disabled={!canEdit('is_bilateral')}
                onChange={(v) => setField('is_bilateral', v)}
              />
            </div>
          </div>
          {field({ k: "muscles", label: t('catalog.field.muscles'), hint: ex.muscle_group ? t('catalog.field.muscle_group', { value: ex.muscle_group }) : undefined, children: (
            <TagInput id="f-muscles" dir="ltr" value={draft.muscles} disabled={!canEdit('muscles')} onChange={(v) => setField('muscles', v)} />
          ) })}
          {field({ k: "equipment", label: t('catalog.field.equipment'), hint: t('catalog.field.equipment.hint'), children: (
            <TagInput id="f-equipment" dir="ltr" value={draft.equipment} suggestions={equipmentSuggestions} disabled={!canEdit('equipment')} onChange={(v) => setField('equipment', v)} />
          ) })}
        </Section>

        <Section id="sec-content" title={t('catalog.section.content')}>
          {field({ k: "description", label: t('catalog.field.description'), children: textArea('description', 2) })}
          {field({ k: "instructions", label: t('catalog.field.instructions'), hint: t('catalog.field.instructions.hint'), children: textArea('instructions', 6) })}
          {field({ k: "key_cues", label: t('catalog.field.key_cues'), children: (
            <CueListEditor
              id="f-key_cues"
              value={draft.key_cues}
              disabled={!canEdit('key_cues')}
              onChange={(v) => setField('key_cues', v, 'local')}
              onCommit={(v) => {
                if (JSON.stringify(v) !== JSON.stringify(lastSaved.current.key_cues)) setField('key_cues', v);
              }}
            />
          ) })}
          {field({ k: "common_mistakes", label: t('catalog.field.common_mistakes'), children: textArea('common_mistakes') })}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            {field({ k: "safety_notes", label: t('catalog.field.safety_notes'), wide: false, children: textArea('safety_notes') })}
            {field({ k: "contraindications", label: t('catalog.field.contraindications'), wide: false, children: textArea('contraindications') })}
          </div>
        </Section>

        <Section id="sec-media" title={t('catalog.section.media')}>
          {primaryMedia?.url ? (
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', border: '1px solid var(--line-soft)', borderRadius: 'var(--radius-card)', overflow: 'hidden', background: 'var(--shell-sidebar-bg)' }}>
                <img src={mediaSrc(primaryMedia.url)} alt={draft.name_en ?? draft.name} width={200} height={200} style={{ display: 'block', objectFit: 'contain' }} />
                {!primaryMedia.verified && (
                  <span style={{ position: 'absolute', insetBlockStart: 8, insetInlineStart: 8, background: 'var(--flag-red)', color: 'var(--white)', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 5 }}>
                    {t('picker.card.unverified')}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 260 }}>
                {!primaryMedia.verified && <div>{t('catalog.media.unverified')}</div>}
                {ex.external_ref && <div>© Gym visual — https://gymvisual.com/</div>}
                {primaryMedia.source_file && <div dir="ltr">{primaryMedia.source_file}</div>}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('catalog.media.none')}</div>
          )}
          <VideoField ex={ex} video={video} readOnly={readOnly} onSaved={reload} />
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('catalog.media.next_phase')}</div>
        </Section>

        <Section id="sec-usage" title={t('catalog.section.usage')}>
          <UsagePanel ex={ex} readOnly={readOnly} onChanged={reload} />
        </Section>

        <Section id="sec-history" title={t('catalog.section.history')}>
          <ExerciseHistory exerciseId={ex.id} readOnly={readOnly} regions={regions} onRestored={reload} />
        </Section>
      </div>

      <PatientPreview open={previewOpen} onClose={() => setPreviewOpen(false)} fields={draft} media={primaryMedia} />
    </div>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'idle') return null;
  const color = state === 'error' || state === 'conflict' ? 'var(--danger)' : state === 'saved' ? 'var(--flag-green)' : 'var(--muted)';
  return (
    <span role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color, whiteSpace: 'nowrap' }}>
      {state === 'saving' && t('catalog.save.saving')}
      {state === 'saved' && `✓ ${t('catalog.save.saved')}`}
      {state === 'conflict' && t('catalog.save.error')}
      {state === 'error' && (
        <>
          {t('catalog.save.error')}
          <button type="button" style={linkButtonStyle} onClick={onRetry}>{t('catalog.save.retry')}</button>
        </>
      )}
    </span>
  );
}

// Supplementary YouTube video. Only a clinic's own exercise can carry an
// attached video today (app.set_exercise_video); the full media manager is
// the next phase.
function VideoField({ ex, video, readOnly, onSaved }: { ex: CatalogExercise; video: CatalogExercise['media'][number] | null; readOnly: boolean; onSaved: () => void }) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const initial = video?.url ?? '';
  const [value, setValue] = useState(initial);
  const parsed = value.trim() ? parseYouTubeId(value) : null;
  const invalid = value.trim() !== '' && !parsed;
  const editable = ex.is_clinic_owned && !readOnly;

  async function save() {
    if (invalid || (parsed ?? '') === initial) return;
    const { data, error } = await supabase.functions.invoke(`exercises/${ex.id}/video`, { method: 'PUT', body: { youtube_id: parsed } });
    if (error || (data as { error?: string })?.error) {
      toast.show(t('error.save.body'), { tone: 'error' });
      return;
    }
    onSaved();
  }

  if (!editable && !video) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor="f-video" style={fieldLabelStyle}>{t('catalog.field.video')}</label>
      {editable && (
        <input
          id="f-video"
          dir="ltr"
          value={value}
          placeholder="https://youtube.com/watch?v=…"
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          style={{ ...textInputStyle, borderColor: invalid ? 'var(--danger)' : undefined }}
        />
      )}
      {invalid && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{t('catalog.field.video.invalid')}</span>}
      {(parsed ?? (editable ? null : video?.url)) && (
        <div style={{ maxWidth: 360 }}>
          <YouTubeFacade youtubeId={(parsed ?? video?.url)!} title={ex.name} height={180} />
        </div>
      )}
    </div>
  );
}
