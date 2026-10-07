import { useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Modal, useToast } from 'ui';
import { hhmm, minutesOf, t, windowsOn, zonedTimeToUtc, type AppointmentType, type WeeklyHoursRule } from 'shared';
import { SupabaseContext } from '../../App';
import { SchedulingError, useCreateAppointment } from '../../lib/scheduling';
import { ConflictList } from './ConflictList';
import { TypeSwatch, fieldStyle, labelStyle } from './calendarUi';

interface PatientOption {
  id: string;
  name: string;
  injury?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  tz: string;
  types: AppointmentType[];
  rules: WeeklyHoursRule[];
  /** prefilled from the grid cell that was clicked */
  initial: { date: string; minutes: number } | null;
}

export default function NewAppointmentModal({ open, onClose, tz, types, rules, initial }: Props) {
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
  const [date, setDate] = useState(initial?.date ?? '');
  const [time, setTime] = useState(initial ? hhmm(initial.minutes) : '');
  const [duration, setDuration] = useState(firstType?.duration_min ?? 45);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<SchedulingError | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const { data: results, isFetching } = useQuery({
    queryKey: ['patients', 'search', debounced],
    enabled: open && debounced.length >= 1 && !patient,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(`patients?filter=all&q=${encodeURIComponent(debounced)}`, { method: 'GET' });
      if (error) throw error;
      return (data as PatientOption[]).slice(0, 8);
    },
  });

  const start = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(minutesOf(time)) ? zonedTimeToUtc(date, time, tz) : null;
  const outsideHours = start ? !windowsOn(rules, date).some((w) => minutesOf(time) >= w.start && minutesOf(time) + duration <= w.end) : false;
  const valid = !!patient && !!typeId && !!start;

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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('sched.appt.new')}
      size="sm"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-start' }}>
          <Button onClick={submit} disabled={!valid} loading={create.isPending}>
            {t('sched.appt.create')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('sched.book.back')}
          </Button>
        </div>
      }
    >
      {activeTypes.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14 }}>{t('sched.appt.no_types')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={labelStyle}>
            <label htmlFor="appt-patient">{t('sched.appt.patient')}</label>
            {patient ? (
              <div style={{ ...fieldStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{patient.name}</strong>
                <button
                  type="button"
                  onClick={() => setPatient(null)}
                  aria-label={t('sched.appt.patient_search')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16, padding: 0 }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <>
                <input
                  id="appt-patient"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('sched.appt.patient_search')}
                  autoComplete="off"
                  style={fieldStyle}
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
                          style={{ width: '100%', textAlign: 'start', background: 'var(--white)', border: 'none', borderBottom: '1px solid var(--line-soft)', padding: '9px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}
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
                  padding: '7px 12px',
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <label style={labelStyle}>
              {t('sched.appt.date')}
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fieldStyle} />
            </label>
            <label style={labelStyle}>
              {t('sched.appt.time')}
              <input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} style={fieldStyle} />
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
          {outsideHours && <div style={{ fontSize: 12, color: 'var(--gold-deep)' }}>{t('sched.appt.outside_hours')}</div>}

          <label style={labelStyle}>
            {t('sched.appt.note')}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} style={{ ...fieldStyle, resize: 'vertical' }} />
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{t('sched.appt.note_hint')}</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
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
    </Modal>
  );
}
