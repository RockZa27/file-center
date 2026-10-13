/**
 * Throw-away Ed25519 key pairs for the tests that install update packages. Packages must be signed, so each test
 * file signs its packages with a key of its own and gives the matching public key to the app it runs
 * (UPDATE_PUBLIC_KEY, or config.updatePublicKey in-process). The real private key is not in the repository.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export type TestKey = { publicKey: string; privateKey: KeyObject; pem: string }

export function makeTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey,
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** the key as a file for "bun run package --sign" */
export function writeKeyFile(key: TestKey, file: string): string {
  writeFileSync(file, key.pem, { mode: 0o600 })
  return file
}

/** manifest.sig content: the signature of the exact bytes of manifest.json */
export const signManifest = (manifestBytes: Uint8Array, key: TestKey) => sign(null, manifestBytes, key.privateKey).toString('base64')
