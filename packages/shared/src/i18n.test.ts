import { describe, expect, it } from 'vitest';
import { he, t } from './i18n';

// COPY.md is the canonical key list. These are the state families it
// enumerates ("all loading / empty / error / offline / validation / confirm /
// toast keys implemented", T-25). Every key here must resolve to real Hebrew
// text — never fall through to the key string.
const REQUIRED_KEYS = [
  'loading.generic', 'loading.patients', 'loading.plan', 'loading.session', 'loading.saving', 'loading.syncing',
  'empty.patients.title', 'empty.patients.body', 'empty.patients.action',
  'empty.patients.filtered.title', 'empty.alerts.title', 'empty.plan.title',
  'empty.assessments.title', 'empty.messages.title', 'empty.today.rest', 'empty.today.done',
  'empty.progress.title', 'empty.search',
  'error.generic.title', 'error.generic.body', 'error.generic.action',
  'error.network.title', 'error.network.body', 'error.notfound.title', 'error.forbidden.title',
  'error.save.title', 'error.save.body', 'error.conflict.title', 'error.conflict.primary',
  'error.conflict.secondary', 'error.session.load',
  'offline.banner', 'offline.queued', 'offline.synced', 'offline.sync_failed',
  'valid.required', 'valid.email', 'valid.phone', 'valid.password.short', 'valid.password.weak',
  'valid.password.mismatch', 'valid.number.range', 'valid.pain.range', 'valid.date.future',
  'valid.sets.min', 'valid.reason.required', 'valid.token.expired', 'valid.login.failed',
  'confirm.discard_plan.title', 'confirm.discard_plan.confirm',
  'confirm.remove_exercise.title', 'confirm.remove_exercise.confirm',
  'confirm.approve_phase.title', 'confirm.approve_phase.confirm',
  'confirm.approve_override.title', 'confirm.discharge.title',
  'toast.plan_saved', 'toast.phase_approved', 'toast.invite_sent', 'toast.alert_reviewed',
  'toast.measurement_saved', 'toast.session_done', 'toast.copied',
  'auth.login.title', 'auth.login.submit', 'auth.forgot.link', 'auth.forgot.title',
  'auth.reset.title', 'auth.invite.title', 'auth.consent.label', 'auth.logout',
  'disclaimer.clinical',
] as const;

describe('i18n copy layer (COPY.md)', () => {
  it.each(REQUIRED_KEYS)('%s resolves to Hebrew text', (key) => {
    const value = he[key as keyof typeof he];
    expect(value, `missing key ${key}`).toBeTruthy();
    // must not just echo the key back, and must contain a Hebrew letter
    expect(value).not.toBe(key);
    expect(value).toMatch(/[֐-׿]/);
  });

  it('interpolates {vars}', () => {
    expect(t('empty.search', { query: 'ACL' })).toBe('לא נמצאו תוצאות עבור "ACL"');
    expect(t('confirm.approve_phase.title', { n: 3 })).toContain('3');
    expect(t('toast.plan_saved', { version: 7 })).toContain('7');
  });

  it('has no leftover interpolation placeholders in plain keys', () => {
    for (const [key, value] of Object.entries(he)) {
      // keys that legitimately carry a placeholder
      if (/\{(query|min|max|n|version|name|count|clinician|shown|total|phase_n|category|value|phases|field|updated|reasons|done|ok|failed|skipped)\}/.test(value)) continue;
      expect(value, `${key} has an unfilled {placeholder}`).not.toMatch(/\{[a-z_]+\}/);
    }
  });

  it('fixed the known typos', () => {
    expect(he['auth.logout']).toBe('יציאה'); // was "יציסה"
    expect(he['valid.phone']).toBe('מספר טלפון לא תקין'); // was "...תקינה"
  });
});
