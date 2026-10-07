import { useContext, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, useToast } from 'ui';
import {
  addDays,
  clinicDate,
  formatLocalDate,
  formatTime,
  hhmm,
  minutesOf,
  t,
  weekdayOf,
  windowsOn,
  zonedTimeToUtc,
  type AppointmentType,
  type I18nKey,
  type WeeklyHoursRule,
} from 'shared';
import { SupabaseContext } from '../../App';
import { SchedulingError, useClinicianSlots, useCreateAppointment } from '../../lib/scheduling';
import { DialogFrame } from './BottomSheet';
import { ConflictList } from './ConflictList';
import { Segmented, TypeSwatch, fieldStyle, labelStyle } from './calendarUi';

interface PatientOption {
  id: string;
  name: string;
  injury?: string;
}

interface Props {
  onClose: () => void;
  tz: string;
  types: AppointmentType[];
  rules: WeeklyHoursRule[];
  /** a time picked on the calendar (grid cell, free gap); null → suggest one */
  initial: { date: string; minutes: number } | null;
  /** the day in view — the date field's fallback */
  defaultDate: string;
  /** phone: a bottom sheet instead of a modal */
  sheet?: boolean;
  /** phone: the "block time" side of the FAB's sheet */
  onSwitchToBlock?: () => void;
}

const SUGGEST_DAYS = 14;

export default function NewAppointmentModal({ onClose, tz, types, rules, initial, defaultDate, sheet = false, onSwitchToBlock }: Props) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const create = useCreateAppointment();
  const activeTypes = useMemo(() => types.filter((ty) => ty.active), [types]);

  // Mounted per opening (see Calendar), so the form starts from the props
  // once and a background refetch can't wipe what's being typed.
  const firstType = activeTypes.find((ty) => ty.who_may_book !== 'anyone') ?? activeTypes[0];
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [typeId, setTypeId] = useState(firstType?.id ?? '');
  const [date, setDate] = useState(initial?.date ?? defaultDate);
  const [time, setTime] = useState(initial ? hhmm(initial.minutes) : '');
  const [duration, setDuration] = useState(firstType?.duration_min ?? 45);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<SchedulingError | null>(null);
  // A time chosen by hand (or handed in from the calendar) is never replaced
  // by a suggestion; until then the earliest free start is preselected.
  const [chosen, setChosen] = useState(!!initial);
  const [manual, setManual] = useState(!!initial);

  const today = clinicDate(new Date(), tz);
  const slots = useClinicianSlots(typeId || null, today, addDays(today, SUGGEST_DAYS - 1));
  const suggestions = (slots.data ?? []).slice(0, sheet ? 6 : 8);

  useEffect(() => {
    if (chosen || !slots.data) return;
    const first = slots.data[0];
    if (first) {
      setDate(clinicDate(first, tz));
      setTime(formatTime(first, tz));
    } else {
      setManual(true);
    }
  }, [slots.data, chosen, tz]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const { data: results, isFetching } = useQuery({
    queryKey: ['patients', 'search', debounced],
    enabled: debounced.length >= 1 && !patient,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`patients?filter=all&q=${encodeURIComponent(debounced)}`, { method: 'GET' });
      if (error) throw error;
      return (data as PatientOption[]).slice(0, 8);
    },
  });

  const start = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(minutesOf(time)) ? zonedTimeToUtc(date, time, tz) : null;
  const outsideHours = start ? !windowsOn(rules, date).some((w) => minutesOf(time) >= w.start && minutesOf(time) + duration <= w.end) : false;
  const valid = !!patient && !!typeId && !!start;

  function dayWord(d: string): string {
    if (d === today) return t('sched.mobile.today');
    if (d === addDays(today, 1)) return t('sched.mobile.tomorrow');
    if (d < addDays(today, 7)) return t(`sched.weekday.${weekdayOf(d)}` as I18nKey);
    return `${Number(d.slice(8))}.${Number(d.slice(5, 7))}`;
  }

  async function submit() {
    if (!valid || !patient || !start) return;
    setError(null);
    try {
      const res = await create.mutateAsync({
        patient_id: patient.id,
        type_id: typeId,
        starts_at: start.toISOString(),
        duration_min: duration,
        note: note.trim() || undefined,
        notify,
      });
      toast.show(t('sched.appt.toast.created'), { tone: 'success' });
      if (res.emailed) toast.show(t('sched.appt.toast.emailed'));
      onClose();
    } catch (e) {
      setError(e instanceof SchedulingError ? e : new SchedulingError('internal_error'));
    }
  }

  const submitLabel = start && sheet ? `${t('sched.appt.create')} · ${dayWord(date)} ${time}` : t('sched.appt.create');

  return (
    <DialogFrame
      sheet={sheet}
      open
      onClose={onClose}
      title={onSwitchToBlock ? t('sched.mobile.new_or_block') : t('sched.appt.new')}
      footer={
        sheet ? (
          <Button onClick={submit} disabled={!valid} loading={create.isPending} size="lg" style={{ width: '100%' }}>
            {submitLabel}
          </Button>
        ) : (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-start' }}>
            <Button onClick={submit} disabled={!valid} loading={create.isPending}>
              {submitLabel}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('sched.book.back')}
            </Button>
          </div>
        )
      }
    >
      {activeTypes.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14 }}>{t('sched.appt.no_types')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {onSwitchToBlock && (
            <Segmented
              label={t('sched.mobile.new_or_block')}
              options={[
                { value: 'appt', label: t('sched.appt.new') },
                { value: 'off', label: t('sched.cal.block') },
              ]}
              value="appt"
              onChange={(v) => v === 'off' && onSwitchToBlock()}
            />
          )}

          <div style={labelStyle}>
            <label htmlFor="appt-patient">{t('sched.appt.patient')}</label>
            {patient ? (
              <div style={{ ...fieldStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: sheet ? 46 : undefined }}>
                <strong>{patient.name}</strong>
                <button
                  type="button"
                  onClick={() => setPatient(null)}
                  aria-label={t('sched.appt.patient_search')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16, padding: 0, minWidth: 32, minHeight: 32 }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <>
                <input
                  id="appt-patient"
                  type="search"
                  autoFocus={!sheet}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('sched.appt.patient_search')}
                  autoComplete="off"
                  style={{ ...fieldStyle, height: sheet ? 46 : undefined, fontSize: sheet ? 16 : 14 }}
                />
                {debounced && (
                  <ul role="listbox" aria-label={t('sched.appt.patient')} style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--line)', borderRadius: 'var(--radius-button)', maxHeight: 220, overflowY: 'auto' }}>
                    {(results ?? []).map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          onClick={() => setPatient(p)}
                          style={{ width: '100%', minHeight: sheet ? 48 : undefined, textAlign: 'start', background: 'var(--white)', border: 'none', borderBottom: '1px solid var(--line-soft)', padding: '9px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}
                        >
                          <strong>{p.name}</strong>
                          {p.injury ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {p.injury}</span> : null}
                        </button>
                      </li>
                    ))}
                    {!isFetching && results?.length === 0 && (
                      <li style={{ padding: '9px 12px', fontSize: 13, color: 'var(--muted)' }}>{t('sched.appt.patient_none')}</li>
                    )}
                  </ul>
                )}
              </>
            )}
          </div>

          <div role="radiogroup" aria-label={t('sched.appt.type')} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {activeTypes.map((ty) => (
              <button
                key={ty.id}
                type="button"
                role="radio"
                aria-checked={ty.id === typeId}
                onClick={() => {
                  setTypeId(ty.id);
                  setDuration(ty.duration_min);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 12px',
                  height: sheet ? 38 : 32,
                  borderRadius: 'var(--radius-pill)',
                  border: ty.id === typeId ? '1.5px solid var(--navy)' : '1px solid var(--line-input)',
                  background: ty.id === typeId ? 'var(--nav-active-bg)' : 'var(--white)',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: ty.id === typeId ? 700 : 500,
                  color: 'var(--ink)',
                  cursor: 'pointer',
                }}
              >
                <TypeSwatch color={ty.color} /> {ty.name} · {t('sched.minutes', { n: ty.duration_min })}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{t('sched.mobile.suggested')}</span>
              {!manual && (
                <button type="button" onClick={() => setManual(true)} style={linkButton}>
                  {t('sched.mobile.other_time')}
                </button>
              )}
            </div>
            {slots.isLoading ? (
              <div aria-busy="true" style={{ height: sheet ? 56 : 44, borderRadius: 12, background: 'var(--line-soft)' }} />
            ) : suggestions.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>{t('sched.mobile.no_suggestions')}</p>
            ) : (
              <div role="radiogroup" aria-label={t('sched.mobile.suggested')} style={{ display: 'grid', gridTemplateColumns: `repeat(${sheet ? 3 : 4}, minmax(0, 1fr))`, gap: 8 }}>
                {suggestions.map((iso) => {
                  const on = !!start && start.getTime() === Date.parse(iso);
                  const d = clinicDate(iso, tz);
                  return (
                    <button
                      key={iso}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={`${formatLocalDate(d, 'long')} ${formatTime(iso, tz)}`}
                      onClick={() => {
                        setDate(d);
                        setTime(formatTime(iso, tz));
                        setChosen(true);
                      }}
                      style={slotStyle(on, sheet)}
                    >
                      <span style={{ fontSize: 11.5 }}>{dayWord(d)}</span>
                      <span style={{ fontSize: sheet ? 16 : 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{formatTime(iso, tz)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {manual && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <label style={labelStyle}>
                {t('sched.appt.date')}
                <input
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setChosen(true);
                  }}
                  style={fieldStyle}
                />
              </label>
              <label style={labelStyle}>
                {t('sched.appt.time')}
                <input
                  type="time"
                  step={300}
                  value={time}
                  onChange={(e) => {
                    setTime(e.target.value);
                    setChosen(true);
                  }}
                  style={fieldStyle}
                />
              </label>
              <label style={labelStyle}>
                {t('sched.appt.duration')}
                <input
                  type="number"
                  min={5}
                  max={480}
                  step={5}
                  value={duration}
                  onChange={(e) => setDuration(Math.max(5, Math.min(480, Number(e.target.value) || 5)))}
                  style={fieldStyle}
                />
              </label>
            </div>
          )}
          {outsideHours && <div style={{ fontSize: 12, color: 'var(--gold-deep)' }}>{t('sched.appt.outside_hours')}</div>}

          <label style={labelStyle}>
            {t('sched.appt.note')}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} style={{ ...fieldStyle, resize: 'vertical' }} />
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{t('sched.appt.note_hint')}</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minHeight: sheet ? 32 : undefined }}>
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={sheet ? { width: 18, height: 18 } : undefined} />
            {t('sched.appt.notify')}
          </label>

          {error &&
            (error.code === 'conflict' && error.conflicts ? (
              <ConflictList conflicts={error.conflicts} tz={tz} />
            ) : (
              <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
                {t('error.save.body')}
              </div>
            ))}
        </div>
      )}
    </DialogFrame>
  );
}

function slotStyle(on: boolean, sheet: boolean): CSSProperties {
  return {
    height: sheet ? 56 : 48,
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    cursor: 'pointer',
    fontFamily: 'inherit',
    ...(on
      ? { border: '1.5px solid var(--navy)', background: 'var(--navy)', color: 'var(--cream)' }
      : { border: '1px solid var(--line-input)', background: 'var(--white)', color: 'var(--navy)' }),
  };
}

const linkButton: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: '4px 0',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--gold-deep)',
};
