import { t, type I18nKey, type PatientAppointment } from 'shared';
import { DARK as th } from './theme';

/** Status of a patient's appointment, in the app's dark theme. */
export default function StatusTag({ a }: { a: PatientAppointment }) {
  const pending = a.status === 'pending';
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        borderRadius: 999,
        padding: '2px 9px',
        background: 'var(--patient-card-light)',
        color: pending ? th.accent : th.success,
      }}
    >
      {t(`sched.status.${a.status}` as I18nKey)}
    </span>
  );
}
