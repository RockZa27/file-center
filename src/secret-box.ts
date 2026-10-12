import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { paths } from './config'

// AES-256-GCM for small secrets kept in users.json (the 2FA secret). Sealed form: base64url(iv | tag | ciphertext).
let keyCache: Buffer | null = null

/** made on first use, readable by this account only; without it the sealed values can not be opened again */
function key(): Buffer {
  if (keyCache) return keyCache
  const file = paths.secretKey
  if (existsSync(file)) {
    const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url')
    // a damaged key is not replaced: a new one would silently make every sealed value unreadable
    if (k.length !== 32) throw new Error('secret.key is damaged')
    return (keyCache = k)
  }
  const k = randomBytes(32)
  writeFileSync(file, k.toString('base64url'), { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows */ }
  return (keyCache = k)
}

export function seal(text: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')
}

/** the text that was sealed; throws when the value was changed or sealed with another key (fails closed) */
export function open(sealed: string): string {
  const raw = Buffer.from(sealed, 'base64url')
  if (raw.length < 29) throw new Error('sealed value is too short')
  const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

/** for tests: forget the key held in memory so the next call reads the file again */
export function forgetKey() {
  keyCache = null
}
