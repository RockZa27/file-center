#!/bin/sh
# Entrypoint of the Docker image: runs the CMD (bun src/launcher.ts) as the user "bun" (uid 1000), not as root.
#
# Started as root (the default) and FC_RUN_AS_ROOT is not "true":
#   1. /data (FC_DATA_ROOT) of an older install belongs to root: hand it to bun with one chown -R. Only when /data
#      or a folder right under it is not bun's yet, so it runs once after the upgrade and not on every start.
#   2. drop to bun and exec the CMD: the launcher keeps this process (PID 1) and gets the signals of `docker stop`.
# Started as another user (`user:` in compose) or with FC_RUN_AS_ROOT=true: the CMD runs as it is.
set -eu

DATA_ROOT=${FC_DATA_ROOT:-/data}
RUN_USER=bun

[ "$#" -gt 0 ] || { echo 'docker-entrypoint: ไม่มีคำสั่งให้รัน' >&2; exit 64; }

if [ "$(id -u)" != 0 ] || [ "${FC_RUN_AS_ROOT:-}" = true ]; then
  exec "$@"
fi

if ! uid=$(id -u "$RUN_USER" 2>/dev/null); then
  echo "docker-entrypoint: ไม่พบผู้ใช้ $RUN_USER ในอิมเมจ (ถ้าต้องการรันเป็น root ให้ตั้ง FC_RUN_AS_ROOT=true)" >&2
  exit 1
fi

# the top folder and the ones right under it (storage, system, backups): cheap to look at on every start
needs_chown=
mkdir -p "$DATA_ROOT"
for d in "$DATA_ROOT" "$DATA_ROOT"/*; do
  [ -d "$d" ] || continue
  if [ "$(stat -c %u "$d")" != "$uid" ]; then needs_chown=1; break; fi
done
if [ -n "$needs_chown" ]; then
  echo "docker-entrypoint: เปลี่ยนเจ้าของ $DATA_ROOT เป็น $RUN_USER (ครั้งเดียวหลังอัปเกรด ข้อมูลมากอาจใช้เวลาสักครู่)"
  chown -R "$RUN_USER:$RUN_USER" "$DATA_ROOT"
fi

# setpriv (util-linux) replaces this process, so the CMD stays PID 1; su is the fallback for images without it
home=$(awk -F: -v u="$RUN_USER" '$1 == u { print $6 }' /etc/passwd 2>/dev/null || true)
[ -z "$home" ] || export HOME="$home"
export USER="$RUN_USER" LOGNAME="$RUN_USER"
if command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups -- "$@"
fi
exec su -s /bin/sh -c 'exec "$0" "$@"' "$RUN_USER" "$@"
