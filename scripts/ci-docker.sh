#!/usr/bin/env bash
# The real image, end to end (used by .github/workflows/qa.yml, and runnable on any machine with Docker and Bun):
#
#   1. build the image, start it on an empty volume with ADMIN_PASSWORD, wait for /api/health
#   2. the app (PID 1) runs as uid 1000 and everything under /data belongs to 1000
#   3. log in, upload a file in chunks, download it back: byte for byte the same
#   4. an UNSIGNED update package is refused; a package (99.0.0) signed with a throw-away key (its public key is the
#      container's UPDATE_PUBLIC_KEY) is installed through /api/admin/update/upload|stage|apply,
#      wait for the restart: the version is 99.0.0
#      thumbnails: the tools in the image (libvips, poppler, ffmpeg) make a picture of a jpg, a pdf and an mp4 that the
#      tools themselves made inside the container, as uid 1000 on the read-only root (skipped with FC_CI_NO_APT=1)
#   5. a second container with FC_RUN_AS_ROOT=true runs as uid 0
#   6. a volume of an older install (owned by root, closed folder) is handed to uid 1000 with only the four capabilities
#
# Both containers run with the hardening of docker-compose.yml (read-only root, tmpfs /tmp, cap_drop ALL + the four
# capabilities of the entrypoint, no-new-privileges); step 2 checks it took effect: a write outside /data fails, the
# app (PID 1) has no capabilities left (CapEff 0) and no_new_privs is set. The update in step 4 therefore also proves
# that a web update works on a read-only root (it writes to /data/system/app only).
#
# Everything it makes (containers, volumes, the image, temp files) is removed on exit, also after a failure.
# FC_CI_CA_BUNDLE=<file> makes the image build trust an extra CA bundle (for a network with an inspecting proxy).
# FC_CI_PREFIX changes the start of the names it uses (default "fc-ci"); a random port on 127.0.0.1 is used.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

PREFIX="${FC_CI_PREFIX:-fc-ci}-$$"
IMAGE="$PREFIX-image"
PASSWORD='ci-docker-Pass-4821'
CHUNK=1048576
WORK=$(mktemp -d)
COOKIES="$WORK/cookies"
CSRF=
BASE_URL=
DIST_FROM_IMAGE=
RESULTS=()
# keep in step with docker-compose.yml (checked in step 1)
HARDEN=(--read-only --tmpfs /tmp:size=256m,mode=1777 --cap-drop ALL
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE
  --security-opt no-new-privileges:true --memory 2g --pids-limit 512)

log()  { printf '== %s\n' "$*"; }
pass() { RESULTS+=("PASS  $*"); printf '   ok: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; show_logs; exit 1; }

show_logs() {
  local c
  for c in "$PREFIX-main" "$PREFIX-root" "$PREFIX-old"; do
    if docker inspect "$c" >/dev/null 2>&1; then
      printf -- '--- logs of %s (last 60 lines)\n' "$c" >&2
      docker logs --tail 60 "$c" >&2 || true
    fi
  done
}

cleanup() {
  local code=$?
  set +e
  docker rm -f "$PREFIX-main" "$PREFIX-root" "$PREFIX-old" >/dev/null 2>&1
  docker volume rm -f "$PREFIX-data" "$PREFIX-data-root" "$PREFIX-data-old" >/dev/null 2>&1
  docker rmi -f "$IMAGE" >/dev/null 2>&1
  # web/dist copied out of the image only because this checkout has none
  [ -z "$DIST_FROM_IMAGE" ] || rm -rf "$ROOT/web/dist"
  rm -rf "$WORK"
  if [ "$code" -eq 0 ]; then
    printf '\nSummary\n'
    printf '  %s\n' "${RESULTS[@]}"
    printf 'All checks passed.\n'
  else
    printf '\nci-docker.sh failed (exit %s)\n' "$code" >&2
    [ "${#RESULTS[@]}" -eq 0 ] || { printf 'Passed before the failure:\n' >&2; printf '  %s\n' "${RESULTS[@]}" >&2; }
  fi
  exit "$code"
}
trap cleanup EXIT

# JSON out of a reply: json '<expression on d>' < reply
json() { bun -e "const d = JSON.parse(await Bun.stdin.text()); console.log($1)"; }

# api METHOD PATH [JSON-BODY]: one JSON call with the session cookie and CSRF token; prints the body, fails on HTTP >= 400
api() {
  local method=$1 path=$2 body=${3:-} out status
  local args=(-sS -o "$WORK/reply" -w '%{http_code}' -X "$method" -b "$COOKIES" -c "$COOKIES" -H "x-csrf-token: $CSRF")
  [ -z "$body" ] || args+=(-H 'content-type: application/json' --data "$body")
  status=$(curl "${args[@]}" "$BASE_URL$path") || fail "curl $method $path"
  out=$(cat "$WORK/reply")
  [ "$status" -lt 400 ] || fail "$method $path answered $status: $out"
  printf '%s' "$out"
}

# put_chunks ID FILE CHUNKSIZE: PUT the file to /api/upload/ID/N, one request per chunk
put_chunks() {
  local id=$1 file=$2 size=$3 i=0 part status
  rm -rf "$WORK/parts" && mkdir "$WORK/parts"
  split -b "$size" -d -a 4 "$file" "$WORK/parts/p"
  for part in "$WORK"/parts/p*; do
    status=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -b "$COOKIES" -H "x-csrf-token: $CSRF" \
      -H 'content-type: application/octet-stream' --data-binary "@$part" "$BASE_URL/api/upload/$id/$i") || fail "chunk $i"
    [ "$status" = 200 ] || fail "chunk $i of upload $id answered $status"
    i=$((i + 1))
  done
}

host_port() { docker port "$1" 3000/tcp | head -n1 | sed 's/.*://'; }

wait_health() {
  local url=$1 i
  for i in $(seq 1 90); do
    if curl -fsS -o /dev/null "$url/api/health" 2>/dev/null; then return 0; fi
    sleep 1
  done
  fail "$url/api/health did not answer in 90 seconds"
}

login() {
  rm -f "$COOKIES"
  CSRF=$(curl -sS -c "$COOKIES" "$BASE_URL/api/session" | json 'd.csrf')
  CSRF=$(api POST /api/login "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" | json 'd.csrf')
  [ -n "$CSRF" ] || fail 'login gave no CSRF token'
}

# the version the running app reports (an admin sees it on /api/health)
running() { api GET /api/health | json 'd.version + " " + d.boot'; }

command -v docker >/dev/null || fail 'docker is not installed'
docker info >/dev/null 2>&1 || fail 'the Docker daemon does not answer (docker info)'
command -v bun >/dev/null || fail 'bun is not installed (used to read JSON and to build the update package)'

# ───────────── 1. build and start
log "build the image ($IMAGE)"
build=(docker build -q -t "$IMAGE")
# a machine that can not reach a Debian mirror builds without the security updates (CI always installs them)
[ "${FC_CI_NO_APT:-}" = "1" ] && build+=(--build-arg APT_UPGRADE=false --build-arg THUMB_TOOLS=false)
if [ -n "${FC_CI_CA_BUNDLE:-}" ]; then
  # a machine whose HTTPS goes through an inspecting proxy: the build trusts this CA bundle too (nothing else changes)
  mkdir "$WORK/ca" && cp "$FC_CI_CA_BUNDLE" "$WORK/ca/ca.crt"
  awk '{ print } /^FROM / { print "COPY --from=extra-ca ca.crt /extra-ca.crt"; print "ENV NODE_EXTRA_CA_CERTS=/extra-ca.crt" }' Dockerfile > "$WORK/Dockerfile"
  build+=(-f "$WORK/Dockerfile" --build-context "extra-ca=$WORK/ca")
fi
"${build[@]}" . >/dev/null
pass 'image builds'

log 'docker-compose.yml carries the same hardening'
for want in 'read_only: true' 'cap_drop: \[ALL\]' 'cap_add: \[CHOWN, SETUID, SETGID, DAC_OVERRIDE\]' 'no-new-privileges:true' 'mem_limit:' 'pids_limit:'; do
  grep -Eq "^ +(- )?$want" docker-compose.yml || fail "docker-compose.yml has no '$want' (HARDEN in this script must match it)"
done
pass 'docker-compose.yml: read_only, cap_drop ALL + 4 caps, no-new-privileges, memory and pids limits'

log 'start on an empty volume'
# update packages must be signed: a throw-away key pair, the container trusts its public key
UPDATE_KEY=$(bun scripts/package.ts --gen-key "$WORK/keys" 2>/dev/null | tail -n1)
[ -f "$WORK/keys/update-signing.key" ] && [ -n "$UPDATE_KEY" ] || fail 'the throw-away signing key was not made'
docker volume create "$PREFIX-data" >/dev/null
docker run -d --name "$PREFIX-main" -p 127.0.0.1::3000 -v "$PREFIX-data:/data" "${HARDEN[@]}" \
  -e ADMIN_PASSWORD="$PASSWORD" -e UPLOAD_CHUNK_SIZE="$CHUNK" -e MIN_FREE_SPACE=0 -e UPDATE_PUBLIC_KEY="$UPDATE_KEY" "$IMAGE" >/dev/null
BASE_URL="http://127.0.0.1:$(host_port "$PREFIX-main")"
wait_health "$BASE_URL"
pass "/api/health answers ($BASE_URL)"

# ───────────── 2. not root
log 'who runs the app'
uid=$(docker exec "$PREFIX-main" awk '/^Uid:/ { print $2 }' /proc/1/status)
[ "$uid" = 1000 ] || fail "PID 1 runs as uid $uid, expected 1000"
pass 'PID 1 (the launcher) runs as uid 1000'
wrong=$(docker exec "$PREFIX-main" find /data ! -uid 1000 | head -n 5)
[ -z "$wrong" ] || fail "files under /data not owned by 1000: $wrong"
pass 'everything under /data belongs to uid 1000'

log 'hardening took effect'
if docker exec "$PREFIX-main" touch /app/should-not-write /etc/should-not-write 2>/dev/null; then
  fail 'a write outside /data succeeded: the root filesystem is not read-only'
fi
docker exec "$PREFIX-main" touch /data/.write-test /tmp/.write-test || fail '/data or /tmp is not writable'
docker exec "$PREFIX-main" rm -f /data/.write-test /tmp/.write-test
pass 'root filesystem is read-only (writes to /app and /etc fail), /data and /tmp are writable'
capeff=$(docker exec "$PREFIX-main" awk '/^CapEff:/ { print $2 }' /proc/1/status)
[ "$capeff" = 0000000000000000 ] || fail "PID 1 has capabilities left (CapEff $capeff), expected 0000000000000000"
pass 'PID 1 has no capabilities after the drop (CapEff 0)'
nnp=$(docker exec "$PREFIX-main" awk '/^NoNewPrivs:/ { print $2 }' /proc/1/status)
[ "$nnp" = 1 ] || fail "no-new-privileges is not set on PID 1 (NoNewPrivs $nnp)"
pass 'no-new-privileges is set on PID 1'

# ───────────── 3. chunked upload and download
log 'upload in chunks and download it back'
login
head -c 2621440 /dev/urandom > "$WORK/blob.bin" # 2.5 MB: three chunks of 1 MB
init=$(api POST /api/upload '{"space":"home","path":"/","name":"blob.bin","size":2621440}')
id=$(printf '%s' "$init" | json 'd.id')
size=$(printf '%s' "$init" | json 'd.chunkSize')
total=$(printf '%s' "$init" | json 'd.total')
[ "$total" -ge 2 ] || fail "expected a chunked upload, the server wants $total chunk(s) of $size bytes"
put_chunks "$id" "$WORK/blob.bin" "$size"
api POST "/api/upload/$id/complete" '{}' >/dev/null
curl -fsS -b "$COOKIES" -o "$WORK/back.bin" "$BASE_URL/api/download?space=home&path=/blob.bin" || fail 'download failed'
cmp "$WORK/blob.bin" "$WORK/back.bin" || fail 'the downloaded file differs from the uploaded one'
pass "uploaded in $total chunks, downloaded byte for byte the same"

# ───────────── 3b. thumbnails
if [ "${FC_CI_NO_APT:-}" = "1" ]; then
  # no tools in the image (no Debian mirror): the app must say so and answer 404 thumb.unavailable, not fail
  log 'thumbnails (the image was built without the tools, FC_CI_NO_APT=1): they must be off, not broken'
  [ "$(api GET /api/thumbs/status | json 'JSON.stringify(d)')" = '{"image":false,"pdf":false,"video":false}' ] \
    || fail "/api/thumbs/status without the tools: $(api GET /api/thumbs/status)"
  status=$(curl -sS -o "$WORK/thumb.out" -w '%{http_code}' -b "$COOKIES" "$BASE_URL/api/thumb?space=home&path=/blob.bin") || fail 'curl thumb'
  [ "$status" = 404 ] || fail "a thumbnail without the tools answered $status, expected 404"
  pass 'without the tools thumbnails are off (status all false, 404 for a file), the rest works'
else
  log 'thumbnails of a jpg, a pdf and an mp4 made by the tools in the image'
  # the test files are made by the image's own tools, as the app's user (uid 1000)
  docker exec -u 1000 "$PREFIX-main" sh -c \
    'ffmpeg -v error -f lavfi -i testsrc=size=800x600:rate=1 -frames:v 1 -y /data/storage/t.jpg &&
     ffmpeg -v error -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -pix_fmt yuv420p -c:v mpeg4 -y /data/storage/t.mp4' \
    || fail 'ffmpeg in the image could not make the test files'
  docker exec -i -u 1000 "$PREFIX-main" sh -c 'cat > /data/storage/t.pdf' <<'PDF'
%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 52 >>
stream
BT /F1 48 Tf 72 700 Td (Hello File Center) Tj ET
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF
PDF
  [ "$(api GET /api/thumbs/status | json 'JSON.stringify(d)')" = '{"image":true,"pdf":true,"video":true}' ] \
    || fail "/api/thumbs/status does not report image, pdf and video as available: $(api GET /api/thumbs/status)"
  # thumb_check FILE MAGIC-HEX (the first bytes of the answer): webp starts with RIFF (52494646), jpeg with ffd8
  thumb_check() {
    local name=$1 magic=$2 status first
    status=$(curl -sS -o "$WORK/thumb.out" -w '%{http_code}' -b "$COOKIES" "$BASE_URL/api/thumb?space=home&path=/$name") || fail "curl thumb $name"
    [ "$status" = 200 ] || fail "thumbnail of $name answered $status: $(head -c 300 "$WORK/thumb.out")"
    first=$(od -An -tx1 -N"$((${#magic} / 2))" "$WORK/thumb.out" | tr -d ' \n')
    [ "$first" = "$magic" ] || fail "thumbnail of $name starts with $first, expected $magic"
    [ "$(stat -c %s "$WORK/thumb.out")" -gt 100 ] || fail "thumbnail of $name is empty"
  }
  thumb_check t.jpg 52494646
  thumb_check t.mp4 52494646
  thumb_check t.pdf ffd8
  [ "$(docker exec "$PREFIX-main" sh -c 'ls /data/system/thumbs | wc -l')" -ge 3 ] || fail 'the thumbnail cache in /data/system/thumbs is empty'
  [ -z "$(docker exec "$PREFIX-main" sh -c 'ls /data/system/thumbs/tmp')" ] || fail '/data/system/thumbs/tmp still holds work files'
  pass 'jpg, pdf and mp4 thumbnails are made inside the container (uid 1000, read-only root), cached in /data/system/thumbs'
fi

# ───────────── 4. update from the web
log 'build and install an update package (99.0.0)'
if [ ! -f web/dist/index.html ]; then
  # this checkout has no built web page: take the one in the image
  DIST_FROM_IMAGE=1
  docker cp "$PREFIX-main:/app/web/dist" web/dist
fi
bun scripts/package.ts --skip-web --version 99.0.0 --out "$WORK/pkg" --sign "$WORK/keys/update-signing.key" >/dev/null
PKG="$WORK/pkg/file-center-99.0.0.zip"
[ -f "$PKG" ] || fail 'the update package was not made'
before=$(running)

# an unsigned package (the same code, no manifest.sig) is refused when staging
bun scripts/package.ts --skip-web --version 99.0.1 --out "$WORK/pkg-unsigned" >/dev/null
UNSIGNED="$WORK/pkg-unsigned/file-center-99.0.1.zip"
[ -f "$UNSIGNED" ] || fail 'the unsigned test package was not made'
init=$(api POST /api/admin/update/upload "{\"size\":$(stat -c %s "$UNSIGNED")}")
uid_=$(printf '%s' "$init" | json 'd.id')
put_chunks "$uid_" "$UNSIGNED" "$(printf '%s' "$init" | json 'd.chunkSize')"
status=$(curl -sS -o "$WORK/reply" -w '%{http_code}' -X POST -b "$COOKIES" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  --data "{\"id\":\"$uid_\"}" "$BASE_URL/api/admin/update/stage") || fail 'curl stage (unsigned)'
[ "$status" = 400 ] && [ "$(json 'd.code' < "$WORK/reply")" = update.unsigned ] || fail "an unsigned package was not refused (status $status): $(cat "$WORK/reply")"
pass 'an unsigned update package is refused (update.unsigned)'

init=$(api POST /api/admin/update/upload "{\"size\":$(stat -c %s "$PKG")}")
id=$(printf '%s' "$init" | json 'd.id')
size=$(printf '%s' "$init" | json 'd.chunkSize')
put_chunks "$id" "$PKG" "$size"
staged=$(api POST /api/admin/update/stage "{\"id\":\"$id\"}")
sid=$(printf '%s' "$staged" | json 'd.id')
[ "$(printf '%s' "$staged" | json 'd.version')" = 99.0.0 ] || fail "staged package is not 99.0.0: $staged"
api POST /api/admin/update/apply "{\"id\":\"$sid\",\"password\":\"$PASSWORD\"}" >/dev/null
now=$before
for _ in $(seq 1 90); do
  sleep 1
  now=$(running 2>/dev/null || true)
  # a new boot time and the new version
  case $now in 99.0.0\ *) [ "$now" != "$before" ] && break ;; esac
done
case $now in 99.0.0\ *) ;; *) fail "after the update the app reports '${now:-nothing}', expected 99.0.0" ;; esac
pass 'update uploaded, staged, applied: the app restarted as 99.0.0'
curl -fsS -b "$COOKIES" -o "$WORK/back2.bin" "$BASE_URL/api/download?space=home&path=/blob.bin" || fail 'download after the update failed'
cmp "$WORK/blob.bin" "$WORK/back2.bin" || fail 'the file changed across the update'
pass 'the uploaded file survived the update'

# ───────────── 5. the way out: FC_RUN_AS_ROOT
log 'FC_RUN_AS_ROOT=true'
docker volume create "$PREFIX-data-root" >/dev/null
docker run -d --name "$PREFIX-root" -p 127.0.0.1::3000 -v "$PREFIX-data-root:/data" "${HARDEN[@]}" \
  -e ADMIN_PASSWORD="$PASSWORD" -e FC_RUN_AS_ROOT=true "$IMAGE" >/dev/null
wait_health "http://127.0.0.1:$(host_port "$PREFIX-root")"
uid=$(docker exec "$PREFIX-root" awk '/^Uid:/ { print $2 }' /proc/1/status)
[ "$uid" = 0 ] || fail "with FC_RUN_AS_ROOT=true PID 1 runs as uid $uid, expected 0"
pass 'FC_RUN_AS_ROOT=true keeps uid 0'
if docker exec "$PREFIX-root" touch /app/should-not-write 2>/dev/null; then fail 'root in the container can write outside /data: read-only is not in effect'; fi
pass 'even as root the root filesystem is read-only'

# ───────────── 6. an older install: /data belongs to root, the entrypoint's one-time chown needs its capabilities
log 'volume owned by root (older install)'
docker volume create "$PREFIX-data-old" >/dev/null
docker run --rm -v "$PREFIX-data-old:/data" --entrypoint /bin/sh "$IMAGE" -c \
  'mkdir -p /data/storage/closed /data/system && echo old > /data/storage/closed/f.txt && chmod 700 /data/storage/closed && chown -R 0:0 /data' >/dev/null
docker run -d --name "$PREFIX-old" -p 127.0.0.1::3000 -v "$PREFIX-data-old:/data" "${HARDEN[@]}" \
  -e ADMIN_PASSWORD="$PASSWORD" "$IMAGE" >/dev/null
wait_health "http://127.0.0.1:$(host_port "$PREFIX-old")"
wrong=$(docker exec "$PREFIX-old" find /data ! -uid 1000 | head -n 5)
[ -z "$wrong" ] || fail "after the one-time chown files under /data are not owned by 1000: $wrong"
pass 'a root-owned volume is handed to uid 1000 with only CHOWN, SETUID, SETGID, DAC_OVERRIDE'
