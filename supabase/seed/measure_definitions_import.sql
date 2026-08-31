-- ============================================================================
-- Measure definition catalog — imported from ROM_CATALOG in
-- design_handoff_recoveryos/Rehab Platform Prototype.dc.html
-- (see scripts/_gen-measure-definitions-import.cjs; T-09b).
-- Loaded via [db.seed] sql_paths in config.toml, separate from seed.sql,
-- since this is global system data (clinic_id = NULL), not demo-clinic data.
-- Idempotent: id is uuid_generate_v5 derived from the measure code, so
-- ON CONFLICT (id) DO NOTHING makes re-running safe.
-- ============================================================================

INSERT INTO public.measure_definition (
  id, clinic_id, code, joint, name_he, name_en, unit, norm, target, scale, flags, norm_source, protocol_tip
) VALUES
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'knee_flex'),
    NULL, 'knee_flex', 'knee', 'כפיפת ברך', 'Knee flexion',
    'deg', 135, 120, 160,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'knee_ext'),
    NULL, 'knee_ext', 'knee', 'יישור ברך', 'Knee extension',
    'deg', 0, 0, 20,
    '{"deficit":true,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'knee_h2b'),
    NULL, 'knee_h2b', 'knee', 'עקב-לישבן', 'Heel-to-buttock distance',
    'cm', 0, 2, 12,
    '{"deficit":false,"lower":true,"fx":true,"bilat":true,"deg_opt":false,"side_diff":2}'::jsonb, NULL, 'שכיבה על הבטן, כפיפת ברך מקסימלית. נמדד המרחק מהעקב לישבן — 0 ס"מ = טווח מלא. פער צדדי ≥2 ס"מ = מגבלה.'
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'knee_squat'),
    NULL, 'knee_squat', 'knee', 'סקוואט עמוק', 'Deep squat',
    'pass_fail', NULL, NULL, 20,
    '{"deficit":false,"lower":false,"fx":true,"bilat":false,"deg_opt":false}'::jsonb, NULL, 'סקוואט דו-צדדי מלא, עקבים על הרצפה. סמן עובר/לא עובר ואת הפיצויים שנצפו.'
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'wr_flex'),
    NULL, 'wr_flex', 'wrist', 'כפיפת שורש כף היד', 'Wrist flexion',
    'deg', 80, 70, 100,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'wr_ext'),
    NULL, 'wr_ext', 'wrist', 'יישור שורש כף היד', 'Wrist extension',
    'deg', 70, 60, 90,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'wr_sup'),
    NULL, 'wr_sup', 'wrist', 'סופינציה', 'Forearm supination',
    'deg', 80, 70, 100,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'wr_pron'),
    NULL, 'wr_pron', 'wrist', 'פרונציה', 'Forearm pronation',
    'deg', 80, 70, 100,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'cv_flex'),
    NULL, 'cv_flex', 'cervical', 'כפיפת צוואר', 'Cervical flexion',
    'deg', 50, 45, 60,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'cv_ext'),
    NULL, 'cv_ext', 'cervical', 'יישור צוואר', 'Cervical extension',
    'deg', 60, 50, 70,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'cv_rot'),
    NULL, 'cv_rot', 'cervical', 'סיבוב צוואר', 'Cervical rotation',
    'deg', 80, 70, 100,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'cv_lat'),
    NULL, 'cv_lat', 'cervical', 'הטיה צידית', 'Cervical lateral flexion',
    'deg', 45, 40, 60,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'sh_flex'),
    NULL, 'sh_flex', 'shoulder', 'כפיפת כתף', 'Shoulder flexion',
    'deg', 180, 160, 210,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'sh_abd'),
    NULL, 'sh_abd', 'shoulder', 'אבדוקציה', 'Shoulder abduction',
    'deg', 180, 150, 210,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'sh_ext'),
    NULL, 'sh_ext', 'shoulder', 'יישור כתף', 'Shoulder extension',
    'deg', 60, 50, 70,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'sh_er'),
    NULL, 'sh_er', 'shoulder', 'סיבוב חוץ', 'External rotation',
    'deg', 90, 75, 110,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'sh_ir'),
    NULL, 'sh_ir', 'shoulder', 'סיבוב פנים', 'Internal rotation',
    'deg', 70, 60, 90,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'ank_df'),
    NULL, 'ank_df', 'ankle', 'דורסיפלקסיה', 'Ankle dorsiflexion',
    'deg', 20, 15, 30,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'ank_wblt'),
    NULL, 'ank_wblt', 'ankle', 'דורסיפלקסיה בעמידה · WBLT', 'Weight-bearing lunge test',
    'cm', 11, 10, 15,
    '{"deficit":false,"lower":false,"fx":true,"bilat":true,"deg_opt":true,"side_diff":1.5,"risk_below":9}'::jsonb, 'WBLT', 'עקב-קיר: הבוהן על הסרט, הברך נוגעת בקיר, העקב לא מתרומם. מרחק מקסימלי בס"מ. פער צדדי ≥1.5 ס"מ או פחות מ-9 ס"מ = מגבלה משמעותית.'
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'ank_pf'),
    NULL, 'ank_pf', 'ankle', 'פלנטרפלקסיה', 'Ankle plantarflexion',
    'deg', 50, 45, 60,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'ank_inv'),
    NULL, 'ank_inv', 'ankle', 'אינברסיה', 'Ankle inversion',
    'deg', 35, 30, 50,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'ank_ev'),
    NULL, 'ank_ev', 'ankle', 'אוורסיה', 'Ankle eversion',
    'deg', 15, 12, 20,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'hip_flex'),
    NULL, 'hip_flex', 'hip', 'כפיפת ירך', 'Hip flexion',
    'deg', 120, 110, 140,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'hip_ext'),
    NULL, 'hip_ext', 'hip', 'יישור ירך', 'Hip extension',
    'deg', 20, 15, 30,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'hip_abd'),
    NULL, 'hip_abd', 'hip', 'אבדוקציית ירך', 'Hip abduction',
    'deg', 45, 40, 60,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'hip_add'),
    NULL, 'hip_add', 'hip', 'אדוקציית ירך', 'Hip adduction',
    'deg', 30, 25, 40,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'hip_ir'),
    NULL, 'hip_ir', 'hip', 'סיבוב פנים ירך', 'Hip internal rotation',
    'deg', 45, 35, 60,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'hip_er'),
    NULL, 'hip_er', 'hip', 'סיבוב חוץ ירך', 'Hip external rotation',
    'deg', 45, 35, 60,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'hip_thomas'),
    NULL, 'hip_thomas', 'hip', 'תומאס · חסר יישור ירך', 'Thomas test',
    'deg', 0, 0, 30,
    '{"deficit":true,"lower":false,"fx":true,"bilat":true,"deg_opt":false}'::jsonb, 'Thomas', 'שכיבה על הגב בקצה המיטה, ירך נגדית לחזה. נמדדת זווית חסר היישור של הירך הנבדקת — 0° = תקין.'
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'elb_flex'),
    NULL, 'elb_flex', 'elbow', 'כפיפת מרפק', 'Elbow flexion',
    'deg', 150, 140, 180,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'elb_ext'),
    NULL, 'elb_ext', 'elbow', 'יישור מרפק', 'Elbow extension',
    'deg', 0, 0, 20,
    '{"deficit":true,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'lum_flex'),
    NULL, 'lum_flex', 'lumbar', 'כפיפת גב תחתון', 'Lumbar flexion',
    'deg', 60, 50, 70,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'lum_ext'),
    NULL, 'lum_ext', 'lumbar', 'יישור גב תחתון', 'Lumbar extension',
    'deg', 25, 20, 30,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'lum_lat'),
    NULL, 'lum_lat', 'lumbar', 'הטיה צידית', 'Lumbar lateral flexion',
    'deg', 25, 20, 30,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'lum_rot'),
    NULL, 'lum_rot', 'lumbar', 'סיבוב גב תחתון', 'Lumbar rotation',
    'deg', 30, 25, 40,
    '{"deficit":false,"lower":false,"fx":false,"bilat":true,"deg_opt":false}'::jsonb, 'AAOS', NULL
  ),
  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || 'lum_schober'),
    NULL, 'lum_schober', 'lumbar', 'שוברס מותאם', 'Modified Schober',
    'cm', 6, 5, 9,
    '{"deficit":false,"lower":false,"fx":true,"bilat":false,"deg_opt":false}'::jsonb, 'Schober', 'סימון 10 ס"מ מעל ו-5 ס"מ מתחת ל-S2, כפיפה קדימה מלאה. נמדדת ההתארכות בס"מ — פחות מ-5 ס"מ = הגבלה.'
  )
ON CONFLICT (id) DO NOTHING;
