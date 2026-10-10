#!/bin/sh
# Postgres backups for the helpline: the backup container's entrypoint (docker/backup.Dockerfile).
#
#   backup.sh [now]            one backup, now
#   backup.sh schedule         one backup every day at 21:30 UTC (03:00 IST): the container's command
#   backup.sh restore <dump>   restores a dump into the database, which must be empty (docs/runbooks/restore.md)
#
# By hand on the VM, from /opt/arham/app:
#   docker compose -f docker/docker-compose.yml --env-file /opt/arham/.env exec backup backup.sh
#
# A backup is `pg_dump -Fc | gzip` into /backups/arham-<UTC time>.dump.gz (/opt/arham/backups on the VM), read back
# with `pg_restore --list` before it takes that name. After a good one, dumps older than BACKUP_RETENTION_DAYS (30)
# days are deleted, and when AZURE_BACKUP_SAS_URL is set (a Blob container SAS URL with Create permission) the new
# dump is uploaded there. The connection comes from PGHOST, PGUSER, PGPASSWORD and PGDATABASE.
# Every step logs a line (docker compose logs backup); a run that fails logs "backup FAILED: <why>" and exits 1. The
# SAS URL is a secret: it is never logged.
set -u

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
# 21:30 UTC, in seconds after midnight UTC.
SCHEDULE_UTC_SECONDS=77400
ACTION=backup

log() {
  printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ACTION" "$*"
}

fail() {
  log "$ACTION FAILED: $*"
  exit 1
}

# Deletes dumps older than RETENTION_DAYS. Called only after a good dump, so the newest one is never among them.
prune() {
  old=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'arham-*.dump.gz' -mmin "+$((RETENTION_DAYS * 1440))")
  for f in $old; do
    rm -f "$f" && log "deleted $(basename "$f") (over $RETENTION_DAYS days old)"
  done
  # Leftovers of a run that was killed mid-dump.
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '.arham-*.partial' -mmin +1440 -exec rm -f {} +
}

# PUT Blob of $1 as $2 into the container AZURE_BACKUP_SAS_URL names: the blob name goes between the container path
# and the SAS query string.
upload() {
  if [ -z "${AZURE_BACKUP_SAS_URL:-}" ]; then
    log "AZURE_BACKUP_SAS_URL not set: kept on the VM only"
    return 0
  fi
  base=${AZURE_BACKUP_SAS_URL%%\?*}
  query=${AZURE_BACKUP_SAS_URL#*\?}
  [ "$query" != "$AZURE_BACKUP_SAS_URL" ] && [ -n "$query" ] || fail "AZURE_BACKUP_SAS_URL has no SAS token (nothing after '?')"
  if curl --fail --silent --show-error --connect-timeout 30 --max-time 3600 --retry 3 --retry-delay 10 \
    -X PUT -H "x-ms-blob-type: BlockBlob" -H "Content-Type: application/gzip" \
    -T "$1" -o /dev/null "${base%/}/$2?$query"; then
    log "uploaded $2 to ${base%/}"
  else
    fail "upload to Azure Blob (curl exit $?); the dump is kept in $BACKUP_DIR"
  fi
}

run_backup() {
  case "$RETENTION_DAYS" in
    '' | *[!0-9]* | 0) fail "BACKUP_RETENTION_DAYS must be a whole number of days, at least 1" ;;
  esac
  [ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] || fail "$BACKUP_DIR is not a writable directory"
  umask 077
  # So a failing pg_dump fails the pipe into gzip. The image's /bin/sh (busybox ash) has it.
  # shellcheck disable=SC3040
  set -o pipefail
  started=$(date -u +%s)
  name="arham-$(date -u +%Y%m%dT%H%M%SZ).dump.gz"
  partial="$BACKUP_DIR/.$name.partial"
  log "starting $name (database ${PGDATABASE:-?} on ${PGHOST:-?})"
  if ! pg_dump --format=custom | gzip > "$partial"; then
    rm -f "$partial"
    fail "pg_dump"
  fi
  if ! gunzip -c "$partial" | pg_restore --list > /dev/null; then
    rm -f "$partial"
    fail "the dump does not read back (pg_restore --list)"
  fi
  mv "$partial" "$BACKUP_DIR/$name" || fail "could not rename the dump to $name"
  log "wrote $name ($(du -k "$BACKUP_DIR/$name" | cut -f1) KiB) in $(($(date -u +%s) - started)) s"
  prune
  upload "$BACKUP_DIR/$name" "$name"
  log "done: $name"
}

schedule() {
  trap 'log "stopping"; exit 0' INT TERM
  log "schedule: daily at 21:30 UTC (03:00 IST) into $BACKUP_DIR, kept $RETENTION_DAYS days"
  while :; do
    now=$(date -u +%s)
    next=$((now - now % 86400 + SCHEDULE_UTC_SECONDS))
    [ "$next" -gt "$now" ] || next=$((next + 86400))
    log "next backup at $(date -u -d "@$next" +%Y-%m-%dT%H:%M:%SZ)"
    # In the background, so a stop signal ends the wait at once.
    sleep $((next - now)) &
    wait $!
    # A process of its own: a failed run (it logs why) never ends the schedule.
    "$0" now || true
  done
}

# Restores dump $1 (a file name in BACKUP_DIR, or a path) into PGDATABASE, which must hold no table yet: restored over
# existing tables, a dump fails halfway or mixes two states.
restore() {
  if [ $# -ne 1 ]; then
    echo "usage: backup.sh restore <arham-...dump.gz>" >&2
    exit 2
  fi
  case "$1" in
    /*) file=$1 ;;
    *) file="$BACKUP_DIR/$1" ;;
  esac
  [ -f "$file" ] || fail "no file $file"
  gunzip -t "$file" 2>/dev/null || fail "$file is not a whole gzip file"
  tables=$(psql -X -At -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')") ||
    fail "could not reach the database"
  [ "$tables" = 0 ] || fail "the database already holds $tables tables: restore only into a fresh volume (docs/runbooks/restore.md)"
  # shellcheck disable=SC3040
  set -o pipefail
  log "restoring $(basename "$file") into ${PGDATABASE:-?} on ${PGHOST:-?}"
  if ! gunzip -c "$file" | pg_restore --exit-on-error --no-owner --dbname="${PGDATABASE:?PGDATABASE is not set}"; then
    fail "pg_restore stopped; the database may hold part of the dump: start again from a fresh volume"
  fi
  log "restored $(basename "$file")"
}

case "${1:-now}" in
  now) run_backup ;;
  schedule) schedule ;;
  restore)
    ACTION=restore
    shift
    restore "$@"
    ;;
  *)
    echo "usage: backup.sh [now | schedule | restore <dump>]" >&2
    exit 2
    ;;
esac
