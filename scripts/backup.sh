#!/usr/bin/env bash
# Archives the data directory (received submissions and the participant-code
# file) into a dated tar.gz and deletes archives older than KEEP_DAYS.
# Run it from cron on the server, and copy the archives to another machine:
# the encrypted submissions are useless without the private key, so the
# archives can be stored anywhere.
#
# Usage: scripts/backup.sh <data dir> <backup dir> [keep days, default 90]
#   e.g. scripts/backup.sh /opt/wellbeing-mapper-server/data /var/backups/wellbeing-mapper
set -euo pipefail

DATA_DIR="${1:?usage: backup.sh <data dir> <backup dir> [keep days]}"
BACKUP_DIR="${2:?usage: backup.sh <data dir> <backup dir> [keep days]}"
KEEP_DAYS="${3:-90}"
[[ -d "$DATA_DIR" ]] || { echo "no such directory: $DATA_DIR"; exit 1; }

mkdir -p "$BACKUP_DIR"
archive="$BACKUP_DIR/wellbeing-mapper-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
# Submissions are written atomically, so the archive holds only complete
# files; in-progress temporary files are skipped.
tar -C "$(dirname "$DATA_DIR")" --exclude='.tmp-*' --exclude='.write-probe-*' \
  -czf "$archive.part" "$(basename "$DATA_DIR")"
mv "$archive.part" "$archive"
find "$BACKUP_DIR" -name 'wellbeing-mapper-data-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "$archive"
