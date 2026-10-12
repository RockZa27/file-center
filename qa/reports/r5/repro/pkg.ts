// builds a structurally valid, unsigned update package (manifest + server.js + web/index.html) with real SHA-256s
import { zipSync } from 'fflate'
const sha = (d: Uint8Array) => new Bun.CryptoHasher('sha256').update(d).digest('hex')
export function buildPackage(version: string): Uint8Array {
  const enc = new TextEncoder()
  const files: Record<string, Uint8Array> = {
    'server.js': enc.encode('console.log("hello")\n'),
    'web/index.html': enc.encode('<!doctype html><title>x</title>\n'),
  }
  const manifest = {
    name: 'file-center', version, builtAt: new Date().toISOString(), notes: '',
    files: Object.fromEntries(Object.entries(files).map(([p, d]) => [p, { size: d.length, sha256: sha(d) }])),
  }
  return zipSync({ 'manifest.json': enc.encode(JSON.stringify(manifest)), ...files })
}
export const sha256hex = sha
