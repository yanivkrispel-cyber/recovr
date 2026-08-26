# PRD Design-Ready v0.2
## מערכת פרטית לניהול ושיקום פציעות ספורט

### מטרת המסמך

מסמך זה מיועד לשלב ה־UX/UI וה־Prototype.

המטרה היא לקחת את ה־Product Requirements ולהפוך אותם לחוויה ויזואלית ואינטראקטיבית שמאפשרת לבחון:

- איך המטפל עובד עם המערכת.
- איך המטופל מבצע את התכנית.
- איך פרוטוקול הופך לתכנית אישית.
- איך תכנית יומית נראית.
- איך התקדמות מוצגת.
- איך שינוי בתכנית מתבצע.
- איך הקריטריונים להתקדמות באים לידי ביטוי.
- איך המוצר מרגיש בשימוש יומיומי.

ה־Prototype צריך להרגיש כמו מוצר SaaS/HealthTech אמיתי, ולא כמו אוסף wireframes.

---

# 1. Product Concept

## One-liner

מערכת שמתרגמת פרוטוקול שיקום מקצועי לתכנית שיקום אישית, יומית ומדידה — ומאפשרת למטפל לשלוט בהתקדמות על בסיס קריטריונים מוגדרים.

## Core loop

```text
Protocol
↓
Patient
↓
Personalized Plan
↓
Today's Tasks
↓
Exercise
↓
Completion
↓
Feedback
↓
Progress
↓
Clinician Review
↓
Plan Update
```

---

# 2. שתי חוויות עיקריות

למוצר שני interfaces:

## A. Clinician

ה־Clinician מנהל את השיקום.

הוא:

- יוצר מטופל.
- מגדיר פציעה.
- בוחר פרוטוקול.
- מתאים את הפרוטוקול.
- מנהל phases.
- מגדיר exercises.
- מגדיר criteria.
- בודק progress.
- משנה תכנית.

## B. Patient

המטופל משתמש במערכת בעיקר כדי:

- לדעת מה לעשות היום.
- להבין איך לבצע.
- לבצע.
- לסמן completion.
- לדווח איך הרגיש.
- לראות התקדמות.

---

# 3. Design Principle

## Clinician interface

Information-rich אבל לא עמוס.

המטפל צריך לקבל:

**Overview → Decision → Action**

ולא dashboard עמוס בגרפים שאין להם פעולה ברורה.

## Patient interface

Simple, focused, reassuring.

המשפט המרכזי:

> "What do I need to do today?"

---

# 4. Navigation

## Clinician

Desktop-first.

Sidebar:

```text
Dashboard
Patients
Protocols
Exercises
Assessments
Settings
```

ב־MVP אפשר להציג גם:

```text
Search
Notifications
Profile
```

---

# 5. Clinician Dashboard

## מטרת המסך

לתת למטפל תמונת מצב תוך 10 שניות.

### Header

```text
Good morning, Dr. ___

Overview of your patients
```

### KPI cards

```text
Active Patients
12

Needs Attention
3

Completed Today
8

Average Adherence
87%
```

### Patient list

Columns:

```text
Patient
Condition
Phase
Adherence
Last Activity
Status
```

דוגמה:

```text
Noa Cohen
ACL Reconstruction
Phase 3
91%
Today
On track

Daniel Levi
Shoulder
Phase 2
64%
Yesterday
Needs attention
```

### Filters

- All
- Needs Attention
- Active
- Inactive

---

# 6. Patient List

מסך מלא לניהול מטופלים.

### Search

```text
Search patients...
```

### Filters

- Injury
- Phase
- Status
- Adherence
- Last activity

### Patient row

כל row צריך להציג:

- Name
- Injury
- Current phase
- Progress
- Adherence
- Last activity
- Alert status

Click → Patient Overview.

---

# 7. Patient Overview

זהו אחד המסכים החשובים ביותר.

### Header

```text
Noa Cohen

ACL Reconstruction
Left Knee

Day 42

Phase 3 — Strength & Control

[Edit Plan]
```

### Summary

```text
Adherence
91%

Pain trend
↓ 2.1 → 1.4

ROM
132°

Strength
82%

Phase progress
████████░░
```

### Alerts

לדוגמה:

```text
Needs Review

Pain increased after exercise
on 2 consecutive sessions.

[Review]
```

### Current goals

```text
✓ Full extension
✓ ROM > 130°
○ Strength > 85%
○ Single-leg control
```

### Today's activity

```text
5 / 5 completed
```

### Recent activity

Timeline:

```text
Today
Completed all exercises

Yesterday
Completed 4/5

Aug 15
Pain reported 4/10
```

---

# 8. Patient Profile / Clinical Information

Tabs:

```text
Overview
Plan
Progress
Assessments
History
```

Clinical information:

```text
Diagnosis
Surgery
Injury Date
Surgery Date
Side
Restrictions
Notes
```

---

# 9. Plan Screen

המסך שבו המטפל רואה את תכנית השיקום.

### Top

```text
Current Plan

ACL Reconstruction
Phase 3

Started:
July 18

Current day:
42
```

### Phase timeline

ויזואליזציה:

```text
Phase 1 ✓
Phase 2 ✓
Phase 3 ●
Phase 4 ○
Phase 5 ○
```

### Current phase

```text
Phase 3
Strength & Neuromuscular Control

Goals
✓ ROM
○ Strength
○ Single-leg control
```

### Exercises

Table:

```text
Exercise
Prescription
Frequency
Status
```

Example:

```text
Split Squat
3 × 10
4x/week
Active

Single Leg Press
3 × 12
3x/week
Active

Balance
3 × 30 sec
Daily
Active
```

---

# 10. Edit Plan

זהו workflow מרכזי.

לחיצה:

**Edit Plan**

פותחת editor.

### Left side

Phase navigation:

```text
Phase 1
Phase 2
Phase 3
Phase 4
```

### Main area

```text
Goals

Exercises

Assessments

Criteria
```

### Exercise editor

```text
Single Leg Squat

Sets
3

Reps
10

Load
5 kg

Frequency
4x/week

Rest
60 sec

Side
Left

Tempo
3-1-1
```

Buttons:

```text
Save
Cancel
```

---

# 11. Add Exercise

Modal / drawer:

```text
Add Exercise

Search exercises...

Categories:
Strength
Mobility
Balance
Control
Plyometric
Running
Sport Specific
```

Exercise card:

```text
Single Leg Squat

[Preview]

Strength
Knee

[Add]
```

---

# 12. Exercise Detail — Clinician

```text
Single Leg Squat

VIDEO

Description

Target muscles

Equipment

Instructions

Common mistakes

Safety notes
```

---

# 13. Progression Criteria Editor

זהו מסך חשוב מאוד.

המטפל צריך להיות מסוגל להגדיר:

```text
Progression Criteria

To enter Phase 4:

✓ Minimum 42 days
✓ Pain ≤ 2/10
✓ ROM ≥ 130°
✓ Strength ≥ 85%
✓ Functional test ≥ 90%

Clinician approval required
```

UI:

```text
Add criterion
```

Criteria types:

```text
Time
Pain
ROM
Strength
Completion
Assessment
Manual Approval
```

---

# 14. Criteria Visualization

ב־Patient Overview:

```text
Phase 3 → Phase 4

Progression

✓ Time
✓ Pain
✓ ROM
✓ Strength
○ Functional Test
○ Clinician Approval

2 / 6 completed
```

Status:

```text
Not ready
```

או:

```text
Ready for review
```

חשוב:

המערכת לא צריכה להציג:

> "You should progress."

אלא:

> "Progression criteria met — ready for clinician review."

---

# 15. Patient App — Home

זה המסך החשוב ביותר בצד המטופל.

Mobile-first.

### Header

```text
Good morning, Noa

Day 42
Phase 3
```

### Main card

```text
Today's Rehabilitation

5 activities
~25 minutes

[Start Today's Plan]
```

### Progress

```text
Today's progress

3 / 5 completed
```

### Exercise list

```text
✓ Warm-up

✓ Mobility

○ Single Leg Squat
3 × 10

○ Balance
3 × 30 sec

○ Walking
20 min
```

---

# 16. Patient Exercise Screen

מסך Full-screen / focused.

```text
← Back

Single Leg Squat

VIDEO

3 × 10

Rest 60 sec
```

### Instructions

```text
1.
Stand on the affected leg.

2.
Keep your knee aligned.

3.
Lower slowly.

4.
Return to standing.
```

### Primary CTA

```text
Start Exercise
```

---

# 17. Active Exercise

כאשר המטופל מבצע:

```text
Set 1

8 / 10

[Complete Set]
```

לא חייבים לבנות timer מורכב בשלב הראשון.

החוויה צריכה להיות:

**minimal cognitive load.**

---

# 18. Exercise Completion

לאחר completion:

```text
Exercise complete ✓

How did it feel?

Pain
0 ───────── 10

Difficulty
Easy ───── Hard

Optional note

[Continue]
```

המסך לא צריך להרגיש רפואי או מאיים.

---

# 19. Daily Completion

בסיום:

```text
Great work, Noa.

Today's plan
5 / 5 complete

25 minutes

Your next session
Tomorrow
```

---

# 20. Patient Progress

המסך צריך להיות חיובי אך לא "gamified" מדי.

```text
Your Progress

Phase 3
Strength & Control

Day 42

Current streak
5 days
```

### Metrics

```text
Pain
↓ 35%

ROM
↑ 12°

Strength
↑ 18%
```

### Timeline

```text
Phase 1 ✓
Phase 2 ✓
Phase 3 ●
Phase 4 ○
```

---

# 21. Patient Education

לכל phase ניתן להציג:

```text
About this phase

What we're working on

What to expect

Things to keep in mind
```

המידע מגיע מהמטפל/פרוטוקול.

---

# 22. Notifications

MVP:

```text
Your rehabilitation is ready

You have 5 activities today
```

Reminder:

```text
You haven't started today's rehabilitation yet.
```

Clinician update:

```text
Your rehabilitation plan was updated.
```

---

# 23. Empty States

חובה לעצב.

לדוגמה:

### No patients

```text
No patients yet.

Create your first patient
```

### No plan

```text
No active rehabilitation plan.

Create a plan
```

### No exercises today

```text
You're done for today 🎉
```

---

# 24. Loading / Error / Offline

צריך להגדיר מצבים:

- Loading
- Empty
- Error
- Offline
- Saved
- Unsaved changes

---

# 25. Visual Direction

המערכת צריכה להרגיש:

**Clinical + Modern + Calm + Premium**

לא:

- בית חולים מיושן
- אפליקציית כושר
- משחק
- אפליקציית wellness צבעונית מדי

### Visual language

- הרבה whitespace.
- typography ברורה.
- cards נקיים.
- hierarchy חזקה.
- צבעים מינימליים.
- status colors רק כאשר הם משמעותיים.
- גרפים פשוטים.
- motion עדין.

---

# 26. Design System

צריך ליצור:

### Typography

- Display
- H1
- H2
- H3
- Body
- Caption
- Label

### Components

- Button
- Input
- Select
- Search
- Tabs
- Card
- Badge
- Progress bar
- Modal
- Drawer
- Toast
- Table
- Timeline
- Metric card
- Exercise card
- Phase indicator
- Criterion row

---

# 27. Responsive Strategy

## Clinician

Desktop-first.

Minimum target:

1440px.

צריך להיות שימושי גם ב־1024px.

## Patient

Mobile-first.

Primary target:

390px width.

---

# 28. Prototype Required Flows

ה־Prototype חייב לאפשר לבצע לפחות את ה־flows הבאים.

## Flow A — New Patient

```text
Dashboard
→ Add Patient
→ Injury
→ Choose Protocol
→ Select Phase
→ Customize
→ Activate
```

## Flow B — Daily Patient

```text
Home
→ Today's Plan
→ Exercise
→ Video
→ Start
→ Complete
→ Feedback
→ Next Exercise
→ Complete Day
```

## Flow C — Clinician Review

```text
Dashboard
→ Patient
→ Overview
→ Progress
→ Feedback
→ Criteria
→ Edit Plan
→ Save
```

## Flow D — Progression

```text
Patient
→ Current Phase
→ Progression Criteria
→ Criteria Status
→ Ready for Review
→ Clinician Approval
→ Next Phase
```

---

# 29. Prototype Data

אין צורך ב־backend אמיתי בשלב העיצוב.

השתמש ב־seeded mock data.

### Patient

```text
Noa Cohen
29
ACL Reconstruction
Left Knee
Day 42
Phase 3
91% adherence
```

### Second patient

```text
Daniel Levi
34
Rotator Cuff Repair
Right Shoulder
Day 28
Phase 2
68% adherence
Needs Attention
```

### Third patient

```text
Maya Shalev
24
Achilles Repair
Right
Day 74
Phase 4
95% adherence
On Track
```

---

# 30. Prototype Success Criteria

לאחר שימוש ב־Prototype המשתמש צריך להבין ללא הסבר:

### Clinician

- איפה המטופלים שלי?
- מי צריך תשומת לב?
- איפה המטופל נמצא בשיקום?
- מה הוא עשה?
- איך הוא מרגיש?
- האם הוא עומד בקריטריונים?
- איך אני משנה לו את התכנית?

### Patient

- מה אני צריך לעשות היום?
- איך עושים את זה?
- כמה?
- מה כבר עשיתי?
- איך אני מדווח איך היה?
- איפה אני נמצא בתהליך?

---

# 31. מה לא להציג ב־Prototype

לא צריך כרגע:

- Billing
- Insurance
- Messaging complex
- Admin panel
- Multi-clinic management
- AI
- Wearables
- Computer vision
- Integrations
- Advanced analytics
- Public protocol marketplace

---

# 32. Design Deliverables

ה־Prototype צריך לכלול:

### Clinician

1. Dashboard
2. Patient List
3. Patient Overview
4. Patient Plan
5. Edit Plan
6. Add Exercise
7. Exercise Detail
8. Progress
9. Assessments
10. Progression Criteria

### Patient

11. Home
12. Today's Plan
13. Exercise Detail
14. Active Exercise
15. Feedback
16. Completion
17. Progress
18. Education

סה"כ:

**18 מסכים עיקריים**, עם drawers/modals למצבים משניים.

---

# 33. Priority

### P0 — חובה

- Dashboard
- Patient Overview
- Plan
- Edit Plan
- Patient Home
- Exercise
- Completion
- Feedback
- Progression

### P1

- Assessments
- Education
- Exercise Library
- History
- Notifications

### P2

- Advanced analytics
- Protocol Builder
- Versioning UI
- Advanced settings

---

# 34. Design Philosophy

המערכת צריכה להרגיש כאילו היא אומרת:

> "אני יודע בדיוק איפה אני נמצא ומה אני צריך לעשות."

ולמטפל:

> "אני יכול להבין את המצב של המטופל ולהחליט מה לעשות הלאה."

זהו ה־UX המרכזי של המוצר.