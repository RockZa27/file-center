#!/bin/sh
# usage: scripts/qa/sandbox.sh <scratch-dir> <cmd...>   (SBX_CWD = working dir inside, default scratch)
# no network (own netns, loopback only), empty allowlisted env, read-only filesystem except <scratch-dir>,
# CPU/memory/process/file-size/wall-clock limits.
set -e
SCR=$(realpath "$1"); shift
exec unshare -rmnpf --mount-proc=/proc sh -c '
set -e
SCR="$1"; shift
ip link set lo up 2>/dev/null || true
R=/mnt
mount -t tmpfs -o size=64m none $R
for d in /bin /sbin /lib /lib64 /usr /etc /opt /root /home /var /tmp /srv; do
  [ -e "$d" ] || continue
  if [ -L "$d" ]; then cp -P "$d" "$R$d"; continue; fi
  mkdir -p "$R$d"; mount --rbind "$d" "$R$d"; mount -o remount,bind,ro "$R$d"
done
mkdir -p $R/dev $R/proc "$R$SCR"
mount --rbind /dev $R/dev; mount --rbind /proc $R/proc
mount --bind "$SCR" "$R$SCR"; mount -o remount,bind,rw "$R$SCR"
mkdir -p "$SCR/home" "$SCR/tmp"
exec chroot $R env -i PATH=/opt/node22/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin HOME="$SCR/home" TMPDIR="$SCR/tmp" LANG=C.UTF-8 \
  prlimit --cpu=300 --as=8000000000 --nproc=256 --fsize=200000000 --nofile=1024 -- timeout 300 sh -c "cd \"\$0\" && exec \"\$@\"" "${SBX_CWD:-$SCR}" "$@"
' sbx "$SCR" "$@"
