# Upstream

- Source: https://github.com/cloudflare/security-audit-skill (`skills/security-audit/`)
- Pinned commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (copied 2026-10-25, unchanged)
- License: MIT (`LICENSE`, copied from the repository root)

To update: clone the repository, read every changed file, copy `skills/security-audit/` over this folder and change the
commit above. Keep this file and `LICENSE`.

## How this project runs it

See "ตรวจความปลอดภัยเต็มรูปแบบ (security-audit skill)" in `qa/README.md`. In short:
- Output goes outside the repo (default `~/security-audit-skill/file-center/run-<N>`); only the final `REPORT.md`
  is copied to `qa/reports/sec-<version>/`.
- Hunters and verifiers are this repo's `security-auditor` and `verifier` agents, at most 2 at a time.
- Target code runs only inside an OS sandbox: own network namespace (loopback only), read-only filesystem except the
  agent's scratch directory, `env -i` with an allowlist, and `prlimit` + `timeout` limits.
