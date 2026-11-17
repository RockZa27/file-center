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
