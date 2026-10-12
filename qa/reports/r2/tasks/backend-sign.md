Signed update packages. Today anyone who gets an admin session and the admin password can install any code. With a signing key, only packages built by whoever holds the private key are accepted, even if the admin account is taken over.

- `scripts/package.ts`:
  - `--gen-key <dir>` creates an Ed25519 key pair with `node:crypto`: writes `<dir>/update-signing.key` (private key, PKCS#8 PEM, file mode 0600) and prints the public key as ONE line of base64 (SPKI DER) to put in `UPDATE_PUBLIC_KEY`. It refuses to overwrite an existing key file.
  - `--sign <private key file>` signs the exact bytes of `manifest.json` and adds `manifest.sig` (base64 signature) to the zip. Without `--sign` the package is unsigned, as now.
- Server (`src/config.ts`, `src/updater.ts`, `src/routes/update.ts`):
  - `UPDATE_PUBLIC_KEY` (env, empty by default). When set: `stagePackage` refuses a package without `manifest.sig`, or whose signature does not verify against the manifest bytes with that key (`crypto.verify(null, bytes, key, sig)`), with clear Thai messages. An invalid `UPDATE_PUBLIC_KEY` value must not crash the app at start: log it and refuse every package until it is fixed.
  - When not set: unsigned packages work as now; a signed one is accepted too (the signature cannot be checked without a key).
  - `manifest.sig` is the one file allowed in a package besides `manifest.json` and the files the manifest lists.
  - `applyStaged` re-checks the signature, like it re-checks the files.
  - The staged info gets `signed: boolean` and `signatureVerified: boolean`; `GET /api/admin/update` gets `signatureRequired: boolean`.
- Docs: a README section (Thai, like the rest) on making a key once, keeping the private key off the server, setting `UPDATE_PUBLIC_KEY`, and building with `bun run package --sign <key>`; `.env.example` entry.
- Tests: signed package accepted with the key set; unsigned refused with the key set; signed with another key refused; manifest changed after signing refused; an invalid key value refuses packages without crashing. The existing update tests (no key) must keep passing unchanged.
