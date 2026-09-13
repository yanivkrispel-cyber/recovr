import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { t, type BodyRegion } from 'shared';
import { Button, Input, Select, Skeleton } from 'ui';
import { SupabaseContext } from '../App';
import ExerciseDetailDrawer from './ExerciseDetailDrawer';

interface Goal {
  he: string;
  en?: string;
}

interface ExerciseDraft {
  exercise_id: string;
  name: string;
  name_en: string | null;
  sets: number | null;
  reps: number | null;
  hold_sec: number | null;
  frequency: string;
  notes: string;
  order: number;
}

interface CriterionDraft {
  type: 'time' | 'pain' | 'rom' | 'strength' | 'assessment' | 'manual';
  label: string;
  label_en: string | null;
  operator: 'gte' | 'lte' | 'eq';
  value: number;
  unit: string | null;
}

interface PhaseDraft {
  name: string;
  name_en: string;
  duration_days: number | null;
  goals: Goal[];
  exercises: ExerciseDraft[];
  criteria: CriterionDraft[];
}

interface ProtocolDetail {
  id: string;
  name: string;
  name_en: string | null;
  body_region: BodyRegion | null;
  region_detail: string | null;
  region_detail_en: string | null;
  source: 'system' | 'clinic';
  version: string;
  is_editable: boolean;
  phases: {
    name: string;
    name_en: string | null;
    duration_days: number | null;
    goals: Goal[];
    exercises: { exercise_id: string; name: string; name_en: string | null; prescription: { sets?: number; reps?: number; hold_sec?: number }; frequency: string | null; order: number; notes: string | null }[];
    criteria: { type: CriterionDraft['type']; label: string; label_en: string | null; operator: CriterionDraft['operator']; value: number; unit: string | null }[];
  }[];
}

interface ExerciseOption {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  body_region: BodyRegion | null;
}

interface FilterOptions {
  categories: string[];
  body_regions: BodyRegion[];
}

const ADD_PAGE_SIZE = 60;

interface EditProtocolProps {
  protocolId: string | null; // null = create mode
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function emptyPhase(n: number): PhaseDraft {
  return { name: `שלב ${n}`, name_en: '', duration_days: null, goals: [], exercises: [], criteria: [] };
}

export default function EditProtocol({ protocolId, open, onClose, onSaved }: EditProtocolProps) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();

  const { data: detail, isLoading } = useQuery({
    queryKey: ['protocol-detail', protocolId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`protocols/${protocolId}`, { method: 'GET' });
      if (error) throw error;
      return data as ProtocolDetail;
    },
    enabled: open && protocolId !== null,
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

  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [bodyRegionId, setBodyRegionId] = useState('');
  const [regionDetail, setRegionDetail] = useState('');
  const [regionDetailEn, setRegionDetailEn] = useState('');
  const [phases, setPhases] = useState<PhaseDraft[]>([emptyPhase(1)]);
  const [activePhase, setActivePhase] = useState(0);
  const [readOnly, setReadOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addCategory, setAddCategory] = useState('');
  const [addRegionId, setAddRegionId] = useState('');
  const [addResults, setAddResults] = useState<ExerciseOption[]>([]);
  const [addTotal, setAddTotal] = useState(0);
  const [addLoadingMore, setAddLoadingMore] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);

  // (Re)initialize the draft whenever the editor opens, for either a fresh
  // create or a loaded protocol.
  useEffect(() => {
    if (!open) return;
    if (protocolId === null) {
      setName('');
      setNameEn('');
      setBodyRegionId('');
      setRegionDetail('');
      setRegionDetailEn('');
      setPhases([emptyPhase(1)]);
      setActivePhase(0);
      setReadOnly(false);
      setSaveError(null);
      setNameTouched(false);
      return;
    }
    if (!detail) return;
    setName(detail.name);
    setNameEn(detail.name_en ?? '');
    setBodyRegionId(detail.body_region?.id ?? '');
    setRegionDetail(detail.region_detail ?? '');
    setRegionDetailEn(detail.region_detail_en ?? '');
    setPhases(
      detail.phases.map((p) => ({
        name: p.name,
        name_en: p.name_en ?? '',
        duration_days: p.duration_days,
        goals: p.goals,
        exercises: p.exercises.map((e) => ({
          exercise_id: e.exercise_id,
          name: e.name,
          name_en: e.name_en,
          sets: e.prescription?.sets ?? null,
          reps: e.prescription?.reps ?? null,
          hold_sec: e.prescription?.hold_sec ?? null,
          frequency: e.frequency ?? '',
          notes: e.notes ?? '',
          order: e.order,
        })),
        criteria: p.criteria,
      })),
    );
    setActivePhase(0);
    setReadOnly(!detail.is_editable);
    setSaveError(null);
    setNameTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, protocolId, detail]);

  function updatePhase(index: number, patch: Partial<PhaseDraft>) {
    setPhases((ps) => ps.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function addPhase() {
    setPhases((ps) => [...ps, emptyPhase(ps.length + 1)]);
    setActivePhase(phases.length);
  }

  function removePhase(index: number) {
    if (phases.length <= 1) return;
    if (!window.confirm('להסיר את השלב הזה מהפרוטוקול?')) return;
    setPhases((ps) => ps.filter((_, i) => i !== index));
    setActivePhase((a) => Math.max(0, a >= index ? a - 1 : a));
  }

  function movePhaseTab(index: number, dir: -1 | 1) {
    setPhases((ps) => {
      const next = [...ps];
      const swapWith = index + dir;
      if (swapWith < 0 || swapWith >= next.length) return ps;
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      return next;
    });
    setActivePhase((a) => (a === index ? index + dir : a === index + dir ? index : a));
  }

  const phase = phases[activePhase];
  const draftExerciseIds = new Set(phase?.exercises.map((e) => e.exercise_id) ?? []);

  async function runAddSearch(overrides?: { q?: string; category?: string; regionId?: string }) {
    const q = overrides?.q ?? addQuery;
    const cat = overrides?.category ?? addCategory;
    const regionId = overrides?.regionId ?? addRegionId;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (cat) params.set('category', cat);
    if (regionId) params.set('region_id', regionId);
    params.set('limit', String(ADD_PAGE_SIZE));
    params.set('offset', '0');
    const { data } = await supabase.functions.invoke(`exercises?${params.toString()}`, { method: 'GET' });
    const result = data as { items: ExerciseOption[]; total: number } | undefined;
    setAddResults(result?.items ?? []);
    setAddTotal(result?.total ?? 0);
  }

  async function loadMoreAddResults() {
    setAddLoadingMore(true);
    const params = new URLSearchParams();
    if (addQuery) params.set('q', addQuery);
    if (addCategory) params.set('category', addCategory);
    if (addRegionId) params.set('region_id', addRegionId);
    params.set('limit', String(ADD_PAGE_SIZE));
    params.set('offset', String(addResults.length));
    const { data } = await supabase.functions.invoke(`exercises?${params.toString()}`, { method: 'GET' });
    const result = data as { items: ExerciseOption[]; total: number } | undefined;
    setAddResults((prev) => [...prev, ...(result?.items ?? [])]);
    setAddTotal(result?.total ?? addTotal);
    setAddLoadingMore(false);
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

  function addSelectedExercises() {
    const toAdd = addResults.filter((ex) => selectedIds.has(ex.id) && !draftExerciseIds.has(ex.id));
    updatePhase(activePhase, {
      exercises: [
        ...phase.exercises,
        ...toAdd.map((ex, i) => ({
          exercise_id: ex.id, name: ex.name, name_en: ex.name_en,
          sets: 3, reps: 10, hold_sec: null, frequency: '', notes: '',
          order: phase.exercises.length + i + 1,
        })),
      ],
    });
    setAddOpen(false);
    setAddQuery('');
    setAddCategory('');
    setAddRegionId('');
    setAddResults([]);
    setAddTotal(0);
    setSelectedIds(new Set());
  }

  function removeExercise(index: number) {
    updatePhase(activePhase, { exercises: phase.exercises.filter((_, i) => i !== index) });
  }

  function moveExercise(index: number, dir: -1 | 1) {
    const next = [...phase.exercises];
    const swapWith = index + dir;
    if (swapWith < 0 || swapWith >= next.length) return;
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    updatePhase(activePhase, { exercises: next.map((row, i) => ({ ...row, order: i + 1 })) });
  }

  function updateExerciseField(index: number, field: 'sets' | 'reps' | 'hold_sec', value: string) {
    const next = [...phase.exercises];
    next[index] = { ...next[index], [field]: value === '' ? null : Number(value) };
    updatePhase(activePhase, { exercises: next });
  }

  function updateExerciseText(index: number, field: 'frequency' | 'notes', value: string) {
    const next = [...phase.exercises];
    next[index] = { ...next[index], [field]: value };
    updatePhase(activePhase, { exercises: next });
  }

  function addCriterion() {
    updatePhase(activePhase, {
      criteria: [...phase.criteria, { type: 'manual', label: '', label_en: null, operator: 'eq', value: 1, unit: null }],
    });
  }

  function removeCriterion(index: number) {
    updatePhase(activePhase, { criteria: phase.criteria.filter((_, i) => i !== index) });
  }

  function updateCriterionText(index: number, field: 'type' | 'label' | 'operator' | 'unit', value: string) {
    const next = [...phase.criteria];
    next[index] = { ...next[index], [field]: value };
    updatePhase(activePhase, { criteria: next });
  }

  function updateCriterionValue(index: number, value: string) {
    const next = [...phase.criteria];
    next[index] = { ...next[index], value: value === '' ? 0 : Number(value) };
    updatePhase(activePhase, { criteria: next });
  }

  function addGoal() {
    updatePhase(activePhase, { goals: [...phase.goals, { he: '', en: '' }] });
  }

  function updateGoal(index: number, field: 'he' | 'en', value: string) {
    const next = [...phase.goals];
    next[index] = { ...next[index], [field]: value };
    updatePhase(activePhase, { goals: next });
  }

  function removeGoal(index: number) {
    updatePhase(activePhase, { goals: phase.goals.filter((_, i) => i !== index) });
  }

  const nameValid = name.trim().length > 0;

  async function handleSave() {
    if (!nameValid) {
      setNameTouched(true);
      return;
    }
    setSaving(true);
    setSaveError(null);

    const payload = {
      name: name.trim(),
      name_en: nameEn.trim() || undefined,
      body_region_id: bodyRegionId || undefined,
      region_detail: regionDetail.trim() || undefined,
      region_detail_en: regionDetailEn.trim() || undefined,
      phases: phases.map((p) => ({
        name: p.name.trim(),
        name_en: p.name_en.trim() || undefined,
        duration_days: p.duration_days,
        goals: p.goals.filter((g) => g.he.trim()),
        exercises: p.exercises.map((e) => ({
          exercise_id: e.exercise_id,
          prescription: {
            ...(e.sets != null ? { sets: e.sets } : {}),
            ...(e.reps != null ? { reps: e.reps } : {}),
            ...(e.hold_sec != null ? { hold_sec: e.hold_sec } : {}),
          },
          frequency: e.frequency.trim() || undefined,
          notes: e.notes.trim() || undefined,
          order: e.order,
        })),
        criteria: p.criteria.map((c, i) => ({ ...c, order: i + 1 })),
      })),
    };

    const { data, error } = protocolId === null
      ? await supabase.functions.invoke('protocols', { method: 'POST', body: payload })
      : await supabase.functions.invoke(`protocols/${protocolId}`, { method: 'PATCH', body: payload });

    setSaving(false);

    if (error || data?.error) {
      setSaveError(t('error.save.body'));
      return;
    }

    queryClient.invalidateQueries({ queryKey: ['protocol-library'] });
    if (protocolId !== null) queryClient.invalidateQueries({ queryKey: ['protocol-detail', protocolId] });
    onSaved();
  }

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)', background: 'var(--shell-content-bg)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 26px', borderBottom: '1px solid var(--shell-border)', background: 'var(--shell-sidebar-bg)' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--ink)' }}>
          {protocolId === null ? 'פרוטוקול חדש · New Protocol' : readOnly ? 'צפייה בפרוטוקול · View Protocol' : 'עריכת פרוטוקול · Edit Protocol'}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: 'var(--ink-soft)', border: '1px solid rgba(34,28,20,0.24)', borderRadius: 'var(--radius-pill)', padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            ביטול · Cancel
          </button>
          {!readOnly && (
            <Button loading={saving} onClick={handleSave}>שמור · Save</Button>
          )}
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {isLoading && protocolId !== null ? (
          <div style={{ flex: 1, padding: 28 }}><Skeleton count={6} height={20} /></div>
        ) : (
          <>
            <div style={{ width: 180, flex: 'none', padding: '18px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderInlineEnd: '1px solid var(--shell-border)', overflow: 'auto' }}>
              {phases.map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => setActivePhase(i)} style={{ ...pillStyle(i === activePhase), flex: 1 }}>
                    {i + 1}. {p.name || `שלב ${i + 1}`}
                  </button>
                  {!readOnly && (
                    <button onClick={() => removePhase(i)} disabled={phases.length <= 1} aria-label="הסר שלב · Remove phase" style={iconBtnStyle}>✕</button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => movePhaseTab(activePhase, -1)} disabled={activePhase === 0} aria-label="הזז שלב למעלה" style={{ ...iconBtnStyle, flex: 1 }}>↑</button>
                    <button onClick={() => movePhaseTab(activePhase, 1)} disabled={activePhase === phases.length - 1} aria-label="הזז שלב למטה" style={{ ...iconBtnStyle, flex: 1 }}>↓</button>
                  </div>
                  <button onClick={addPhase} style={ghostPillStyle}>+ שלב · Add Phase</button>
                </>
              )}
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <Input
                    label="שם הפרוטוקול · Name"
                    value={name}
                    disabled={readOnly}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => setNameTouched(true)}
                    error={nameTouched && !nameValid ? t('valid.required') : undefined}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <Input label="שם באנגלית" value={nameEn} disabled={readOnly} onChange={(e) => setNameEn(e.target.value)} />
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Select
                    label="אזור בגוף"
                    value={bodyRegionId}
                    disabled={readOnly}
                    onChange={(e) => setBodyRegionId(e.target.value)}
                    options={[
                      { value: '', label: 'ללא · None' },
                      ...(filterOptions?.body_regions ?? []).map((r) => ({ value: r.id, label: r.name })),
                    ]}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Input label="פירוט (אופציונלי) · Detail" value={regionDetail} disabled={readOnly} onChange={(e) => setRegionDetail(e.target.value)} />
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Input label="פירוט באנגלית · Detail (EN)" value={regionDetailEn} disabled={readOnly} onChange={(e) => setRegionDetailEn(e.target.value)} />
                </div>
              </div>

              {phase && (
                <>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <Input label="שם השלב · Phase name" value={phase.name} disabled={readOnly} onChange={(e) => updatePhase(activePhase, { name: e.target.value })} />
                    </div>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <Input label="שם באנגלית" value={phase.name_en} disabled={readOnly} onChange={(e) => updatePhase(activePhase, { name_en: e.target.value })} />
                    </div>
                    <div style={{ width: 140 }}>
                      <Input
                        label="משך (ימים)"
                        type="number"
                        value={phase.duration_days ?? ''}
                        disabled={readOnly}
                        onChange={(e) => updatePhase(activePhase, { duration_days: e.target.value === '' ? null : Number(e.target.value) })}
                      />
                    </div>
                  </div>

                  <div style={panelStyle()}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>מטרות השלב · Goals</div>
                    {phase.goals.map((g, i) => (
                      <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <Input placeholder="מטרה" value={g.he} disabled={readOnly} onChange={(e) => updateGoal(i, 'he', e.target.value)} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <Input placeholder="Goal (EN)" value={g.en ?? ''} disabled={readOnly} onChange={(e) => updateGoal(i, 'en', e.target.value)} />
                        </div>
                        {!readOnly && (
                          <button onClick={() => removeGoal(i)} aria-label="הסר מטרה" style={{ ...iconBtnStyle, color: 'var(--flag-red)' }}>✕</button>
                        )}
                      </div>
                    ))}
                    {!readOnly && (
                      <div><Button size="sm" variant="ghost" onClick={addGoal}>+ מטרה</Button></div>
                    )}
                  </div>

                  <div style={{ background: 'var(--shell-sidebar-bg)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-panel)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--shell-border)' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>תרגילים · Exercises</div>
                      {!readOnly && <button onClick={openAddPanel} style={ghostPillStyle}>+ הוסף תרגיל · Add Exercise</button>}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.6fr 0.6fr 0.6fr 1fr 0.5fr', padding: '10px 18px', fontSize: 11, color: 'var(--nav-inactive-text)', fontWeight: 600 }}>
                      <div>תרגיל · Exercise</div><div>סטים</div><div>חזרות</div><div>החזקה (שנ׳)</div><div>תדירות</div><div />
                    </div>
                    {phase.exercises.length === 0 ? (
                      <div style={{ padding: 20, textAlign: 'center', color: 'var(--nav-inactive-text)', fontSize: 13, borderTop: '1px solid var(--shell-border-soft)' }}>אין תרגילים בשלב זה</div>
                    ) : phase.exercises.map((row, i) => (
                      <div key={`${row.exercise_id}-${i}`} style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.6fr 0.6fr 0.6fr 1fr 0.5fr', padding: '12px 18px', borderTop: '1px solid var(--shell-border-soft)', alignItems: 'center', gap: 6 }}>
                        <div style={{ fontSize: 13, color: 'var(--gold-deep)', fontWeight: 600 }}>
                          {row.name} <span style={{ fontWeight: 400, color: 'var(--nav-inactive-text)', fontSize: 11 }}>{row.name_en}</span>
                        </div>
                        <input type="number" disabled={readOnly} value={row.sets ?? ''} onChange={(e) => updateExerciseField(i, 'sets', e.target.value)} style={numInputStyle} />
                        <input type="number" disabled={readOnly} value={row.reps ?? ''} onChange={(e) => updateExerciseField(i, 'reps', e.target.value)} style={numInputStyle} />
                        <input type="number" disabled={readOnly} value={row.hold_sec ?? ''} onChange={(e) => updateExerciseField(i, 'hold_sec', e.target.value)} style={numInputStyle} />
                        <input placeholder="3x/week" disabled={readOnly} value={row.frequency} onChange={(e) => updateExerciseText(i, 'frequency', e.target.value)} style={textInputStyle} />
                        {!readOnly && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={() => moveExercise(i, -1)} disabled={i === 0} aria-label="הזז למעלה · Move up" style={iconBtnStyle}>↑</button>
                            <button onClick={() => moveExercise(i, 1)} disabled={i === phase.exercises.length - 1} aria-label="הזז למטה · Move down" style={iconBtnStyle}>↓</button>
                            <button onClick={() => removeExercise(i)} aria-label="הסר תרגיל · Remove exercise" style={{ ...iconBtnStyle, color: 'var(--flag-red)' }}>✕</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {addOpen && !readOnly && (
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

                      <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)', marginBottom: 6 }}>
                        {addTotal > 0 && `מוצגים ${addResults.length} מתוך ${addTotal}`}
                      </div>
                      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--shell-border-soft)', borderRadius: 8 }}>
                        {addResults.length === 0 ? (
                          <div style={{ padding: 16, textAlign: 'center', fontSize: 13, color: 'var(--nav-inactive-text)' }}>אין תוצאות</div>
                        ) : addResults.map((ex) => {
                          const already = draftExerciseIds.has(ex.id);
                          return (
                            <div
                              key={ex.id}
                              style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                                padding: '8px 12px', fontSize: 13, borderBottom: '1px solid var(--shell-border-soft)',
                                opacity: already ? 0.6 : 1,
                              }}
                            >
                              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: already ? 'not-allowed' : 'pointer' }}>
                                <input type="checkbox" disabled={already} checked={selectedIds.has(ex.id)} onChange={() => toggleSelect(ex.id)} />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ex.name}</span>
                              </label>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                {already && <span style={{ color: 'var(--nav-inactive-text)', fontSize: 12 }}>כבר בשלב זה</span>}
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

                      {addResults.length < addTotal && (
                        <div style={{ textAlign: 'center', marginTop: 8 }}>
                          <Button size="sm" variant="secondary" loading={addLoadingMore} onClick={loadMoreAddResults}>
                            טען עוד · Load more
                          </Button>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                        <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>{t('clinician.plan.discard')}</Button>
                        <Button size="sm" onClick={addSelectedExercises} disabled={selectedIds.size === 0}>
                          הוסף ({selectedIds.size})
                        </Button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>קריטריונים להתקדמות · Criteria</div>
                    {phase.criteria.length === 0 ? (
                      <div style={{ fontSize: 13, color: 'var(--nav-inactive-text)' }}>אין קריטריונים לשלב זה</div>
                    ) : (
                      phase.criteria.map((c, i) => (
                        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <div style={{ flex: 2 }}>
                            <Input placeholder="תיאור הקריטריון" disabled={readOnly} value={c.label} onChange={(e) => updateCriterionText(i, 'label', e.target.value)} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <Select
                              value={c.type}
                              disabled={readOnly}
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
                              disabled={readOnly}
                              onChange={(e) => updateCriterionText(i, 'operator', e.target.value)}
                              options={[
                                { value: 'gte', label: '≥' },
                                { value: 'lte', label: '≤' },
                                { value: 'eq', label: '=' },
                              ]}
                            />
                          </div>
                          <div style={{ width: 70 }}>
                            <input type="number" disabled={readOnly} value={c.value} onChange={(e) => updateCriterionValue(i, e.target.value)} style={{ width: '100%', padding: 8, border: 'var(--border-input)', borderRadius: 6 }} />
                          </div>
                          <div style={{ width: 70 }}>
                            <Input placeholder="יחידה" disabled={readOnly} value={c.unit ?? ''} onChange={(e) => updateCriterionText(i, 'unit', e.target.value)} />
                          </div>
                          {!readOnly && (
                            <button onClick={() => removeCriterion(i)} aria-label="הסר קריטריון · Remove criterion" style={{ ...iconBtnStyle, color: 'var(--flag-red)' }}>✕</button>
                          )}
                        </div>
                      ))
                    )}
                    {!readOnly && (
                      <div><Button size="sm" variant="ghost" onClick={addCriterion}>+ קריטריון</Button></div>
                    )}
                  </div>
                </>
              )}

              {saveError && <p style={{ color: 'var(--flag-red)', fontSize: 13 }}>{saveError}</p>}
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
    ? { padding: '10px 12px', borderRadius: 'var(--radius-pill)', background: 'var(--gold-deep)', color: 'var(--cream)', fontWeight: 600, fontSize: 13, cursor: 'pointer', textAlign: 'start', border: 'none', fontFamily: 'inherit' }
    : { padding: '10px 12px', borderRadius: 'var(--radius-pill)', background: 'transparent', color: 'var(--nav-inactive-text)', fontWeight: 500, fontSize: 13, cursor: 'pointer', textAlign: 'start', border: '1px solid rgba(34,28,20,0.18)', fontFamily: 'inherit' };
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
const textInputStyle: CSSProperties = { width: '100%', padding: 4, border: 'var(--border-input)', borderRadius: 4, fontFamily: 'inherit' };

const iconBtnStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--line)',
  borderRadius: 4,
  cursor: 'pointer',
  width: 26,
  height: 26,
  fontSize: 12,
};
