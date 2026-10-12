/**
 * Publishes an update package in the git branch `updates`, where servers with UPDATE_SOURCE find it.
 *
 *   bun run release                         build file-center-<version>.zip and commit it to the local branch `updates`
 *   bun run release --notes "what changed" --sign ~/keys/update-signing.key --push      ...and push it to origin
 *   (--skip-web reuses web/dist instead of building the page again)
 *
 * Refuses unless the working tree is clean (the package must be exactly the commit it names) and package.json's
 * version is newer than every version already in `updates`. The package is built by scripts/package.ts. The branch
 * is changed in a temporary git worktree, so the checkout you work in is never touched; it holds only packages:
 *
 *   file-center-<version>.zip   one per release, kept so an older one can still be downloaded by hand
 *   SHA256SUMS                  of every zip ("sha256sum -c SHA256SUMS")
 *   README.md                   a table of the versions, in Thai (the branch page on GitHub shows it)
 *   latest.json                 the newest one, read by the update page: { version, file, sha256, size, builtAt, commit, notes, signed }
 */
import { copyFileSync, constants as FS, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { compareVersions, isVersion } from '../src/release'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const BRANCH = 'updates'
const LOCAL = `refs/heads/${BRANCH}`
const REMOTE = `refs/remotes/origin/${BRANCH}`
const ZIP = /^file-center-(\d+\.\d+\.\d+)\.zip$/

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function run(cmd: string[], cwd = root) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}
/** git that must work; its own message says why when it does not */
function git(a: string[], cwd = root): string {
  const r = run(['git', ...a], cwd)
  if (!r.ok) throw new Error(`git ${a.join(' ')}: ${r.err || r.out}`)
  return r.out
}
const commitOf = (ref: string) => {
  const r = run(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.ok ? r.out : null
}
const isAncestor = (a: string, b: string) => run(['git', 'merge-base', '--is-ancestor', a, b]).ok

const notes = (opt('notes') ?? '').trim()
const signKey = args.includes('--sign') ? opt('sign') : undefined
if (args.includes('--sign') && !signKey) fail('usage: bun run release --sign <private key file>')
const push = args.includes('--push')

// ── the source: exactly one commit, nothing on top of it
if (!run(['git', 'rev-parse', '--git-dir']).ok) fail(`${root} is not a git repository`)
const dirty = git(['status', '--porcelain'])
if (dirty) fail(`มีไฟล์ที่ยังไม่ได้ commit ให้ commit หรือเก็บออกก่อน (แพ็กเกจต้องตรงกับ commit ที่ระบุ):\n${dirty}`)
const version = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
if (!isVersion(version)) fail(`version ใน package.json ต้องอยู่ในรูปแบบ x.y.z (ได้ "${version}")`)
const commit = git(['rev-parse', '--short', 'HEAD'])
const sourceBranch = run(['git', 'symbolic-ref', '--short', '-q', 'HEAD']).out

// ── the branch: the newest of the local one and origin's, so a fresh clone does not start a second history
if (run(['git', 'remote', 'get-url', 'origin']).ok) {
  const f = run(['git', 'fetch', '--quiet', 'origin', `+${LOCAL}:${REMOTE}`])
  if (!f.ok && !/couldn't find remote ref/i.test(f.err)) console.warn(`! ดึง branch ${BRANCH} จาก origin ไม่ได้ ใช้ที่มีในเครื่อง: ${f.err}`)
}
let local = commitOf(LOCAL)
const remote = commitOf(REMOTE)
if (remote && local !== remote) {
  if (!local) git(['branch', '--no-track', BRANCH, remote])
  else if (isAncestor(local, remote)) git(['update-ref', LOCAL, remote, local])
  else if (!isAncestor(remote, local)) fail(`branch ${BRANCH} ในเครื่องกับของ origin แยกกันไปคนละทาง ให้แก้ด้วยมือก่อน`)
  local = commitOf(LOCAL)
}

// ── newer than everything already published
const published: string[] = []
if (local) {
  for (const name of git(['ls-tree', '--name-only', local]).split('\n')) {
    const m = ZIP.exec(name)
    if (m && isVersion(m[1])) published.push(m[1])
  }
  const latest = run(['git', 'show', `${local}:latest.json`])
  if (latest.ok) {
    try {
      const v = JSON.parse(latest.out).version
      if (isVersion(v)) published.push(v)
    } catch { /* a broken latest.json is rewritten below */ }
  }
}
const newest = published.sort(compareVersions).at(-1)
if (newest && compareVersions(version, newest) <= 0) {
  fail(`เวอร์ชัน ${version} ไม่ใหม่กว่า ${newest} ที่มีใน branch ${BRANCH} แล้ว ให้เพิ่ม version ใน package.json ก่อน`)
}

const sha256 = (file: string) => new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex')
/** one table cell: no line breaks, no column separators */
const cell = (s: string) => s.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim()

const TABLE_HEADER = '| เวอร์ชัน | ไฟล์ | สร้างจาก commit | หมายเหตุ | เซ็น |'
const README = `# แพ็กเกจอัปเดต File Center

branch นี้เก็บเฉพาะไฟล์แพ็กเกจอัปเดต (ไม่มีโค้ด) สร้างด้วย \`bun run release\` ใช้กับเมนู **อัปเดตระบบ** ในเว็บ (บัญชีผู้ดูแล) ไม่ต้อง FTP และไม่ต้องปิดระบบ

${TABLE_HEADER}
|---|---|---|---|---|

## วิธีอัปเดต
- เซิร์ฟเวอร์ที่ตั้ง \`UPDATE_SOURCE\` ไว้ที่ branch นี้: เมนู "อัปเดตระบบ" → กดตรวจหาอัปเดต → ดาวน์โหลด → ใส่รหัสผ่านอีกครั้งแล้วกดติดตั้ง
- หรือดาวน์โหลดไฟล์ .zip จากตารางด้านบน (ตรวจด้วย \`sha256sum -c SHA256SUMS\` ได้) แล้วลากไปวางในเมนู "อัปเดตระบบ"
- ระบบรีสตาร์ตเองภายในไม่กี่วินาที ถ้าเวอร์ชันใหม่เปิดไม่ขึ้นจะย้อนกลับเวอร์ชันเดิมให้อัตโนมัติ

## ข้อควรรู้
- หน้าอัปเดตรับเฉพาะเวอร์ชันที่ใหม่กว่าที่ติดตั้งอยู่
- เซิร์ฟเวอร์ที่ตั้ง \`UPDATE_PUBLIC_KEY\` ไว้รับเฉพาะแพ็กเกจที่เซ็นด้วยกุญแจที่ตรงกัน (คอลัมน์ "เซ็น")
- \`latest.json\` บอกเวอร์ชันล่าสุด หน้าอัปเดตอ่านไฟล์นี้
`

/** add the new version as the first row of the versions table; a table without the "เซ็น" column gets one */
function addRow(readme: string, row: string): string {
  const lines = readme.split('\n')
  let at = lines.findIndex(l => /^\|\s*เวอร์ชัน\s*\|/.test(l))
  if (at < 0) {
    lines.push('', TABLE_HEADER, '|---|---|---|---|---|')
    at = lines.length - 2
  } else if (!lines[at].includes('เซ็น')) {
    // older rows: whether they were signed is not known here
    lines[at] = `${lines[at].trimEnd()} เซ็น |`
    for (let i = at + 1; i < lines.length && lines[i].startsWith('|'); i++) lines[i] = `${lines[i].trimEnd()}${i === at + 1 ? '---|' : ' - |'}`
  }
  lines.splice(at + 2, 0, row)
  return lines.join('\n')
}

const tmp = mkdtempSync(join(tmpdir(), 'fc-release-'))
const out = join(tmp, 'out')
const tree = join(tmp, BRANCH)
let failure: Error | null = null
try {
  // ── build, with the script that builds every package
  const build = Bun.spawnSync([
    process.execPath, join(root, 'scripts', 'package.ts'), '--version', version, '--out', out, '--notes', notes,
    ...(signKey ? ['--sign', resolve(signKey)] : []), ...(args.includes('--skip-web') ? ['--skip-web'] : []),
  ], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if (build.exitCode !== 0) throw new Error('scripts/package.ts failed')
  const file = `file-center-${version}.zip`
  const zip = join(out, file)
  const inside = unzipSync(new Uint8Array(readFileSync(zip)), { filter: f => f.name === 'manifest.json' || f.name === 'manifest.sig' })
  const manifest = JSON.parse(new TextDecoder().decode(inside['manifest.json']))
  const signed = 'manifest.sig' in inside

  // ── the branch, in a worktree of its own
  if (local) git(['worktree', 'add', '--quiet', tree, BRANCH])
  else {
    // a branch with no history and none of the source's files
    git(['worktree', 'add', '--quiet', '--detach', tree, 'HEAD'])
    git(['checkout', '--quiet', '--orphan', BRANCH], tree)
    git(['rm', '-r', '-f', '--quiet', '--ignore-unmatch', '.'], tree)
  }
  copyFileSync(zip, join(tree, file), FS.COPYFILE_EXCL)
  const zips = readdirSync(tree).filter(n => ZIP.test(n)).sort((a, b) => compareVersions(ZIP.exec(a)![1], ZIP.exec(b)![1]))
  writeFileSync(join(tree, 'SHA256SUMS'), zips.map(n => `${sha256(join(tree, n))}  ${n}\n`).join(''))
  const readmeFile = join(tree, 'README.md')
  const from = `\`${commit}\`${sourceBranch ? ` (${sourceBranch})` : ''}`
  const row = `| ${version} | [${file}](${file}) | ${from} | ${cell(notes) || '-'} | ${signed ? 'ใช่' : 'ไม่'} |`
  writeFileSync(readmeFile, addRow(existsSync(readmeFile) ? readFileSync(readmeFile, 'utf8') : README, row))
  const latest = {
    version, file, sha256: sha256(zip), size: statSync(zip).size, builtAt: String(manifest.builtAt ?? ''), commit, notes, signed,
  }
  writeFileSync(join(tree, 'latest.json'), JSON.stringify(latest, null, 2) + '\n')
  git(['add', '-A'], tree)
  git(['commit', '--quiet', '-m', `Update package ${version} (built from ${sourceBranch || 'commit'} ${commit})`], tree)
  console.log(`✓ ${file} อยู่ใน branch ${BRANCH} แล้ว (sha256 ${latest.sha256}, ${signed ? 'เซ็นแล้ว' : 'ไม่ได้เซ็น'})`)

  if (push) {
    git(['push', '--quiet', 'origin', BRANCH])
    console.log(`✓ push ${BRANCH} ไปที่ origin แล้ว`)
  } else console.log(`  ยังไม่ได้ push: ตรวจแล้วสั่ง "git push origin ${BRANCH}" หรือครั้งหน้าใช้ --push`)
} catch (e) {
  failure = e as Error
} finally {
  // whatever happened: no worktree and no temp files are left behind (process.exit would skip this, so fail after)
  run(['git', 'worktree', 'remove', '--force', tree])
  rmSync(tmp, { recursive: true, force: true })
  run(['git', 'worktree', 'prune'])
}
if (failure) fail(failure.message)
