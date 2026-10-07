import { useState, type CSSProperties } from 'react';
import { addDays, formatDayLong, formatTime, t, whatsappUrl, zonedTimeToUtc, type CalendarAppointment } from 'shared';
import { useCalendarRange } from '../../lib/scheduling';
import { personName } from './calendarUi';

// Tomorrow's appointments with a ready-made WhatsApp reminder each — for the
// people the e-mail reminders don't reach (no address), or when a personal
// message works better. "Sent" marks are a per-device convenience.

const SENT_KEY = 'recoveryos.calendar.wa-reminded';

function readSent(): Set<string> {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSent(sent: Set<string>) {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify([...sent].slice(-300)));
  } catch {
    // private mode / blocked storage: the marks just don't stick
  }
}

/** Tomorrow's confirmed appointments, clinic time. */
export function useTomorrowAppointments(tz: string, today: string, enabled: boolean) {
  const tomorrow = addDays(today, 1);
  const q = useCalendarRange(
    zonedTimeToUtc(tomorrow, '00:00', tz).toISOString(),
    zonedTimeToUtc(addDays(tomorrow, 1), '00:00', tz).toISOString(),
    enabled,
  );
  const list = (q.data?.appointments ?? [])
    .filter((a) => a.status === 'confirmed')
    .sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  return { list, loading: q.isLoading };
}

export function RemindersList({
  appointments,
  tz,
  clinicName,
  address,
  emailReminders,
}: {
  appointments: CalendarAppointment[];
  tz: string;
  clinicName: string;
  address: string;
  /** the clinic sends e-mail reminders (so people with an address get one anyway) */
  emailReminders: boolean;
}) {
  const [sent, setSent] = useState(readSent);

  if (appointments.length === 0) {
    return <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('sched.remind.empty')}</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{t('sched.remind.hint')}</span>
      {appointments.map((a) => {
        const phone = a.patient?.phone ?? a.lead?.phone ?? null;
        const email = a.patient?.email ?? a.lead?.email ?? null;
        const key = `${a.id}:${a.starts_at}`;
        const done = sent.has(key);
        const text = t('sched.remind.text', {
          name: personName(a).trim().split(/\s+/)[0],
          day: formatDayLong(a.starts_at, tz),
          time: formatTime(a.starts_at, tz),
          // "ב" + a Latin name needs a hyphen: "ב-RecoveryOS", "בקליניקה".
          clinic: /^[֐-׿]/.test(clinicName) ? clinicName : `-${clinicName}`,
          address: address ? `, ${address}` : '',
        });
        const href = phone ? whatsappUrl(phone, text) : null;
        return (
          <div key={a.id} style={row}>
            <span style={{ width: 46, flex: 'none', fontSize: 15, fontWeight: 700, color: 'var(--navy)', fontVariantNumeric: 'tabular-nums' }}>
              {formatTime(a.starts_at, tz)}
            </span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{personName(a)}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {a.type.name}
                {email && emailReminders ? ` · ${t('sched.remind.auto_email')}` : ''}
              </span>
            </span>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  const next = new Set(sent);
                  next.add(key);
                  setSent(next);
                  writeSent(next);
                }}
                style={done ? sentButton : sendButton}
              >
                {done ? `✓ ${t('sched.remind.sent')}` : t('sched.remind.send')}
              </a>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--muted-2)', flex: 'none' }}>{t('sched.remind.no_phone')}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  background: 'var(--white)',
  border: '1px solid var(--line-soft)',
  borderRadius: 12,
};

const sendButton: CSSProperties = {
  flex: 'none',
  height: 36,
  padding: '0 14px',
  borderRadius: 'var(--radius-pill)',
  background: 'var(--pill-good-bg)',
  color: 'var(--flag-green)',
  fontSize: 13,
  fontWeight: 800,
  display: 'flex',
  alignItems: 'center',
  textDecoration: 'none',
};

const sentButton: CSSProperties = {
  ...sendButton,
  background: 'transparent',
  border: '1px solid var(--line-input)',
  color: 'var(--muted)',
  fontWeight: 700,
};
