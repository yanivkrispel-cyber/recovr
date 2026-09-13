import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t, type BodyRegion } from 'shared';
import { Button, Input, Select, Skeleton } from 'ui';
import { SupabaseContext } from '../App';
import ExerciseDetailDrawer from './ExerciseDetailDrawer';

interface PlanExercise {
  id: string | null; // null = new, not yet saved
  exercise_id: string;
  name: string;
  name_en: string | null;
  sets: number | null;
  reps: number | null;
  rest_sec: number | null;
  order: number;
  clinician_note: string | null;
}

// Raw shape from GET /patients/:id/plan — includes already-removed rows
// (deleted_at set) for history views; the editor draft excludes them.
interface RawPlanExercise extends PlanExercise {
  deleted_at: string | null;
}

interface PlanCriterion {
  id: string | null; // null = new, not yet saved
  type: 'time' | 'pain' | 'rom' | 'strength' | 'assessment' | 'manual';
  label: string;
  label_en: string | null;
  operator: 'gte' | 'lte' | 'eq';
  value: number;
  unit: string | null;
}

interface ProtocolPhase {
  n: number;
  name: string;
  duration_days: number | null;
  goals: { he: string; en?: string }[];
}

interface PlanPhase {
  n: number;
  name: string;
  exercises: RawPlanExercise[];
  criteria: PlanCriterion[];
}

interface PlanData {
  version: number;
  current_phase_n: number;
  pathology: { protocol_id: string; name: string; is_custom: boolean };
  phases: PlanPhase[];
  protocol_phases: ProtocolPhase[];
}

interface ExerciseOption {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  body_region: BodyRegion | null;
  phase_match?: boolean;
  has_media?: boolean;
}

interface FilterOptions {
  categories: string[];
  body_regions: BodyRegion[];
}

interface EditPlanProps {
  patientId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type EditTab = 'goals' | 'exercises' | 'assessments' | 'criteria';

const DRAFT_KEY_PREFIX = 'recoveryos:plan-draft:';

export default function EditPlan({ patientId, open, onClose, onSaved }: EditPlanProps) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();

  const { data: plan, isLoading } = useQuery({
    queryKey: ['plan', patientId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`plan/patients/${patientId}/plan`, {
        method: 'GET',
      });
      if (error) throw error;
      return data as PlanData;
    },
    enabled: open,
  });

  const { data: filterOptions } = useQuery({
    queryKey: ['exercise-filter-options'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('exercises/filter-options', { method: 'GET' });
      if (error) throw error;
      return data as FilterOptions;
    },
    enabled: open,
  });

  const [phaseN, setPhaseN] = useState<number | null>(null);
  const [editTab, setEditTab] = useState<EditTab>('exercises');
  const [draft, setDraft] = useState<PlanExercise[]>([]);
  const [criteriaDraft, setCriteriaDraft] = useState<PlanCriterion[]>([]);
  const [removals, setRemovals] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addCategory, setAddCategory] = useState('');
  const [addRegionId, setAddRegionId] = useState('');
  const [addResults, setAddResults] = useState<ExerciseOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentVersion: number } | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [pathologyName, setPathologyName] = useState('');
  const [pathologySaving, setPathologySaving] = useState(false);
  const [pathologyError, setPathologyError] = useState<string | null>(null);
  const [pathologyFlash, setPathologyFlash] = useState(false);

  // Reset editor state whenever it's (re)opened or the plan finishes loading.
  useEffect(() => {
    if (!open || !plan) return;
    const initialPhase = phaseN ?? plan.current_phase_n;
    loadPhaseIntoDraft(initialPhase);
    setEditTab('exercises');
    setSavedFlash(false);
    setPathologyName(plan.pathology?.name ?? '');
    setPathologyError(null);
    setPathologyFlash(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan]);

  function loadPhaseIntoDraft(n: number) {
    setPhaseN(n);
    const phase = plan?.phases.find((p) => p.n === n);
    setDraft((phase?.exercises ?? []).filter((e) => !e.deleted_at));
    setCriteriaDraft(phase?.criteria ?? []);
    setRemovals({});
    setSaveError(null);
    setDirty(false);
  }

  async function runAddSearch(overrides?: { q?: string; category?: string; regionId?: string }) {
    const q = overrides?.q ?? addQuery;
    const cat = overrides?.category ?? addCategory;
    const regionId = overrides?.regionId ?? addRegionId;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (cat) params.set('category', cat);
    if (regionId) params.set('region_id', regionId);
    if (phaseN) params.set('phase', String(phaseN));
    const { data } = await supabase.functions.invoke(`exercises?${params.toString()}`, { method: 'GET' });
    setAddResults((data as { items: ExerciseOption[] })?.items ?? []);
  }

  function openAddPanel() {
    setAddOpen(true);
    setSelectedIds(new Set());
    runAddSearch();
  }

  function toggleSelect(id: string) {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const draftExerciseIds = new Set(draft.map((d) => d.exercise_id));

  function addSelectedExercises() {
    const toAdd = addResults.filter((ex) => selectedIds.has(ex.id) && !draftExerciseIds.has(ex.id));
    setDraft((d) => [
      ...d,
      ...toAdd.map((ex, i) => ({
        id: null,
        exercise_id: ex.id,
        name: ex.name,
        name_en: ex.name_en,
        sets: 3,
        reps: 10,
        rest_sec: 60,
        order: d.length + i + 1,
        clinician_note: null,
      })),
    ]);
    setDirty(true);
    setAddOpen(false);
    setAddQuery('');
    setAddCategory('');
    setAddRegionId('');
    setAddResults([]);
    setSelectedIds(new Set());
  }

  function removeExercise(row: PlanExercise) {
    if (!row.id) {
      // never-saved addition — just drop it, no reason needed
      setDraft((d) => d.filter((r) => r !== row));
      setDirty(true);
      return;
    }
    const reason = window.prompt(t('confirm.remove_exercise.title'));
    if (!reason || !reason.trim()) return;
    setRemovals((r) => ({ ...r, [row.id!]: reason.trim() }));
    setDraft((d) => d.filter((r) => r !== row));
    setDirty(true);
  }

  function moveExercise(index: number, dir: -1 | 1) {
    setDraft((d) => {
      const next = [...d];
      const swapWith = index + dir;
      if (swapWith < 0 || swapWith >= next.length) return d;
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      return next.map((row, i) => ({ ...row, order: i + 1 }));
    });
    setDirty(true);
  }

  function updateField(index: number, field: 'sets' | 'reps' | 'rest_sec', value: string) {
    setDraft((d) => {
      const next = [...d];
      next[index] = { ...next[index], [field]: value === '' ? null : Number(value) };
      return next;
    });
    setDirty(true);
  }

  function copyPhaseFrom(sourceN: number) {
    const source = plan?.phases.find((p) => p.n === sourceN);
    if (!source) return;
    setDraft(
      source.exercises
        .filter((e) => !e.deleted_at)
        .map((e, i) => ({ ...e, id: null, order: i + 1 })),
    );
    setDirty(true);
  }

  function addCriterion() {
    setCriteriaDraft((c) => [
      ...c,
      { id: null, type: 'manual', label: '', label_en: null, operator: 'eq', value: 1, unit: null },
    ]);
    setDirty(true);
  }

  function removeCriterion(index: number) {
    setCriteriaDraft((c) => c.filter((_, i) => i !== index));
    setDirty(true);
  }

  function updateCriterionText(
    index: number,
    field: 'type' | 'label' | 'operator' | 'unit',
    value: string,
  ) {
    setCriteriaDraft((c) => {
      const next = [...c];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setDirty(true);
  }

  function updateCriterionValue(index: number, value: string) {
    setCriteriaDraft((c) => {
      const next = [...c];
      next[index] = { ...next[index], value: value === '' ? 0 : Number(value) };
      return next;
    });
    setDirty(true);
  }

  // Returns whether the save succeeded — the top-bar "Save" closes the
  // editor afterward, the sticky unsaved-changes bar's "Save" doesn't
  // (matches the prototype's saveAndCloseEditPlan vs saveEditPlan split).
  async function doSave(): Promise<boolean> {
    if (!plan || phaseN === null) return false;
    setSaving(true);
    setSaveError(null);

    const { data, error } = await supabase.functions.invoke(
      `plan/patients/${patientId}/plan/versions`,
      {
        method: 'POST',
        body: {
          base_version: plan.version,
          phase_n: phaseN,
          exercises: draft.map((e) => ({
            plan_exercise_id: e.id,
            exercise_id: e.exercise_id,
            sets: e.sets,
            reps: e.reps,
            rest_sec: e.rest_sec,
            order: e.order,
            clinician_note: e.clinician_note,
          })),
          removal_reasons: removals,
          criteria: criteriaDraft.map((c, i) => ({
            id: c.id,
            type: c.type,
            label: c.label,
            label_en: c.label_en,
            operator: c.operator,
            value: c.value,
            unit: c.unit,
            order: i + 1,
          })),
        },
      },
    );

    setSaving(false);

    if (error) {
      setSaveError(t('error.save.body'));
      return false;
    }
    if (data?.error === 'plan_version_conflict') {
      setConflict({ currentVersion: data.current_version });
      return false;
    }
    if (data?.error) {
      setSaveError(t('error.save.body'));
      return false;
    }

    localStorage.removeItem(DRAFT_KEY_PREFIX + patientId + ':' + phaseN);
    queryClient.invalidateQueries({ queryKey: ['plan', patientId] });
    setDirty(false);
    setSavedFlash(true);
    onSaved();
    return true;
  }

  async function handleSaveAndClose() {
    if (await doSave()) onClose();
  }

  async function handleSaveTemplate() {
    if (!templateName.trim()) return;
    setSavingTemplate(true);
    await supabase.functions.invoke('plan-templates', {
      method: 'POST',
      body: { name: templateName.trim(), payload: { exercises: draft } },
    });
    setSavingTemplate(false);
    setTemplateName('');
  }

  async function savePathology() {
    const name = pathologyName.trim();
    if (!plan || !name || name === plan.pathology.name) return;
    setPathologySaving(true);
    setPathologyError(null);
    const { data, error } = await supabase.functions.invoke(`plan/patients/${patientId}/plan`, {
      method: 'PATCH',
      body: { name },
    });
    setPathologySaving(false);
    if (error || (data as { error?: string })?.error) {
      setPathologyError(t('error.save.body'));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['plan', patientId] });
    setPathologyFlash(true);
    onSaved();
  }

  function handleConflictReload() {
    setConflict(null);
    queryClient.invalidateQueries({ queryKey: ['plan', patientId] });
  }

  function handleConflictKeepDraft() {
    if (phaseN !== null) {
      localStorage.setItem(
        DRAFT_KEY_PREFIX + patientId + ':' + phaseN,
        JSON.stringify({ draft, removals }),
      );
    }
    setConflict(null);
  }

  function handleDiscard() {
    if (phaseN !== null) loadPhaseIntoDraft(phaseN);
  }

  if (!open) return null;

  const currentProtocolPhase = plan?.protocol_phases.find((p) => p.n === phaseN);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)', background: 'var(--shell-content-bg)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 26px', borderBottom: '1px solid var(--shell-border)', background: 'var(--shell-sidebar-bg)' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--ink)' }}>{t('clinician.plan.edit')} · Edit Plan</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: 'var(--ink-soft)', border: '1px solid rgba(34,28,20,0.24)', borderRadius: 'var(--radius-pill)', padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            ביטול · Cancel
          </button>
          <Button loading={saving} onClick={handleSaveAndClose} disabled={!plan || !!conflict}>
            שמור · Save
          </Button>
        </div>
      </header>

      {dirty && (
        <div style={{ position: 'sticky', top: 0, zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, background: 'var(--navy)', color: 'var(--cream)', padding: '11px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--gold)', flex: 'none' }} />
            <span>יש שינויים שלא נשמרו <span style={{ opacity: 0.7 }}>· Unsaved changes</span></span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleDiscard}
              style={{ background: 'transparent', color: 'var(--navy-muted)', border: '1px solid rgba(243,234,217,0.3)', borderRadius: 'var(--radius-pill)', padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
            >
              בטל שינויים · Discard
            </button>
            <button
              onClick={doSave}
              style={{ background: 'var(--gold)', color: 'var(--navy)', border: 'none', borderRadius: 'var(--radius-pill)', padding: '7px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
            >
              שמור שינויים · Save
            </button>
          </div>
        </div>
      )}

      {savedFlash && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--pill-good-bg)', color: 'var(--flag-green)', padding: '10px 26px', fontSize: 12, fontWeight: 600 }}>
          ✓ כל השינויים נשמרו <span style={{ opacity: 0.75, fontWeight: 400 }}>· All changes saved</span>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {isLoading || !plan ? (
          <div style={{ flex: 1, padding: 28 }}><Skeleton count={6} height={20} /></div>
        ) : conflict ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ maxWidth: 420 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--ink)' }}>{t('error.conflict.title')}</h3>
              <p style={{ fontSize: 13, color: 'var(--nav-inactive-text)', marginBottom: 20 }}>{t('error.conflict.body')}</p>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={handleConflictKeepDraft}>{t('error.conflict.secondary')}</Button>
                <Button onClick={handleConflictReload}>{t('error.conflict.primary')}</Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div style={{ width: 160, flex: 'none', padding: '18px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderInlineEnd: '1px solid var(--shell-border)' }}>
              {plan.protocol_phases.map((p) => (
                <button
                  key={p.n}
                  onClick={() => loadPhaseIntoDraft(p.n)}
                  style={p.n === phaseN ? pillStyle(true) : pillStyle(false)}
                >
                  שלב {p.n}
                </button>
              ))}
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                <div style={{ flex: 1, maxWidth: 420 }}>
                  <Input
                    label="פתולוגיה · Pathology"
                    value={pathologyName}
                    disabled={!plan.pathology.is_custom || pathologySaving}
                    onChange={(e) => {
                      setPathologyName(e.target.value);
                      setPathologyFlash(false);
                    }}
                    hint={
                      plan.pathology.is_custom
                        ? undefined
                        : 'פתולוגיה מפרוטוקול ספרייה — לא ניתן לשנות מכאן'
                    }
                    error={pathologyError ?? undefined}
                  />
                </div>
                {plan.pathology.is_custom && (
                  <Button
                    variant="ghost"
                    loading={pathologySaving}
                    disabled={
                      !pathologyName.trim() || pathologyName.trim() === plan.pathology.name
                    }
                    onClick={savePathology}
                  >
                    עדכן · Update
                  </Button>
                )}
                {pathologyFlash && (
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--flag-green)', paddingBottom: 9 }}>
                    ✓ עודכן
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 20, borderBottom: '1px solid var(--shell-border)' }}>
                <button onClick={() => setEditTab('goals')} style={editTabStyle(editTab === 'goals')}>מטרות · Goals</button>
                <button onClick={() => setEditTab('exercises')} style={editTabStyle(editTab === 'exercises')}>תרגילים · Exercises</button>
                <button onClick={() => setEditTab('assessments')} style={editTabStyle(editTab === 'assessments')}>הערכות · Assessments</button>
                <button onClick={() => setEditTab('criteria')} style={editTabStyle(editTab === 'criteria')}>קריטריונים · Criteria</button>
              </div>

              {editTab === 'goals' && (
                <div style={panelStyle()}>
                  {(currentProtocolPhase?.goals ?? []).length === 0 ? (
                    <span style={{ fontSize: 13, color: 'var(--nav-inactive-text)' }}>אין מטרות מוגדרות לשלב זה</span>
                  ) : (
                    currentProtocolPhase!.goals.map((g, i) => (
                      <div key={i} style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                        ✓ {g.he} <span style={{ color: 'var(--nav-inactive-text)' }}>· {g.en}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {editTab === 'exercises' && (
                <>
                  {plan.phases.filter((p) => p.n !== phaseN).length > 0 && (
                    <div style={{ maxWidth: 280 }}>
                      <Select
                        value=""
                        onChange={(e) => e.target.value && copyPhaseFrom(Number(e.target.value))}
                        options={[
                          { value: '', label: 'העתק תרגילים משלב אחר…' },
                          ...plan.phases
                            .filter((p) => p.n !== phaseN)
                            .map((p) => ({ value: String(p.n), label: `${p.n}. ${p.name}` })),
                        ]}
                      />
                    </div>
                  )}

                  <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--shell-border)' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>תרגילים · Exercises</div>
                      <button onClick={openAddPanel} style={ghostPillStyle}>+ הוסף תרגיל · Add Exercise</button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.5fr', padding: '10px 18px', fontSize: 11, color: 'var(--nav-inactive-text)', fontWeight: 600 }}>
                      <div>תרגיל · Exercise</div><div>סטים</div><div>חזרות</div><div>מנוחה (שנ׳)</div><div />
                    </div>
                    {draft.length === 0 ? (
                      <div style={{ padding: 20, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13, borderTop: '1px solid var(--shell-border-soft)' }}>אין תרגילים בשלב זה</div>
                    ) : draft.map((row, i) => (
                      <div key={row.id ?? `new-${i}`} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.5fr', padding: '12px 18px', borderTop: '1px solid var(--shell-border-soft)', alignItems: 'center' }}>
                        <div style={{ fontSize: 13, color: 'var(--gold-deep)', fontWeight: 600 }}>
                          {row.name} <span style={{ fontWeight: 400, color: 'var(--nav-inactive-text)', fontSize: 11 }}>{row.name_en}</span>
                        </div>
                        <div>
                          <input type="number" value={row.sets ?? ''} onChange={(e) => updateField(i, 'sets', e.target.value)} style={numInputStyle} />
                        </div>
                        <div>
                          <input type="number" value={row.reps ?? ''} onChange={(e) => updateField(i, 'reps', e.target.value)} style={numInputStyle} />
                        </div>
                        <div>
                          <input type="number" value={row.rest_sec ?? ''} onChange={(e) => updateField(i, 'rest_sec', e.target.value)} style={numInputStyle} />
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => moveExercise(i, -1)} disabled={i === 0} aria-label="הזז למעלה · Move up" style={iconBtnStyle}>↑</button>
                          <button onClick={() => moveExercise(i, 1)} disabled={i === draft.length - 1} aria-label="הזז למטה · Move down" style={iconBtnStyle}>↓</button>
                          <button onClick={() => removeExercise(row)} aria-label="הסר תרגיל · Remove exercise" style={{ ...iconBtnStyle, color: 'var(--flag-red)' }}>✕</button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {addOpen && (
                    <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-card)', padding: 16 }}>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 180, flex: 1 }}>
                          <Input
                            placeholder="חיפוש"
                            value={addQuery}
                            onChange={(e) => {
                              setAddQuery(e.target.value);
                              runAddSearch({ q: e.target.value });
                            }}
                          />
                        </div>
                        <div style={{ minWidth: 150 }}>
                          <Select
                            value={addCategory}
                            onChange={(e) => {
                              setAddCategory(e.target.value);
                              runAddSearch({ category: e.target.value });
                            }}
                            options={[
                              { value: '', label: 'כל הקטגוריות' },
                              ...(filterOptions?.categories ?? []).map((c) => ({ value: c, label: c })),
                            ]}
                          />
                        </div>
                        <div style={{ minWidth: 150 }}>
                          <Select
                            value={addRegionId}
                            onChange={(e) => {
                              setAddRegionId(e.target.value);
                              runAddSearch({ regionId: e.target.value });
                            }}
                            options={[
                              { value: '', label: 'כל האזורים' },
                              ...(filterOptions?.body_regions ?? []).map((r) => ({ value: r.id, label: r.name })),
                            ]}
                          />
                        </div>
                      </div>

                      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--shell-border-soft)', borderRadius: 8 }}>
                        {addResults.length === 0 ? (
                          <div style={{ padding: 16, textAlign: 'center', fontSize: 13, color: 'var(--nav-inactive-text)' }}>אין תוצאות</div>
                        ) : addResults.map((ex) => {
                          const alreadyInPhase = draftExerciseIds.has(ex.id);
                          return (
                            <div
                              key={ex.id}
                              style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                                padding: '8px 12px', fontSize: 13, borderBottom: '1px solid var(--shell-border-soft)',
                                opacity: alreadyInPhase ? 0.6 : 1,
                              }}
                            >
                              <label
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0,
                                  cursor: alreadyInPhase ? 'not-allowed' : 'pointer',
                                }}
                              >
                                <input type="checkbox" disabled={alreadyInPhase} checked={selectedIds.has(ex.id)} onChange={() => toggleSelect(ex.id)} />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ex.name}</span>
                                {ex.phase_match && (
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gold-deep)', background: 'var(--nav-active-bg)', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>
                                    מתאים לשלב
                                  </span>
                                )}
                              </label>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                {alreadyInPhase && <span style={{ color: 'var(--nav-inactive-text)', fontSize: 12 }}>כבר בשלב זה</span>}
                                <button
                                  type="button"
                                  onClick={() => setDetailId(ex.id)}
                                  style={{ background: 'transparent', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-pill)', padding: '3px 10px', fontSize: 11, color: 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'inherit' }}
                                >
                                  פרטים
                                </button>
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                        <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>{t('clinician.plan.discard')}</Button>
                        <Button size="sm" onClick={addSelectedExercises} disabled={selectedIds.size === 0}>
                          הוסף ({selectedIds.size})
                        </Button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Input placeholder="שם תבנית" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
                    <Button size="sm" variant="ghost" loading={savingTemplate} onClick={handleSaveTemplate}>
                      שמור כתבנית
                    </Button>
                  </div>

                  {saveError && <p style={{ color: 'var(--flag-red)', fontSize: 13 }}>{saveError}</p>}
                </>
              )}

              {editTab === 'assessments' && (
                <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px dashed var(--placeholder)', borderRadius: 'var(--radius-card)', padding: 32, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13 }}>
                  אין הערכות מתוזמנות · No assessments scheduled
                </div>
              )}

              {editTab === 'criteria' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {criteriaDraft.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--nav-inactive-text)' }}>אין קריטריונים לשלב זה</div>
                  ) : (
                    criteriaDraft.map((c, i) => (
                      <div key={c.id ?? `new-crit-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <div style={{ flex: 2 }}>
                          <Input placeholder="תיאור הקריטריון" value={c.label} onChange={(e) => updateCriterionText(i, 'label', e.target.value)} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <Select
                            value={c.type}
                            onChange={(e) => updateCriterionText(i, 'type', e.target.value)}
                            options={[
                              { value: 'time', label: 'זמן' },
                              { value: 'pain', label: 'כאב' },
                              { value: 'rom', label: 'טווח תנועה' },
                              { value: 'strength', label: 'כוח' },
                              { value: 'assessment', label: 'הערכה' },
                              { value: 'manual', label: 'אישור ידני' },
                            ]}
                          />
                        </div>
                        <div style={{ width: 70 }}>
                          <Select
                            value={c.operator}
                            onChange={(e) => updateCriterionText(i, 'operator', e.target.value)}
                            options={[
                              { value: 'gte', label: '≥' },
                              { value: 'lte', label: '≤' },
                              { value: 'eq', label: '=' },
                            ]}
                          />
                        </div>
                        <div style={{ width: 70 }}>
                          <input type="number" value={c.value} onChange={(e) => updateCriterionValue(i, e.target.value)} style={{ width: '100%', padding: 8, border: 'var(--border-input)', borderRadius: 6 }} />
                        </div>
                        <div style={{ width: 70 }}>
                          <Input placeholder="יחידה" value={c.unit ?? ''} onChange={(e) => updateCriterionText(i, 'unit', e.target.value)} />
                        </div>
                        <button onClick={() => removeCriterion(i)} aria-label="הסר קריטריון · Remove criterion" style={{ ...iconBtnStyle, color: 'var(--flag-red)' }}>✕</button>
                      </div>
                    ))
                  )}
                  <div>
                    <Button size="sm" variant="ghost" onClick={addCriterion}>+ קריטריון</Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <ExerciseDetailDrawer
        exerciseId={detailId}
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        onDuplicated={(newId) => setDetailId(newId)}
      />
    </div>
  );
}

function pillStyle(active: boolean): CSSProperties {
  return active
    ? { padding: '10px 12px', borderRadius: 'var(--radius-pill)', background: 'var(--gold-deep)', color: 'var(--cream)', fontWeight: 600, fontSize: 13, cursor: 'pointer', textAlign: 'center', border: 'none', fontFamily: 'inherit' }
    : { padding: '10px 12px', borderRadius: 'var(--radius-pill)', background: 'transparent', color: 'var(--nav-inactive-text)', fontWeight: 500, fontSize: 13, cursor: 'pointer', textAlign: 'center', border: '1px solid rgba(34,28,20,0.18)', fontFamily: 'inherit' };
}

function editTabStyle(active: boolean): CSSProperties {
  return {
    padding: '10px 4px', background: 'transparent', border: 'none',
    borderBottom: active ? '2px solid var(--gold-deep)' : '2px solid transparent',
    color: active ? 'var(--gold-deep)' : 'var(--nav-inactive-text)',
    fontWeight: active ? 700 : 500, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
  };
}

function panelStyle(): CSSProperties {
  return { background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-card)', padding: 18, display: 'flex', flexDirection: 'column', gap: 8 };
}

const ghostPillStyle: CSSProperties = {
  background: 'transparent', color: 'var(--gold-deep)', border: '1px solid rgba(140,100,35,0.5)',
  borderRadius: 'var(--radius-pill)', letterSpacing: '0.04em', padding: '7px 12px', fontSize: 12,
  fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};

const numInputStyle: CSSProperties = { width: 56, padding: 4, border: 'var(--border-input)', borderRadius: 4 };

const iconBtnStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--line)',
  borderRadius: 4,
  cursor: 'pointer',
  width: 26,
  height: 26,
  fontSize: 12,
};
