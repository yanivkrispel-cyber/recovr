import { useContext, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, useToast } from 'ui';
import {
  addDays,
  clinicDate,
  formatLocalDate,
  formatMonthTitle,
  formatTime,
  hhmm,
  isValidEmail,
  minutesOf,
  normalizePhone,
  t,
  weekStart,
  weekdayOf,
  windowsOn,
  zonedTimeToUtc,
  type AppointmentType,
  type I18nKey,
  type WeeklyHoursRule,
} from 'shared';
import { SupabaseContext } from '../../App';
import { SchedulingError, useClinicianSlots, useContactMatches, useCreateAppointment } from '../../lib/scheduling';
import { DialogFrame } from './BottomSheet';
import { ConflictList } from './ConflictList';
import { Chevron, DateField, Segmented, TimeField, TypeSwatch, fieldStyle, labelStyle } from './calendarUi';

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
  /** the day in view — where the day picker opens */
  defaultDate: string;
  /** phone: a bottom sheet instead of a modal */
  sheet?: boolean;
  /** phone: the "block time" side of the FAB's sheet */
  onSwitchToBlock?: () => void;
}

const DURATIONS = [15, 20, 30, 45, 60, 75, 90, 120];

export default function NewAppointmentModal({ onClose, tz, types, rules, initial, defaultDate, sheet = false, onSwitchToBlock }: Props) {
  const supabase = useContext(SupabaseContext);
  const toast = useToast();
  const create = useCreateAppointment();
  const activeTypes = useMemo(() => types.filter((ty) => ty.active), [types]);
  const today = clinicDate(new Date(), tz);
  const firstDay = initial?.date ?? (defaultDate < today ? today : defaultDate);

  // Mounted per opening (see Calendar), so the form starts from the props
  // once and a background refetch can't wipe what's being typed.
  const firstType = activeTypes.find((ty) => ty.who_may_book !== 'anyone') ?? activeTypes[0];
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [patient, setPatient] = useState<PatientOption | null>(null);
  // Someone without a card yet: booked by name + phone, shown as a new patient.
  const [contact, setContact] = useState<{ name: string; phone: string; email: string } | null>(null);
  const [contactKey, setContactKey] = useState({ phone: '', email: '' });
  const [typeId, setTypeId] = useState(firstType?.id ?? '');
  const [date, setDate] = useState(firstDay);
  const [time, setTime] = useState(initial ? hhmm(initial.minutes) : '');
  const [week, setWeek] = useState(() => weekStart(firstDay));
  const [duration, setDuration] = useState(firstType?.duration_min ?? 45);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [notify, setNotify] = useState(true);
  const [otherTime, setOtherTime] = useState(false);
  const [error, setError] = useState<SchedulingError | null>(null);
  // A day or time picked by hand (or handed in from the calendar) stays put;
  // until then the earliest free start from the day in view (two weeks on)
  // is preselected.
  const [chosen, setChosen] = useState(!!initial);

  const nearest = useClinicianSlots(chosen ? null : typeId || null, firstDay, addDays(firstDay, 13));
  useEffect(() => {
    if (chosen || !nearest.data?.length) return;
    const first = nearest.data[0];
    const day = clinicDate(first, tz);
    setDate(day);
    setTime(formatTime(first, tz));
    setWeek(weekStart(day));
  }, [nearest.data, chosen, tz]);

  // Free starts of the week on screen, per day.
  const weekSlots = useClinicianSlots(typeId || null, week, addDays(week, 6));
  const freeByDay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const iso of weekSlots.data ?? []) {
      const day = clinicDate(iso, tz);
      map.set(day, [...(map.get(day) ?? []), formatTime(iso, tz)]);
    }
    return map;
  }, [weekSlots.data, tz]);
  // The chosen day's free starts, plus a time picked another way (a gap off
  // the slot grid, "other time") so the choice stays visible.
  const dayTimes = useMemo(() => {
    const list = freeByDay.get(date) ?? [];
    return time && !list.includes(time) ? [...list, time].sort() : list;
  }, [freeByDay, date, time]);

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

  const contactPhone = contact ? normalizePhone(contact.phone) : null;
  const contactEmail = contact ? contact.email.trim() : '';
  const contactEmailOk = !contactEmail || isValidEmail(contactEmail);
  const contactValid = !!contact && contact.name.trim().length >= 2 && !!contactPhone && contactEmailOk;
  useEffect(() => {
    const id = setTimeout(() => setContactKey({ phone: contactPhone ?? '', email: contactEmail && contactEmailOk ? contactEmail : '' }), 400);
    return () => clearTimeout(id);
  }, [contactPhone, contactEmail, contactEmailOk]);
  const matches = useContactMatches(contactKey.phone, contactKey.email, !!contact && !!(contactKey.phone || contactKey.email));
  const canEmail = !!patient || (!!contactEmail && contactEmailOk);

  function startContact(seed: string) {
    const s = seed.trim();
    const looksLikePhone = /^[+\d][\d\s-]{6,}$/.test(s);
    setContact({ name: looksLikePhone ? '' : s, phone: looksLikePhone ? s : '', email: '' });
    setQuery('');
    setDebounced('');
  }

  const start = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(minutesOf(time)) ? zonedTimeToUtc(date, time, tz) : null;
  const outsideHours = start ? !windowsOn(rules, date).some((w) => minutesOf(time) >= w.start && minutesOf(time) + duration <= w.end) : false;
  const valid = (!!patient || contactValid) && !!typeId && !!start;
  const thisWeek = weekStart(today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const durations = [...new Set([...DURATIONS, duration])].sort((x, y) => x - y);

  function dayLabel(day: string): string {
    if (day === today) return t('sched.mobile.today');
    if (day === addDays(today, 1)) return t('sched.mobile.tomorrow');
    return t('sched.appt.day_label', { wd: t(`sched.weekday_short.${weekdayOf(day)}` as I18nKey), date: `${Number(day.slice(8))}.${Number(day.slice(5, 7))}` });
  }

  function pickDay(day: string) {
    if (day !== date) {
      setDate(day);
      setTime('');
    }
    setChosen(true);
  }

  async function submit() {
    if (!valid || !start) return;
    setError(null);
    try {
      const res = await create.mutateAsync({
        ...(patient
          ? { patient_id: patient.id }
          : { lead: { name: contact!.name.trim(), phone: contactPhone!, email: contactEmail || undefined } }),
        type_id: typeId,
        starts_at: start.toISOString(),
        duration_min: duration,
        note: note.trim() || undefined,
        notify: notify && canEmail,
      });
      toast.show(t('sched.appt.toast.created'), { tone: 'success' });
      if (res.emailed) toast.show(t('sched.appt.toast.emailed'));
      onClose();
    } catch (e) {
      setError(e instanceof SchedulingError ? e : new SchedulingError('internal_error'));
    }
  }

  const submitLabel = start ? `${t('sched.appt.create')} · ${dayLabel(date)} · ${time}` : t('sched.appt.pick_time');
  const notifyBox = canEmail ? (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink)', minHeight: 28 }}>
      <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 18, height: 18, margin: 0 }} />
      {t('sched.appt.notify')}
    </label>
  ) : contact ? (
    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{t('sched.contact.no_email')}</span>
  ) : null;

  return (
    <DialogFrame
      sheet={sheet}
      open
      onClose={onClose}
      title={t('sched.appt.new')}
      header={
        onSwitchToBlock && (
          <Segmented
            label={t('sched.mobile.new_or_block')}
            options={[
              { value: 'appt', label: t('sched.appt.new') },
              { value: 'off', label: t('sched.cal.block') },
            ]}
            value="appt"
            onChange={(v) => v === 'off' && onSwitchToBlock()}
          />
        )
      }
      footer={
        sheet ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {notifyBox}
            <Button onClick={submit} disabled={!valid} loading={create.isPending} size="lg" style={{ width: '100%' }}>
              {submitLabel}
            </Button>
          </div>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={labelStyle}>
            {contact ? <span>{t('sched.appt.patient')}</span> : <label htmlFor="appt-patient">{t('sched.appt.patient')}</label>}
            {contact ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12, border: '1.5px dashed var(--gold-deep)', background: 'var(--white)', fontWeight: 400 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 14, color: 'var(--navy)' }}>{t('sched.contact.new')}</strong>
                  <button type="button" onClick={() => setContact(null)} style={{ ...linkButton, alignSelf: 'auto' }}>
                    {t('sched.contact.back')}
                  </button>
                </div>
                <input
                  aria-label={t('sched.contact.name')}
                  placeholder={t('sched.contact.name')}
                  value={contact.name}
                  onChange={(e) => setContact({ ...contact, name: e.target.value })}
                  autoComplete="off"
                  maxLength={80}
                  style={{ ...fieldStyle, minHeight: 44 }}
                />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                  <input
                    type="tel"
                    inputMode="tel"
                    dir="ltr"
                    aria-label={t('sched.contact.phone')}
                    placeholder={t('sched.contact.phone')}
                    value={contact.phone}
                    onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                    aria-invalid={!!contact.phone.trim() && !contactPhone}
                    autoComplete="off"
                    style={{ ...fieldStyle, minHeight: 44, textAlign: 'end' }}
                  />
                  <input
                    type="email"
                    inputMode="email"
                    dir="ltr"
                    aria-label={t('sched.contact.email')}
                    placeholder={t('sched.contact.email')}
                    value={contact.email}
                    onChange={(e) => setContact({ ...contact, email: e.target.value })}
                    aria-invalid={!contactEmailOk}
                    autoComplete="off"
                    style={{ ...fieldStyle, minHeight: 44, textAlign: 'end' }}
                  />
                </div>
                {!!matches.data?.length && (
                  <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 10, background: 'var(--warn-bg)' }}>
                    <span style={{ fontSize: 12.5, color: 'var(--gold-deep)', fontWeight: 700 }}>{t('sched.contact.matches')}</span>
                    {matches.data.map((m) => (
                      <Button
                        key={m.id}
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setPatient({ id: m.id, name: m.name });
                          setContact(null);
                        }}
                      >
                        {t('sched.contact.use_card', { name: m.name })}
                      </Button>
                    ))}
                  </div>
                )}
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('sched.contact.hint')}</span>
              </div>
            ) : patient ? (
              <div style={{ ...fieldStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 }}>
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
                  style={{ ...fieldStyle, minHeight: 44 }}
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
                          style={{ width: '100%', minHeight: 44, textAlign: 'start', background: 'var(--white)', border: 'none', borderBottom: '1px solid var(--line-soft)', padding: '9px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}
                        >
                          <strong>{p.name}</strong>
                          {p.injury ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {p.injury}</span> : null}
                        </button>
                      </li>
                    ))}
                    {!isFetching && results?.length === 0 && (
                      <li style={{ padding: '9px 12px', fontSize: 13, color: 'var(--muted)' }}>{t('sched.appt.patient_none')}</li>
                    )}
                    <li>
                      <button
                        type="button"
                        onClick={() => startContact(debounced)}
                        style={{ width: '100%', minHeight: 44, textAlign: 'start', background: 'var(--warn-bg)', border: 'none', padding: '9px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 700, color: 'var(--gold-deep)' }}
                      >
                        {t('sched.contact.cta_named', { name: debounced })}
                      </button>
                    </li>
                  </ul>
                )}
                {!debounced && (
                  <button type="button" onClick={() => startContact('')} style={linkButton}>
                    {t('sched.contact.cta')}
                  </button>
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
                  height: 38,
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

          {/* When: a week of days (a dot = free time that day), then that day's free starts. */}
          <section aria-label={t('sched.appt.date')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ flex: 1, fontSize: 15, fontWeight: 800, color: 'var(--navy)' }}>{formatMonthTitle(addDays(week, 3))}</span>
              <button
                type="button"
                aria-label={t('sched.cal.prev_week')}
                disabled={week <= thisWeek}
                onClick={() => setWeek(addDays(week, -7))}
                style={{ ...navButton, opacity: week <= thisWeek ? 0.35 : 1, cursor: week <= thisWeek ? 'default' : 'pointer' }}
              >
                <Chevron dir="prev" />
              </button>
              <button type="button" aria-label={t('sched.cal.next_week')} onClick={() => setWeek(addDays(week, 7))} style={navButton}>
                <Chevron dir="next" />
              </button>
              <DateField
                variant="icon"
                label={t('sched.appt.date')}
                value={date}
                onChange={(day) => {
                  pickDay(day);
                  setWeek(weekStart(day));
                }}
              />
            </div>
            <div role="radiogroup" aria-label={t('sched.appt.date')} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
              {days.map((day) => {
                const free = freeByDay.get(day)?.length ?? 0;
                const on = day === date;
                const past = day < today;
                return (
                  <button
                    key={day}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={past}
                    aria-label={`${formatLocalDate(day, 'long')}${free ? ` · ${t('sched.appt.free_n', { n: free })}` : ''}`}
                    onClick={() => pickDay(day)}
                    style={dayChip(on, free > 0, day === today, past)}
                  >
                    <span style={{ fontSize: 11 }}>{t(`sched.weekday_short.${weekdayOf(day)}` as I18nKey)}</span>
                    <span style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{Number(day.slice(8))}</span>
                    <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: free ? (on ? 'var(--gold)' : 'var(--flag-green)') : 'transparent' }} />
                  </button>
                );
              })}
            </div>
          </section>

          <section aria-label={t('sched.appt.time')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{t('sched.appt.free_times', { day: dayLabel(date) })}</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--muted)', flex: 'none' }}>
                {t('sched.appt.duration')}
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={{ ...fieldStyle, width: 'auto', padding: '5px 8px', fontSize: 13, cursor: 'pointer' }}>
                  {durations.map((m) => (
                    <option key={m} value={m}>
                      {t('sched.minutes', { n: m })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {weekSlots.isLoading ? (
              <div aria-busy="true" style={{ height: 44, borderRadius: 10, background: 'var(--line-soft)' }} />
            ) : dayTimes.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('sched.appt.no_free_day')}</p>
            ) : (
              <div role="radiogroup" aria-label={t('sched.appt.free_times', { day: dayLabel(date) })} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: 6 }}>
                {dayTimes.map((tm) => (
                  <button
                    key={tm}
                    type="button"
                    role="radio"
                    aria-checked={tm === time}
                    onClick={() => {
                      setTime(tm);
                      setChosen(true);
                    }}
                    style={timeChip(tm === time)}
                  >
                    {tm}
                  </button>
                ))}
              </div>
            )}
            {otherTime || dayTimes.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--ink)' }}>
                {t('sched.appt.other_time')}
                <TimeField
                  value={time}
                  onChange={(v) => {
                    setTime(v);
                    setChosen(true);
                  }}
                  label={t('sched.appt.other_time')}
                />
              </div>
            ) : (
              <button type="button" onClick={() => setOtherTime(true)} style={linkButton}>
                {t('sched.appt.other_time')}
              </button>
            )}
            {outsideHours && <div style={{ fontSize: 12, color: 'var(--gold-deep)' }}>{t('sched.appt.outside_hours')}</div>}
          </section>

          {noteOpen || note ? (
            <label style={labelStyle}>
              {t('sched.appt.note')}
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} autoFocus={noteOpen && !note} style={{ ...fieldStyle, resize: 'vertical' }} />
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{t('sched.appt.note_hint')}</span>
            </label>
          ) : (
            <button type="button" onClick={() => setNoteOpen(true)} style={linkButton}>
              + {t('sched.appt.note')}
            </button>
          )}

          {!sheet && notifyBox}

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

function dayChip(on: boolean, free: boolean, isToday: boolean, past: boolean): CSSProperties {
  return {
    height: 60,
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    padding: 0,
    fontFamily: 'inherit',
    cursor: past ? 'default' : 'pointer',
    ...(on
      ? { border: '1.5px solid var(--navy)', background: 'var(--navy)', color: 'var(--cream)' }
      : {
          border: isToday ? '1.5px solid var(--danger)' : '1px solid var(--line-input)',
          background: 'var(--white)',
          color: free ? 'var(--navy)' : 'var(--muted-2)',
          opacity: past ? 0.4 : free ? 1 : 0.75,
        }),
  };
}

function timeChip(on: boolean): CSSProperties {
  return {
    height: 42,
    borderRadius: 10,
    fontFamily: 'inherit',
    fontSize: 15,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    ...(on
      ? { border: '1.5px solid var(--navy)', background: 'var(--navy)', color: 'var(--cream)' }
      : { border: '1px solid var(--line-input)', background: 'var(--white)', color: 'var(--navy)' }),
  };
}

const navButton: CSSProperties = {
  width: 36,
  height: 36,
  border: 'none',
  background: 'transparent',
  color: 'var(--navy)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};

const linkButton: CSSProperties = {
  alignSelf: 'flex-start',
  border: 'none',
  background: 'none',
  padding: '4px 0',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--gold-deep)',
};
