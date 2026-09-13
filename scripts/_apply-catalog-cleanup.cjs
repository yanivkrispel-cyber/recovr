// One-off transform (catalog cleanup step 1, 2026-09-13): rewrites
// supabase/seed/protocols-data.json per the curator-approved decisions at
// https://claude.ai/code/artifact/27d95f2c-46a6-4bc4-975f-29d34997fc70
// (all 64 items approved). Merges collapse to one row because exercise id is
// uuid_generate_v5(name) — giving two occurrences the same Hebrew `name`
// makes them the same row on the next `_gen-protocols-import.cjs` run.
// Run once, review the diff, then re-run _gen-protocols-import.cjs.
// Cross-source merges (Quad Sets/Straight Leg Raise/Heel Slides -> the
// hand-authored e0000001-... demo rows) and the region/category overrides
// that don't fit here are appended directly to supabase/seed/seed.sql.
'use strict';
const fs = require('fs');
const path = require('path');
const jsonPath = path.join(__dirname, '..', 'supabase', 'seed', 'protocols-data.json');
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// oldHebrewName -> { name?, nameEn? } (global rename; merges multiple old
// names onto one canonical name so they collapse to one exercise row).
const RENAME = {
  'גשר עכוז': { name: 'גשר', nameEn: 'Bridge' },
  'Clamshells': { name: 'צדפה (Clamshell)', nameEn: 'Clamshell' },
  'חיזוק מפשקי ירך (Clamshell)': { name: 'צדפה (Clamshell)', nameEn: 'Clamshell' },
  'הרמת רגל בשכיבה צידית': { name: 'הרחקת ירך בשכיבה על הצד', nameEn: 'Side-Lying Hip Abduction' },
  'חיזוק מפשקי ירך': { name: 'הרחקת ירך בשכיבה על הצד', nameEn: 'Side-Lying Hip Abduction' },
  'ישיבת קיר איזומטרית': { name: 'ישיבה על הקיר', nameEn: 'Wall Sit' },
  'הרמות עקב': { name: 'הרמת עקב בעמידה', nameEn: 'Standing Calf Raise' },
  'הורדת עקב אקסצנטרית': { name: 'הורדת עקב אקסצנטרית (אלפרדסון)', nameEn: 'Eccentric Heel Drop (Alfredson)' },
  'הרמת עקב אקסצנטרית': { name: 'הורדת עקב אקסצנטרית (אלפרדסון)', nameEn: 'Eccentric Heel Drop (Alfredson)' },
  'כיווץ איזומטרי לשוק': { name: 'החזקה איזומטרית בהרמת עקב', nameEn: 'Isometric Calf Hold' },
  'החזקות איזומטריות לשוק': { name: 'החזקה איזומטרית בהרמת עקב', nameEn: 'Isometric Calf Hold' },
  'סחיטת שכמות': { name: 'קירוב שכמות', nameEn: 'Scapular Retraction' },
  'רוטציה חיצונית עם תרהבנד': { name: 'רוטציה חיצונית עם גומייה', nameEn: 'Band External Rotation' },
  'חיזוק רוטציה חיצונית': { name: 'רוטציה חיצונית עם גומייה', nameEn: 'Band External Rotation' },
  'רוטציה עם תרהבנד': { name: 'רוטציה חיצונית עם גומייה', nameEn: 'Band External Rotation' },
  'מתיחת שוק עדינה': { name: 'מתיחת שוק', nameEn: 'Calf Stretch' },
  'מתיחת כופף ירך עדינה': { name: 'מתיחת כופפי ירך', nameEn: 'Hip Flexor Stretch' },
  'גלגול IT Band': { name: 'גלגול ITB על גליל', nameEn: 'Foam Rolling: ITB' },
  'גלגול ITB': { name: 'גלגול ITB על גליל', nameEn: 'Foam Rolling: ITB' },
  'אימון שיווי משקל': { name: 'שיווי משקל חד-רגלי', nameEn: 'Single-Leg Balance' },
  'לחיצה מעל הראש בהדרגה': { name: 'לחיצה מעל הראש', nameEn: 'Overhead Press' },
  'התקדמות מעל הראש': { name: 'לחיצה מעל הראש', nameEn: 'Overhead Press' },
  'משיכת סנטר': { name: 'משיכת סנטר (רטרקציה צווארית)', nameEn: 'Chin Tuck' },
  'חזרה הדרגתית לריצה': { name: 'תוכנית חזרה לריצה', nameEn: 'Return to Run Program' },
  'התקדמות הדרגתית בריצה': { name: 'תוכנית חזרה לריצה', nameEn: 'Return to Run Program' },
  'התקדמות בריצה קלה': { name: 'תוכנית חזרה לריצה', nameEn: 'Return to Run Program' },
  'חזרה לריצה/זריזות': { name: 'תוכנית חזרה לריצה', nameEn: 'Return to Run Program' },
  'מכניקת ריצה': { name: 'תיקון דפוס ריצה', nameEn: 'Running Gait Retraining' },
  'זריזות לחזרה לספורט': { name: 'חזרה הדרגתית לספורט', nameEn: 'Gradual Return to Sport' },
  'תרגילי חזרה לספורט': { name: 'חזרה הדרגתית לספורט', nameEn: 'Gradual Return to Sport' },
  'תרגילי חיתוך וזריזות': { name: 'תרגילי שינוי כיוון', nameEn: 'Change of Direction Drills' },
  'מתיחת אמה': { name: 'מתיחת כופפים/יישור שורש', nameEn: 'Wrist Flexor/Extensor Stretch' },
  // pure renames (single row, no merge)
  'יישור בית החזה': { name: 'יישור עמוד שדרה חזי' },
  'מתיחת שרירי כף היד': { name: 'מתיחת פושטי שורש כף היד' },
  'כיווץ איזומטרי של יישור שורש כף היד': { name: 'פשיטת שורש כף היד איזומטרית' },
  'יישור שורש כף היד אקסצנטרי (Tyler Twist)': { name: 'פשיטת שורש כף היד אקסצנטרית' },
  'יישור שורש כף היד עם תרהבנד': { name: 'פשיטת שורש כף היד עם גומייה', nameEn: 'Band Wrist Extension' },
  'שכיבה על הבטן (מקנזי)': { name: 'יישור גב בשכיבה על הבטן (מקנזי)' },
  'פיזיותרפיה במים': { name: 'ריצה במים', nameEn: 'Aqua Jogging' },
  'מתיחת פאשיה כפית': { name: 'מתיחת הפסציה הפלנטרית' },
  'מתיחת Sleeper': { name: 'מתיחת Sleeper (רוטציה פנימית בשכיבה על הצד)' },
  'החלקות עצב': { name: 'החלקת עצב סיאטי', nameEn: 'Sciatic Nerve Glide' },
  'חיזוק שוקה קדמית': { name: 'כפיפה דורסלית של הקרסול עם גומייה', nameEn: 'Band Ankle Dorsiflexion' },
  'חיזוק שרירי כף רגל פנימיים': { name: 'תרגיל כף רגל קצרה', nameEn: 'Short Foot Exercise' },
  'חיזוק אחיזה': { name: 'לחיצת כדור', nameEn: 'Ball Squeeze' },
  'חיזוק כופף ירך': { name: 'כפיפת ירך בעמידה עם גומייה', nameEn: 'Standing Hip Flexion with Band' },
  'סקוואט פונקציונלי': { name: 'סקוואט במשקל גוף', nameEn: 'Bodyweight Squat' },
  'טווח תנועה למרפק': { name: 'כפיפה ויישור של המרפק', nameEn: 'Elbow Flexion–Extension ROM' },
  'התקדמות בקפיצות': { name: 'קפיצות פוגו', nameEn: 'Pogo Hops' },
  'כיפוף מק-גיל': { name: "כפיפת בטן מק'גיל" },
  'הפעלת VMO': { name: 'יישור ברך סופי עם גומייה (TKE)', nameEn: 'Terminal Knee Extension (Band)' },
  'תרגילי מוטוריקה עדינה': { name: 'תרגילי אצבעות עם פלסטלינה טיפולית', nameEn: 'Therapy Putty Finger Exercises' },
};

// Delete this exercise entry outright from one protocol phase (merge-role
// duplicate that already collides in the same phase, or a pure retire).
const REMOVE = [
  { slug: 'jumpers_knee', phase: 2, name: 'חיזוק ארבע ראשי' }, // R02
  { slug: 'shin_splints', phase: 4, name: 'הערכת נעליים ודפוס הליכה' }, // T02
  { slug: 'chronic_neck', phase: 1, name: 'רטרקציה צווארית' }, // M19 (collides with Chin Tucks in the same phase)
  { slug: 'jumpers_knee', phase: 4, name: 'התקדמות פליומטרית' }, // M24 (collides with Landing Mechanics Drills)
  { slug: 'hamstring_strain', phase: 1, name: 'כפיפת ברך נורדית' }, // C01 (moves to phase 4)
  { slug: 'adductor_strain', phase: 1, name: 'פלאנק קופנהגן' }, // C02 (moves to phase 3)
];

// Retarget one specific protocol-phase occurrence to a different (existing)
// exercise, keeping its prescription/frequency.
const REPLACE_IN_PHASE = [
  { slug: 'adductor_strain', phase: 2, oldName: 'חיזוק ירך', name: 'הרחקת ירך בשכיבה על הצד', nameEn: 'Side-Lying Hip Abduction' }, // R01
  { slug: 'shoulder_impingement', phase: 3, oldName: 'חיזוק מותג הכתף', name: 'רוטציה חיצונית עם גומייה', nameEn: 'Band External Rotation' }, // R03
  { slug: 'slap_lesion', phase: 1, oldName: 'ייצוב שכמה', name: 'קירוב שכמות', nameEn: 'Scapular Retraction' }, // R04
  { slug: 'adductor_strain', phase: 3, oldName: 'יציבות ליבה', name: 'חרק מת', nameEn: 'Dead Bug' }, // R05
  { slug: 'hip_flexor_strain', phase: 2, oldName: 'יציבות ליבה', name: 'חרק מת', nameEn: 'Dead Bug' }, // R05
  { slug: 'osgood_schlatter', phase: 3, oldName: 'חיזוק עדין', name: 'ישיבה על הקיר', nameEn: 'Wall Sit' }, // R06
  { slug: 'quad_contusion', phase: 3, oldName: 'חיזוק הדרגתי', name: 'עליות מדרגה', nameEn: 'Step-Ups' }, // R07
  { slug: 'stress_fracture', phase: 2, oldName: 'חיזוק איזומטרי', name: 'החזקה איזומטרית בהרמת עקב', nameEn: 'Isometric Calf Hold' }, // R08
  { slug: 'mcl_sprain', phase: 1, oldName: 'תרגילי טווח תנועה', name: 'החלקות עקב', nameEn: 'Heel Slides' }, // R09
  { slug: 'meniscus_tear', phase: 1, oldName: 'תרגילי טווח תנועה', name: 'החלקות עקב', nameEn: 'Heel Slides' }, // R09
  { slug: 'quad_contusion', phase: 1, oldName: 'טווח תנועה עדין לברך', name: 'החלקות עקב', nameEn: 'Heel Slides' }, // R09
  { slug: 'stress_fracture', phase: 1, oldName: 'טווח תנועה ללא נשיאת משקל', name: 'אלף-בית קרסול', nameEn: 'Ankle Alphabet' }, // R10
  { slug: 'quad_contusion', phase: 2, oldName: 'מתיחה ללא כאב', name: 'מתיחת ארבע ראשי', nameEn: 'Quad Stretch' }, // R11
  { slug: 'chronic_neck', phase: 4, oldName: 'תיקון יציבה', name: 'קירוב שכמות', nameEn: 'Scapular Retraction' }, // R12
  { slug: 'shoulder_impingement', phase: 4, oldName: 'תיקון יציבה', name: 'Y-T-W בשכיבה', nameEn: 'Prone Y-T-W' }, // R12
  { slug: 'stress_fracture', phase: 3, oldName: 'אירובי בעצימות נמוכה', name: 'אופניים נייחים', nameEn: 'Stationary Bike' }, // R13
  { slug: 'hamstring_strain', phase: 4, oldName: 'עומס אקסצנטרי לירך אחורית', name: 'כפיפת ברך נורדית', nameEn: 'Nordic Hamstring Curl' }, // C01 (Nordic moves into this slot)
];

// Add a new exercise entry to a phase (nothing there to replace).
const ADD_TO_PHASE = [
  { slug: 'adductor_strain', phase: 3, name: 'פלאנק קופנהגן', nameEn: 'Copenhagen Plank', prescription: '3 × 10', frequency: '4×/שבוע' }, // C02
];

let renameHits = 0, removeHits = 0, replaceHits = 0, addHits = 0;
const renameSeen = new Set();

for (const [slug, protocol] of Object.entries(data)) {
  for (const phase of protocol.phases) {
    // rename (global)
    for (const ex of phase.exercises) {
      const r = RENAME[ex.name];
      if (r) {
        renameSeen.add(ex.name);
        renameHits++;
        if (r.name) ex.name = r.name;
        if (r.nameEn) ex.nameEn = r.nameEn;
      }
    }
    // remove
    for (const rem of REMOVE) {
      if (rem.slug !== slug || rem.phase !== phase.n) continue;
      const before = phase.exercises.length;
      phase.exercises = phase.exercises.filter((ex) => ex.name !== rem.name);
      removeHits += before - phase.exercises.length;
    }
    // replace-in-phase
    for (const rep of REPLACE_IN_PHASE) {
      if (rep.slug !== slug || rep.phase !== phase.n) continue;
      for (const ex of phase.exercises) {
        if (ex.name === rep.oldName) {
          ex.name = rep.name;
          ex.nameEn = rep.nameEn;
          replaceHits++;
        }
      }
    }
    // add-to-phase
    for (const add of ADD_TO_PHASE) {
      if (add.slug !== slug || add.phase !== phase.n) continue;
      phase.exercises.push({ name: add.name, nameEn: add.nameEn, prescription: add.prescription, frequency: add.frequency });
      addHits++;
    }
  }
}

const missingRenames = Object.keys(RENAME).filter((k) => !renameSeen.has(k));
console.log(`rename: ${renameHits} occurrences changed (${renameSeen.size}/${Object.keys(RENAME).length} distinct old names matched)`);
if (missingRenames.length) console.log('  NOT FOUND (check spelling):', JSON.stringify(missingRenames));
console.log(`remove: ${removeHits} entries deleted (expected ${REMOVE.length})`);
console.log(`replace-in-phase: ${replaceHits} entries retargeted (expected ${REPLACE_IN_PHASE.length})`);
console.log(`add-to-phase: ${addHits} entries added (expected ${ADD_TO_PHASE.length})`);

fs.writeFileSync(jsonPath, JSON.stringify(data));
console.log('wrote', jsonPath);
