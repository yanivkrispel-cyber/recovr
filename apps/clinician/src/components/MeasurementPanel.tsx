import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button } from 'ui';
import { SupabaseContext } from '../App';
import {
  computeFlag,
  flagColor,
  gapFlag,
  governingValue,
  rowSummary,
  sideGap,
  type FlagState,
  type GoverningSource,
  type MeasureDefinition,
} from '../lib/romFlags';

export interface MeasurementRow {
  id: string;
  patient_id: string;
  measure_code: string;
  side: 'involved' | 'healthy' | 'bilateral';
  value: number;
  value_secondary: number | null;
  pass: boolean | null;
  compensations: string[] | null;
  attempts: number[] | null;
  governing_source: GoverningSource | null;
  pain: number | null;
  end_feel: 'soft' | 'hard' | null;
  swelling: 'none' | 'mild' | 'moderate' | 'severe' | null;
  note: string | null;
  visit_id: string | null;
  measured_at: string;
}

export interface JointDefinition extends MeasureDefinition {
  id: string;
  joint: string;
  name_he: string;
  name_en: string | null;
  protocol_tip: string | null;
}

export interface JointEntry {
  definition: JointDefinition;
  involved: MeasurementRow | null;
  healthy: MeasurementRow | null;
  history: MeasurementRow[];
}

const COMPENSATION_OPTIONS: Record<string, { key: string; label: string }[]> = {
  knee_squat: [
    { key: 'heels', label: 'עקבים מתרוממים' },
    { key: 'knees', label: 'ברכיים פנימה' },
    { key: 'trunk', label: 'גו נוטה קדימה' },
  ],
};

const END_FEEL_OPTIONS: { value: 'soft' | 'hard'; label: string }[] = [
  { value: 'soft', label: 'רך' },
  { value: 'hard', label: 'קשה' },
];

const SWELLING_OPTIONS: { value: 'none' | 'mild' | 'moderate' | 'severe'; label: string }[] = [
  { value: 'none', label: 'אין' },
  { value: 'mild', label: 'קל' },
  { value: 'moderate', label: 'בינוני' },
  { value: 'severe', label: 'ניכר' },
];

const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

function polarPoint(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number) {
  const start = polarPoint(cx, cy, r, fromDeg);
  const end = polarPoint(cx, cy, r, toDeg);
  const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

// value 0 -> 180deg (left), value scale -> 0deg (right): a left-to-right 180deg sweep.
function valueToAngle(value: number, scale: number) {
  const t = Math.max(0, Math.min(1, value / scale));
  return 180 - t * 180;
}

function ArcGauge({ def, value, healthyValue, previousValue, flag }: {
  def: JointDefinition;
  value: number | null;
  healthyValue: number | null;
  previousValue: number | null;
  flag: FlagState;
}) {
  const cx = 110, cy = 100, r = 88;
  const scale = def.scale || 100;
  const bandGood = def.flags.deficit || def.flags.lower
    ? { from: 0, to: def.target ?? 0 }
    : { from: def.target ?? 0, to: scale };

  return (
    <svg width="220" height="120" viewBox="0 0 220 120" role="img" aria-label="מד זווית">
      <path d={arcPath(cx, cy, r, 180, 0)} stroke="var(--shell-border)" strokeWidth={10} fill="none" strokeLinecap="round" />
      {def.target != null && (
        <path
          d={arcPath(cx, cy, r, valueToAngle(bandGood.from, scale), valueToAngle(bandGood.to, scale))}
          stroke="var(--flag-green)"
          strokeOpacity={0.35}
          strokeWidth={10}
          fill="none"
        />
      )}
      {def.norm != null && (() => {
        const p1 = polarPoint(cx, cy, r - 6, valueToAngle(def.norm!, scale));
        const p2 = polarPoint(cx, cy, r + 6, valueToAngle(def.norm!, scale));
        return <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--flag-green)" strokeWidth={3} />;
      })()}
      {healthyValue != null && (() => {
        const p1 = polarPoint(cx, cy, r - 10, valueToAngle(healthyValue, scale));
        const p2 = polarPoint(cx, cy, r + 10, valueToAngle(healthyValue, scale));
        return <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--navy)" strokeWidth={2} strokeDasharray="3 3" />;
      })()}
      {previousValue != null && (() => {
        const p1 = polarPoint(cx, cy, r - 8, valueToAngle(previousValue, scale));
        const p2 = polarPoint(cx, cy, r + 8, valueToAngle(previousValue, scale));
        return <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--placeholder)" strokeWidth={2} />;
      })()}
      {value != null && (() => {
        const tip = polarPoint(cx, cy, r - 4, valueToAngle(value, scale));
        return <line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke={flagColor(flag)} strokeWidth={3} strokeLinecap="round" />;
      })()}
      <circle cx={cx} cy={cy} r={4} fill={flagColor(flag)} />
    </svg>
  );
}

function Ruler({ def, value, healthyValue, previousValue, flag }: {
  def: JointDefinition;
  value: number | null;
  healthyValue: number | null;
  previousValue: number | null;
  flag: FlagState;
}) {
  const scale = def.scale || 20;
  const width = 236;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const lowerBetter = !!def.flags.lower;
  const ticks = Array.from({ length: scale + 1 }, (_, i) => i);
  const bandFrom = def.target != null ? (lowerBetter ? 0 : def.target) : null;
  const bandTo = def.target != null ? (lowerBetter ? def.target : scale) : null;

  return (
    <div style={{ width, maxWidth: '100%', position: 'relative', paddingTop: 8 }}>
      <div style={{ position: 'relative', height: 14, background: 'var(--white)', borderRadius: 6, border: '1px solid var(--shell-border)' }}>
        {bandFrom != null && bandTo != null && (
          <div style={{ position: 'absolute', insetInlineStart: pct(bandFrom), width: `calc(${pct(bandTo)} - ${pct(bandFrom)})`, top: 0, bottom: 0, background: 'var(--flag-green)', opacity: 0.25 }} />
        )}
        {value != null && (
          <div style={{ position: 'absolute', insetInlineStart: 0, width: pct(value), top: 0, bottom: 0, background: flagColor(flag), opacity: 0.55, borderRadius: 6 }} />
        )}
        {def.norm != null && (
          <div style={{ position: 'absolute', insetInlineStart: pct(def.norm), top: -3, bottom: -3, width: 2, background: 'var(--flag-green)' }} />
        )}
        {healthyValue != null && (
          <div style={{ position: 'absolute', insetInlineStart: pct(healthyValue), top: -3, bottom: -3, width: 0, borderInlineStart: '2px dashed var(--navy)' }} />
        )}
        {previousValue != null && (
          <div style={{ position: 'absolute', insetInlineStart: pct(previousValue), top: -2, bottom: -2, width: 2, background: 'var(--placeholder)' }} />
        )}
      </div>
      <div style={{ position: 'relative', height: 16, marginTop: 2 }}>
        {ticks.filter(t => t % 3 === 0).map(t => (
          <span key={t} style={{ position: 'absolute', insetInlineStart: pct(t), transform: 'translateX(50%)', fontSize: 10, color: 'var(--nav-inactive-text)' }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function Legend({ def, healthyValue, side }: { def: JointDefinition; healthyValue: number | null; side: 'involved' | 'healthy' }) {
  const unit = def.unit === 'cm' ? ' ס״מ' : '°';
  const dot = (color: string, dashed?: boolean): CSSProperties => ({
    width: 12, height: dashed ? 0 : 3, borderTop: dashed ? `2px dashed ${color}` : undefined, background: dashed ? undefined : color,
  });
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 10, fontSize: 10, color: 'var(--nav-inactive-text)' }}>
      {def.norm != null && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={dot('var(--flag-green)')} />{`נורמה (${def.norm_source ?? 'AAOS'})`}</span>
      )}
      {healthyValue != null && side === 'involved' && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={dot('var(--navy)', true)} />{`צד בריא ${healthyValue}${unit}`}</span>
      )}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={dot('var(--placeholder)')} />מדידה קודמת</span>
      {def.target != null && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 8, background: 'var(--flag-green)', opacity: 0.35, borderRadius: 2 }} />טווח תקין</span>
      )}
    </div>
  );
}

interface MeasurementPanelProps {
  patientId: string;
  patientName?: string;
  entry: JointEntry;
  visitId: string | null;
  onClose: () => void;
  onSaved: (measureCode: string) => void;
  /** T-22: tablet is view-only for v1 — hides recording controls, keeps the read side. */
  readOnly?: boolean;
}

export default function MeasurementPanel({ patientId, patientName, entry, visitId, onClose, onSaved, readOnly = false }: MeasurementPanelProps) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  const { definition: def } = entry;
  const bilat = def.flags.bilat !== false;

  const [side, setSide] = useState<'involved' | 'healthy'>('involved');
  const [attempts, setAttempts] = useState<[string, string, string]>(['', '', '']);
  const [gov, setGov] = useState<GoverningSource>('best');
  const [attemptIndex, setAttemptIndex] = useState(0);
  const [singleVal, setSingleVal] = useState('');
  const [secondaryDeg, setSecondaryDeg] = useState('');
  const [pass, setPass] = useState<boolean | null>(null);
  const [comp, setComp] = useState<Record<string, boolean>>({});
  const [pain, setPain] = useState<number | null>(null);
  const [endFeel, setEndFeel] = useState<'soft' | 'hard' | ''>('');
  const [swelling, setSwelling] = useState<'none' | 'mild' | 'moderate' | 'severe' | ''>('');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const currentRow = bilat ? (side === 'involved' ? entry.involved : entry.healthy) : entry.involved;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const row = currentRow;
    setAttempts(row?.attempts ? [String(row.attempts[0] ?? ''), String(row.attempts[1] ?? ''), String(row.attempts[2] ?? '')] : ['', '', '']);
    setGov((row?.governing_source as GoverningSource) ?? 'best');
    setAttemptIndex(0);
    setSingleVal(row ? String(row.value) : '');
    setSecondaryDeg(row?.value_secondary != null ? String(row.value_secondary) : '');
    setPass(row?.pass ?? null);
    setComp(row?.compensations ? Object.fromEntries(row.compensations.map(c => [c, true])) : {});
    setPain(row?.pain ?? null);
    setEndFeel(row?.end_feel ?? '');
    setSwelling(row?.swelling ?? '');
    setNote(row?.note ?? '');
    setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.definition.code, side]);

  const isGoniometric = def.unit === 'deg' && !def.flags.fx;

  const attemptNums = attempts.map(v => (v === '' ? null : Number(v)));
  const liveValue = def.unit === 'pass_fail'
    ? null
    : isGoniometric
      ? governingValue(attemptNums, gov, attemptIndex)
      : (singleVal === '' || Number.isNaN(Number(singleVal)) ? null : Number(singleVal));

  const healthyValue = bilat ? (side === 'involved' ? entry.healthy?.value ?? null : null) : null;
  const previousValue = currentRow && currentRow.id !== editingId ? currentRow.value : null;
  const flag = computeFlag(def, liveValue, healthyValue, pass);
  const gap = def.unit === 'cm' ? gapFlag(def, liveValue, healthyValue) : 'neutral';
  const gapCm = sideGap(liveValue, healthyValue);
  const unitSuffix = def.unit === 'cm' ? ' ס״מ' : '°';

  const compensationOptions = COMPENSATION_OPTIONS[def.code] ?? [];

  const govSourceLabel = def.unit === 'pass_fail'
    ? 'סמן עובר או לא עובר'
    : isGoniometric
      ? (gov === 'avg' ? 'ממוצע שלושת הניסיונות' : gov === 'attempt_n' ? 'ניסיון נבחר' : 'הניסיון הטוב ביותר')
      : `מדידה בודדת${def.name_en ? ` · ${def.name_en}` : ''}`;

  const avgOfAttempts = (() => {
    const nums = attemptNums.filter((v): v is number => v !== null);
    return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  })();

  function pressKey(k: string) {
    setSingleVal((v) => {
      if (k === '⌫') return v.slice(0, -1);
      if (k === '.') return v.includes('.') ? v : v + '.';
      const digits = v.replace('.', '');
      if (digits.length >= 4) return v;
      return v + k;
    });
  }

  const sortedHistory = [...entry.history].sort((a, b) => new Date(a.measured_at).getTime() - new Date(b.measured_at).getTime());
  const baseline = sortedHistory[0] ?? null;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        patient_id: patientId,
        measure_code: def.code,
        side: bilat ? side : 'bilateral',
        // measurement.value is NOT NULL even for pass/fail rows, where the
        // real signal lives in `pass` — store a 1/0 sentinel mirroring it.
        value: def.unit === 'pass_fail' ? (pass ? 1 : 0) : liveValue,
        pass: def.unit === 'pass_fail' ? pass : null,
        attempts: isGoniometric ? attemptNums.filter((v): v is number => v !== null) : null,
        governing_source: def.unit === 'pass_fail' ? null : isGoniometric ? gov : 'single',
        pain,
        end_feel: endFeel || null,
        swelling: swelling || null,
        note: note || null,
        visit_id: visitId,
      };
      // The panel prefills secondaryDeg/comp from the stored row on open
      // (ROM_MEASUREMENT.md §5 rule 2), so "untouched" already means "send
      // the same value back" — an intentional clear is the only way these
      // end up empty, and that's the one case that should overwrite (§5
      // rule 1 is about a field the clinician never saw, not one they saw
      // and cleared).
      if (def.flags.deg_opt) {
        body.value_secondary = secondaryDeg === '' ? null : Number(secondaryDeg);
      }
      if (def.unit === 'pass_fail') {
        body.compensations = Object.keys(comp).filter(k => comp[k]);
      }
      const path = editingId ? `measurements/measurements/${editingId}` : `measurements/patients/${patientId}/measurements`;
      const { data, error } = await supabase.functions.invoke(path, {
        method: editingId ? 'PATCH' : 'POST',
        body,
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patient-measurements', patientId] });
      onSaved(def.code);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.functions.invoke(`measurements/measurements/${id}`, {
        method: 'DELETE',
        body: { patient_id: patientId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['patient-measurements', patientId] }),
  });

  const canSave = def.unit === 'pass_fail' ? pass !== null : liveValue !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={def.name_he}
      style={{ position: 'fixed', inset: 0, background: 'rgba(27,33,64,.42)', zIndex: 'var(--z-modal)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 780, maxWidth: '100%', maxHeight: '100%', overflow: 'auto', background: 'var(--shell-sidebar-bg)', borderRadius: 18, boxShadow: '0 24px 60px rgba(0,0,0,.24)', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '20px 24px', borderBottom: '1px solid var(--shell-border)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19, color: 'var(--ink)', letterSpacing: '-0.01em' }}>{def.name_he}</div>
              {def.protocol_tip && (
                <span title={def.protocol_tip} style={{ width: 18, height: 18, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--placeholder)', borderRadius: '50%', fontSize: 11, color: 'var(--gold-deep)', cursor: 'help' }}>
                  i
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)', marginTop: 3 }}>
              {[def.name_en, patientName, bilat ? (side === 'involved' ? 'מודד: צד פגוע' : 'מודד: צד בריא') : null].filter(Boolean).join(' · ')}
            </div>
          </div>
          {bilat && (
            <div style={{ display: 'flex', gap: 6 }}>
              {(['involved', 'healthy'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  style={s === side
                    ? { padding: '6px 14px', borderRadius: 'var(--radius-pill)', background: 'var(--gold-deep)', color: 'var(--cream)', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }
                    : { padding: '6px 14px', borderRadius: 'var(--radius-pill)', background: 'transparent', color: 'var(--nav-inactive-text)', fontSize: 12, fontWeight: 500, border: '1px solid rgba(34,28,20,0.18)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                >
                  {s === 'involved' ? 'צד פגוע' : 'צד בריא'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, padding: '22px 24px' }}>
          {/* Left column */}
          <div
            aria-disabled={readOnly}
            style={{ display: 'flex', flexDirection: 'column', gap: 16, pointerEvents: readOnly ? 'none' : 'auto', opacity: readOnly ? 0.55 : 1 }}
          >
            <div style={{ background: 'var(--shell-content-bg)', border: '1px solid var(--shell-border)', borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              {def.unit === 'pass_fail' ? (
                <>
                  <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                    <Button variant={pass === true ? 'primary' : 'secondary'} onClick={() => setPass(true)} style={{ flex: 1 }}>עובר</Button>
                    <Button variant={pass === false ? 'danger' : 'secondary'} onClick={() => setPass(false)} style={{ flex: 1 }}>לא עובר</Button>
                  </div>
                  {compensationOptions.length > 0 && (
                    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 7, marginTop: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>פיצויים שנצפו</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {compensationOptions.map((o) => (
                          <button key={o.key} onClick={() => setComp((c) => ({ ...c, [o.key]: !c[o.key] }))} style={chipBtnStyle(!!comp[o.key])}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : def.unit === 'cm' ? (
                <>
                  <Ruler def={def} value={liveValue} healthyValue={healthyValue} previousValue={previousValue} flag={flag} />
                  <Legend def={def} healthyValue={healthyValue} side={side} />
                </>
              ) : (
                <>
                  <ArcGauge def={def} value={liveValue} healthyValue={healthyValue} previousValue={previousValue} flag={flag} />
                  <Legend def={def} healthyValue={healthyValue} side={side} />
                </>
              )}

              <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, fontWeight: 700, color: flagColor(flag), marginTop: 6 }}>
                {def.unit === 'pass_fail'
                  ? (pass === null ? '—' : pass ? 'עובר' : 'לא עובר')
                  : liveValue === null ? '—' : `${liveValue}${unitSuffix}`}
              </div>
              <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>{govSourceLabel}</div>
              {def.unit === 'cm' && gapCm !== null && (
                <div style={{ fontSize: 11, fontWeight: 600, color: flagColor(gap) }}>פער צדדים {gapCm} ס״מ</div>
              )}
              {def.scale > 0 && def.unit !== 'pass_fail' && (
                <div style={{ fontSize: 10, color: 'var(--gold-deep)' }}>סקאלה 0–{def.scale}{unitSuffix}</div>
              )}
            </div>

            {isGoniometric ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>שלושה ניסיונות · בחר את הערך הקובע</div>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      onClick={() => { setGov('attempt_n'); setAttemptIndex(i); }}
                      style={radioMarkStyle(gov === 'attempt_n' && attemptIndex === i)}
                    >
                      {gov === 'attempt_n' && attemptIndex === i ? '✓' : ''}
                    </button>
                    <span style={{ fontSize: 12, color: 'var(--nav-inactive-text)', width: 58 }}>ניסיון {i + 1}</span>
                    <input
                      value={attempts[i]}
                      inputMode="numeric"
                      onChange={(e) => {
                        const next = [...attempts] as [string, string, string];
                        next[i] = e.target.value;
                        setAttempts(next);
                      }}
                      placeholder="—"
                      style={{ flex: 1, boxSizing: 'border-box', background: 'var(--white)', border: '1px solid var(--shell-border)', borderRadius: 9, padding: '9px 11px', fontSize: 15, fontWeight: 600, color: 'var(--ink)', fontFamily: 'inherit' }}
                    />
                    <span style={{ fontSize: 13, color: 'var(--nav-inactive-text)' }}>°</span>
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
                  <button onClick={() => setGov('avg')} style={radioMarkStyle(gov === 'avg')}>{gov === 'avg' ? '✓' : ''}</button>
                  <span style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>ממוצע</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{avgOfAttempts != null ? `${avgOfAttempts}°` : '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={() => setGov('best')} style={radioMarkStyle(gov === 'best')}>{gov === 'best' ? '✓' : ''}</button>
                  <span style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>הטוב ביותר</span>
                </div>
              </div>
            ) : def.unit !== 'pass_fail' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>ערך המדידה</div>
                  <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>{unitSuffix === '°' ? '°' : 'ס״מ'}</div>
                </div>
                <div style={{ background: 'var(--white)', border: '1px solid var(--shell-border)', borderRadius: 11, padding: '12px 14px', fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 700, color: 'var(--ink)', textAlign: 'center', minHeight: 34 }}>
                  {singleVal || ' '}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7 }}>
                  {KEYPAD_KEYS.map((k) => (
                    <button key={k} onClick={() => pressKey(k)} style={keypadKeyStyle(k === '⌫')}>{k}</button>
                  ))}
                </div>
                {def.flags.deg_opt && (
                  <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>
                    זווית טיביה · אופציונלי (אינקלינומטר)
                    <input
                      value={secondaryDeg}
                      onChange={(e) => setSecondaryDeg(e.target.value)}
                      inputMode="decimal"
                      placeholder="למשל 38"
                      style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, background: 'var(--white)', border: '1px solid var(--shell-border)', borderRadius: 9, padding: '9px 11px', fontSize: 14, fontWeight: 600, color: 'var(--ink)', fontFamily: 'inherit' }}
                    />
                  </label>
                )}
              </div>
            ) : null}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--shell-border)', paddingTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>מדידות קודמות</div>
                {editingId && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gold-deep)', background: 'var(--nav-active-bg)', padding: '3px 8px', borderRadius: 'var(--radius-pill)' }}>מצב עריכה</span>}
              </div>
              {entry.history.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>אין עדיין מדידות לתנועה זו</div>
              ) : (
                entry.history.map((h) => (
                  <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: `1px solid ${editingId === h.id ? 'var(--gold-deep)' : 'var(--shell-border-soft)'}`, borderRadius: 9, background: 'var(--white)' }}>
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--ink-soft)' }}>
                      {new Date(h.measured_at).toLocaleDateString('he-IL')} · {h.side === 'involved' ? 'פגוע' : h.side === 'healthy' ? 'בריא' : 'דו-צדדי'} ·{' '}
                      {rowSummary(def, h.value, h.side === 'involved' ? entry.healthy?.value ?? null : null, h.value_secondary, h.pass, h.compensations)}
                      {h.visit_id && <span style={{ color: 'var(--nav-inactive-text)' }}> · נמדד במפגש</span>}
                    </span>
                    <button
                      onClick={() => {
                        setEditingId(h.id);
                        setSide(h.side === 'healthy' ? 'healthy' : 'involved');
                        setAttempts(h.attempts ? [String(h.attempts[0] ?? ''), String(h.attempts[1] ?? ''), String(h.attempts[2] ?? '')] : ['', '', '']);
                        setGov((h.governing_source as GoverningSource) ?? 'best');
                        setAttemptIndex(0);
                        setSingleVal(String(h.value));
                        setSecondaryDeg(h.value_secondary != null ? String(h.value_secondary) : '');
                        setPass(h.pass);
                        setComp(h.compensations ? Object.fromEntries(h.compensations.map((c) => [c, true])) : {});
                        setPain(h.pain);
                        setEndFeel(h.end_feel ?? '');
                        setSwelling(h.swelling ?? '');
                        setNote(h.note ?? '');
                      }}
                      style={{ background: 'transparent', border: '1px solid rgba(140,100,35,0.45)', color: 'var(--gold-deep)', borderRadius: 'var(--radius-pill)', padding: '4px 10px', fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      ערוך
                    </button>
                    <button
                      onClick={() => deleteMutation.mutate(h.id)}
                      disabled={deleteMutation.isPending}
                      style={{ background: 'transparent', border: '1px solid rgba(158,59,46,0.4)', color: 'var(--flag-red)', borderRadius: 'var(--radius-pill)', padding: '4px 10px', fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      מחק
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: 'var(--shell-content-bg)', border: '1px solid var(--shell-border)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>ייחוס · Reference</div>
              {bilat && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-soft)' }}>
                  <span>צד בריא</span>
                  <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{entry.healthy ? `${entry.healthy.value}${unitSuffix}` : '—'}</span>
                </div>
              )}
              {def.norm != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-soft)' }}>
                  <span>{`נורמה (${def.norm_source ?? 'AAOS'})`}</span>
                  <span style={{ fontWeight: 600 }}>{def.norm}{unitSuffix}</span>
                </div>
              )}
              {def.flags.deg_opt && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-soft)' }}>
                  <span>זווית שוקה</span>
                  <span style={{ fontWeight: 600 }}>{currentRow?.value_secondary != null ? `${currentRow.value_secondary}°` : '—'}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-soft)' }}>
                <span>מדידת בסיס</span>
                <span style={{ fontWeight: 600 }}>{baseline ? `${baseline.value}${def.unit === 'cm' ? ' ס״מ' : def.unit === 'deg' ? '°' : ''}` : '—'}</span>
              </div>
              {def.target != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-soft)', borderTop: '1px solid var(--shell-border)', paddingTop: 8 }}>
                  <span>יעד לקריטריון השלב</span>
                  <span style={{ fontWeight: 700, color: 'var(--gold-deep)' }}>{def.target}{unitSuffix}</span>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>כאב בקצה הטווח</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                  <button key={n} onClick={() => setPain(n)} style={{ ...chipBtnStyle(pain === n), minWidth: 28, padding: '6px 0' }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>תחושת קצה</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {END_FEEL_OPTIONS.map((o) => (
                    <button key={o.value} onClick={() => setEndFeel((v) => (v === o.value ? '' : o.value))} style={chipBtnStyle(endFeel === o.value)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>נפיחות</div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {SWELLING_OPTIONS.map((o) => (
                    <button key={o.value} onClick={() => setSwelling((v) => (v === o.value ? '' : o.value))} style={chipBtnStyle(swelling === o.value)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--nav-inactive-text)' }}>
              הערה
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="מה הגביל את התנועה"
                style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, background: 'var(--white)', border: '1px solid var(--shell-border)', borderRadius: 9, padding: '9px 11px', fontSize: 12, color: 'var(--ink)', fontFamily: 'inherit', resize: 'none' }}
              />
            </label>

            {editingId && <Badge tone="neutral">עריכת מדידה קיימת · תישמר כרשומה חדשה</Badge>}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '16px 24px', borderTop: '1px solid var(--shell-border)', background: 'var(--shell-content-bg)', borderRadius: '0 0 18px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--nav-inactive-text)' }}>
            {readOnly ? 'תצוגה בלבד במסך זה — הקלטת מדידה זמינה במסך רחב יותר' : 'המדידה הקודמת נשמרת בהיסטוריה ולא נמחקת'}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={{ background: 'transparent', color: 'var(--ink-soft)', border: '1px solid rgba(34,28,20,0.24)', borderRadius: 'var(--radius-pill)', padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              {readOnly ? 'סגור' : 'ביטול'}
            </button>
            {!readOnly && (
              <Button onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending} loading={saveMutation.isPending}>
                שמור מדידה
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function chipBtnStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 'var(--radius-pill)',
    border: active ? 'none' : '1px solid rgba(34,28,20,0.18)',
    background: active ? 'var(--gold-deep)' : 'var(--white)',
    color: active ? 'var(--cream)' : 'var(--ink-soft)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function radioMarkStyle(active: boolean): CSSProperties {
  return {
    width: 18,
    height: 18,
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    border: active ? 'none' : '1.5px solid var(--placeholder)',
    background: active ? 'var(--gold-deep)' : 'transparent',
    color: 'var(--cream)',
    fontSize: 10,
    cursor: 'pointer',
    padding: 0,
  };
}

function keypadKeyStyle(isDelete: boolean): CSSProperties {
  return {
    padding: '10px 0',
    borderRadius: 9,
    border: '1px solid var(--shell-border)',
    background: 'var(--white)',
    color: isDelete ? 'var(--flag-red)' : 'var(--ink)',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}
