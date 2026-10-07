import { useEffect, useState } from 'react';
import { Button, useToast } from 'ui';
import { addDays, clinicDate, formatDayLong, formatTime, minutesOf, t, zonedTimeToUtc, type TimeOff } from 'shared';
import { SchedulingError, useCreateTimeOff, useDeleteTimeOff } from '../../lib/scheduling';
import { ConflictList } from './ConflictList';
import { DialogFrame } from './BottomSheet';
import { DateField, Segmented, TimeField, fieldStyle, labelStyle } from './calendarUi';

interface Props {
  /** 'new' opens the form; a TimeOff shows it with a remove button */
  target: 'new' | TimeOff | null;
  defaultDate: string;
  tz: string;
  onClose: () => void;
  /** phone: a bottom sheet instead of a modal */
  sheet?: boolean;
  /** phone: the "new appointment" side of the FAB's sheet */
  onSwitchToAppointment?: () => void;
}

export default function TimeOffModal({ target, defaultDate, tz, onClose, sheet = false, onSwitchToAppointment }: Props) {
  const toast = useToast();
  const create = useCreateTimeOff();
  const remove = useDeleteTimeOff();
  const [allDay, setAllDay] = useState(false);
  const [fromDate, setFromDate] = useState(defaultDate);
  const [fromTime, setFromTime] = useState('09:00');
  const [toDate, setToDate] = useState(defaultDate);
  const [toTime, setToTime] = useState('12:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<SchedulingError | null>(null);

  useEffect(() => {
    if (target !== 'new') return;
    setAllDay(false);
    setFromDate(defaultDate);
    setToDate(defaultDate);
    setFromTime('09:00');
    setToTime('12:00');
    setReason('');
    setError(null);
  }, [target, defaultDate]);

  if (!target) return null;

  if (target !== 'new') {
    const sameDay = clinicDate(target.starts_at, tz) === clinicDate(target.ends_at, tz);
    return (
      <DialogFrame
        sheet={sheet}
        open
        onClose={onClose}
        title={t('sched.off.title')}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={async () => {
                await remove.mutateAsync(target.id);
                toast.show(t('sched.off.toast.deleted'), { tone: 'success' });
                onClose();
              }}
            >
              {t('sched.off.delete')}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('sched.book.back')}
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {formatDayLong(target.starts_at, tz)} {formatTime(target.starts_at, tz)} –{' '}
          {sameDay ? '' : `${formatDayLong(target.ends_at, tz)} `}
          {formatTime(target.ends_at, tz)}
        </p>
        {target.reason && <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--ink-soft)' }}>{target.reason}</p>}
      </DialogFrame>
    );
  }

  const start = /^\d{4}-\d{2}-\d{2}$/.test(fromDate) && (allDay || !Number.isNaN(minutesOf(fromTime)))
    ? zonedTimeToUtc(fromDate, allDay ? '00:00' : fromTime, tz)
    : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(toDate) && (allDay || !Number.isNaN(minutesOf(toTime)))
    ? allDay
      ? zonedTimeToUtc(addDays(toDate, 1), '00:00', tz)
      : zonedTimeToUtc(toDate, toTime, tz)
    : null;
  const valid = !!start && !!end && end > start;

  async function submit() {
    if (!start || !end) return;
    setError(null);
    try {
      await create.mutateAsync({ starts_at: start.toISOString(), ends_at: end.toISOString(), reason: reason.trim() || undefined });
      toast.show(t('sched.off.toast.saved'), { tone: 'success' });
      onClose();
    } catch (e) {
      setError(e instanceof SchedulingError ? e : new SchedulingError('internal_error'));
    }
  }

  return (
    <DialogFrame
      sheet={sheet}
      open
      onClose={onClose}
      title={t('sched.off.title')}
      header={
        onSwitchToAppointment && (
          <Segmented
            label={t('sched.mobile.new_or_block')}
            options={[
              { value: 'appt', label: t('sched.appt.new') },
              { value: 'off', label: t('sched.cal.block') },
            ]}
            value="off"
            onChange={(v) => v === 'appt' && onSwitchToAppointment()}
          />
        )
      }
      footer={
        sheet ? (
          <Button onClick={submit} disabled={!valid} loading={create.isPending} style={{ width: '100%' }} size="lg">
            {t('sched.off.save')}
          </Button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={submit} disabled={!valid} loading={create.isPending}>
              {t('sched.off.save')}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('sched.book.back')}
            </Button>
          </div>
        )
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, minHeight: 28 }}>
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} style={{ width: 18, height: 18, margin: 0 }} />
          {t('sched.off.all_day')}
        </label>
        <div style={labelStyle}>
          {t('sched.off.from')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <DateField
                value={fromDate}
                label={t('sched.off.from')}
                onChange={(d) => {
                  setFromDate(d);
                  if (toDate < d) setToDate(d);
                }}
              />
            </div>
            {!allDay && <TimeField value={fromTime} onChange={setFromTime} label={t('sched.off.from')} />}
          </div>
        </div>
        <div style={labelStyle}>
          {t('sched.off.to')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <DateField value={toDate} min={fromDate} label={t('sched.off.to')} onChange={setToDate} />
            </div>
            {!allDay && <TimeField value={toTime} onChange={setToTime} label={t('sched.off.to')} />}
          </div>
        </div>
        <label style={labelStyle}>
          {t('sched.off.reason')}
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} style={fieldStyle} />
        </label>
        {error &&
          (error.code === 'conflict' && error.conflicts ? (
            <ConflictList conflicts={error.conflicts} tz={tz} intro={t('sched.off.conflict')} />
          ) : (
            <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
              {t('error.save.body')}
            </div>
          ))}
      </div>
    </DialogFrame>
  );
}
