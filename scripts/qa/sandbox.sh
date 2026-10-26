#!/bin/sh
# usage: scripts/qa/sandbox.sh <scratch-dir> <cmd...>   (SBX_CWD = working dir inside, default scratch)
# no network (own netns, loopback only), empty allowlisted env, read-only filesystem except <scratch-dir>,
# CPU/memory/process/file-size/wall-clock limits. SBX_AS=unlimited lifts only the address-space cap (Chromium reserves
# far more virtual memory than it uses); SBX_NODE_PATH passes a module folder (e.g. Playwright's) through env -i.
set -e
SCR=$(realpath "$1"); shift
exec unshare -rmnpf --mount-proc=/proc sh -c '
set -e
SCR="$1"; shift
# loopback up (a new network namespace starts with it down; there may be no `ip` tool, so set the flag directly)
python3 -c "import socket,fcntl,struct as t;s=socket.socket();n=b\"lo\";f=t.unpack(\"16sH\",fcntl.ioctl(s,0x8913,t.pack(\"16sH\",n,0)))[1];fcntl.ioctl(s,0x8914,t.pack(\"16sH\",n,f|1))"
R=/mnt
mount -t tmpfs -o size=64m none $R
for d in /bin /sbin /lib /lib64 /usr /etc /opt /root /home /var /tmp /srv; do
  [ -e "$d" ] || continue
  if [ -L "$d" ]; then cp -P "$d" "$R$d"; continue; fi
  mkdir -p "$R$d"; mount --rbind "$d" "$R$d"; mount -o remount,bind,ro "$R$d"
done
# /root and /tmp hold the scratch of other agents, transcripts and keys: inside they are empty and read-only, except
# bun (/root/.bun) and the scratch of this agent, mounted below (no single quote in this block: it is one sh -c string)
mount -t tmpfs -o size=1m none $R/root; mount -t tmpfs -o size=1m none $R/tmp
if [ -d /root/.bun ]; then mkdir -p $R/root/.bun; mount --rbind /root/.bun $R/root/.bun; mount -o remount,bind,ro $R/root/.bun; fi
# /dev: only the plain device nodes and a private /dev/shm, never the host devtmpfs itself (it would be writable)
mkdir -p $R/dev $R/proc "$R$SCR"
mount -t tmpfs -o size=1m,mode=755 none $R/dev
for n in null zero full random urandom tty; do touch $R/dev/$n; mount --bind /dev/$n $R/dev/$n; done
ln -s /proc/self/fd $R/dev/fd; ln -s /proc/self/fd/0 $R/dev/stdin; ln -s /proc/self/fd/1 $R/dev/stdout; ln -s /proc/self/fd/2 $R/dev/stderr
mkdir -p $R/dev/shm; mount -t tmpfs -o size=256m,nosuid,nodev none $R/dev/shm
mount -o remount,ro,nosuid,noexec $R/dev
mount --rbind /proc $R/proc
mount --bind "$SCR" "$R$SCR"; mount -o remount,bind,rw "$R$SCR"
mount -o remount,ro $R/root; mount -o remount,ro $R/tmp
mkdir -p "$SCR/home" "$SCR/tmp"
exec chroot $R env -i PATH=/opt/node22/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin HOME="$SCR/home" TMPDIR="$SCR/tmp" LANG=C.UTF-8 ${SBX_NODE_PATH:+"NODE_PATH=$SBX_NODE_PATH"} ${PLAYWRIGHT_BROWSERS_PATH:+"PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"} \
  prlimit --cpu=300 --as=${SBX_AS:-8000000000} --nproc=256 --fsize=200000000 --nofile=1024 -- timeout 300 sh -c "cd \"\$0\" && exec \"\$@\"" "${SBX_CWD:-$SCR}" "$@"
' sbx "$SCR" "$@"
