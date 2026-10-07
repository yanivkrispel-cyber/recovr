import { Button, Skeleton, useToast } from 'ui';
import { formatDayShort, formatTime, t, type CalendarAppointment } from 'shared';
import { useBookingRequests, useUpdateAppointment } from '../../lib/scheduling';
import { Pill, isLead, panelStyle, personName } from './calendarUi';

/** Pending booking requests (website + patients' apps), oldest decision first.
 *  `bare`: no panel chrome or heading — inside the phone's requests sheet. */
export default function RequestsPanel({ tz, onOpen, bare = false }: { tz: string; onOpen: (a: CalendarAppointment) => void; bare?: boolean }) {
  const toast = useToast();
  const { data: requests, isLoading } = useBookingRequests();
  const update = useUpdateAppointment();

  return (
    <section
      aria-labelledby={bare ? undefined : 'requests-title'}
      style={bare ? { display: 'flex', flexDirection: 'column', gap: 10 } : { ...panelStyle, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {!bare && (
        <h2 id="requests-title" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>
          {t('sched.cal.requests.title')}
          {requests?.length ? <span style={{ color: 'var(--gold-deep)' }}> · {requests.length}</span> : null}
        </h2>
      )}

      {isLoading ? (
        <Skeleton count={2} height={74} radius={10} />
      ) : !requests?.length ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('sched.cal.requests.empty')}</p>
      ) : (
        requests.map((r) => (
          <article
            key={r.id}
            style={{ background: 'var(--white)', border: '1px dashed var(--gold-deep)', borderRadius: 'var(--radius-card)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <strong style={{ fontSize: 14, color: 'var(--ink)' }}>{personName(r)}</strong>
              <Pill style={isLead(r) ? { background: 'var(--nav-active-bg)', color: 'var(--ink)' } : { background: 'var(--pill-good-bg)', color: 'var(--flag-green)' }}>
                {isLead(r) ? t('sched.lead') : t('sched.cal.requests.from_app')}
              </Pill>
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              {r.type.name} · {formatDayShort(r.starts_at, tz)} · {formatTime(r.starts_at, tz)}
            </div>
            {r.lead?.body_region && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.lead.body_region.name}</div>}
            {!!r.matches?.length && (
              <div style={{ fontSize: 12, color: 'var(--gold-deep)' }}>{t('sched.appt.link_existing', { name: r.matches[0].name })}</div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
              <Button
                size={bare ? 'md' : 'sm'}
                loading={update.isPending && update.variables?.id === r.id}
                onClick={async () => {
                  try {
                    const res = await update.mutateAsync({ id: r.id, patch: { status: 'confirmed', notify: true } });
                    toast.show(t('sched.appt.toast.approved'), { tone: 'success' });
                    if (res.emailed) toast.show(t('sched.appt.toast.emailed'));
                  } catch {
                    toast.show(t('error.save.body'), { tone: 'error' });
                  }
                }}
              >
                {t('sched.appt.approve')}
              </Button>
              <Button size={bare ? 'md' : 'sm'} variant="secondary" onClick={() => onOpen(r)}>
                {t('sched.appt.details')}
              </Button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
