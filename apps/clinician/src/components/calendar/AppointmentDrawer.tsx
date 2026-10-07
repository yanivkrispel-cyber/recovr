import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button, Drawer, useToast } from 'ui';
import {
  canTransition,
  clinicDate,
  formatDayLong,
  formatTime,
  minutesOf,
  t,
  windowsOn,
  zonedTimeToUtc,
  type AppointmentStatus,
  type AppointmentType,
  type CalendarAppointment,
  type I18nKey,
  type WeeklyHoursRule,
} from 'shared';
import { SchedulingError, useLinkRequest, useUpdateAppointment, type AppointmentPatch } from '../../lib/scheduling';
import { AddPatientModal, type PatientPrefill } from '../../pages/PatientList';
import { ConflictList } from './ConflictList';
import { StatusPill, TypeSwatch, fieldStyle, isLead, labelStyle, personName } from './calendarUi';

interface Props {
  appointment: CalendarAppointment | null;
  tz: string;
  types: AppointmentType[];
  rules: WeeklyHoursRule[];
  /** desktop: move, retype, annotate; below 1024px the drawer is status-only */
  editable: boolean;
  onClose: () => void;
}

const DURATIONS = [15, 20, 30, 45, 60, 75, 90, 120];

export default function AppointmentDrawer({ appointment, tz, types, rules, editable, onClose }: Props) {
  return (
    <Drawer open={!!appointment} onClose={onClose} title={appointment ? personName(appointment) : ''} width="440px">
      {appointment && (
        <DrawerBody key={appointment.id + appointment.status + appointment.starts_at} a={appointment} tz={tz} types={types} rules={rules} editable={editable} onClose={onClose} />
      )}
    </Drawer>
  );
}

function DrawerBody({ a, tz, types, rules, editable, onClose }: { a: CalendarAppointment; tz: string; types: AppointmentType[]; rules: WeeklyHoursRule[]; editable: boolean; onClose: () => void }) {
  const toast = useToast();
  const update = useUpdateAppointment();
  const link = useLinkRequest();
  const [notify, setNotify] = useState(true);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<null | 'cancelled' | 'declined'>(null);
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState(clinicDate(a.starts_at, tz));
  const [time, setTime] = useState(formatTime(a.starts_at, tz));
  const [duration, setDuration] = useState(Math.round((Date.parse(a.ends_at) - Date.parse(a.starts_at)) / 60_000));
  const [typeId, setTypeId] = useState(a.type.id);
  const [note, setNote] = useState(a.note ?? '');
  // A snapshot, not the live lead: once the card is created the appointment
  // refetches as the patient's, and the wizard must stay up for its result
  // screen (invite link).
  const [cardPrefill, setCardPrefill] = useState<PatientPrefill | null>(null);
  const cardCreated = useRef(false);
  const queryClient = useQueryClient();
  const [error, setError] = useState<SchedulingError | null>(null);

  useEffect(() => setError(null), [date, time, duration]);

  const lead = isLead(a) ? a.lead : null;
  const hasEmail = !!(a.lead?.email || a.patient);

  async function run(patch: AppointmentPatch, success: I18nKey) {
    setError(null);
    try {
      const res = await update.mutateAsync({ id: a.id, patch: { ...patch, notify } });
      toast.show(t(success), { tone: 'success' });
      if (res.emailed === true) toast.show(t('sched.appt.toast.emailed'));
      if (res.emailed === false && hasEmail) toast.show(t('sched.appt.toast.email_failed'), { tone: 'error' });
      setConfirming(null);
      setMoving(false);
      if (patch.status && patch.status !== 'confirmed') onClose();
    } catch (e) {
      setError(e instanceof SchedulingError ? e : new SchedulingError('internal_error'));
    }
  }

  const can = (to: AppointmentStatus) => canTransition(a.status, to);
  const busy = update.isPending;

  const newStart = (() => {
    const m = minutesOf(time);
    return Number.isNaN(m) || !/^\d{4}-\d{2}-\d{2}$/.test(date) ? null : zonedTimeToUtc(date, time, tz);
  })();
  const outsideHours = (() => {
    if (!newStart) return false;
    const m = minutesOf(time);
    return !windowsOn(rules, date).some((w) => m >= w.start && m + duration <= w.end);
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 24px 28px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <StatusPill status={a.status} />
        {lead && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gold-deep)' }}>{t('sched.lead')}</span>}
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t(`sched.source.${a.source}` as I18nKey)}</span>
        {a.cancelled_by && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>· {t(`sched.cancelled_by.${a.cancelled_by}` as I18nKey)}</span>
        )}
      </div>

      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: 14 }}>
        <Term>{t('sched.appt.date')}</Term>
        <dd style={{ margin: 0, fontWeight: 600 }}>
          {formatDayLong(a.starts_at, tz)} · {formatTime(a.starts_at, tz)}–{formatTime(a.ends_at, tz)}
        </dd>
        <Term>{t('sched.appt.type')}</Term>
        <dd style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <TypeSwatch color={a.type.color} /> {a.type.name}
        </dd>
        {a.clinical?.phase_n != null && (
          <>
            <Term>{t('sched.appt.rehab')}</Term>
            <dd style={{ margin: 0 }}>
              {a.clinical.phase_name ?? t('sched.cal.phase', { n: a.clinical.phase_n })}
              {a.clinical.adherence != null && (
                <span style={{ color: a.clinical.low_adherence ? 'var(--flag-red)' : 'var(--flag-green)', fontWeight: 700 }}>
                  {' · '}
                  {t('sched.cal.adherence', { n: a.clinical.adherence })}
                </span>
              )}
            </dd>
          </>
        )}
        {a.cancel_reason && (a.status === 'cancelled' || a.status === 'declined') && (
          <>
            <Term>{t('sched.appt.cancel_reason')}</Term>
            <dd style={{ margin: 0 }}>{a.cancel_reason}</dd>
          </>
        )}
      </dl>

      {a.patient && (
        <Link to="/patients/$patientId" params={{ patientId: a.patient.id }} style={{ fontSize: 14, fontWeight: 600, color: 'var(--gold-deep)' }}>
          {t('sched.appt.open_patient')} ←
        </Link>
      )}

      {lead && (
        <Section title={t('sched.appt.lead_contact')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
            <a href={`tel:${lead.phone}`} dir="ltr" style={{ color: 'var(--ink)', textAlign: 'start' }}>{lead.phone}</a>
            <a href={`mailto:${lead.email}`} dir="ltr" style={{ color: 'var(--ink)', textAlign: 'start' }}>{lead.email}</a>
            {lead.body_region && (
              <span>
                {t('sched.appt.lead_region')}: {lead.body_region.name}
              </span>
            )}
          </div>
          {(a.matches ?? []).map((m) => (
            <Button
              key={m.id}
              variant="secondary"
              size="sm"
              disabled={link.isPending}
              onClick={async () => {
                await link.mutateAsync({ requestId: lead.request_id, patientId: m.id });
                toast.show(t('sched.appt.toast.linked'), { tone: 'success' });
                onClose();
              }}
            >
              {t('sched.appt.link_existing', { name: m.name })}
            </Button>
          ))}
          {editable && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCardPrefill({ name: lead.name, email: lead.email, phone: lead.phone, bookingRequestId: lead.request_id })}
              >
                {t('sched.appt.open_card')}
              </Button>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('sched.appt.open_card_hint')}</span>
            </div>
          )}
        </Section>
      )}

      {/* Status actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {a.status === 'pending' && (
          <>
            <Button onClick={() => run({ status: 'confirmed' }, 'sched.appt.toast.approved')} loading={busy}>
              {t('sched.appt.approve')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming('declined')} disabled={busy}>
              {t('sched.appt.decline')}
            </Button>
          </>
        )}
        {a.status === 'confirmed' && (
          <>
            {Date.parse(a.starts_at) <= Date.now() + 60 * 60_000 && (
              <>
                <Button variant="secondary" onClick={() => run({ status: 'attended' }, 'sched.appt.toast.saved')} loading={busy}>
                  ✓ {t('sched.appt.attended')}
                </Button>
                <Button variant="secondary" onClick={() => run({ status: 'no_show' }, 'sched.appt.toast.saved')} disabled={busy}>
                  {t('sched.appt.no_show')}
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={() => setConfirming('cancelled')} disabled={busy} style={{ color: 'var(--danger)' }}>
              {t('sched.appt.cancel')}
            </Button>
          </>
        )}
        {(a.status === 'attended' || a.status === 'no_show') && can('confirmed') && (
          <Button variant="secondary" onClick={() => run({ status: 'confirmed' }, 'sched.appt.toast.saved')} loading={busy}>
            {t('sched.appt.undo_mark')}
          </Button>
        )}
        {(a.status === 'cancelled' || a.status === 'declined') && Date.parse(a.starts_at) > Date.now() && editable && (
          <Button variant="secondary" onClick={() => run({ status: 'confirmed' }, 'sched.appt.toast.saved')} loading={busy}>
            {t('sched.appt.restore')}
          </Button>
        )}
        {editable && (a.status === 'pending' || a.status === 'confirmed') && !moving && (
          <Button variant="ghost" onClick={() => setMoving(true)} disabled={busy}>
            {t('sched.appt.move')}
          </Button>
        )}
      </div>

      {confirming && (
        <Section title={confirming === 'declined' ? t('sched.appt.decline') : t('sched.appt.cancel')}>
          <label style={labelStyle}>
            {t('sched.appt.cancel_reason')}
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} style={fieldStyle} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                run(
                  { status: confirming, cancel_reason: reason || undefined },
                  confirming === 'declined' ? 'sched.appt.toast.declined' : 'sched.appt.toast.cancelled',
                )
              }
            >
              {confirming === 'declined' ? t('sched.appt.decline') : t('sched.appt.cancel')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t('sched.book.back')}
            </Button>
          </div>
        </Section>
      )}

      {moving && (
        <Section title={t('sched.appt.move')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
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
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={fieldStyle}>
                {[...new Set([...DURATIONS, duration])].sort((x, y) => x - y).map((d) => (
                  <option key={d} value={d}>{t('sched.minutes', { n: d })}</option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              {t('sched.appt.type')}
              <select value={typeId} onChange={(e) => setTypeId(e.target.value)} style={fieldStyle}>
                {types.filter((ty) => ty.active || ty.id === a.type.id).map((ty) => (
                  <option key={ty.id} value={ty.id}>{ty.name}</option>
                ))}
              </select>
            </label>
          </div>
          {outsideHours && <div style={{ fontSize: 12, color: 'var(--gold-deep)' }}>{t('sched.appt.outside_hours')}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              loading={busy}
              disabled={!newStart}
              onClick={() =>
                newStart &&
                run(
                  {
                    starts_at: newStart.toISOString(),
                    duration_min: duration,
                    type_id: typeId !== a.type.id ? typeId : undefined,
                    status: a.status === 'pending' ? 'confirmed' : undefined,
                  },
                  a.status === 'pending' ? 'sched.appt.toast.approved' : 'sched.appt.toast.saved',
                )
              }
            >
              {a.status === 'pending' ? `${t('sched.appt.move')} + ${t('sched.appt.approve')}` : t('sched.appt.save')}
            </Button>
            <Button variant="ghost" onClick={() => setMoving(false)}>
              {t('sched.book.back')}
            </Button>
          </div>
        </Section>
      )}

      {(confirming || moving || a.status === 'pending') && hasEmail && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink)' }}>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          {t('sched.appt.notify')}
        </label>
      )}

      {error && <ErrorBox error={error} tz={tz} />}

      {editable && (
        <Section title={t('sched.appt.note')}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            style={{ ...fieldStyle, resize: 'vertical' }}
            aria-describedby="appt-note-hint"
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span id="appt-note-hint" style={{ fontSize: 12, color: 'var(--muted)' }}>{t('sched.appt.note_hint')}</span>
            {note !== (a.note ?? '') && (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => run({ note: note || null, notify: false }, 'sched.appt.toast.saved')}>
                {t('sched.appt.save')}
              </Button>
            )}
          </div>
        </Section>
      )}

      {cardPrefill && (
        <AddPatientModal
          open
          onClose={() => {
            setCardPrefill(null);
            if (cardCreated.current) onClose();
          }}
          onCreated={() => {
            cardCreated.current = true;
            void queryClient.invalidateQueries({ queryKey: ['scheduling'] });
            void queryClient.invalidateQueries({ queryKey: ['patients'] });
          }}
          prefill={cardPrefill}
        />
      )}
    </div>
  );
}

function Term({ children }: { children: ReactNode }) {
  return <dt style={{ color: 'var(--muted)', fontSize: 13 }}>{children}</dt>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{title}</h3>
      {children}
    </section>
  );
}

function ErrorBox({ error, tz }: { error: SchedulingError; tz: string }) {
  if (error.code === 'conflict' && error.conflicts) {
    return <ConflictList conflicts={error.conflicts} tz={tz} />;
  }
  return (
    <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
      {error.code === 'invalid_transition' ? t('error.conflict.title') : t('error.save.body')}
    </div>
  );
}
