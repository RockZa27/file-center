# Needs validation — run 5 (scoped follow-up)

No record ended as `needs_validation`. The open items below are not findings.

## Unresolved candidates (validation budget exhausted)

### `zipstream-no-yield-eventloop-stall-large-tree` — Phase 3 confirmed, Phase 5 missing

zipStream builds the archive without yielding to the event loop and collectZipItems has no entry or depth cap. Independently reproduced in-process: a public folder with 20,000 one-byte files downloaded through an anonymous batch token ran 3.3 s with zero 10 ms timer ticks, so every other request on the single Bun process waited. Cost is linear in entry count.

- Phase 3 verifier result: totalMs 3359 and 3269, timer ticks 0, max loop gap equal to the whole download, in two sandboxed runs. (proposed medium: likelihood medium, impact medium).
- Needed: one fresh Phase 5 record verifier.

### `zipstream-unread-body-holds-codec-slots` — hunter only

With the default guest permissions an anonymous visitor can start GET /api/batch/:token (new session per request, token from POST /api/batch) or GET /api/s/:token/download on a folder link, receive the headers and not read the body. Each such request keeps one zip.js codec slot (maxWorkers = CPU count, 4 here) while the writer waits for backpressure. With 4 such connections every other zip, including admin backups that use zipStream, waits until the holders are closed.

- Hunter result: victim zip and backup-like zip TIMEOUT at 12 s in 4 of 4 runs (and 2 of 2 on share link); after abort both finish in a few ms. (proposed medium).
- Needed: one independent Phase 3 verifier, then one Phase 5 verifier.

## Coverage gaps named by the critic (outside this run's scope)

- `src/routes/files.ts#POST /api/unzip` → `src/antivirus.ts#gate`: critic c21: parallel gate-then-write path to files/put-content-stale-auth-after-scan. files.ts:352-355 fixes need(zip,write), quotaUserOf and the destination before extraction; files.ts:395-401 awaits gate() per extracted file; files.ts:405-414 moves the tree in and commits the hold with no re-check of the account instance, rights or quota owner. dropUploadsOf cannot see the staged folder.
- `src/routes/files.ts#POST /api/zip` → `src/zip.ts#zipStream`: critic c21: other zipStream callers were not checked as triggers. files.ts:337-343 builds a server-side archive with collectZipItems (no entry cap) for any user with zip+write; logs.ts:90 zips log files; backup.ts:581 was used only as the victim. Needs an account (guest defaults in settings.ts:90 exclude zip).
