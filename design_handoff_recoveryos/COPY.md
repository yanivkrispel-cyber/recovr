# COPY.md — Hebrew UI copy for system states

All strings live in the i18n layer; keys below are canonical. Tone: clinical, calm, direct.
No exclamation marks, no gamification, no blame. Second person singular; clinician-side
addresses the therapist, patient-side addresses the patient.

## Loading
| key | he |
|---|---|
| `loading.generic` | טוען… |
| `loading.patients` | טוען מטופלים… |
| `loading.plan` | טוען תוכנית… |
| `loading.session` | מכין את האימון… |
| `loading.saving` | שומר… |
| `loading.syncing` | מסנכרן… |

Prefer a skeleton over text. Text only where a skeleton would be misleading (saving, syncing).

## Empty states
| key | title | body | action |
|---|---|---|---|
| `empty.patients` | אין מטופלים עדיין | הזמן מטופל ראשון כדי להתחיל | הזמנת מטופל |
| `empty.patients.filtered` | אין מטופלים שמתאימים לסינון | נסה לשנות את הסינון או החיפוש | נקה סינון |
| `empty.alerts` | אין התראות פתוחות | הכול תחת מעקב | — |
| `empty.plan` | לא נבנתה תוכנית | בחר פרוטוקול או בנה תוכנית מותאמת | בניית תוכנית |
| `empty.assessments` | אין מדידות | מדידה ראשונה תאפשר מעקב על קריטריונים | הוספת מדידה |
| `empty.messages` | אין הודעות | — | — |
| `empty.today.rest` | היום יום מנוחה | מנוחה היא חלק מהתוכנית | — |
| `empty.today.done` | סיימת להיום | נתראה באימון הבא | צפייה בהתקדמות |
| `empty.progress` | עוד אין מספיק נתונים | אחרי כמה אימונים תופיע כאן מגמה | — |
| `empty.search` | לא נמצאו תוצאות עבור "{query}" | — | — |

## Errors
| key | he |
|---|---|
| `error.generic.title` | משהו לא עבד |
| `error.generic.body` | לא הצלחנו לטעון את המידע. נסה שוב. |
| `error.generic.action` | נסה שוב |
| `error.network.title` | אין חיבור לאינטרנט |
| `error.network.body` | נציג את המידע השמור. שינויים יסתנכרנו כשהחיבור יחזור. |
| `error.notfound.title` | הדף לא נמצא |
| `error.notfound.body` | ייתכן שהקישור לא עדכני. |
| `error.forbidden.title` | אין הרשאה |
| `error.forbidden.body` | הפנייה הזו אינה זמינה עבורך. |
| `error.save.title` | השמירה נכשלה |
| `error.save.body` | השינויים שלך נשמרו כטיוטה. נסה לשמור שוב. |
| `error.conflict.title` | התוכנית עודכנה במקביל |
| `error.conflict.body` | גרסה חדשה נשמרה על ידי משתמש אחר. אפשר לפתוח את הגרסה המעודכנת או להוריד את השינויים שלך לצד. |
| `error.conflict.primary` | פתח גרסה מעודכנת |
| `error.conflict.secondary` | שמור את הטיוטה שלי |
| `error.session.load` | לא הצלחנו לטעון את האימון. בדוק חיבור ונסה שוב. |

## Offline / sync
| key | he |
|---|---|
| `offline.banner` | מצב לא מקוון — האימון ימשיך לעבוד |
| `offline.queued` | {count} רשומות ממתינות לסנכרון |
| `offline.synced` | הכול מסונכרן |
| `offline.sync_failed` | הסנכרון נכשל. ננסה שוב אוטומטית. |

## Validation
| key | he |
|---|---|
| `valid.required` | שדה חובה |
| `valid.email` | כתובת אימייל לא תקינה |
| `valid.phone` | מספר טלפון לא תקין |
| `valid.password.short` | לפחות 10 תווים |
| `valid.password.weak` | הסיסמה חייבת לכלול אות, ספרה ותו מיוחד |
| `valid.password.mismatch` | הסיסמאות אינן זהות |
| `valid.number.range` | הזן מספר בין {min} ל-{max} |
| `valid.pain.range` | דרג בין 0 ל-10 |
| `valid.date.future` | התאריך לא יכול להיות בעתיד |
| `valid.sets.min` | לפחות סט אחד |
| `valid.reason.required` | נדרש נימוק |
| `valid.token.expired` | תוקף ההזמנה פג. בקש הזמנה חדשה מהמטפל. |
| `valid.login.failed` | אימייל או סיסמה שגויים |

## Confirmations (destructive / clinical)
| key | title | body | confirm |
|---|---|---|---|
| `confirm.discard_plan` | לבטל את השינויים? | הטיוטה תימחק ולא ניתן לשחזר אותה. | בטל שינויים |
| `confirm.remove_exercise` | להסיר את התרגיל? | ההסרה תופיע בהיסטוריית המטופל. נדרש נימוק. | הסר תרגיל |
| `confirm.approve_phase` | לאשר מעבר לשלב {n}? | האישור נרשם כרשומה קלינית ואינו ניתן לביטול. | אשר מעבר |
| `confirm.approve_override` | לא כל הקריטריונים הושגו | אישור בכל זאת ידרוש נימוק שיישמר ברשומה. | המשך עם נימוק |
| `confirm.discharge` | לשחרר את המטופל? | המטופל יאבד גישה לתוכנית. הנתונים נשמרים. | שחרר |

## Toasts
| key | he |
|---|---|
| `toast.plan_saved` | התוכנית נשמרה (גרסה {version}) |
| `toast.phase_approved` | המעבר לשלב {n} אושר |
| `toast.invite_sent` | ההזמנה נשלחה ל{name} |
| `toast.alert_reviewed` | ההתראה סומנה כטופלה |
| `toast.measurement_saved` | המדידה נשמרה |
| `toast.session_done` | האימון נרשם |
| `toast.copied` | הועתק |

## Auth
| key | he |
|---|---|
| `auth.login.title` | כניסה למערכת |
| `auth.login.submit` | כניסה |
| `auth.forgot.link` | שכחתי סיסמה |
| `auth.forgot.title` | איפוס סיסמה |
| `auth.forgot.body` | נשלח קישור לאיפוס לכתובת האימייל שלך. |
| `auth.forgot.sent` | אם הכתובת קיימת במערכת, נשלח אליה קישור. |
| `auth.reset.title` | בחירת סיסמה חדשה |
| `auth.invite.title` | הפעלת החשבון שלך |
| `auth.invite.body` | {clinician} הזמין אותך לעקוב אחרי תוכנית השיקום שלך. |
| `auth.consent.label` | קראתי ואני מאשר את תנאי השימוש ומדיניות הפרטיות |
| `auth.logout` | יציאה |

## Disclaimer (patient onboarding + printed program — required, RULES §7)
`disclaimer.clinical`:
> המערכת היא כלי לתיעוד ומעקב אחר תוכנית השיקום שנקבעה עבורך. היא אינה מספקת אבחון או ייעוץ
> רפואי ואינה מחליפה את המטפל. בכל כאב חד, נפיחות או החמרה — הפסק את התרגול ופנה למטפל.

## Terminology (use exactly)
מטופל · מטפל · תוכנית · שלב · תרגיל · סט · חזרות · מנוחה · כאב · קושי · היענות (adherence) ·
מדידה · קריטריון · אישור מעבר · יום אימון · יום מנוחה.
Never: "משתמש" for a patient, "workout" transliterated, "אימון כוח" for a Strength-category exercise.
