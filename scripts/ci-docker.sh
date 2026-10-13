#!/usr/bin/env bash
# The real image, end to end (used by .github/workflows/qa.yml, and runnable on any machine with Docker and Bun):
#
#   1. build the image, start it on an empty volume with ADMIN_PASSWORD, wait for /api/health
#   2. the app (PID 1) runs as uid 1000 and everything under /data belongs to 1000
#   3. log in, upload a file in chunks, download it back: byte for byte the same
#   4. build an update package (99.0.0), install it through /api/admin/update/upload|stage|apply,
#      wait for the restart: the version is 99.0.0
#   5. a second container with FC_RUN_AS_ROOT=true runs as uid 0
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

log()  { printf '== %s\n' "$*"; }
pass() { RESULTS+=("PASS  $*"); printf '   ok: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; show_logs; exit 1; }

show_logs() {
  local c
  for c in "$PREFIX-main" "$PREFIX-root"; do
    if docker inspect "$c" >/dev/null 2>&1; then
      printf -- '--- logs of %s (last 60 lines)\n' "$c" >&2
      docker logs --tail 60 "$c" >&2 || true
    fi
  done
}

cleanup() {
  local code=$?
  set +e
  docker rm -f "$PREFIX-main" "$PREFIX-root" >/dev/null 2>&1
  docker volume rm -f "$PREFIX-data" "$PREFIX-data-root" >/dev/null 2>&1
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
if [ -n "${FC_CI_CA_BUNDLE:-}" ]; then
  # a machine whose HTTPS goes through an inspecting proxy: the build trusts this CA bundle too (nothing else changes)
  mkdir "$WORK/ca" && cp "$FC_CI_CA_BUNDLE" "$WORK/ca/ca.crt"
  awk '{ print } /^FROM / { print "COPY --from=extra-ca ca.crt /extra-ca.crt"; print "ENV NODE_EXTRA_CA_CERTS=/extra-ca.crt" }' Dockerfile > "$WORK/Dockerfile"
  build+=(-f "$WORK/Dockerfile" --build-context "extra-ca=$WORK/ca")
fi
"${build[@]}" . >/dev/null
pass 'image builds'

log 'start on an empty volume'
docker volume create "$PREFIX-data" >/dev/null
docker run -d --name "$PREFIX-main" -p 127.0.0.1::3000 -v "$PREFIX-data:/data" \
  -e ADMIN_PASSWORD="$PASSWORD" -e UPLOAD_CHUNK_SIZE="$CHUNK" -e MIN_FREE_SPACE=0 "$IMAGE" >/dev/null
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

# ───────────── 4. update from the web
log 'build and install an update package (99.0.0)'
if [ ! -f web/dist/index.html ]; then
  # this checkout has no built web page: take the one in the image
  DIST_FROM_IMAGE=1
  docker cp "$PREFIX-main:/app/web/dist" web/dist
fi
bun scripts/package.ts --skip-web --version 99.0.0 --out "$WORK/pkg" >/dev/null
PKG="$WORK/pkg/file-center-99.0.0.zip"
[ -f "$PKG" ] || fail 'the update package was not made'
before=$(running)
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
docker run -d --name "$PREFIX-root" -p 127.0.0.1::3000 -v "$PREFIX-data-root:/data" \
  -e ADMIN_PASSWORD="$PASSWORD" -e FC_RUN_AS_ROOT=true "$IMAGE" >/dev/null
wait_health "http://127.0.0.1:$(host_port "$PREFIX-root")"
uid=$(docker exec "$PREFIX-root" awk '/^Uid:/ { print $2 }' /proc/1/status)
[ "$uid" = 0 ] || fail "with FC_RUN_AS_ROOT=true PID 1 runs as uid $uid, expected 0"
pass 'FC_RUN_AS_ROOT=true keeps uid 0'
