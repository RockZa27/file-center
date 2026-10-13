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
 */
export const BUILTIN_UPDATE_KEY = 'MCowBQYDK2VwAyEAABWif/NzPgsrhrBQDkIYpxFSViyCFTAJhHkS9zlsXXo='
