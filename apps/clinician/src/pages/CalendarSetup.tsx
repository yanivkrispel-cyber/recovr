import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Modal, QueryError, Skeleton, Toggle, useToast } from 'ui';
import {
  BUFFER_OPTIONS,
  FREE_CANCEL_OPTIONS,
  HORIZON_OPTIONS,
  MIN_NOTICE_OPTIONS,
  REMINDER_FIRST_OPTIONS,
  REMINDER_SECOND_OPTIONS,
  SLOT_STEP_OPTIONS,
  TYPE_COLORS,
  formatILS,
  isValidSlug,
  suggestSlug,
  t,
  validateWeeklyHours,
  type AppointmentType,
  type Confirmation,
  type I18nKey,
  type SchedulingSetup,
  type WeeklyHoursRule,
  type WhoMayBook,
} from 'shared';
import { AuthContext } from '../App';
import AppShell from '../components/AppShell';
import { TYPE_STYLE, TimeField, TypeSwatch, fieldStyle, labelStyle, panelStyle, weekdayLabel } from '../components/calendar/calendarUi';
import {
  SchedulingError,
  useSaveAppointmentType,
  useSaveAvailability,
  useSchedulingSetup,
  useUpdateSchedulingSettings,
} from '../lib/scheduling';

export default function CalendarSetup() {
  const { user } = useContext(AuthContext);
  const setup = useSchedulingSetup();
  if (!user) return null;

  return (
    <AppShell user={user}>
      <div style={{ maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <Link to="/calendar" style={{ fontSize: 13, color: 'var(--gold-deep)' }}>
            → {t('sched.setup.back')}
          </Link>
          <h1 style={{ margin: '6px 0 0', fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>
            {t('sched.setup.title')}
          </h1>
        </div>

        {setup.error ? (
          <QueryError title={t('error.generic.title')} body={t('error.generic.body')} retryLabel={t('error.generic.action')} onRetry={() => setup.refetch()} />
        ) : !setup.data ? (
          <Skeleton count={4} height={160} radius={14} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))', gap: 18, alignItems: 'start' }}>
            <WeeklyHours setup={setup.data} />
            <Types setup={setup.data} />
            <BookingRules setup={setup.data} />
            <PublicPage setup={setup.data} />
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Card({ title, hint, children, wide }: { title: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section style={{ ...panelStyle, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, gridColumn: wide ? '1 / -1' : undefined }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--ink)' }}>{title}</h2>
        {hint && <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--nav-inactive-text)', lineHeight: 1.5 }}>{hint}</p>}
      </div>
      {children}
    </section>
  );
}

// --- weekly hours -------------------------------------------------------------

type Week = Record<number, { start_time: string; end_time: string }[]>;

function toWeek(rules: WeeklyHoursRule[]): Week {
  const w: Week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const r of rules) w[r.weekday].push({ start_time: r.start_time, end_time: r.end_time });
  for (const d of Object.keys(w)) w[Number(d)].sort((a, b) => a.start_time.localeCompare(b.start_time));
  return w;
}

function fromWeek(w: Week): WeeklyHoursRule[] {
  return Object.entries(w).flatMap(([d, list]) => list.map((x) => ({ weekday: Number(d), ...x })));
}

function WeeklyHours({ setup }: { setup: SchedulingSetup }) {
  const toast = useToast();
  const save = useSaveAvailability();
  const saved = useMemo(() => toWeek(setup.availability.filter((r) => r.practitioner_id === setup.me)), [setup]);
  const [week, setWeek] = useState<Week>(saved);
  useEffect(() => setWeek(saved), [saved]);

  const rules = fromWeek(week);
  const problem = validateWeeklyHours(rules);
  const dirty = JSON.stringify(rules) !== JSON.stringify(fromWeek(saved));

  const setDay = (d: number, list: Week[number]) => setWeek((w) => ({ ...w, [d]: list }));

  return (
    <Card title={t('sched.setup.hours.title')} hint={t('sched.setup.hours.hint')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[0, 1, 2, 3, 4, 5, 6].map((d) => {
          const list = week[d];
          return (
            <div key={d} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 10, alignItems: 'start', borderBottom: '1px solid var(--line-soft)', paddingBottom: 8 }}>
              <strong style={{ fontSize: 14, paddingTop: 8, color: 'var(--ink)' }}>{weekdayLabel(d)}</strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {list.length === 0 && <span style={{ fontSize: 13, color: 'var(--muted-2)', paddingInlineEnd: 6 }}>{t('sched.setup.hours.closed')}</span>}
                {list.map((win, i) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--white)', border: '1px solid var(--line-input)', borderRadius: 'var(--radius-button)', padding: '3px 6px' }}>
                    <TimeField
                      bare
                      value={win.start_time}
                      label={`${weekdayLabel(d)} — ${t('sched.off.from')}`}
                      onChange={(v) => setDay(d, list.map((x, j) => (j === i ? { ...x, start_time: v } : x)))}
                    />
                    –
                    <TimeField
                      bare
                      value={win.end_time}
                      label={`${weekdayLabel(d)} — ${t('sched.off.to')}`}
                      onChange={(v) => setDay(d, list.map((x, j) => (j === i ? { ...x, end_time: v } : x)))}
                    />
                    <button
                      type="button"
                      onClick={() => setDay(d, list.filter((_, j) => j !== i))}
                      aria-label={t('sched.setup.hours.remove')}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 14, padding: '0 2px' }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const last = list[list.length - 1];
                    const next = last ? { start_time: last.end_time < '20:00' ? addHour(last.end_time) : '17:00', end_time: last.end_time < '20:00' ? addHour(addHour(last.end_time)) : '19:00' } : { start_time: '09:00', end_time: '17:00' };
                    setDay(d, [...list, next]);
                  }}
                  style={{ border: '1px dashed var(--line-input)', background: 'transparent', borderRadius: 'var(--radius-button)', padding: '6px 10px', fontSize: 13, color: 'var(--nav-inactive-text)', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  {t('sched.setup.hours.add')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {problem && (
        <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
          {t(problem === 'overlap' ? 'sched.setup.hours.overlap' : 'sched.setup.hours.invalid')}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button
          disabled={!dirty || !!problem}
          loading={save.isPending}
          onClick={async () => {
            try {
              await save.mutateAsync({ rules });
              toast.show(t('sched.setup.saved'), { tone: 'success' });
            } catch {
              toast.show(t('error.save.body'), { tone: 'error' });
            }
          }}
        >
          {t('sched.setup.hours.save')}
        </Button>
        <Button variant="ghost" onClick={() => setWeek((w) => ({ ...w, 1: [...w[0]], 2: [...w[0]], 3: [...w[0]], 4: [...w[0]] }))} disabled={week[0].length === 0}>
          {t('sched.setup.hours.copy')}
        </Button>
      </div>
    </Card>
  );
}

function addHour(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}


// --- appointment types -----------------------------------------------------------

function Types({ setup }: { setup: SchedulingSetup }) {
  const save = useSaveAppointmentType();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<AppointmentType> | null>(null);

  return (
    <Card title={t('sched.setup.types.title')} hint={t('sched.setup.types.hint')}>
      {setup.types.length === 0 && <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)' }}>{t('sched.setup.types.empty')}</p>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {setup.types.map((ty) => (
          <li
            key={ty.id}
            style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--white)', border: '1px solid var(--line-soft)', borderRadius: 'var(--radius-card)', padding: '10px 12px', opacity: ty.active ? 1 : 0.6 }}
          >
            <TypeSwatch color={ty.color} size={14} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>
                {ty.name} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {t('sched.minutes', { n: ty.duration_min })}</span>
                {!ty.active && <span style={{ fontSize: 12, color: 'var(--muted)' }}> · {t('sched.setup.types.archived')}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                {t(`sched.who.${ty.who_may_book}` as I18nKey)} · {t(`sched.confirm.${ty.confirmation}` as I18nKey)}
                {ty.price_ils != null ? ` · ${formatILS(ty.price_ils)}` : ''}
                {ty.price_label ? ` · ${ty.price_label}` : ''}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(ty)}>
              {t('sched.setup.types.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={save.isPending && save.variables?.id === ty.id}
              onClick={async () => {
                try {
                  await save.mutateAsync({ id: ty.id, active: !ty.active });
                } catch {
                  toast.show(t('error.save.body'), { tone: 'error' });
                }
              }}
            >
              {ty.active ? t('sched.setup.types.archive') : t('sched.setup.types.unarchive')}
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button variant="secondary" onClick={() => setEditing({ duration_min: 45, color: 'gold', who_may_book: 'existing', confirmation: 'auto' })}>
          {t('sched.setup.types.add')}
        </Button>
      </div>
      {editing && <TypeEditor initial={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TypeEditor({ initial, onClose }: { initial: Partial<AppointmentType>; onClose: () => void }) {
  const save = useSaveAppointmentType();
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<AppointmentType>>(initial);
  const [price, setPrice] = useState(initial.price_ils != null ? String(initial.price_ils) : '');
  const set = <K extends keyof AppointmentType>(k: K, v: AppointmentType[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const priceValue = price.trim() === '' ? null : Number(price);
  const priceValid = priceValue === null || (Number.isFinite(priceValue) && priceValue >= 0 && priceValue <= 100000);
  const valid = !!draft.name?.trim() && !!draft.duration_min && draft.duration_min >= 5 && draft.duration_min <= 480 && priceValid;

  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id ? initial.name ?? '' : t('sched.setup.types.add')}
      size="sm"
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            disabled={!valid}
            loading={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({
                  id: draft.id,
                  name: draft.name?.trim(),
                  duration_min: draft.duration_min,
                  price_ils: priceValue,
                  price_label: draft.price_label?.trim() || null,
                  description: draft.description ?? null,
                  color: draft.color,
                  who_may_book: draft.who_may_book,
                  confirmation: draft.confirmation,
                });
                toast.show(t('sched.setup.saved'), { tone: 'success' });
                onClose();
              } catch {
                toast.show(t('error.save.body'), { tone: 'error' });
              }
            }}
          >
            {t('sched.setup.types.save')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('sched.book.back')}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <label style={labelStyle}>
            {t('sched.setup.types.name')}
            <input value={draft.name ?? ''} onChange={(e) => set('name', e.target.value)} maxLength={60} style={fieldStyle} autoFocus />
          </label>
          <label style={labelStyle}>
            {t('sched.setup.types.duration')}
            <input type="number" min={5} max={480} step={5} value={draft.duration_min ?? ''} onChange={(e) => set('duration_min', Number(e.target.value))} style={fieldStyle} />
          </label>
        </div>
        <label style={labelStyle}>
          {t('sched.setup.types.price_ils')}
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={100000}
            step={10}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-invalid={!priceValid}
            style={{ ...fieldStyle, maxWidth: 160 }}
          />
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{t('sched.setup.types.price_ils_hint')}</span>
        </label>
        <label style={labelStyle}>
          {t('sched.setup.types.price')}
          <input value={draft.price_label ?? ''} onChange={(e) => set('price_label', e.target.value)} maxLength={40} style={fieldStyle} />
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{t('sched.setup.types.price_hint')}</span>
        </label>
        <label style={labelStyle}>
          {t('sched.setup.types.description')}
          <input value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} maxLength={200} style={fieldStyle} />
        </label>
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>{t('sched.setup.types.color')}</legend>
          <div style={{ display: 'flex', gap: 8 }}>
            {TYPE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={draft.color === c}
                aria-label={t(`sched.color.${c}` as I18nKey)}
                onClick={() => set('color', c)}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: '50%',
                  cursor: 'pointer',
                  background: TYPE_STYLE[c].background,
                  border: draft.color === c ? '3px solid var(--navy)' : `2px solid ${TYPE_STYLE[c].accent}`,
                }}
              />
            ))}
          </div>
        </fieldset>
        <Choice<WhoMayBook>
          legend={t('sched.setup.types.who')}
          value={draft.who_may_book ?? 'existing'}
          options={['anyone', 'existing', 'clinician_only']}
          label={(v) => t(`sched.who.${v}` as I18nKey)}
          onChange={(v) => set('who_may_book', v)}
        />
        <Choice<Confirmation>
          legend={t('sched.setup.types.confirmation')}
          value={draft.confirmation ?? 'auto'}
          options={['auto', 'manual']}
          label={(v) => t(`sched.confirm.${v}` as I18nKey)}
          onChange={(v) => set('confirmation', v)}
        />
      </div>
    </Modal>
  );
}

const fieldsetStyle = { border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 } as const;
const legendStyle = { fontSize: 13, fontWeight: 600, color: 'var(--ink)', padding: 0, marginBottom: 6 } as const;

function Choice<T extends string>({ legend, value, options, label, onChange }: { legend: string; value: T; options: T[]; label: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>{legend}</legend>
      {options.map((o) => (
        <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--ink)' }}>
          <input type="radio" checked={value === o} onChange={() => onChange(o)} />
          {label(o)}
        </label>
      ))}
    </fieldset>
  );
}

// --- booking rules ------------------------------------------------------------------

function BookingRules({ setup }: { setup: SchedulingSetup }) {
  const update = useUpdateSchedulingSettings();
  const toast = useToast();
  const s = setup.settings;

  const field = (
    key: 'slot_step_min' | 'buffer_min' | 'min_notice_min' | 'horizon_days' | 'free_cancel_hours' | 'reminder_first_h' | 'reminder_second_h',
    labelKey: I18nKey,
    options: readonly number[],
    fmt: (n: number) => string,
  ) => (
    <label style={labelStyle}>
      {t(labelKey)}
      <select
        value={s[key]}
        disabled={update.isPending}
        onChange={async (e) => {
          try {
            await update.mutateAsync({ [key]: Number(e.target.value) });
            toast.show(t('sched.setup.saved'), { tone: 'success' });
          } catch {
            toast.show(t('error.save.body'), { tone: 'error' });
          }
        }}
        style={fieldStyle}
      >
        {[...new Set([...options, s[key]])].sort((a, b) => a - b).map((n) => (
          <option key={n} value={n}>{fmt(n)}</option>
        ))}
      </select>
    </label>
  );

  const reminderLabel = (n: number) =>
    n === 0
      ? t('sched.none')
      : n === 1
        ? t('sched.setup.rules.reminder_1h')
        : n === 2
          ? t('sched.setup.rules.reminder_2h')
          : t('sched.setup.rules.reminder_value', { n });

  const duration = (min: number) =>
    min === 0 ? t('sched.none') : min % 1440 === 0 ? t('sched.days', { n: min / 1440 }) : min % 60 === 0 ? t('sched.hours', { n: min / 60 }) : t('sched.minutes', { n: min });

  return (
    <Card title={t('sched.setup.rules.title')} hint={t('sched.setup.rules.hint')}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        {field('slot_step_min', 'sched.setup.rules.step', SLOT_STEP_OPTIONS, (n) => t('sched.minutes', { n }))}
        {field('buffer_min', 'sched.setup.rules.buffer', BUFFER_OPTIONS, (n) => (n === 0 ? t('sched.none') : t('sched.minutes', { n })))}
        {field('min_notice_min', 'sched.setup.rules.notice', MIN_NOTICE_OPTIONS, (n) => (n === 0 ? t('sched.none') : t('sched.setup.rules.notice_value', { n: duration(n) })))}
        {field('horizon_days', 'sched.setup.rules.horizon', HORIZON_OPTIONS, (n) => t('sched.setup.rules.horizon_value', { n }))}
        {field('free_cancel_hours', 'sched.setup.rules.free_cancel', FREE_CANCEL_OPTIONS, (n) => (n === 0 ? t('sched.none') : t('sched.setup.rules.free_cancel_value', { n })))}
        {field('reminder_first_h', 'sched.setup.rules.reminder_first', REMINDER_FIRST_OPTIONS, reminderLabel)}
        {field('reminder_second_h', 'sched.setup.rules.reminder_second', REMINDER_SECOND_OPTIONS, reminderLabel)}
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>{t('sched.setup.rules.reminder_hint')}</p>
    </Card>
  );
}

// --- public page ---------------------------------------------------------------------

function PublicPage({ setup }: { setup: SchedulingSetup }) {
  const update = useUpdateSchedulingSettings();
  const toast = useToast();
  const s = setup.settings;
  const [slug, setSlug] = useState(setup.booking_slug ?? suggestSlug(setup.clinic_name));
  const [address, setAddress] = useState(s.contact_address);
  const [phone, setPhone] = useState(s.contact_phone);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAddress(s.contact_address);
    setPhone(s.contact_phone);
  }, [s.contact_address, s.contact_phone]);

  const slugOk = isValidSlug(slug);
  const dirty = slug !== (setup.booking_slug ?? '') || address !== s.contact_address || phone !== s.contact_phone;
  const publicTypes = setup.types.filter((ty) => ty.active && ty.who_may_book === 'anyone');
  const practitionerId = s.practitioner_id ?? setup.me;
  const hasHours = setup.availability.some((r) => r.practitioner_id === practitionerId);

  async function save(patch: Parameters<typeof update.mutateAsync>[0]) {
    setError(null);
    try {
      await update.mutateAsync(patch);
      toast.show(t('sched.setup.saved'), { tone: 'success' });
    } catch (e) {
      const code = e instanceof SchedulingError ? e.code : '';
      setError(
        code === 'slug_taken'
          ? t('sched.setup.error.slug_taken')
          : code === 'slug_required'
            ? t('sched.setup.error.slug_required')
            : code === 'validation_failed'
              ? t('sched.setup.error.slug_invalid')
              : t('error.save.body'),
      );
    }
  }

  return (
    <Card title={t('sched.setup.public.title')} hint={t('sched.setup.public.hint')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Toggle
          checked={s.booking_enabled}
          onChange={(on: boolean) => save(on ? { booking_enabled: true, booking_slug: slug || null } : { booking_enabled: false })}
          label={t('sched.setup.public.enabled')}
        />
      </div>

      <label style={labelStyle}>
        {t('sched.setup.public.slug')}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, direction: 'ltr' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>/m/book/</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={40} style={{ ...fieldStyle, direction: 'ltr' }} aria-invalid={!!slug && !slugOk} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 400, color: slug && !slugOk ? 'var(--danger)' : 'var(--muted)' }}>{t('sched.setup.public.slug_hint')}</span>
      </label>
      <label style={labelStyle}>
        {t('sched.setup.public.address')}
        <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        {t('sched.setup.public.phone')}
        <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} dir="ltr" style={{ ...fieldStyle, textAlign: 'right' }} />
      </label>
      {setup.practitioners.length > 1 && (
        <label style={labelStyle}>
          {t('sched.setup.public.practitioner')}
          <select value={practitionerId} onChange={(e) => save({ practitioner_id: e.target.value })} style={fieldStyle}>
            {setup.practitioners.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      )}

      <div>
        <Button
          disabled={!dirty || (!!slug && !slugOk)}
          loading={update.isPending}
          onClick={() => save({ booking_slug: slug || null, contact_address: address, contact_phone: phone })}
        >
          {t('sched.setup.save')}
        </Button>
      </div>

      {error && <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>}

      {s.booking_enabled && setup.booking_url && (
        <div style={{ background: 'var(--white)', border: '1px solid var(--line-soft)', borderRadius: 'var(--radius-card)', padding: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span dir="ltr" style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {setup.booking_url}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(setup.booking_url ?? '');
              toast.show(t('toast.copied'));
            }}
          >
            {t('sched.setup.public.copy')}
          </Button>
          <a href={setup.booking_url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, color: 'var(--gold-deep)' }}>
            {t('sched.setup.public.open')} ↗
          </a>
        </div>
      )}
      {s.booking_enabled && publicTypes.length === 0 && <Warn>{t('sched.setup.public.no_types')}</Warn>}
      {s.booking_enabled && !hasHours && <Warn>{t('sched.setup.public.no_hours')}</Warn>}
    </Card>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 'var(--radius-card)', padding: '8px 12px', fontSize: 13, color: 'var(--ink)' }}>
      {children}
    </div>
  );
}
