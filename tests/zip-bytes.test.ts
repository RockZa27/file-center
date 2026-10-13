/**
 * zipStream (src/zip.ts) at the deflate level it uses now (1.8: level 1): every archive must extract to the same bytes,
 * through File Center's own unzipTo and through an independent reader, and compressible files must still shrink.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import './in-process-env'

const work = mkdtempSync(join(tmpdir(), 'fc-zipbytes-'))
let zip: typeof import('../src/zip')
afterAll(() => rmSync(work, { recursive: true, force: true }))
beforeAll(async () => { zip = await import('../src/zip') })

const text = (n: number) => 'The quick brown fox, สวัสดีครับ 12345\n'.repeat(Math.ceil(n / 30)).slice(0, n)
const noise = (n: number) => crypto.getRandomValues(new Uint8Array(n))

async function collect(s: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  const r = s.getReader()
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

test('files of every size class extract byte for byte, and text shrinks', async () => {
  const src = join(work, 'src')
  mkdirSync(join(src, 'sub', 'deep'), { recursive: true })
  const files: Record<string, Uint8Array> = {
    'empty.txt': new Uint8Array(0),
    'one.txt': Buffer.from('x'),
    'small-text.txt': Buffer.from(text(1500)),
    'small-noise.bin': noise(3000),
    'ไทย ชื่อ.txt': Buffer.from(text(40_000)),
    'sub/mid-text.log': Buffer.from(text(200_000)),
    'sub/just-over-1mb.txt': Buffer.from(text(1024 * 1024 + 1)),
    'sub/deep/big-text.csv': Buffer.from(text(2_500_000)),
    // over 1 MB, so the sample decides: noise is stored
    'sub/deep/big-noise.dat': noise(1_300_000),
    'already.zip': noise(5000),
  }
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(src, name), bytes)
  const items = zip.collectZipItems(src, ['empty.txt', 'one.txt', 'small-text.txt', 'small-noise.bin', 'ไทย ชื่อ.txt', 'sub', 'already.zip'])
  const archive = await collect(zip.zipStream(items))

  // an independent reader
  const read = unzipSync(new Uint8Array(archive))
  for (const [name, bytes] of Object.entries(files)) expect(Buffer.compare(Buffer.from(read[name]), Buffer.from(bytes))).toBe(0)

  // File Center's own extraction, which also checks every CRC
  const zipAbs = join(work, 'a.zip')
  writeFileSync(zipAbs, archive)
  const out = join(work, 'out')
  mkdirSync(out)
  const n = await zip.unzipTo(zipAbs, out, { maxBytes: 100 * 1024 ** 2, maxFiles: 100 })
  expect(n).toBe(Object.keys(files).length)
  for (const [name, bytes] of Object.entries(files)) expect(Buffer.compare(readFileSync(join(out, name)), Buffer.from(bytes))).toBe(0)

  // compressible data still shrinks a lot, noise does not grow beyond the headers
  const total = Object.values(files).reduce((a, b) => a + b.length, 0)
  const noiseTotal = 3000 + 1_300_000 + 5000
  const textTotal = total - noiseTotal
  expect(archive.length).toBeLessThan(noiseTotal + textTotal * 0.1)
})
