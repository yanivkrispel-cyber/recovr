# PRD v0.1 — מערכת פרטית לניהול ושיקום פציעות ספורט

## 1. חזון המוצר

מערכת פרטית לניהול תהליך שיקום של פציעות ספורט.

המערכת מאפשרת לאיש המקצוע להגדיר תכנית שיקום מובנית, המבוססת על פרוטוקול, שלבים, תרגילים, מטרות, מגבלות וקריטריונים להתקדמות.

המטופל מקבל בכל יום תכנית ברורה:

- מה לבצע
- כמה לבצע
- איך לבצע
- באיזה סדר
- מה המטרה של כל פעילות
- מה נדרש כדי להתקדם
- איך לדווח על הביצוע והתחושה

איש המקצוע מקבל תמונת מצב של ההתקדמות ויכול לשנות את התכנית בכל שלב.

### עיקרון מרכזי

המערכת אינה "מחליטה על השיקום".

איש המקצוע קובע את הפרוטוקול, המינונים, התנאים והכללים.

המערכת מנהלת, מציגה, מתזמנת, מודדת ומתריעה בהתאם למה שהוגדר.

---

# 2. מטרת ה־MVP

לאפשר לאיש מקצוע אחד לנהל מספר מטופלים ולכל מטופל:

1. להגדיר פציעה/מצב.
2. לבחור או ליצור פרוטוקול.
3. להגדיר שלבי שיקום.
4. לשייך תרגילים.
5. להגדיר מינון.
6. להגדיר מטרות.
7. להגדיר קריטריונים להתקדמות.
8. ליצור תכנית יומית.
9. לאפשר למטופל לבצע את התכנית.
10. לקבל דיווח על ביצוע.
11. לעקוב אחרי התקדמות.
12. לעדכן את התכנית.

---

# 3. קהל יעד

## MVP

### משתמש ראשי
פיזיותרפיסט / איש מקצוע בתחום השיקום.

### משתמש משני
מטופל המבצע תכנית שיקום.

### לא חלק מה־MVP

- בתי חולים
- חברות ביטוח
- מערכות רפואיות גדולות
- Marketplace
- מערכת תשלומים
- רשת חברתית
- מאגר ציבורי של פרוטוקולים
- אבחון אוטומטי
- המלצות רפואיות אוטונומיות

---

# 4. עקרונות מוצר

## 4.1 Clinician Controlled

כל החלטה קלינית משמעותית מגיעה מהמטפל.

## 4.2 Protocol ≠ Patient Plan

פרוטוקול הוא Template.

תכנית המטופל היא Instance מותאם אישית של הפרוטוקול.

## 4.3 Time + Criteria

שלב שיקום יכול להיות תלוי:

- זמן
- קריטריונים
- מדדים
- ביצוע
- החלטת מטפל

ולא רק במספר ימים.

## 4.4 Patient Simplicity

המטופל לא צריך להבין את כל הפרוטוקול.

הוא צריך להבין:

"מה אני עושה היום?"

## 4.5 Everything Should Be Measurable

ככל שניתן, המערכת צריכה לתעד:

- מה תוכנן
- מה בוצע
- מה לא בוצע
- איך הרגיש
- מדדים
- החלטת המטפל
- שינוי בתכנית

---

# 5. מודל המידע המרכזי

## 5.1 Patient

```text
Patient
- id
- name
- dateOfBirth
- contact
- notes
- createdAt
```

---

## 5.2 Injury

```text
Injury
- id
- patientId
- bodyRegion
- diagnosis
- side
- injuryDate
- surgeryDate
- surgeryType
- surgeon
- currentStatus
- restrictions
- notes
```

דוגמאות:

```text
ACL Reconstruction
Meniscus Repair
Achilles Tendon Rupture
Rotator Cuff Repair
Ankle Ligament Injury
Hamstring Injury
Shoulder Instability
```

---

# 6. Protocol

Protocol הוא Template כללי.

```text
Protocol
- id
- name
- bodyRegion
- condition
- interventionType
- version
- description
- source
- clinicalNotes
- phases[]
```

### דוגמה

```text
ACL Reconstruction
Version 1.0
```

---

# 7. Phase

כל פרוטוקול מורכב משלבים.

```text
Phase
- id
- protocolId
- name
- order
- description
- estimatedDuration
- goals[]
- precautions[]
- restrictions[]
- exercises[]
- education[]
- assessments[]
- entryCriteria[]
- exitCriteria[]
```

דוגמה:

```text
Phase 1
Protection / Early Recovery

Phase 2
Mobility + Strength

Phase 3
Strength + Neuromuscular Control

Phase 4
Running / Plyometrics

Phase 5
Sport Specific

Phase 6
Return to Sport
```

המספר והשם אינם קבועים במערכת.

כל מטפל יכול להגדיר שלבים אחרים.

---

# 8. Goals

לכל Phase יש מטרות.

```text
Goal
- id
- name
- description
- category
- target
- measurement
```

קטגוריות:

- Pain
- ROM
- Strength
- Mobility
- Stability
- Balance
- Neuromuscular Control
- Function
- Endurance
- Power
- Sport Performance
- Psychological Readiness

---

# 9. Exercise Library

המערכת צריכה ספריית תרגילים.

אבל:

**Exercise אינו Prescription.**

Exercise הוא התרגיל עצמו.

```text
Exercise
- id
- name
- bodyRegion
- category
- description
- instructions
- video
- images
- equipment
- commonMistakes
- safetyNotes
- tags
```

---

# 10. Exercise Prescription

זה האופן שבו התרגיל ניתן למטופל ספציפי.

```text
ExercisePrescription
- id
- exerciseId
- patientId
- phaseId
- sets
- reps
- duration
- hold
- rest
- load
- resistance
- tempo
- frequency
- side
- intensity
- order
- startDate
- endDate
- instructionsOverride
```

### דוגמה

Exercise:

```text
Single Leg Squat
```

Prescription:

```text
3 sets
8 reps
Left
1x/day
Tempo 3-1-1
Rest 60 sec
```

---

# 11. Schedule

המערכת צריכה להפוך את ה־Prescription ללוח ביצוע.

```text
Schedule
- id
- patientId
- date
- phaseId
- tasks[]
```

Task:

```text
Task
- id
- scheduleId
- type
- exercisePrescriptionId
- educationId
- assessmentId
- scheduledTime
- status
- completedAt
```

Statuses:

```text
Scheduled
Started
Completed
Skipped
Modified
Missed
```

---

# 12. Daily Patient Experience

המסך המרכזי של המטופל הוא:

# היום שלי

```text
Tuesday
Phase 2

Today's plan

1. Exercise A
3 × 10

2. Exercise B
3 × 12

3. Mobility
5 minutes

4. Walking
20 minutes
```

לכל משימה:

- הסבר
- סרטון
- הוראות
- מינון
- ציוד
- זמן משוער
- כפתור Start

---

# 13. Exercise Execution

בעת ביצוע התרגיל:

```text
Exercise Name

VIDEO

How to perform

1.
2.
3.
4.

Prescription

3 × 10

[Start]
```

לאחר כל סט ניתן לאפשר סימון ביצוע.

בסיום:

```text
Completed

How did it feel?

Pain
0 ───────── 10

Difficulty
Easy ─────── Hard

Optional note
___________
```

---

# 14. Patient Feedback

Feedback הוא Entity עצמאי.

```text
SessionFeedback
- id
- patientId
- taskId
- painBefore
- painDuring
- painAfter
- difficulty
- confidence
- completionQuality
- notes
- createdAt
```

לא כל שדה חייב להופיע בכל תכנית.

המטפל מחליט אילו מדדים לאסוף.

---

# 15. Assessment Engine

המערכת צריכה לאפשר מדידות שאינן רק "בוצע / לא בוצע".

```text
Assessment
- id
- name
- category
- unit
- target
- frequency
- instructions
```

דוגמאות:

```text
ROM
Strength
Hop Test
Balance
Walking Duration
Running Speed
Functional Score
Patient Reported Outcome
Psychological Readiness
```

לכל Assessment:

```text
Measurement
- patientId
- assessmentId
- value
- unit
- date
- notes
```

---

# 16. Progression Engine

זה אחד המרכיבים החשובים ביותר במערכת.

המערכת אינה ממציאה כללי התקדמות.

היא מאפשרת למטפל להגדיר אותם.

```text
ProgressionRule
- id
- phaseId
- name
- conditions[]
- logic
- result
```

---

# 17. Condition Types

### Time

```text
daysSinceSurgery >= 21
```

### Pain

```text
pain <= 3
```

### ROM

```text
ROM >= target
```

### Strength

```text
strength >= target
```

### Completion

```text
exerciseCompleted >= 90%
```

### Consecutive Sessions

```text
successfulSessions >= 3
```

### Assessment

```text
functionalTest >= target
```

### Manual Approval

```text
clinicianApproved = true
```

---

# 18. Rule Logic

המערכת צריכה לתמוך ב־AND / OR.

לדוגמה:

```text
Minimum 28 days
AND
Pain <= 3
AND
Full ROM
AND
Strength >= 80%
```

או:

```text
Functional Test >= 90%
OR
Clinician Override
```

---

# 19. Progression Status

המערכת מחשבת:

```text
NOT READY
READY
BLOCKED
MANUAL REVIEW
```

אבל לא מעבירה את המטופל אוטומטית ללא הרשאה שהוגדרה מראש.

---

# 20. Regression

לכל Exercise / Phase ניתן להגדיר גם Regression Rules.

לדוגמה:

```text
If difficulty > threshold
→ reduce load

If completion < target
→ repeat current prescription

If clinician flags issue
→ manual review
```

המערכת מציגה למטפל את המצב.

החלטה קלינית נשארת אצל המטפל.

---

# 21. Alerts

המערכת צריכה לזהות מצבים שדורשים תשומת לב.

לדוגמה:

```text
Patient missed 3 sessions

Pain increased

Repeated high difficulty

Assessment below target

Progression criteria not met

Patient reported issue
```

Alert אינו אבחון.

הוא פשוט:

**"יש מידע שכדאי למטפל לראות."**

---

# 22. Clinician Dashboard

מסך המטפל:

```text
PATIENTS

Patient A
ACL Reconstruction
Phase 2
82% adherence
Last activity: Today

Patient B
Shoulder
Phase 3
94% adherence
Needs review

Patient C
Achilles
Phase 1
60% adherence
3 missed sessions
```

---

# 23. Patient Overview

בעת כניסה למטופל:

```text
Patient
↓
Current Injury
↓
Current Phase
↓
Goals
↓
Today's Plan
↓
Adherence
↓
Symptoms
↓
Assessments
↓
Progression
↓
History
```

---

# 24. Progress Dashboard

צריך להציג Trends.

לדוגמה:

```text
Pain
10 ┤
 8 ┤ █
 6 ┤ █ █
 4 ┤ █ █ █
 2 ┤ █ █ █ █ █
 0 └────────────
```

ומדדים:

```text
Adherence       87%
Pain Trend      ↓
ROM             ↑
Strength        ↑
Function        ↑
```

---

# 25. Protocol Builder

זה כלי פנימי חשוב מאוד.

המטפל יכול ליצור:

```text
Protocol
    ↓
Phase
    ↓
Goals
    ↓
Exercises
    ↓
Prescriptions
    ↓
Assessments
    ↓
Entry Criteria
    ↓
Exit Criteria
    ↓
Progression Rules
```

---

# 26. Protocol Template vs Patient Override

המערכת חייבת לשמור על ההפרדה:

```text
MASTER PROTOCOL
       ↓
PATIENT PLAN
       ↓
PATIENT OVERRIDE
```

לדוגמה:

Protocol:

```text
3 × 10
```

Patient:

```text
2 × 10
```

המערכת צריכה לדעת שה־2×10 הוא Override ולא לשנות את הפרוטוקול המקורי.

---

# 27. Versioning

פרוטוקולים חייבים להיות Versioned.

```text
ACL Protocol
v1.0
v1.1
v2.0
```

כאשר מטופל כבר משתמש ב־v1.0:

עדכון ל־v2.0 לא צריך לשנות רטרואקטיבית את ההיסטוריה שלו.

---

# 28. Audit Trail

יש לשמור:

```text
Who changed what
When
Old value
New value
Reason
```

לדוגמה:

```text
18/08
Therapist changed:

Squat
3×10 → 3×8

Reason:
Patient difficulty
```

---

# 29. Safety Layer

זה חלק חובה מהמוצר.

המערכת לא צריכה:

- לאבחן פציעה.
- לקבוע לבד תכנית טיפול.
- להחליף איש מקצוע.
- להבטיח שהמטופל כשיר להתקדם.
- להציג כלל גנרי כעצה רפואית אישית.

במקום זאת:

```text
Clinician-defined protocol
+
Clinician-defined thresholds
+
Patient-reported information
+
Clinician review
```

בפרוטוקולים עצמם קיימת שונות משמעותית, ואף גופים מקצועיים מדגישים שהפרוטוקול הוא מסגרת ולא תחליף לשיקול דעת קליני.

---

# 30. Protocol Coverage — גרסת המחקר הראשונה

מסקירת מאגרי הפרוטוקולים עולה שה־MVP צריך להתייחס לפחות למשפחות הבאות:

## Knee

- ACL Reconstruction
- ACL non-operative
- ACL + Meniscus
- Meniscus Repair
- Meniscectomy
- PCL
- MCL / LCL
- MPFL
- Patellar Tendon
- Quadriceps Tendon
- Cartilage / Osteochondral
- Knee Arthroscopy

מקורות מוסדיים מציגים בדיוק משפחות כאלה, כולל וריאציות לפי ניתוח ושילוב פציעות.

## Ankle / Foot

- Achilles Repair
- Achilles non-operative
- Lateral Ankle Ligament
- Ankle Sprain
- Ankle Fracture
- Return to Running



## Shoulder

- Rotator Cuff
- Bankart
- Shoulder Instability
- SLAP
- Biceps Tenodesis
- Shoulder Arthroscopy



## Hip

- Hip Arthroscopy
- FAI
- Labral pathology
- Hip Abductor Repair



## Elbow

- UCL / Tommy John
- Distal Biceps
- Lateral Epicondylitis
- Throwing Elbow



## Muscle / Tendon

- Hamstring
- Quadriceps
- Calf
- Achilles
- Pectoral
- Tendon repair



---

# 31. Return to Sport

Return to Sport לא צריך להיות Checkbox.

צריך להיות Phase בפני עצמו.

```text
ReturnToSport
- sport
- position
- level
- criteria[]
- tests[]
- sportSpecificTraining[]
- clinicianApproval
```

הקריטריונים יכולים לכלול:

- Symptoms
- ROM
- Strength
- Power
- Jumping
- Running
- Change of Direction
- Sport Specific Skills
- Psychological Readiness
- Clinician Clearance

ב־ACL, למשל, ההנחיות של Aspetar כוללות שילוב של סימפטומים, ROM, יציבות, כוח, קפיצה, מכניקת תנועה, ריצה והכנה ספציפית לספורט.

---

# 32. מה לא נכניס ל־MVP

כדי לא להתפזר:

- AI diagnosis
- AI-generated protocols
- Automated medical decisions
- Marketplace
- Payments
- Insurance
- Hospital integrations
- Wearables
- Computer vision
- Motion tracking
- Video analysis
- Social network
- Public protocol marketplace

כל אלה יכולים להגיע מאוחר יותר.

---

# 33. MVP User Flow

## Therapist

```text
Login
 ↓
Create Patient
 ↓
Create Injury
 ↓
Choose Protocol
 ↓
Select Starting Phase
 ↓
Customize
 ↓
Assign
 ↓
Review
 ↓
Activate Plan
```

## Patient

```text
Login
 ↓
Today
 ↓
Exercise
 ↓
Watch / Read
 ↓
Perform
 ↓
Complete
 ↓
Feedback
 ↓
Next task
 ↓
Finish day
```

## Therapist — Follow Up

```text
Dashboard
 ↓
Patient
 ↓
Progress
 ↓
Review feedback
 ↓
Review assessments
 ↓
Review criteria
 ↓
Modify plan
 ↓
Save
 ↓
Patient receives updated plan
```

---

# 34. MVP Acceptance Criteria

## Patient

- [ ] יכול לראות את התכנית היומית.
- [ ] יכול לפתוח תרגיל.
- [ ] יכול לצפות בהדרכה.
- [ ] יכול לראות מינון.
- [ ] יכול לסמן ביצוע.
- [ ] יכול לדווח על feedback.
- [ ] יכול לראות מה נשאר להיום.
- [ ] יכול לראות היסטוריה בסיסית.

## Therapist

- [ ] יכול ליצור מטופל.
- [ ] יכול להגדיר injury.
- [ ] יכול לבחור protocol.
- [ ] יכול לבחור phase.
- [ ] יכול להוסיף/remove exercise.
- [ ] יכול לשנות dosage.
- [ ] יכול להגדיר goals.
- [ ] יכול להגדיר criteria.
- [ ] יכול לראות adherence.
- [ ] יכול לראות feedback.
- [ ] יכול לראות assessments.
- [ ] יכול לשנות phase.
- [ ] יכול לשנות תכנית.
- [ ] יכול לראות היסטוריה.

---

# 35. הארכיטקטורה הלוגית

```text
                    PROTOCOL
                       │
             ┌─────────┴─────────┐
             ↓                   ↓
           PHASE               RULES
             │                   │
       ┌─────┼─────┐             │
       ↓     ↓     ↓             │
     GOALS EXERCISES TESTS       │
       │     │       │            │
       └─────┼───────┘            │
             ↓                    │
        PATIENT PLAN ←────────────┘
             │
       ┌─────┼─────────┐
       ↓     ↓         ↓
    SCHEDULE SESSIONS FEEDBACK
       │       │         │
       └───────┼─────────┘
               ↓
          PROGRESS DATA
               │
               ↓
        CLINICIAN REVIEW
               │
               ↓
         PLAN UPDATE
```

---

# 36. ה־MVP Data Model

ה־Entities המרכזיים:

```text
User
Patient
Clinician

Injury

Protocol
ProtocolVersion
Phase
Goal
Restriction
Criterion
ProgressionRule

Exercise
ExercisePrescription

PatientPlan
PatientPhase
Schedule
Task

Session
SessionExercise
SessionFeedback

Assessment
AssessmentResult

Alert

AuditLog
```

זהו ה־Core Domain.

---

# 37. סדר הפיתוח המומלץ

## Sprint 1 — Foundation

- Users
- Patients
- Injuries
- Protocols
- Phases

## Sprint 2 — Exercise

- Exercise Library
- Exercise details
- Prescription
- Video
- Dosage

## Sprint 3 — Patient

- Daily Plan
- Exercise execution
- Completion
- Feedback

## Sprint 4 — Clinician

- Patient dashboard
- Adherence
- Feedback
- Progress

## Sprint 5 — Rules

- Criteria
- Progression
- Regression
- Manual approval

## Sprint 6 — Assessments

- Measurements
- Tests
- Trends

## Sprint 7 — Hardening

- Versioning
- Audit
- Permissions
- Notifications
- Safety messaging

---

# 38. מחקר הפרוטוקולים — מה כבר ניתן לקבע

מהסקירה הראשונית ניתן לקבע כבר עכשיו שהמודל שלנו חייב לתמוך ב:

1. **Phases**
2. **Time windows**
3. **Goals**
4. **Precautions**
5. **Restrictions**
6. **Exercises**
7. **Dosage**
8. **ROM targets**
9. **Strength targets**
10. **Functional targets**
11. **Progression criteria**
12. **Regression**
13. **Assessments**
14. **Return-to-running**
15. **Return-to-sport**
16. **Psychological readiness**
17. **Sport-specific work**
18. **Clinician override**

אלה לא "פיצ'רים שהמצאנו"; הם דפוסים שחוזרים בפרוטוקולים אמיתיים. לדוגמה, בפרוטוקולי ACL מופיעים phases, goals, precautions, recommended program וקריטריונים למעבר, ובשלבים מתקדמים גם testing ו־sport-specific preparation.

---

# 39. החלטת מוצר חשובה

אני ממליץ **לא להכניס כרגע "שבועות" כישות מרכזית**.

במקום:

```text
Week 1
Week 2
Week 3
```

המודל צריך להיות:

```text
Phase
  +
Time Window
  +
Criteria
```

כך אפשר לייצג גם:

```text
Phase 2
Minimum 14 days
AND
ROM target achieved
AND
Pain target achieved
```

וגם:

```text
Phase 3
No fixed duration
Manual progression
```

וזה יהפוך את המערכת להרבה יותר גמישה.

---

# 40. ההחלטה השנייה

**Protocol Library ו־Exercise Library הן שתי ספריות שונות.**

Protocol:

> "ACL Reconstruction"

Exercise:

> "Single Leg Squat"

הפרוטוקול משתמש בתרגיל.

הוא לא "מחזיק" עותק נפרד של התרגיל.

---

# 41. ההחלטה השלישית

כל דבר שהמטופל רואה צריך להיות **Patient-facing representation** של מידע קליני.

כלומר:

```text
Clinical Protocol
       ↓
Patient-safe presentation
```

לא פשוט להציג למטופל PDF של פרוטוקול.

המערכת מתרגמת את הפרוטוקול ל־Daily Plan.

---

# 42. ההחלטה הרביעית

צריך לשמור היסטוריה מלאה.

אם המטפל שינה:

```text
3 × 10
→
3 × 8
```

לא מוחקים את 3×10.

שומרים:

```text
Original
Modified
Date
Clinician
Reason
```

כך תמיד ניתן להבין איך התכנית השתנתה.

---

# 43. הגדרת המוצר במשפט אחד

> **מערכת שמתרגמת פרוטוקול שיקום מקצועי לתכנית שיקום אישית, יומית ומדידה — ומאפשרת למטפל לשלוט בהתקדמות על בסיס קריטריונים מוגדרים.**

---

# 44. Definition of Done ל־MVP

ה־MVP מוכן כאשר מטפל יכול לקחת מטופל חדש, לבחור פרוטוקול, להתאים אותו, להפעיל אותו, והמטופל יכול במשך מספר שבועות לבצע את התכנית ולדווח עליה — כאשר המטפל רואה בפועל מה תוכנן, מה בוצע, מה השתנה ומה דורש בדיקה.

---

## החלטת Scope

לגרסה הראשונה אני ממליץ להתחיל **בפציעות ספורט אורתופדיות**, ולא לנסות לכסות את כל עולם הפיזיותרפיה.

ה־Protocol Engine יהיה כללי, אבל הספרייה הראשונה תהיה:

**Knee → Shoulder → Ankle/Achilles → Hip → Elbow → Muscle/Tendon**

כך אנחנו בונים את המנוע פעם אחת, ומרחיבים את ספריית הפרוטוקולים בהמשך.

השלב הבא מבחינתי הוא לא עוד brainstorming. הוא לקחת את ה־PRD הזה ולבנות ממנו **Specification טכני מלא**: ERD/Database Schema, כל ה־entities וה־relationships, API endpoints, הרשאות, state machines, מסכי MVP, user stories ו־acceptance criteria לכל מסך. במקביל, את מחקר הפרוטוקולים כדאי להפוך ל־**Protocol Schema סופי** ואז להזין אליו את 10–15 הפרוטוקולים הראשונים כדוגמאות reference. זה ייתן לנו בסיס שמפתח יכול להתחיל ממנו ממש.