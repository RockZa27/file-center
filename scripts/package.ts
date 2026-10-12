/**
 * Builds an update package that can be dropped on the web page "อัปเดตระบบ" (admin).
 *
 *   bun run package                      build the web page, bundle the server, write dist-update/file-center-<version>.zip
 *   bun run package --notes "what changed"
 *   bun scripts/package.ts --version 1.2.0 --skip-web     (version defaults to package.json; --skip-web reuses web/dist)
 *   bun run package --gen-key ~/keys      once: make a signing key pair, print the public key for UPDATE_PUBLIC_KEY
 *   bun run package --sign ~/keys/update-signing.key      sign the package (adds manifest.sig)
 *
 * The zip holds server.js (the server with its libraries bundled in), web/ and manifest.json with the SHA-256
 * of every file. Bump "version" in package.json first: the system only accepts a version newer than the running one.
 * manifest.sig is the Ed25519 signature of the exact bytes of manifest.json; a server with UPDATE_PUBLIC_KEY set
 * accepts only packages signed with the matching private key. Keep that key off the server.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { zipSync } from 'fflate'
import pkg from '../package.json'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const KEY_FILE = 'update-signing.key'
const publicKeyLine = (key: KeyObject) => createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')

if (args.includes('--gen-key')) {
  const dir = opt('gen-key')
  if (!dir) throw new Error('usage: bun run package --gen-key <folder>')
  const file = join(resolve(dir), KEY_FILE)
  mkdirSync(resolve(dir), { recursive: true })
  const { privateKey } = generateKeyPairSync('ed25519')
  try {
    // "wx": never overwrite a key, packages signed with it would stop installing
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    console.error(`✗ มีไฟล์กุญแจ ${file} อยู่แล้ว ไม่เขียนทับ (ถ้าต้องการกุญแจใหม่จริง ๆ ให้ย้ายไฟล์เดิมออกก่อน)`)
    process.exit(1)
  }
  chmodSync(file, 0o600)
  console.error(`✓ กุญแจส่วนตัว: ${file} (เก็บไว้กับตัว ห้ามวางบนเซิร์ฟเวอร์)`)
  console.error('  ตั้งค่าใน .env ของเซิร์ฟเวอร์: UPDATE_PUBLIC_KEY=<ข้อความบรรทัดล่าง>')
  // the only line on stdout, so it can be piped
  console.log(publicKeyLine(privateKey))
  process.exit(0)
}

let signingKey: KeyObject | undefined
if (args.includes('--sign')) {
  const keyFile = opt('sign')
  if (!keyFile) throw new Error('usage: bun run package --sign <private key file>')
  signingKey = createPrivateKey(readFileSync(resolve(keyFile)))
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error(`${keyFile} is not an Ed25519 key (make one with --gen-key)`)
}

const version = opt('version') ?? pkg.version
const notes = opt('notes') ?? ''
const outDir = resolve(opt('out') ?? join(root, 'dist-update'))
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 1.2.3 (got "${version}")`)

if (!args.includes('--skip-web')) {
  console.log('• build หน้าเว็บ')
  const r = Bun.spawnSync(['bun', '--bun', 'run', 'build'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1)
}
const webDist = join(root, 'web', 'dist')
if (!statSync(join(webDist, 'index.html'), { throwIfNoEntry: false })) throw new Error('web/dist/index.html not found: run without --skip-web')

console.log('• รวมโค้ดเซิร์ฟเวอร์เป็นไฟล์เดียว')
const tmp = join(outDir, '.build')
rmSync(tmp, { recursive: true, force: true })
const built = await Bun.build({ entrypoints: [join(root, 'src', 'index.ts')], target: 'bun', outdir: tmp, naming: 'server.js' })
if (!built.success) {
  for (const l of built.logs) console.error(l)
  process.exit(1)
}

const files: Record<string, Uint8Array> = { 'server.js': new Uint8Array(readFileSync(join(tmp, 'server.js'))) }
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs)
    else files[`web/${relative(webDist, abs).split(sep).join('/')}`] = new Uint8Array(readFileSync(abs))
  }
}
walk(webDist)

const manifest = {
  name: 'file-center',
  version,
  builtAt: new Date().toISOString(),
  notes,
  files: Object.fromEntries(Object.entries(files).map(([path, data]) => [
    path, { size: data.length, sha256: new Bun.CryptoHasher('sha256').update(data).digest('hex') },
  ])),
}

const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2))
const entries: Record<string, Uint8Array> = { 'manifest.json': manifestBytes, ...files }
if (signingKey) entries['manifest.sig'] = new TextEncoder().encode(sign(null, manifestBytes, signingKey).toString('base64'))
mkdirSync(outDir, { recursive: true })
const out = join(outDir, `file-center-${version}.zip`)
writeFileSync(out, zipSync(entries, { level: 6 }))
rmSync(tmp, { recursive: true, force: true })
console.log(`✓ ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, ${Object.keys(files).length} ไฟล์)`)
console.log(signingKey ? `  เซ็นแล้ว ตรงกับ UPDATE_PUBLIC_KEY=${publicKeyLine(signingKey)}` : '  ไม่ได้เซ็น (เซิร์ฟเวอร์ที่ตั้ง UPDATE_PUBLIC_KEY จะไม่รับ)')
