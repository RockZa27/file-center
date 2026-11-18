# Findings detail — run 5 (scoped follow-up)

Medium and higher records with their full trace. Generated from findings.json.

### A pending timer write of the running app overwrites a CLI sessions-revoke and restores revoked app passwords / sessions

- Fingerprint: `store-timer-write-overwrites-cli-revocation` — severity **medium** (likelihood low, impact high); confidence high
- Source: `src/cli.ts:93`, `src/app-passwords.ts:184`, `src/store.ts:166`, `src/auth.ts:327`, `src/store.ts:163`, `src/auth.ts:339`, `src/app-passwords.ts:107`
- Lower-trust principal: Holder of a revoked WebDAV app password or session cookie after the operator ran sessions-revoke
- Conditions: Operator runs the CLI on the host; the beneficiary holds the revoked app password or session cookie; A timer write (5 s app-password lastUsedAt, or hourly purge) must fire after the CLI write and before any request reaches the app; a request in between reloads and heals
- Reproduction (local, dummy data): Start the app on a scratch DATA_DIR, create alice with an app password and carol with a session → PROPFIND once with the app password (queues the 5 s timer) → Run the CLI sessions-revoke alice on the same DATA_DIR → Send no request for 6.5 s, then PROPFIND with the old secret
- Result: Reproduced twice in the sandbox: app-passwords.json 0 items after the CLI, 1 after the timer, PROPFIND 207 with the revoked secret. Control (request right after the CLI): 401, disk 0. Session variant: after purgeExpiredSessions() GET /api/session returns carol.
- What it is: bun src/cli.ts sessions-revoke (and reset-2fa) edits sessions.json and app-passwords.json and then touches cli-changed; the running app re-reads them only at the start of the next request. If an app write fires first (app-password lastUsedAt timer after 5 s, hourly purgeExpiredSessions), it writes the old in-memory data over the CLI's files and the next request reloads that file, so the revoked app password or session works again. The CLI still reports success.
- Priority: likelihood low (Needs a pending timer or the hourly tick to land in the gap before the next request); impact high (Operator emergency revocation of a stolen credential is silently undone while the CLI reports success).
- Root cause: JsonStore.writeNow/persist write the in-memory snapshot without checking whether the cli-changed marker moved; the marker is checked only in request hooks (context.ts, webdav.ts handleDav).
- Smallest fix: Check the cli-changed marker (reload first) inside writeNow/persist before serialising, or have the app watch the marker on a short interval and drop pending timers; add a regression test running the CLI while a touchAppPassword timer is pending.

Trace:
- entrypoint `src/cli.ts:93` (sessions-revoke): destroyUserSessions and removeAppPasswordsOf write the files in the CLI process; the marker is touched at line 101
- propagation `src/app-passwords.ts:184` (touchAppPassword): updateSoon leaves a 5 s timer whose snapshot comes from the app's old in-memory list
- propagation `src/store.ts:166` (JsonStore.writeNow): serialises this.data over the file with no marker or mtime check
- sink `src/auth.ts:327` (reloadIfChangedByCli): the next request reloads the already overwritten files, so the revocation is lost

Evidence:
- `src/store.ts:163`: writeNow persists the stale snapshot without checking the CLI marker
- `src/auth.ts:339`: purgeExpiredSessions uses sessionStore.update, which writes the whole in-memory sessions map (hourly, index.ts:122)
- `src/app-passwords.ts:107`: onCliChange reload happens only inside a request, so a timer can fire first

### One anonymous zip of a big folder blocks the whole event loop for the length of the zip

- Fingerprint: `zipstream-no-yield-eventloop-stall-large-tree` — severity **medium** (likelihood medium, impact medium); confidence high
- Source: `src/routes/files.ts:485`, `src/zip.ts:109`, `src/zip.ts:170`, `src/routes/files.ts:488`
- Lower-trust principal: anonymous visitor
- Conditions: none, with default guest permissions (batchdownload, settings.ts:90) or any folder share link; a very large public or shared tree must already exist; anonymous guests cannot create it by default
- Reproduction (local, dummy data): Create 20,000 one-byte files in nested public folders → Take a session, create a batch token, run a 10 ms timer, download the batch and read it fully
- Result: totalMs 3288, timer ticks 0, max loop gap equal to the whole download (earlier runs 3359 and 3269).
- What it is: zipStream builds the archive without yielding to the event loop and collectZipItems has no entry or depth cap. Reproduced in-process: a public folder with 20,000 one-byte files downloaded through an anonymous batch token ran about 3.3 s with zero 10 ms timer ticks, so every other request on the single Bun process waited. Cost is linear in entry count.
- Priority: likelihood medium (request is trivial and repeatable, but a large existing tree is required); impact medium (the whole process stalls for seconds per request; recovers when the zip ends).
- Root cause: collectZipItems has no entry or depth cap and zipStream never yields to the event loop between entries.
- Smallest fix: Cap entries and depth in collectZipItems, yield (await setImmediate) every few entries in zipStream, and limit concurrent zips.

Trace:
- entrypoint `src/routes/files.ts:485` (GET /api/batch/:token (route at line 476)): collectZipItems(dir, b.names) expands the whole subtree for an anonymous caller with batchdownload
- propagation `src/zip.ts:109` (collectZipItems visit): readdirSync recursion with no cap on entries or depth
- sink `src/zip.ts:170` (zipStream loop): per-entry zip.add chain keeps the event loop busy until the archive is finished

Evidence:
- `src/zip.ts:109`: for (const n of readdirSync(abs)) visit(...) with no limit
- `src/routes/files.ts:488`: new Response(zipStream(list)) with no entry cap; only the number of unused batch tokens is capped (lines 471-472)

### Unread anonymous zip downloads hold all zip.js codec slots and stall every other zip and the real backup

- Fingerprint: `zipstream-unread-body-holds-codec-slots` — severity **medium** (likelihood high, impact medium); confidence high
- Source: `src/routes/files.ts:477`, `src/routes/files.ts:488`, `src/zip.ts:170`, `src/backup.ts:581`, `node_modules/@zip.js/zip.js/lib/core/codec-pool.js:94`, `src/routes/shares.ts:338`
- Lower-trust principal: anonymous visitor on the public page
- Conditions: none: anonymous visitor with public page on and default guest permissions, or any folder share link; public folder files large enough that the zip output exceeds stream buffers (about 6 MB per file here); slots are held while the connection stays open without reading; the 255 s server idleTimeout upper bound was not measured; in-process bodies were used, not a socket
- Reproduction (local, dummy data): Fresh STORAGE_DIR/DATA_DIR, public folder with three large random files → Open 4 anonymous batch downloads, read no body → Request a 5th anonymous zip and POST /api/admin/backups as admin → Cancel the 4 bodies and repeat both
- Result: Baseline victim zip 72-77 ms and backup 13 ms. With 4 holders both TIMEOUT at 10 s in 2 of 2 sandboxed runs (script exit 42). After cancelling the holders victim 66-70 ms and backup 10-17 ms.
- What it is: With default guest permissions an anonymous visitor can obtain a batch token (POST /api/batch) and start GET /api/batch/:token (or a folder share link download), read only the headers, and leave the body unread. Each stream holds one zip.js codec slot while the writer waits for backpressure. With 4 such streams (CPU count 4) every other zip download and the real admin backup (POST /api/admin/backups) wait until the holders are cancelled. Reproduced in-process, including the real backup route.
- Priority: likelihood high (anonymous, 4 plain requests, default configuration); impact medium (zip downloads and backups stall while the holders stay connected; other routes unaffected; recovers on disconnect; temporary).
- Root cause: zipStream has no per-caller or global concurrency cap and no write-idle timeout, and holds the zip.js codec slot across the backpressure wait; the pool (maxWorkers = CPU count) is shared by user downloads and backups. The batch token cap limits only unused tokens, not concurrent streams.
- Smallest fix: Cap concurrent zipStream per caller and globally (429), add a write-idle timeout that aborts the writer, and reserve or separate codec capacity for the backup.

Trace:
- entrypoint `src/routes/files.ts:477` (GET /api/batch/:token): anonymous caller with guest download and batchdownload permission obtains a zip body with no concurrency cap
- propagation `src/routes/files.ts:488` (return new Response(zipStream(list))): the stream is handed to the client unbounded
- sink `src/zip.ts:170` (zipStream zip.add): await zip.add takes a codec slot and keeps it while the TransformStream readable is not drained

Evidence:
- `src/zip.ts:170`: zip.add inside the async writer; readable returned at line 175 with no cap or timeout
- `src/backup.ts:581`: the real backup uses the same zipStream and so the same shared pool (Bun.write at line 590)
- `node_modules/@zip.js/zip.js/lib/core/codec-pool.js:94`: pool.length < maxWorkers else pendingRequests.push (line 101): later tasks wait
- `src/routes/shares.ts:338`: folder share link download uses the same zipStream, no session needed
