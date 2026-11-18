/**
 * The public key every update package must be signed with, unless UPDATE_PUBLIC_KEY names another one.
 *
 * Ed25519, SPKI DER in base64: the same one-line format "bun run package --gen-key" prints. File Center's releases are
 * signed with the matching private key, which is kept by the maintainers and is NOT in this repository:
 *
 *   bun run release --sign <private key file> --push
 *
 * (scripts/release.ts passes --sign to scripts/package.ts, which writes manifest.sig, the signature of the exact bytes
 * of manifest.json; manifest.json lists the SHA-256 of every file, so the signature covers the whole package.)
 * Someone who builds their own packages sets UPDATE_PUBLIC_KEY to their own public key, or UPDATE_ALLOW_UNSIGNED=true.
 *
 * Rotated in 2.0.0-beta.2: the private keys of the earlier ones (MCowBQYDK2VwAyEAABWif... built into 1.7-2.0.0-beta.1,
 * and MCowBQYDK2VwAyEAsDWM... that 2.0.0-beta.1 asked for in UPDATE_PUBLIC_KEY) are lost, so nothing new is signed with
 * them. A server from before 2.0.0-beta.2 sets UPDATE_PUBLIC_KEY to this key and restarts for the one update that brings
 * it in; after that the line can go (docs/admin-guide.md, "ลายเซ็นแพ็กเกจ").
 */
export const BUILTIN_UPDATE_KEY = 'MCowBQYDK2VwAyEAtxu0x/GHgLMzkhTnmwTU/yh/3wnHPchd6ricj9N9VbQ='
