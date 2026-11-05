/**
 * Encryption of backups, opt-in with BACKUP_ENCRYPTION_KEY (32 random bytes as base64url, 43 characters). The key lives
 * in the environment only: never in DATA_DIR, a backup, a log or an API answer.
 *
 * File format (`file-center-backup-YYYYMMDD-HHMMSS.zip.enc`), version 1:
 *
 *   header (21 bytes)  "FCBK" magic | version byte (1) | key id (first 8 bytes of SHA-256 of the key) | nonce prefix (8 random bytes)
 *   chunk 0, chunk 1 ...  the zip cut in pieces of CHUNK.size bytes (the last one 1..size, an empty zip is one empty chunk),
 *                          each sealed with AES-256-GCM and followed by its 16-byte tag
 *
 *   nonce of chunk n = nonce prefix | n as 32-bit big-endian
 *   additional authenticated data = the whole header | n as 32-bit big-endian | one byte, 1 for the last chunk, else 0
 *
 * The header and the position are in the AAD, so a chunk moved, dropped, repeated or cut off, or bytes added at the end,
 * fail to open (the chunk now at the end was not sealed as the last one). Both directions work on streams: nothing is
 * ever held beyond two chunks, and no plaintext zip is written for a backup.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, openSync, rmSync, writeSync } from 'node:fs'

/** tests lower `size`; a file is only opened with the size it was made with */
export const CHUNK = { size: 1024 * 1024 }
const MAGIC = Buffer.from('FCBK')
const VERSION = 1
const HEADER_LEN = MAGIC.length + 1 + 8 + 8
const TAG_LEN = 16

export class BackupCryptError extends Error {
  constructor(readonly code: 'backup.key-wrong' | 'backup.damaged') {
    super(code)
  }
}

export type KeyState = { state: 'off' } | { state: 'invalid' } | { state: 'on'; key: Buffer }

/** the key of the environment as it is now (read every time: nothing keeps a copy) */
export function backupKeyState(): KeyState {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim()
  if (!raw) return { state: 'off' }
  const key = /^[A-Za-z0-9_-]{43}$/.test(raw) ? Buffer.from(raw, 'base64url') : null
  // 43 characters can carry spare bits: only the canonical text of 32 bytes counts
  return key && key.length === 32 && key.toString('base64url') === raw ? { state: 'on', key } : { state: 'invalid' }
}

/** a fresh key to put in .env */
export const newBackupKey = () => randomBytes(32).toString('base64url')

const keyIdOf = (key: Buffer) => createHash('sha256').update(key).digest().subarray(0, 8)

const counter = (n: number) => {
  if (n > 0xffffffff) throw new BackupCryptError('backup.damaged')
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

/** reads `source` piece by piece; `fill(n)` waits until more than n bytes are held or the source ended */
function buffered(source: ReadableStream<Uint8Array>) {
  const reader = source.getReader()
  let acc: Buffer = Buffer.alloc(0)
  let done = false
  return {
    get done() { return done },
    get held() { return acc.length },
    async fill(n: number) {
      while (acc.length <= n && !done) {
        const r = await reader.read()
        if (r.done) done = true
        else if (r.value.length) acc = acc.length ? Buffer.concat([acc, r.value]) : Buffer.from(r.value.buffer, r.value.byteOffset, r.value.length)
      }
    },
    take(n: number) {
      const out = acc.subarray(0, n)
      acc = acc.subarray(n)
      return out
    },
    cancel: (reason?: unknown) => reader.cancel(reason).catch(() => {}),
  }
}

/** the zip (or any bytes) in, the sealed file out, chunk by chunk */
export function encryptStream(source: ReadableStream<Uint8Array>, key: Buffer): ReadableStream<Uint8Array> {
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), keyIdOf(key), randomBytes(8)])
  const prefix = header.subarray(HEADER_LEN - 8)
  const input = buffered(source)
  let n = 0
  let started = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) { started = true; controller.enqueue(new Uint8Array(header)) }
        await input.fill(CHUNK.size)
        // more than one chunk held, or the source ended: only then is it known whether this chunk is the last
        const last = input.held <= CHUNK.size
        const plain = input.take(CHUNK.size)
        const nonce = Buffer.concat([prefix, counter(n)])
        const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN })
        cipher.setAAD(Buffer.concat([header, counter(n), Buffer.from([last ? 1 : 0])]))
        const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
        n++
        controller.enqueue(new Uint8Array(sealed.buffer, sealed.byteOffset, sealed.length))
        if (last) controller.close()
      } catch (err) {
        await input.cancel(err)
        controller.error(err)
      }
    },
    cancel: reason => input.cancel(reason),
  })
}

/** the sealed file in, the zip out; throws BackupCryptError for a wrong key or a file that was changed, cut or extended */
export function decryptStream(source: ReadableStream<Uint8Array>, key: Buffer): ReadableStream<Uint8Array> {
  const input = buffered(source)
  const sealedSize = () => CHUNK.size + TAG_LEN
  let header: Buffer | null = null
  let n = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!header) {
          await input.fill(HEADER_LEN - 1)
          if (input.held < HEADER_LEN) throw new BackupCryptError('backup.damaged')
          header = Buffer.from(input.take(HEADER_LEN))
          if (!header.subarray(0, 4).equals(MAGIC) || header[4] !== VERSION) throw new BackupCryptError('backup.damaged')
          if (!header.subarray(5, 13).equals(keyIdOf(key))) throw new BackupCryptError('backup.key-wrong')
        }
        await input.fill(sealedSize())
        const last = input.held <= sealedSize()
        if (input.held < TAG_LEN) throw new BackupCryptError('backup.damaged')
        const block = input.take(sealedSize())
        const nonce = Buffer.concat([header.subarray(13), counter(n)])
        let plain: Buffer
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN })
          decipher.setAAD(Buffer.concat([header, counter(n), Buffer.from([last ? 1 : 0])]))
          decipher.setAuthTag(block.subarray(block.length - TAG_LEN))
          plain = Buffer.concat([decipher.update(block.subarray(0, block.length - TAG_LEN)), decipher.final()])
        } catch {
          throw new BackupCryptError('backup.damaged')
        }
        n++
        if (plain.length) controller.enqueue(new Uint8Array(plain.buffer, plain.byteOffset, plain.length))
        if (last) controller.close()
      } catch (err) {
        await input.cancel(err)
        controller.error(err)
      }
    },
    cancel: reason => input.cancel(reason),
  })
}

/**
 * Decrypt `src` to a new file `dest` (mode 0600; an existing file is never overwritten). Whatever goes wrong, the part
 * written is removed again.
 */
export async function decryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const fd = openSync(dest, 'wx', 0o600)
  try {
    const reader = decryptStream(Bun.file(src).stream(), key).getReader()
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      for (let at = 0; at < r.value.length;) at += writeSync(fd, r.value, at)
    }
    closeSync(fd)
  } catch (err) {
    try { closeSync(fd) } catch { /* closed already */ }
    rmSync(dest, { force: true })
    throw err
  }
}
