/**
 * scripts/docker-entrypoint.sh without Docker: /data is a temp folder (FC_DATA_ROOT), and id, chown, setpriv and su
 * are small stand-ins on PATH that write down how they were called. `id` plays root or another user, and knows the
 * user bun (uid 1000 in the image) under whatever uid the test picks, so "owned by bun" can be set up without root.
 * setpriv and su then run the command as they would, so the test sees what the CMD gets.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, '..', 'scripts', 'docker-entrypoint.sh')
const base = mkdtempSync(join(tmpdir(), 'fc-entry-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const STUBS: Record<string, string> = {
  id: `echo "id $*" >> "$STUB_LOG"
if [ "$#" -eq 2 ] && [ "$1" = -u ]; then
  [ "$2" = bun ] && [ -n "\${STUB_BUN_UID:-}" ] && { echo "$STUB_BUN_UID"; exit 0; }
  echo "id: '$2': no such user" >&2; exit 1
fi
echo "$STUB_UID"`,
  chown: 'echo "chown $*" >> "$STUB_LOG"',
  setpriv: `echo "setpriv $*" >> "$STUB_LOG"
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
exec "$@"`,
  // su -s /bin/sh -c <command> <user> <args>: the shell gets the command and the args
  su: `echo "su $*" >> "$STUB_LOG"
[ "$1" = -s ] && [ "$3" = -c ] || exit 99
shell=$2 cmd=$4
shift 5
exec "$shell" -c "$cmd" "$@"`,
}

// stat that reports STUB_FAKE_UID for the one path STUB_FAKE_PATH and is the real one for everything else: where
// the test is not root it can not chown a folder to another owner, so it makes the script see one
const FAKE_STAT = `if [ "\${STUB_FAKE_PATH:-}" ] && [ "$#" -eq 3 ] && [ "$1" = -c ] && [ "$2" = %u ] && [ "$3" = "$STUB_FAKE_PATH" ]; then
  echo "$STUB_FAKE_UID"; exit 0
fi
exec "$REAL_STAT" "$@"`

/** a PATH with the stand-ins and only the real tools the script needs; `setpriv: false` leaves setpriv out */
function binDir(withSetpriv: boolean) {
  const bin = mkdtempSync(join(base, 'bin-'))
  for (const [name, body] of Object.entries(STUBS)) {
    if (name === 'setpriv' && !withSetpriv) continue
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  for (const tool of ['sh', 'mkdir', 'awk']) symlinkSync(Bun.which(tool)!, join(bin, tool))
  writeFileSync(join(bin, 'stat'), `#!/bin/sh\n${FAKE_STAT}\n`)
  chmodSync(join(bin, 'stat'), 0o755)
  return bin
}
const BIN = binDir(true)
const BIN_NO_SETPRIV = binDir(false)

type Run = { code: number; pid: number; out: string; err: string; calls: string[] }

/** the entrypoint with the CMD `sh -c 'echo ...' cmd "two words" x`: prints its pid, args and HOME */
function run(env: Record<string, string>, opts: { bin?: string } = {}): Run {
  const log = join(base, `calls-${Math.random().toString(36).slice(2)}.log`)
  writeFileSync(log, '')
  const p = Bun.spawnSync(['sh', SCRIPT, 'sh', '-c', 'echo "pid=$$ args=$#:$1|$2"', 'cmd', 'two words', 'x'], {
    env: { PATH: opts.bin ?? BIN, REAL_STAT: Bun.which('stat')!, STUB_LOG: log, STUB_UID: '0', HOME: '/root', ...env },
  })
  const out = p.stdout.toString()
  return {
    code: p.exitCode ?? -1,
    pid: p.pid,
    out,
    err: p.stderr.toString(),
    calls: readFileSync(log, 'utf8').split('\n').filter(l => l && !l.startsWith('id ')),
  }
}

/** a /data as an older install leaves it */
function dataRoot() {
  const d = mkdtempSync(join(base, 'data-'))
  mkdirSync(join(d, 'system'))
  mkdirSync(join(d, 'storage'))
  writeFileSync(join(d, 'system', 'users.json'), '{}')
  return d
}
const owner = (abs: string) => String(statSync(abs).uid)
const notOwner = (abs: string) => String(statSync(abs).uid + 4242)

describe('docker entrypoint', () => {
  test('is valid POSIX sh', () => {
    const p = Bun.spawnSync(['sh', '-n', SCRIPT])
    expect(p.stderr.toString()).toBe('')
    expect(p.exitCode).toBe(0)
  })

  test('as root on data of an older install: hands /data to bun once, then runs the CMD as bun in its own process', () => {
    const data = dataRoot()
    const r = run({ FC_DATA_ROOT: data, STUB_BUN_UID: notOwner(data) })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.calls).toEqual([
      `chown -R bun:bun ${data}`,
      'setpriv --reuid=bun --regid=bun --init-groups -- sh -c echo "pid=$$ args=$#:$1|$2" cmd two words x',
    ])
    // the arguments arrive untouched, and the CMD replaced the entrypoint: signals to it reach the launcher
    expect(r.out).toContain(`pid=${r.pid} args=2:two words|x`)
  })

  test('data that already belongs to bun is not chowned again', () => {
    const data = dataRoot()
    const r = run({ FC_DATA_ROOT: data, STUB_BUN_UID: owner(data) })
    expect(r.code).toBe(0)
    expect(r.calls).toEqual(['setpriv --reuid=bun --regid=bun --init-groups -- sh -c echo "pid=$$ args=$#:$1|$2" cmd two words x'])
    expect(r.out).toContain(`pid=${r.pid} args=2:two words|x`)
  })

  test('a folder right under /data that is not bun\'s yet is enough to chown', () => {
    const data = dataRoot()
    // only root can give a folder to another owner; elsewhere the stand-in stat reports one for that folder
    const env: Record<string, string> = {}
    if (process.getuid?.() === 0) chownSync(join(data, 'system'), 4242, 4242)
    else Object.assign(env, { STUB_FAKE_PATH: join(data, 'system'), STUB_FAKE_UID: '4242' })
    const r = run({ FC_DATA_ROOT: data, STUB_BUN_UID: owner(data), ...env })
    expect(r.calls[0]).toBe(`chown -R bun:bun ${data}`)
  })

  test('a missing /data is made, then given to bun', () => {
    const data = join(mkdtempSync(join(base, 'empty-')), 'data')
    const r = run({ FC_DATA_ROOT: data, STUB_BUN_UID: '4242' })
    expect(r.code).toBe(0)
    expect(statSync(data).isDirectory()).toBe(true)
    expect(r.calls[0]).toBe(`chown -R bun:bun ${data}`)
  })

  test('FC_RUN_AS_ROOT=true keeps root: no chown, no drop', () => {
    const data = dataRoot()
    const r = run({ FC_DATA_ROOT: data, STUB_BUN_UID: notOwner(data), FC_RUN_AS_ROOT: 'true' })
    expect(r.code).toBe(0)
    expect(r.calls).toEqual([])
    expect(r.out).toContain(`pid=${r.pid} args=2:two words|x`)
    // anything but exactly "true" does not count
    expect(run({ FC_DATA_ROOT: data, STUB_BUN_UID: notOwner(data), FC_RUN_AS_ROOT: '1' }).calls[0]).toBe(`chown -R bun:bun ${data}`)
  })

  test('started as another user (compose user:): runs the CMD as it is', () => {
    const data = dataRoot()
    const r = run({ FC_DATA_ROOT: data, STUB_BUN_UID: notOwner(data), STUB_UID: '1000' })
    expect(r.code).toBe(0)
    expect(r.calls).toEqual([])
    expect(r.out).toContain(`pid=${r.pid} args=2:two words|x`)
  })

  test('without setpriv it drops to bun with su', () => {
    const data = dataRoot()
    const r = run({ FC_DATA_ROOT: data, STUB_BUN_UID: owner(data) }, { bin: BIN_NO_SETPRIV })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.calls).toEqual(['su -s /bin/sh -c exec "$0" "$@" bun sh -c echo "pid=$$ args=$#:$1|$2" cmd two words x'])
    expect(r.out).toContain('args=2:two words|x')
  })

  test('an image without the user bun stops instead of running as root', () => {
    const data = dataRoot()
    const r = run({ FC_DATA_ROOT: data, STUB_BUN_UID: '' })
    expect(r.code).toBe(1)
    expect(r.calls).toEqual([])
    expect(r.out).not.toContain('pid=')
    expect(r.err).toContain('FC_RUN_AS_ROOT=true')
  })

  test('the Dockerfile uses it as ENTRYPOINT with the launcher as CMD and keeps the health check', () => {
    const dockerfile = readFileSync(resolve(import.meta.dir, '..', 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/file-center-entrypoint')
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/file-center-entrypoint"]')
    expect(dockerfile).toContain('CMD ["bun", "src/launcher.ts"]')
    expect(dockerfile).toMatch(/HEALTHCHECK[^\n]*\n\s*CMD bun -e .*\/api\/health/)
    // the image runs as root so that the entrypoint can chown: no USER line
    expect(dockerfile).not.toMatch(/^USER /m)
  })
})

// the container hardening and the security job are plain text files: pin what the README promises
describe('hardening and security job', () => {
  const root = resolve(import.meta.dir, '..')
  const read = (f: string) => readFileSync(join(root, f), 'utf8')

  test('the runtime stage is the slim image, the build stage is unchanged', () => {
    const froms = read('Dockerfile').split('\n').filter(l => l.startsWith('FROM '))
    expect(froms).toEqual(['FROM oven/bun:1.4.2 AS build', 'FROM oven/bun:1.4.2-slim'])
  })

  test('compose: read-only root, only /data and a tmpfs /tmp writable, no capabilities but the entrypoint needs', () => {
    const app = read('docker-compose.yml').split(/^  cloudflared:/m)[0]
    expect(app).toMatch(/^ +read_only: true$/m)
    expect(app).toMatch(/^ +- \/tmp:/m)
    expect(app).toMatch(/^ +cap_drop: \[ALL\]$/m)
    expect(app).toMatch(/^ +cap_add: \[CHOWN, SETUID, SETGID, DAC_OVERRIDE\]$/m)
    expect(app).toMatch(/^ +- no-new-privileges:true$/m)
    expect(app).toMatch(/^ +mem_limit: \$\{FC_MEMORY_LIMIT:-\w+\}$/m)
    expect(app).toMatch(/^ +pids_limit: \$\{FC_PIDS_LIMIT:-\d+\}$/m)
    // the only volume is /data
    expect(app.match(/^ +- \.\/data:\/data$/gm)?.length).toBe(1)
  })

  test('the entrypoint uses no other privileged tool than chown and setpriv', () => {
    const sh = read('scripts/docker-entrypoint.sh').replace(/^\s*#.*$/gm, '')
    for (const tool of ['mount', 'chmod', 'setcap', 'iptables', 'mknod']) expect(sh).not.toContain(tool)
  })

  test('workflow: security job audits, runs Trivy on repo and image with the HIGH/CRITICAL fixable gate, actions pinned', () => {
    const wf = read('.github/workflows/qa.yml')
    const job = wf.split(/^  security:/m)[1] ?? ''
    expect(job).toContain('bun audit --audit-level=high')
    expect(job).toMatch(/scan-type: fs/)
    expect(job).toMatch(/scan-type: image/)
    expect(job).toContain('scanners: vuln,secret,misconfig')
    expect(job.match(/severity: HIGH,CRITICAL/g)?.length).toBe(2)
    expect(job.match(/ignore-unfixed: true/g)?.length).toBe(4)
    expect(job.match(/exit-code: "1"/g)?.length).toBe(2)
    expect(job).toContain('format: sarif')
    expect(job).toContain('name: security-results')
    // every action: a full version (vX.Y.Z), none of the Node 20 majors
    const uses = [...wf.matchAll(/uses: (\S+)@(\S+)/g)]
    expect(uses.length).toBeGreaterThan(8)
    for (const [, name, ver] of uses) expect(`${name}@${ver}`).toMatch(/@v\d+\.\d+\.\d+$/)
    expect(wf).not.toMatch(/checkout@v4|upload-artifact@v4|setup-bun@v2\.0/)
  })

  test('.trivyignore: every entry has a reason comment right above it', () => {
    let reason = false
    let entries = 0
    for (const line of read('.trivyignore').split('\n')) {
      if (line.startsWith('#')) reason = true
      else if (line.trim() === '') reason = false
      else {
        entries++
        expect(reason).toBe(true)
      }
    }
    expect(entries).toBeGreaterThan(0)
  })

  test('ci-docker.sh checks read-only root, empty capabilities and no-new-privileges', () => {
    const sh = read('scripts/ci-docker.sh')
    expect(sh).toContain('--read-only')
    expect(sh).toContain('CapEff')
    expect(sh).toContain('NoNewPrivs')
    expect(sh).toContain('FC_RUN_AS_ROOT=true')
  })
})
