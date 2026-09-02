# Runbook — backup & restore

T-24 requires a **backup + restore rehearsed once** before release. This is the
procedure; run it end-to-end against a throwaway project and record the result
(date, durations, row counts) in the release checklist.

## What is backed up

| Data | Mechanism | Frequency |
|---|---|---|
| Postgres (all schemas: `app`, every `clinic_*`, `auth`, `storage`) | Supabase automated daily backup (platform) + on-demand `pg_dump` below | daily + pre-release |
| Storage bucket `exercise-media` | Supabase Storage is object-store backed; re-ingestable from `exercises-dataset-main` via `scripts/ingest-exercises.ts` | on change |
| Edge function source | this git repo | every commit |
| Secrets (`supabase/functions/.env`, VAPID, SMTP, dispatch) | out of band (password manager / CI secret store) | on change |

The platform daily backup is the primary recovery path. The manual dump below
is for pre-migration safety and for this rehearsal.

## Take a backup

```bash
# 1. Full logical dump (schema + data), custom format so we can restore selectively
supabase db dump --db-url "$PROD_DB_URL" -f backup-$(date +%F).sql          # SQL, human-diffable
pg_dump "$PROD_DB_URL" -Fc -f backup-$(date +%F).dump                        # custom format, for pg_restore

# 2. Note the size and the key row counts for later verification
psql "$PROD_DB_URL" -c "SELECT
  (SELECT count(*) FROM app.\"user\")            AS users,
  (SELECT count(*) FROM app.clinic)             AS clinics,
  (SELECT count(*) FROM app.audit_log)          AS audit_rows;"
# plus, per clinic schema: SELECT count(*) FROM clinic_<slug>.patient; ... measurement; ... session_item;
```

Store both files encrypted, off the app infrastructure, with a 35-day retention
(covers the platform's own 7-day window plus margin).

## Restore (rehearsal + real)

```bash
# Into a fresh, empty project/database:
# A. Schema + data from the SQL dump (fastest to reason about)
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f backup-YYYY-MM-DD.sql

#    or, selective / parallel from the custom-format dump:
pg_restore --clean --if-exists --no-owner --jobs 4 -d "$TARGET_DB_URL" backup-YYYY-MM-DD.dump

# B. Re-point the apps: set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY for the
#    target project and redeploy the two static apps.
# C. Redeploy edge functions from git: supabase functions deploy --project-ref <target>
# D. Restore secrets: supabase secrets set --env-file supabase/functions/.env --project-ref <target>
# E. Re-ingest media if the target has an empty bucket:
#    SUPABASE_DB_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm ingest:exercises
```

## Verify the restore

1. Row counts from step "Take a backup / 2" match on the target (± rows written
   between dump and cutover).
2. `select jobname, schedule from cron.job;` lists all five jobs
   (`adherence-nightly-sweep`, `alerts-sweep`, `notifications-sweep`,
   `notifications-dispatch`, `retention-purge`).
3. Sign in as a seeded clinician → dashboard loads, a patient overview loads,
   the Plan tab renders exercises.
4. Sign in as a patient → today's session loads; log one exercise → it appears
   after refresh (write path + adherence recompute intact).
5. `select count(*) from app.client_error;` is queryable (error sink intact).

## Rehearsal record

```
Date:                 2026-09-02 (local rehearsal, dev stack)
Dump size / duration: 0.6 MB  /  ~1 s   (pg_dump -Fc)
Restore duration:     ~2 s              (pg_restore into a fresh DB)
Row-count check:      PASS  (clinic_demo.session_item = 3 source == 3 restore)
Notes:                Benign restore errors against a bare local DB — pg_cron /
                      pg_net / pg_graphql / pg_read_file can only be created in
                      the platform's primary `postgres` database. On a real
                      restore into a Supabase project those extensions are
                      already present; app tables and data restore cleanly.
                      Re-run the full checklist (cron jobs, clinician + patient
                      smoke) against a real staging project before release.
```
