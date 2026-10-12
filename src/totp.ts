import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** RFC 6238 time-based one-time passwords: HMAC-SHA1, 6 digits, 30 second steps */
export const TOTP_STEP_SECONDS = 30
const DIGITS = 6
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** case, spaces and padding do not matter (authenticator apps show the secret in groups); anything else throws */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) throw new Error('not base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  return Buffer.from(out)
}

export const newTotpSecret = () => base32Encode(randomBytes(20))

export const stepOf = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP_SECONDS)

/** the code of one step */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const o = h[h.length - 1] & 15
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0')
}

/**
 * The step a code belongs to, if it is the code of the current step or of the one before or after (clocks differ)
 * and that step is later than `lastStep` (a code is good once); null otherwise.
 */
export function verifyTotp(secret: string, code: string, lastStep = -1, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const now = stepOf(nowMs)
  let found: number | null = null
  for (const step of [now - 1, now, now + 1]) {
    // no early exit: the time taken does not tell which step matched
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code)) && step > lastStep) found = step
  }
  return found
}

export function otpauthUri(secret: string, username: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
}
