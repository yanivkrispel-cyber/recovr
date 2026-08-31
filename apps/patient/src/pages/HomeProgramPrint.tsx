import { useQuery } from '@tanstack/react-query';
import { t } from 'shared';
import { supabase } from '../App';

interface Media {
  kind: 'image' | 'gif' | 'video';
  url: string;
  thumb_url: string | null;
  width: number | null;
  height: number | null;
}

interface PlanExercise {
  name: string;
  name_en: string | null;
  sets: number | null;
  reps: number | null;
  hold_sec: number | null;
  frequency_days_per_week: number | null;
  clinician_note: string | null;
  instructions: string | null;
  common_mistakes: string | null;
  media: Media[];
}

interface Criterion {
  type: 'time' | 'pain' | 'rom' | 'strength' | 'assessment' | 'manual';
  label: string;
  label_en: string | null;
}

interface HomeProgram {
  patient: { name: string; day: number };
  clinician: { name: string | null; phone: string | null };
  plan: { protocol_name: string; started_at: string };
  phase: { n: number; name: string; goals: { he: string; en?: string }[]; criteria: Criterion[] };
  exercises: PlanExercise[];
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

function mediaSrc(u: string): string {
  return u.startsWith('http') ? u : `${SUPABASE_URL}${u}`;
}

const CRITERION_TYPE_HE: Record<Criterion['type'], string> = {
  time: 'זמן',
  pain: 'כאב',
  rom: 'ROM',
  strength: 'כוח',
  assessment: 'הערכה',
  manual: 'אישור ידני',
};

const WEEK_DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const TRACKING_WEEKS = 4;

function prescription(e: PlanExercise): string {
  if (e.sets != null && e.reps != null) return `${e.sets} × ${e.reps}`;
  if (e.sets != null && e.hold_sec != null) return `${e.sets} × ${e.hold_sec} שנ׳`;
  if (e.reps != null) return `${e.reps} חזרות`;
  if (e.hold_sec != null) return `${e.hold_sec} שנ׳`;
  return '—';
}

function frequency(e: PlanExercise): string {
  const d = e.frequency_days_per_week;
  if (!d) return '—';
  if (d >= 7) return 'יומי';
  return `${d}×/שבוע`;
}

function printImage(media: Media[]): Media | null {
  return media.find((m) => m.kind === 'image') ?? media.find((m) => m.kind === 'gif') ?? media[0] ?? null;
}

const PRINT_CSS = `
@page { size: A4; margin: 0; }
.hpp-root { background: #6E6A5E; padding: 24px 0; min-height: 100vh; }
.hpp-toolbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; gap: 10px; justify-content: center; align-items: center;
  padding: 12px; margin-bottom: 20px;
}
.hpp-btn {
  border: none; border-radius: 999px; padding: 10px 22px; font-size: 14px; font-weight: 700;
  font-family: var(--font-ui); cursor: pointer;
}
.hpp-page {
  width: 210mm; min-height: 297mm; box-sizing: border-box;
  margin: 0 auto 20px; background: var(--white); color: var(--ink);
  font-family: var(--font-ui); direction: rtl;
  display: flex; flex-direction: column;
  box-shadow: 0 6px 30px rgba(0,0,0,.35);
}
.hpp-page:last-child { margin-bottom: 0; }
@media print {
  .hpp-root { background: #fff; padding: 0; }
  .hpp-toolbar { display: none !important; }
  .hpp-page { box-shadow: none; margin: 0; page-break-after: always; }
  .hpp-page:last-child { page-break-after: auto; }
}
`;

export default function HomeProgramPrint({ onBack }: { onBack: () => void }) {
  const { data, isLoading, error } = useQuery<HomeProgram>({
    queryKey: ['home-program'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('me-plan', { method: 'GET' });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data as HomeProgram;
    },
  });

  const printedOn = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

  return (
    <div className="hpp-root">
      <style>{PRINT_CSS}</style>

      <div className="hpp-toolbar">
        <button className="hpp-btn" style={{ background: 'var(--gold)', color: 'var(--navy)' }} onClick={() => window.print()}>
          הדפס · Print
        </button>
        <button className="hpp-btn" style={{ background: 'transparent', color: 'var(--cream)', border: '1px solid var(--cream)' }} onClick={onBack}>
          חזרה · Back
        </button>
      </div>

      {isLoading && (
        <div style={{ textAlign: 'center', color: 'var(--cream)', fontFamily: 'var(--font-ui)', direction: 'rtl' }}>
          {t('loading.generic')}
        </div>
      )}

      {!isLoading && (error || !data) && (
        <div style={{ textAlign: 'center', color: 'var(--cream)', fontFamily: 'var(--font-ui)', direction: 'rtl' }}>
          {t('error.generic.body')}
        </div>
      )}

      {data && (
        <>
          <PageOne data={data} printedOn={printedOn} />
          <PageTwo data={data} />
        </>
      )}
    </div>
  );
}

function PageOne({ data, printedOn }: { data: HomeProgram; printedOn: string }) {
  const { patient, plan, phase, clinician } = data;
  return (
    <section className="hpp-page">
      <div style={{ background: 'var(--navy)', color: 'var(--cream)', padding: '22px 40px 18px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <svg width="26" height="22" viewBox="0 0 26 22" fill="none" aria-hidden="true">
            <path d="M1 21V5l6 6 6-10 6 10 6-6v16H1Z" stroke="var(--gold)" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M5.5 16.5h15" stroke="var(--gold)" strokeWidth="1.6" />
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 13, letterSpacing: '0.14em', textTransform: 'uppercase' }}>RecoveryOS</div>
            <div style={{ fontFamily: 'var(--font-accent)', fontStyle: 'italic', fontSize: 13, color: 'rgba(201,162,75,.8)' }}>precision rehab, phase by phase</div>
          </div>
        </div>
        <div style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22 }}>תוכנית שיקום לבית</div>
          <div style={{ fontSize: 11, color: 'var(--gold)', letterSpacing: '0.1em' }}>HOME PROGRAM · הודפס {printedOn}</div>
        </div>
      </div>

      <div style={{ padding: '24px 40px 0', display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        <InfoCard label="מטופל" value={patient.name} />
        <InfoCard label="פרוטוקול" value={plan.protocol_name} />
        <InfoCard label="שלב" value={`${phase.n} · ${phase.name}`} />
        <InfoCard label="יום בשיקום" value={String(patient.day)} />
      </div>

      <div style={{ padding: '20px 40px 0', display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 18, alignItems: 'start' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 800, marginBottom: 9 }}>התרגילים שלך</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ background: 'var(--navy)', color: 'var(--cream)' }}>
                <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600, fontSize: 10, letterSpacing: '0.06em' }}>תרגיל</th>
                <th style={{ textAlign: 'right', padding: '7px 8px', fontWeight: 600, fontSize: 10 }}>סטים × חזרות</th>
                <th style={{ textAlign: 'right', padding: '7px 8px', fontWeight: 600, fontSize: 10 }}>תדירות</th>
                <th style={{ textAlign: 'right', padding: '7px 8px', fontWeight: 600, fontSize: 10 }}>הערת מטפל</th>
              </tr>
            </thead>
            <tbody>
              {data.exercises.map((e, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'var(--paper)' : undefined }}>
                  <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-soft)' }}>
                    <div style={{ fontWeight: 700 }}>{e.name}</div>
                    {e.name_en && <div style={{ fontSize: 9.5, color: 'var(--muted-2)' }}>{e.name_en}</div>}
                  </td>
                  <td style={{ padding: 8, borderBottom: '1px solid var(--line-soft)', fontVariantNumeric: 'tabular-nums' }}>{prescription(e)}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid var(--line-soft)' }}>{frequency(e)}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid var(--line-soft)', color: 'var(--muted)', fontSize: 10.5 }}>{e.clinician_note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ border: '1px solid var(--sand)', borderRadius: 12, padding: '14px 16px', background: 'var(--paper)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 800, marginBottom: 8 }}>מטרות השלב</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {phase.goals.length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>—</div>
            ) : (
              phase.goals.map((g, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, lineHeight: 1.45 }}>
                  <span style={{ color: 'var(--gold)', fontWeight: 800 }}>·</span>
                  <span>{g.he}</span>
                </div>
              ))
            )}
          </div>
          <div style={{ height: 1, background: 'var(--sand)', margin: '13px 0' }} />
          <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--muted-2)', fontWeight: 600, marginBottom: 6 }}>כלל מדידה</div>
          <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--muted)' }}>
            ההיענות נמדדת לפי <b>מספר ימי אימון בשבוע מול המתוכנן</b> — 3 מתוך 3 = 100%. יום חלקי נחשב יום שבוצע.
          </div>
        </div>
      </div>

      <div style={{ padding: '22px 40px 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 9 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 800 }}>מעקב שבועי</div>
          <div style={{ fontSize: 10, color: 'var(--muted-2)' }}>סמן ✓ בכל יום שבוצע · רשום כאב 0–10</div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 10, color: 'var(--muted-2)', fontWeight: 600, borderBottom: '1px solid var(--sand)' }}>שבוע</th>
              {WEEK_DAYS.map((d) => (
                <th key={d} style={{ padding: '6px 4px', fontSize: 10, color: 'var(--muted-2)', fontWeight: 600, borderBottom: '1px solid var(--sand)', width: '8.5%' }}>{d}</th>
              ))}
              <th style={{ padding: '6px 8px', fontSize: 10, color: 'var(--muted-2)', fontWeight: 600, borderBottom: '1px solid var(--sand)' }}>כאב שיא</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: TRACKING_WEEKS }, (_, wi) => (
              <tr key={wi}>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-soft)', fontWeight: 700, whiteSpace: 'nowrap' }}>שבוע {wi + 1}</td>
                {WEEK_DAYS.map((_, di) => (
                  <td key={di} style={{ padding: '7px 4px', borderBottom: '1px solid var(--line-soft)', textAlign: 'center' }}>
                    <div style={{ width: 17, height: 17, border: '1.4px solid var(--line-input)', borderRadius: 4, margin: '0 auto' }} />
                  </td>
                ))}
                <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ height: 17, borderBottom: '1.4px dotted var(--line-input)' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 'auto', padding: '18px 40px 22px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', borderTop: '1px solid var(--line-soft)' }}>
        <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5, maxWidth: '64%' }}>
          {clinician.name ? <>התוכנית נקבעה ע״י <b>{clinician.name}</b>{clinician.phone ? ` · ${clinician.phone}` : ''} · </> : null}
          במקרה של כאב חד, נפיחות או החמרה — הפסיקו ופנו למטפל.
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted-2)', letterSpacing: '0.08em' }}>עמוד 1 מתוך 2</div>
      </div>
    </section>
  );
}

function PageTwo({ data }: { data: HomeProgram }) {
  const { patient, phase } = data;
  const detailed = data.exercises.filter((e) => e.instructions || e.common_mistakes || e.media.length > 0);
  return (
    <section className="hpp-page">
      <div style={{ padding: '32px 40px 0', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 800 }}>איך לבצע · הוראות מפורטות</div>
        <div style={{ fontSize: 10, color: 'var(--muted-2)', letterSpacing: '0.1em' }}>{patient.name} · שלב {phase.n}</div>
      </div>

      <div style={{ padding: '18px 40px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {detailed.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>אין הוראות מפורטות לשלב זה.</div>
        ) : (
          detailed.map((e, i) => {
            const img = printImage(e.media);
            return (
              <div key={i} style={{ border: '1px solid var(--sand)', borderRadius: 12, padding: 14, display: 'grid', gridTemplateColumns: '150px 1fr', gap: 16, breakInside: 'avoid' }}>
                <div style={{ borderRadius: 9, background: 'var(--sand)', border: img ? '1px solid var(--line-input)' : '1px dashed var(--line-input)', aspectRatio: '4 / 3', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 8, boxSizing: 'border-box', overflow: 'hidden' }}>
                  {img ? (
                    <img src={mediaSrc(img.url)} alt={e.name_en ?? e.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                  ) : (
                    <div style={{ fontSize: 9.5, color: 'var(--muted-2)', lineHeight: 1.5 }}>
                      תמונת תרגיל<br />{e.name_en ?? e.name}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{e.name}</div>
                    {e.name_en && <div style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>{e.name_en}</div>}
                    <div style={{ marginInlineStart: 'auto', fontSize: 10, background: 'var(--navy)', color: 'var(--cream)', borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap' }}>
                      {prescription(e)} · {frequency(e)}
                    </div>
                  </div>
                  <div style={{ marginTop: 9, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 9.5, letterSpacing: '0.1em', color: 'var(--muted-2)', fontWeight: 600, marginBottom: 5 }}>ביצוע</div>
                      <div style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--ink-soft)' }}>{e.instructions ?? '—'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9.5, letterSpacing: '0.1em', color: 'var(--muted-2)', fontWeight: 600, marginBottom: 5 }}>טעויות נפוצות</div>
                      <div style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--ink-soft)' }}>{e.common_mistakes ?? '—'}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div style={{ padding: '20px 40px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ border: '1px solid var(--warn-line)', borderRadius: 12, padding: '15px 16px', background: 'var(--warn-bg)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 800, marginBottom: 9 }}>מתי לעצור ולפנות למטפל</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11, lineHeight: 1.5 }}>
            <div>· כאב מעל 5/10 במהלך התרגיל או אחריו</div>
            <div>· כאב שנמשך מעל 24 שעות מתום האימון</div>
            <div>· נפיחות חדשה, צליעה או תחושת נעילה</div>
            <div>· ירידה פתאומית בטווח התנועה</div>
          </div>
        </div>
        <div style={{ border: '1px solid var(--sand)', borderRadius: 12, padding: '15px 16px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 800, marginBottom: 9 }}>קריטריונים למעבר לשלב הבא</div>
          {phase.criteria.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>—</div>
          ) : (
            phase.criteria.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0', fontSize: 11 }}>
                <div style={{ width: 14, height: 14, border: '1.4px solid var(--line-input)', borderRadius: 3, flex: 'none' }} />
                <span>{c.label}</span>
                <span style={{ marginInlineStart: 'auto', fontSize: 9.5, color: 'var(--muted-2)' }}>{CRITERION_TYPE_HE[c.type] ?? c.type}</span>
              </div>
            ))
          )}
          <div style={{ marginTop: 9, fontSize: 10, color: 'var(--muted)', lineHeight: 1.5 }}>
            מעבר שלב מתבצע <b>רק באישור המטפל</b>, גם כשכל הקריטריונים הושגו.
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 40px 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 9 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 800 }}>יומן תחושות לפגישה הבאה</div>
          <div style={{ fontSize: 10, color: 'var(--muted-2)' }}>הביאו את הדף לפגישה</div>
        </div>
        <div style={{ border: '1px solid var(--sand)', borderRadius: 12, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <div>
            <div style={{ fontSize: 9.5, letterSpacing: '0.1em', color: 'var(--muted-2)', fontWeight: 700, marginBottom: 8 }}>מה הרגשתי השבוע</div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ height: 15, borderBottom: '1px dotted var(--line-input)', marginBottom: i < 3 ? 11 : 0 }} />
            ))}
          </div>
          <div>
            <div style={{ fontSize: 9.5, letterSpacing: '0.1em', color: 'var(--muted-2)', fontWeight: 700, marginBottom: 8 }}>שאלות למטפל</div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ height: 15, borderBottom: '1px dotted var(--line-input)', marginBottom: i < 3 ? 11 : 0 }} />
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 'auto', padding: '18px 40px 22px', borderTop: '1px solid var(--line-soft)' }}>
        <div style={{ fontSize: 9.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 8 }}>{t('disclaimer.clinical')}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5 }}>האפליקציה מעדכנת את התוכנית אוטומטית — הדף הזה נכון לתאריך ההדפסה בלבד.</div>
          <div style={{ fontSize: 10, color: 'var(--muted-2)', letterSpacing: '0.08em' }}>עמוד 2 מתוך 2</div>
        </div>
      </div>
    </section>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--sand)', borderRadius: 10, padding: '11px 13px', background: 'var(--paper)' }}>
      <div style={{ fontSize: 9, letterSpacing: '0.12em', color: 'var(--muted-2)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}
