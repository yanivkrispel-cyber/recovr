// Hebrew i18n layer — single source of every user-facing string (T-25).
// Keys come from COPY.md; the canonical state families (loading / empty /
// error / offline / validation / confirm / toast / auth) are complete and
// guarded by i18n.test.ts. Component state text goes through t().
//
// Still inline in a few places: the decorative bilingual "· English" glosses
// on page headers / nav / back links, and structural table-column labels —
// none are in COPY.md (which governs system-state copy) and all are already
// correct Hebrew. Fold them in here when touched.

export const he = {
  // Loading
  'loading.generic': 'טוען…',
  'loading.patients': 'טוען מטופלים…',
  'loading.plan': 'טוען תוכנית…',
  'loading.session': 'מכין את האימון…',
  'loading.saving': 'שומר…',
  'loading.syncing': 'מסנכרן…',

  // Empty
  'empty.patients.title': 'אין מטופלים עדיין',
  'empty.patients.body': 'הזמן מטופל ראשון כדי להתחיל',
  'empty.patients.action': 'הזמנת מטופל',
  'empty.patients.filtered.title': 'אין מטופלים שמתאימים לסינון',
  'empty.patients.filtered.body': 'נסה לשנות את הסינון או החיפוש',
  'empty.patients.filtered.action': 'נקה סינון',
  'empty.alerts.title': 'אין התראות פתוחות',
  'empty.alerts.body': 'הכול תחת מעקב',
  'empty.plan.title': 'לא נבנתה תוכנית',
  'empty.plan.body': 'בחר פרוטוקול או בנה תוכנית מותאמת',
  'empty.plan.action': 'בניית תוכנית',
  'empty.assessments.title': 'אין מדידות',
  'empty.assessments.body': 'מדידה ראשונה תאפשר מעקב על קריטריונים',
  'empty.assessments.action': 'הוספת מדידה',
  'empty.messages.title': 'אין הודעות',
  'empty.today.rest': 'היום יום מנוחה',
  'empty.today.rest.body': 'מנוחה היא חלק מהתוכנית',
  'empty.today.done': 'סיימת להיום',
  'empty.today.done.body': 'נתראה באימון הבא',
  'empty.today.done.action': 'צפייה בהתקדמות',
  'empty.progress.title': 'עוד אין מספיק נתונים',
  'empty.progress.body': 'אחרי כמה אימונים תופיע כאן מגמה',
  'empty.search': 'לא נמצאו תוצאות עבור "{query}"',

  // Errors
  'error.generic.title': 'משהו לא עבד',
  'error.generic.body': 'לא הצלחנו לטעון את המידע. נסה שוב.',
  'error.generic.action': 'נסה שוב',
  'error.network.title': 'אין חיבור לאינטרנט',
  'error.network.body': 'נציג את המידע השמור. שינויים יסתנכרנו כשהחיבור יחזור.',
  'error.notfound.title': 'הדף לא נמצא',
  'error.notfound.body': 'ייתכן שהקישור לא עדכני.',
  'error.forbidden.title': 'אין הרשאה',
  'error.forbidden.body': 'הפנייה הזו אינה זמינה עבורך.',
  'error.save.title': 'השמירה נכשלה',
  'error.save.body': 'השינויים שלך נשמרו כטיוטה. נסה לשמור שוב.',
  'error.conflict.title': 'התוכנית עודכנה במקביל',
  'error.conflict.body': 'גרסה חדשה נשמרה על ידי משתמש אחר. אפשר לפתוח את הגרסה המעודכנת או להוריד את השינויים שלך לצד.',
  'error.conflict.primary': 'פתח גרסה מעודכנת',
  'error.conflict.secondary': 'שמור את הטיוטה שלי',
  'error.session.load': 'לא הצלחנו לטעון את האימון. בדוק חיבור ונסה שוב.',
  'error.action.retry': 'הפעולה נכשלה. נסה שוב.',
  'status.saved': 'נשמר',

  // Offline / sync
  'offline.banner': 'מצב לא מקוון — האימון ימשיך לעבוד',
  'offline.banner.clinician': 'אין חיבור לרשת — חלק מהפעולות אינן זמינות',
  'offline.queued': '{count} רשומות ממתינות לסנכרון',
  'offline.synced': 'הכול מסונכרן',
  'offline.sync_failed': 'הסנכרון נכשל. ננסה שוב אוטומטית.',

  // Validation
  'valid.required': 'שדה חובה',
  'valid.email': 'כתובת אימייל לא תקינה',
  'valid.phone': 'מספר טלפון לא תקין',
  'valid.password.short': 'לפחות 10 תווים',
  'valid.password.weak': 'הסיסמה חייבת לכלול אות, ספרה ותו מיוחד',
  'valid.password.mismatch': 'הסיסמאות אינן זהות',
  'valid.number.range': 'הזן מספר בין {min} ל-{max}',
  'valid.pain.range': 'דרג בין 0 ל-10',
  'valid.date.future': 'התאריך לא יכול להיות בעתיד',
  'valid.sets.min': 'לפחות סט אחד',
  'valid.reason.required': 'נדרש נימוק',
  'valid.token.expired': 'תוקף ההזמנה פג. בקש הזמנה חדשה מהמטפל.',
  'valid.login.failed': 'אימייל או סיסמה שגויים',

  // Confirmations
  'confirm.discard_plan.title': 'לבטל את השינויים?',
  'confirm.discard_plan.body': 'הטיוטה תימחק ולא ניתן לשחזר אותה.',
  'confirm.discard_plan.confirm': 'בטל שינויים',
  'confirm.remove_exercise.title': 'להסיר את התרגיל?',
  'confirm.remove_exercise.body': 'ההסרה תופיע בהיסטוריית המטופל. נדרש נימוק.',
  'confirm.remove_exercise.confirm': 'הסר תרגיל',
  'confirm.approve_phase.title': 'לאשר מעבר לשלב {n}?',
  'confirm.approve_phase.body': 'האישור נרשם כרשומה קלינית ואינו ניתן לביטול.',
  'confirm.approve_phase.confirm': 'אשר מעבר',
  'confirm.approve_override.title': 'לא כל הקריטריונים הושגו',
  'confirm.approve_override.body': 'אישור בכל זאת ידרוש נימוק שיישמר ברשומה.',
  'confirm.approve_override.confirm': 'המשך עם נימוק',
  'confirm.discharge.title': 'לשחרר את המטופל?',
  'confirm.discharge.body': 'המטופל יאבד גישה לתוכנית. הנתונים נשמרים.',
  'confirm.discharge.confirm': 'שחרר',
  'confirm.delete_exercise.title': 'למחוק את התרגיל?',
  'confirm.delete_exercise.body': 'תרגיל מותאם-קליניקה יימחק לצמיתות. תרגילים בתוכניות קיימות לא יושפעו.',
  'confirm.archive_protocol.title': 'להעביר את הפרוטוקול לארכיון?',
  'confirm.archive_protocol.body': 'הפרוטוקול לא יוצע יותר למטופלים חדשים. מטופלים קיימים שכבר שובצו אליו לא יושפעו, וניתן לשחזר בכל עת.',
  'confirm.delete_account.title': 'לשלוח בקשה למחיקת החשבון?',
  'confirm.delete_account.body': 'פרטי הזיהוי שלך יימחקו והגישה תיחסם. המטפל יאשר את הבקשה.',
  'confirm.anonymize.title': 'לבצע מחיקת נתונים?',
  'confirm.anonymize.body': 'פרטי הזיהוי יימחקו והגישה תיחסם. הרשומות הקליניות יישמרו עד תום תקופת השמירה.',

  // Toasts
  'toast.plan_saved': 'התוכנית נשמרה (גרסה {version})',
  'toast.phase_approved': 'המעבר לשלב {n} אושר',
  'toast.invite_sent': 'ההזמנה נשלחה ל{name}',
  'toast.alert_reviewed': 'ההתראה סומנה כטופלה',
  'toast.measurement_saved': 'המדידה נשמרה',
  'toast.session_done': 'האימון נרשם',
  'toast.copied': 'הועתק',
  'toast.patient_discharged': 'המטופל שוחרר',
  'toast.patient_reactivated': 'המטופל הוחזר לפעילות',

  // Auth
  'auth.login.title': 'כניסה למערכת',
  'auth.login.submit': 'כניסה',
  'auth.forgot.link': 'שכחתי סיסמה',
  'auth.forgot.title': 'איפוס סיסמה',
  'auth.forgot.body': 'נשלח קישור לאיפוס לכתובת האימייל שלך.',
  'auth.forgot.sent': 'אם הכתובת קיימת במערכת, נשלח אליה קישור.',
  'auth.reset.title': 'בחירת סיסמה חדשה',
  'auth.invite.title': 'הפעלת החשבון שלך',
  'auth.invite.body': '{clinician} הזמין אותך לעקוב אחרי תוכנית השיקום שלך.',
  'auth.invite.submit': 'הפעלת החשבון',
  'auth.consent.label': 'קראתי ואני מאשר את תנאי השימוש ומדיניות הפרטיות',
  'auth.logout': 'יציאה',

  // Patient home
  'patient.home.title': 'היום שלי',
  'patient.home.start': 'התחל',
  'patient.home.continue': 'המשך',
  'patient.home.exercises_left': '{n} תרגילים נותרו',
  'patient.home.progress': 'התקדמות',
  'patient.exercise.start': 'התחל תרגיל',
  'patient.exercise.next_set': 'סט הבא',
  'patient.exercise.finish': 'סיום תרגיל',
  'patient.exercise.pain': 'כאב',
  'patient.exercise.difficulty': 'קושי',
  'patient.exercise.note': 'הערה (לא חובה)',
  'patient.feedback.easy': 'קל',
  'patient.feedback.medium': 'בינוני',
  'patient.feedback.hard': 'קשה',
  'patient.completion.title': 'סיימת להיום',
  'patient.progress.adherence': 'היענות',
  'patient.progress.pain_trend': 'מגמת כאב',
  'patient.progress.phase_timeline': 'ציר הזמן',

  // Clinician
  'clinician.dashboard.title': 'לוח בקרה',
  'clinician.dashboard.nav_en': 'Dashboard',
  'dashboard.greeting': 'בוקר טוב, {name}',
  'clinician.patients.title': 'מטופלים',
  'clinician.patients.nav_en': 'Patients',
  'clinician.patient.add': 'הזמן מטופל',
  'clinician.patient.discharge': 'שחרר מטופל',
  'clinician.patient.reactivate': 'החזר לפעילות',
  'clinician.patients.tab_active': 'פעילים',
  'clinician.patients.tab_archived': 'בארכיון',
  'clinician.protocol.title': 'ספריית פרוטוקולים',
  'clinician.protocol.nav': 'פרוטוקולים',
  'clinician.protocol.nav_en': 'Protocols',
  'clinician.exercise.title': 'ספריית תרגילים',
  'clinician.exercise.nav': 'תרגילים',
  'clinician.exercise.nav_en': 'Exercises',
  'clinician.assessments.nav': 'הערכות',
  'clinician.assessments.nav_en': 'Assessments',
  'clinician.settings.nav': 'הגדרות',
  'clinician.settings.nav_en': 'Settings',
  'clinician.plan.edit': 'עריכת תוכנית',
  'clinician.plan.save': 'שמור תוכנית',
  'clinician.plan.discard': 'בטל שינויים',
  'clinician.plan.phase_approve': 'אשר מעבר לשלב {n}',
  'clinician.criteria.title': 'קריטריונים להתקדמות',
  'clinician.alerts.title': 'התראות',
  'clinician.alerts.review': 'סמן כטופל',
  'clinician.assessments.title': 'הערכות',
  'clinician.history.title': 'היסטוריה',

  // Exercise categories
  'exercise.category.Mobility': 'ניידות',
  'exercise.category.Strength': 'כוח',
  'exercise.category.Balance': 'שיווי משקל',
  'exercise.category.Control': 'בקרה',
  'exercise.category.Cardio': 'אירובי',

  // Exercise picker (T-29)
  'picker.title': 'הוספת תרגילים',
  'picker.search.placeholder': 'חיפוש לפי שם, בעברית או באנגלית…  ( / )',
  'picker.view.recommended': 'מומלצים',
  'picker.view.all': 'כל התרגילים',
  'picker.view.favorites': 'מועדפים',
  'picker.view.recent': 'אחרונים',
  'picker.filter.region': 'אזור בגוף',
  'picker.filter.region.any': 'כל האזורים',
  'picker.filter.category': 'קטגוריה',
  'picker.filter.all': 'הכל',
  'picker.filter.equipment': 'ציוד',
  'picker.filter.media_only': 'רק תרגילים עם מדיה',
  'picker.filter.clear': 'נקה סינון',
  'picker.results': 'מוצגים {shown} מתוך {total}',
  'picker.load_more': 'טען עוד',
  'picker.recommended.heading': 'מומלצים לשלב {phase_n}',
  'picker.recommended.heading_no_phase': 'מומלצים להקשר הזה',
  'picker.recommended.explainer': 'הדירוג מבוסס על ספריית הפרוטוקולים ועל הבחירות בקליניקה שלך. ההחלטה תמיד שלך.',
  'picker.recommended.no_region': 'לא הוגדר אזור בגוף, ולכן ההמלצות מוגבלות. אפשר להגדיר אזור בפרוטוקול כדי לשפר אותן.',
  'picker.recommended.show_all': 'לכל התרגילים',
  'picker.empty.recommended.title': 'אין עדיין המלצות להקשר הזה',
  'picker.empty.recommended.body': 'ההמלצות נשענות על פרוטוקולים באותו אזור ושלב. אפשר לחפש ידנית בכל הספרייה.',
  'picker.empty.filtered': 'אין תרגילים שמתאימים לסינון',
  'picker.empty.favorites.title': 'אין מועדפים עדיין',
  'picker.empty.favorites.body': 'סמנו ☆ על תרגיל כדי למצוא אותו מהר בפעם הבאה',
  'picker.empty.recent.title': 'אין עדיין תרגילים אחרונים',
  'picker.empty.recent.body': 'תרגילים שתוסיפו דרך החלון הזה יופיעו כאן',
  'picker.basket.title': 'נבחרו ({n})',
  'picker.basket.empty': 'לחצו על כרטיס כדי לבחור. אפשר לבחור כמה תרגילים בבת אחת.',
  'picker.basket.in_phase': 'כבר בשלב: {n} תרגילים',
  'picker.basket.balance': 'איזון השלב אחרי ההוספה',
  'picker.basket.sets': 'סטים',
  'picker.basket.reps': 'חזרות',
  'picker.basket.hold_sec': 'החזקה (שנ׳)',
  'picker.basket.rest_sec': 'מנוחה (שנ׳)',
  'picker.basket.remove': 'הסר מהבחירה',
  'picker.complete.heading': 'משלימים את הבחירה',
  'picker.add': 'הוסף {n} לשלב',
  'picker.add.hint': 'Ctrl+Enter',
  'picker.card.in_phase': 'כבר בשלב',
  'picker.card.selected': 'נבחר',
  'picker.card.no_media': 'אין מדיה',
  'picker.card.unverified': 'לא מאומת',
  'picker.card.details': 'פרטים',
  'picker.card.favorite.add': 'הוסף למועדפים',
  'picker.card.favorite.remove': 'הסר ממועדפים',
  'picker.close': 'סגירה',
  'picker.confirm_close': 'לסגור בלי להוסיף את התרגילים שנבחרו?',
  'picker.reason.region_phase': 'מופיע ב-{count} מתוך {total} פרוטוקולים באזור, בשלב הזה',
  'picker.reason.region': 'מופיע ב-{count} מתוך {total} פרוטוקולים באזור',
  'picker.reason.adjacent_phase': 'נמצא בשלב {phase_n} של הפרוטוקול הזה',
  'picker.reason.co_occurs': 'מופיע יחד עם תרגילים שבשלב או שבחרת ({count})',
  'picker.reason.my_picks': 'בחרת בו {count} פעמים בהקשר דומה',
  'picker.reason.my_picks.one': 'בחרת בו בעבר בהקשר דומה',
  'picker.reason.clinic_picks': 'נבחר {count} פעמים בקליניקה בהקשר דומה',
  'picker.reason.clinic_picks.one': 'נבחר בקליניקה בהקשר דומה',
  'picker.reason.favorite': 'במועדפים שלך',
  'picker.reason.fills_gap': 'משלים {category}, שחסר בשלב',

  // Notifications opt-in (T-18)
  'push.enable': 'הפעל התראות',
  'push.on': 'התראות מופעלות בדפדפן זה',
  'push.hint': 'קבל/י תזכורת יומית לאימון ועדכון כשהמטפל משנה את התוכנית. שעות שקט 21:30–07:30.',
  'push.result.ok': 'התראות הופעלו',
  'push.result.denied': 'ההרשאה נדחתה — יש לאשר בהגדרות הדפדפן',
  'push.result.unsupported': 'הדפדפן אינו תומך בהתראות',
  'push.result.no_key': 'התראות אינן מוגדרות בשרת',
  'push.result.error': 'שגיאה בהפעלת התראות — נסה שוב',

  // Privacy (T-23)
  'privacy.title': 'פרטיות',
  'privacy.export': 'ייצוא הנתונים שלי',
  'privacy.export.busy': 'מייצא…',
  'privacy.delete_request': 'בקשת מחיקת חשבון',
  'privacy.delete_request.busy': 'שולח…',
  'privacy.delete_request.sent': 'הבקשה נשלחה. המטפל יטפל בה.',

  // Disclaimer
  'disclaimer.clinical':
    'המערכת היא כלי לתיעוד ומעקב אחר תוכנית השיקום שנקבעה עבורך. היא אינה מספקת אבחון או ייעוץ רפואי ואינה מחליפה את המטפל. בכל כאב חד, נפיחות או החמרה — הפסק את התרגול ופנה למטפל.',
} as const;

export type I18nKey = keyof typeof he;

type InterpolationVars = Record<string, string | number>;

const isDev = (() => {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
})();

export function t(key: I18nKey, vars?: InterpolationVars): string {
  let str: string | undefined = he[key];
  if (str === undefined) {
    if (isDev) console.warn(`[i18n] missing key: ${key}`);
    str = String(key);
  }
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}

/**
 * Translate a zod validation message if it's a known i18n key, otherwise return as-is.
 * Pass:  tZodError(error?.message)
 */
export function tZodError(msg?: string): string | undefined {
  if (!msg) return msg;
  if (msg in he) return t(msg as I18nKey);
  return msg;
}

/**
 * Translate all FieldErrors from react-hook-form (mutates nothing, returns a new object).
 */
export function translateErrors<T extends Record<string, { message?: string }>>(
  errors: T,
): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(errors)) {
    out[k as keyof T] = (v?.message ? { ...v, message: tZodError(v.message) } : v) as T[keyof T];
  }
  return out;
}
