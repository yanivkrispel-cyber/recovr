#!/usr/bin/env bash
# Take a logical backup of the RecoveryOS database. See docs/RUNBOOK-backup-restore.md.
#
#   DB_URL=postgresql://... ./scripts/db-backup.sh [outdir]
#
# Produces:
#   <outdir>/recoveryos-<date>.sql    plain SQL (diffable)
#   <outdir>/recoveryos-<date>.dump   pg_dump custom format (for pg_restore -j)
#   <outdir>/recoveryos-<date>.counts key row counts, for restore verification
set -euo pipefail

: "${DB_URL:?set DB_URL to the Postgres connection string}"
OUT="${1:-./backups}"
STAMP="$(date +%F-%H%M)"
mkdir -p "$OUT"

echo "→ plain SQL dump"
pg_dump "$DB_URL" --no-owner --no-privileges -f "$OUT/recoveryos-$STAMP.sql"

echo "→ custom-format dump"
pg_dump "$DB_URL" -Fc --no-owner --no-privileges -f "$OUT/recoveryos-$STAMP.dump"

echo "→ row counts"
psql "$DB_URL" -Atc "
  SELECT 'users='       || count(*) FROM app.\"user\";
  SELECT 'clinics='     || count(*) FROM app.clinic;
  SELECT 'audit_log='   || count(*) FROM app.audit_log;
  SELECT 'client_error='|| count(*) FROM app.client_error;
  SELECT 'deletion_req='|| count(*) FROM app.data_deletion_request;
" | tee "$OUT/recoveryos-$STAMP.counts"

# per-clinic clinical row counts
psql "$DB_URL" -Atc "SELECT 'clinic_' || slug FROM app.clinic" | while read -r schema; do
  psql "$DB_URL" -Atc "
    SELECT '$schema.patient='     || count(*) FROM $schema.patient;
    SELECT '$schema.measurement=' || count(*) FROM $schema.measurement;
    SELECT '$schema.session_item='|| count(*) FROM $schema.session_item;
  " | tee -a "$OUT/recoveryos-$STAMP.counts"
done

echo "✓ backup written to $OUT/recoveryos-$STAMP.{sql,dump,counts}"
