# File Center 2.0.0-beta.1 — security audit follow-up (run 5, scoped)

## Fixed after this run

The records below describe source ref `33f1abb` and are left as found. The three confirmed findings were fixed afterwards; each fix has a regression test in `tests/security-201.test.ts` that fails on the old code (6 tests; 2 more are controls), a seeded bug in `qa/seeded/bugs.json` that those tests catch, and the Phase 3 verifiers' own scripts now come out the other way:

| Fingerprint | Fix | Re-run of the verifier script |
|---|---|---|
| `store-timer-write-overwrites-cli-revocation` | every `JsonStore` change or write first calls `reloadIfChangedByCli` (`JsonStore.beforeWrite`), so a timer write reads the CLI's files before it writes | revoked app password: 401 and 0 on disk after the timer (was 207 and 1); revoked session stays gone |
| `webdav/put-stale-auth-after-body` | before the file is placed, `putMethod` asks again for the app password, the account instance (name, `createdAt`), 2FA and password rules, the space and `upload`/`write`, and the quota owner | PUT after revoke: 401, no file (was 201) |
| `files/put-content-stale-auth-after-scan` | after the scan, and again after the quota counts are awaited, the save asks again for the account instance and `write`, and takes the quota owner from that | in-flight save after downgrade: 403, old content kept (was 200) |

The two unresolved zip candidates and the two coverage gaps named by the critic are not addressed.

## Run

- **Scoped follow-up, not a full audit.** Only the four coverage units that run 4 (`qa/reports/sec-2.0.0-beta.1/`) left `deferred` were reviewed: CLI revocation vs the running app's store writes, WebDAV PUT and editor saves vs account/credential changes, zip creation cost, search cost. All other units are `out_of_scope` here and keep their run-4 result.
- **This run is incomplete:** `run_status: incomplete`, reason `validation_budget_exhausted`. Five candidates came out of hunting; the 12-agent budget held 4 Phase 3 and 3 Phase 5 verifiers, used in fingerprint order. Two zip candidates are therefore **not** in findings.json (see "Unresolved candidates"); they are not findings of this report, even though one passed Phase 3.
- Cloudflare security-audit skill (pinned c1c8a8c), profile `standard`, source ref `33f1abb` (after the three run-4 medium fixes; clean worktree).
- Budget 12 agent invocations, 12 spent: 4 hunters, 1 coverage critic, 4 Phase 3 candidate verifiers, 3 Phase 5 record verifiers. No final-clean critic was run (no budget for another wave in a scoped run).
- Execution: sandboxed source-and-local-only, as in run 4 (`scripts/qa/sandbox.sh`, evidence promoted by `scripts/qa/promote.py`). Every hunter and verifier ran a local check; dummy data only, no stress beyond the sizes stated.
- Process notes (coordinator actions):
  - critic c21: not clean; 2 missing units outside the 4-unit scope recorded as out_of_scope (scoped run rule); no reassign_ids
  - p01/p02/p03: Phase 5 verified with work trail and a sandboxed re-run of the Phase 3 script; zipstream-no-yield-eventloop-stall-large-tree confirmed in Phase 3 (v04) but no Phase 5 verifier left in the 12-agent budget: removed from findings.json, kept as unresolved candidate; zipstream-unread-body-holds-codec-slots: no Phase 3 verifier left (5th in fingerprint order), unresolved candidate

## Result

Three findings are confirmed and passed Phase 5: one medium, two low. No code was changed by this run.

- The medium one: a CLI `sessions-revoke` can be silently undone by a pending timer write of the running app, so a revoked WebDAV app password or session works again.
- The two low ones: a WebDAV PUT and an editor save that are already in flight finish with the credential or rights they had when they started.
- Search (D4) is covered with no finding: queries are bounded to the caller's folder and cost under 50 ms at 100,000 public entries.

## Confirmed findings

| Severity | Title | Lower-trust principal | Observed |
|---|---|---|---|
| medium | A pending timer write of the running app overwrites a CLI sessions-revoke and restores revoked app passwords / sessions | Holder of a revoked WebDAV app password or session cookie after the operator ra… | Reproduced twice in the sandbox: app-passwords.json 0 items after the CLI, 1 after the timer, PROPFIND 207 with the revoked secret. Control (request right afte… |
| low | PUT /api/content writes after the antivirus scan with the rights that existed before the scan | user whose write right is being removed | {"update":200,"freshPutAfterDowngrade":403,"inFlightPut":200,"content":"NEW-AFTER-DOWNGRADE"} in both runs. |
| low | WebDAV PUT completes with the credential and rights it had when the request started, after the app password was revoked | Holder of a WebDAV app password that is revoked while their upload is open | PROPFIND after revoke 401; PUT 201; file f.txt contains helloworld (two runs). |

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

### PUT /api/content writes after the antivirus scan with the rights that existed before the scan

- Fingerprint: `files/put-content-stale-auth-after-scan` — severity **low** (likelihood low, impact low); confidence high
- Source: `src/routes/files.ts:215`, `src/routes/files.ts:233`, `src/routes/files.ts:255`, `src/routes/files.ts:239`
- Lower-trust principal: user whose write right is being removed
- Conditions: Antivirus enabled (off by default) so the scan opens a window; Rights removed while the scan of an already authorized request runs (seconds)
- Reproduction (local, dummy data): Enable antivirus against a fake clamd delaying 1.5 s → Start the PUT as bob → After 400 ms an admin sets bob's permissions to ['read'] → A fresh PUT gives 403; the in-flight one returns 200 and the file holds the new text
- Result: {"update":200,"freshPutAfterDowngrade":403,"inFlightPut":200,"content":"NEW-AFTER-DOWNGRADE"} in both runs.
- What it is: The route evaluates need(write), the quota user and ownerOfPath before the awaited antivirus gate, and does not re-check them after it. A user whose write permission is removed while the scan runs still has the in-flight save written, while a fresh PUT is refused with 403. Reproduced for the permission downgrade; the delete/recreate variant is reported by the hunter only.
- Priority: likelihood low (needs antivirus on and a rights change inside a seconds-long scan window); impact low (one text edit up to MAX_TEXT by a principal whose rights were just removed).
- Root cause: need() at line 215, quotaUserOf at 216 and ownerOfPath at 220 are computed before await gate() at 233; nothing between the gate and writeFileAtomic at 255 calls need() again or compares the account instance.
- Smallest fix: After the scan call need() again and compare the account instance, then compute owner and hold in the same tick.

### WebDAV PUT completes with the credential and rights it had when the request started, after the app password was revoked

- Fingerprint: `webdav/put-stale-auth-after-body` — severity **low** (likelihood low, impact low); confidence high
- Source: `src/webdav.ts:145`, `src/webdav.ts:611`, `src/webdav.ts:660`, `src/webdav.ts:677`, `src/webdav.ts:694`, `src/quota.ts:129`
- Lower-trust principal: Holder of a WebDAV app password that is revoked while their upload is open
- Conditions: holder of a valid app password at request start; revocation happens while the body is still streaming or the scan is running; the client controls the pace
- Reproduction (local, dummy data): Create user with readwrite app password → Start PUT with a ReadableStream body and send 5 of 10 bytes → DELETE /api/me/app-passwords/<id>; PROPFIND with it now returns 401 → Send the remaining bytes and close → Observe PUT 201 and file written
- Result: PROPFIND after revoke 401; PUT 201; file f.txt contains helloworld (two runs).
- What it is: authenticate() verifies the app password once; putMethod then resolves the Space, permissions and quota user once and, after the unbounded body loop and gate(), re-checks only ready(), ownerOfPath, preconditions and holdNow before place(). Revoking the app password while the body streams does not stop the write: a new PROPFIND gets 401 but the running PUT gets 201 and the file is written. Deleted/re-created accounts and lowered rights are expected to behave the same by source (perms copied at start, quota keyed by username) but were not re-run by this verifier.
- Priority: likelihood low (needs a valid credential and a revocation timed during an open upload); impact low (one in-flight file within the upload limit is written after revocation; no other-user data read or changed demonstrated).
- Root cause: putMethod never re-verifies the app password record, the account instance (name, createdAt) or accessFor perms between the start of the request and place(); the body can stream for an unbounded time and quota commit is keyed by lowercase username.
- Smallest fix: Before holdNow/place re-verify the app password item still exists and is unexpired, the account instance is the same, and accessFor still grants upload (and write when replacing); bound total PUT duration; key quota by account instance.

## Unresolved candidates (not findings)

| Fingerprint | Where it stopped | Evidence so far |
|---|---|---|
| `zipstream-no-yield-eventloop-stall-large-tree` | Phase 3 confirmed (medium) by an independent verifier; **no Phase 5 verifier left** | totalMs 3359 and 3269, timer ticks 0, max loop gap equal to the whole download, in two sandboxed runs. |
| `zipstream-unread-body-holds-codec-slots` | hunter only; **no Phase 3 verifier left** (5th in fingerprint order) | victim zip and backup-like zip TIMEOUT at 12 s in 4 of 4 runs (and 2 of 2 on share link); after abort both finish in a few ms. |

Details and what is still needed: NEEDS-VALIDATION.md.

## Coverage

| Unit (surface → boundary) | Status | Result |
|---|---|---|
| `src/cli.ts#sessions-revoke` → `src/auth.ts#reloadIfChangedByCli` | candidate | `store-timer-write-overwrites-cli-revocation` |
| `src/routes/files.ts#GET /api/batch/:token` → `src/zip.ts#collectZipItems` | candidate | `zipstream-unread-body-holds-codec-slots`, `zipstream-no-yield-eventloop-stall-large-tree` |
| `src/routes/files.ts#GET /api/search` → `src/search-index.ts#searchEntries` | covered | no finding |
| `src/webdav.ts#PUT` → `src/quota.ts#holdNow` | candidate | `webdav/put-stale-auth-after-body`, `files/put-content-stale-auth-after-scan` |

The coverage critic was not clean: it named two gaps next to these units, outside this run's scope, recorded as `out_of_scope` (see NEEDS-VALIDATION.md).

## Hardening notes (not findings)

- reloadIfChangedByCli compares mtimeMs of cli-changed; two CLI runs within the same filesystem timestamp granularity could be missed (not exercised)
- cli.ts reset-2fa/sessions-revoke load their own copy of users.json at start; concurrent app writes to users.json between that load and the CLI save would be lost (no locking between processes)
- The synchronous readdir walk alone is cheap (about 50 ms for 20,000 entries); the cost is the zipStream pipeline, not collectZipItems.
- BATCH_PER_CALLER and BATCH_MAX cap only unused tokens; a token can be fetched repeatedly until it expires (5 min) so the cap does not limit concurrent downloads.
- GET /api/search has no per-IP rate limit or result cache; each anonymous 1-2 char query runs a synchronous instr() scan over the public subtree (about 35-49 ms at 100k public rows, roughly linear, so a public folder of 1M+ entries would stall the loop about 0.4 s per request). Consider moving it to a worker, requiring needle length 3 for visitors, or a per-IP limiter.
- FTS path for needles of 3+ chars with more than FTS_CAP hits falls back to the instr scan in name order with LIMIT; a rare-miss ordering by mtime or size cannot stop early, same linear subtree cost.
- Search stalls only scale with the size of the public folder for visitors; extreme sizes (millions of rows) were not measured, to stay within the no-stress rule.
- src/office.ts saveVersion re-runs tokenFile(t,['write']) after the download and gate (line 375), so the office save does not share the gap; ownerOfPath(abs) at line 372 is taken after the scan too.
- src/quota.ts keys reserved/cache by lowercase username only, so a re-created account of the same name inherits holds and commits of the old account until the 60 s recount.
