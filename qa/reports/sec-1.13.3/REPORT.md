# File Center 1.13.3 candidate — security audit report (run 3, scoped)

## Run

- **This is a partial pass.** Scoped run of the Cloudflare security-audit skill (pinned c1c8a8c), profile `standard`, covering only source that changed between `608365e` (1.13.2 candidate, run 2) and `d2a68f8` (1.13.3 candidate on `fix/1.13.3`). 19 changed files; units whose source did not change, or whose only change was the move of forgetAccount out of routes/admin.ts, are `out_of_scope` with the reason recorded, not covered.
- Budget 15 agent invocations, extended to 20 when the final-clean critic reassigned the record-inventory unit and its new hunter produced two candidates: 7 hunters in 3 waves, 3 coverage critics (one post-wave, two final-clean), 5 Phase-3 candidate verifiers, 5 Phase-5 fresh record verifiers. Reconnaissance was done by the parent: run 2's architecture.md plus a change delta from `git diff`, no recon agents.
- Execution: sandboxed source-and-local-only. Target code ran only under `scripts/qa/sandbox.sh` with the run-2 fix in place (own network namespace with loopback, read-only filesystem except the agent scratch, a minimal read-only /dev, empty read-only /root and /tmp, `env -i`, prlimit and timeout). Evidence files were promoted by `scripts/qa/promote.py`. Unlike run 2, agents could not read each other's scratch.
- Process notes (parent corrections, all format-only): h4-misc: the in-sandbox mount check had no artifact (observed from inside); demoted to source-only; v1-proppatch confirmed from source review plus the hunter's artifact without its own execution; Phase 5 re-checks it; v2-trash: its JSON had one stray ']' after remediation; the parent removed that character only (no content change); v1-proppatch: record omitted the 'verdict' key (decision confirmed); the parent added verdict=confirmed; h7-inventory: candidates used 'verdict' instead of 'proposed_verdict' (treated as proposed); budget extended past 15 for the reassigned unit's two candidates (v4, v5, p5-4, p5-5, critic3); upload-cancel record: its trace had two entrypoints (complete and the concurrent DELETE); the parent changed the second to propagation with a note, for the schema.
- Prior-run use: run 2's ledger and findings were read. All six confirmed run-2 records had their source changed by fixes, so none was carried; each became a changed-source revalidation unit.

### Run-2 records revalidated

| Run-2 record | Result in run 3 |
|---|---|
| `backup-restore:later-same-name-account-app-passwords-shares-grants-groups-carry-over` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `guest-upload-allowance-reserved-at-announce` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `scripts/qa/sandbox.sh:dev-rbind-not-readonly` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `session-store:restore-keeps-sessions-of-later-same-name-account` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `upload-pending-cap-shared-guest-owner` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `webdav:propfind-duplicate-property-response-amplification` (confirmed) | closed by the fix (re-hunted, not reproduced) |

## Security posture

The 1.13.2 fixes close all six confirmed run-2 findings at their root cause; none was reproducible again. Run 3 found five new problems, all at most medium: PROPPATCH had the same namespace-echo amplification the PROPFIND fix removed (another path to the run-2 sink); and four account-lifecycle or race gaps around the account-instance rule (name, createdAt) and the guest allowance: the trash, office link tokens and unfinished uploads of a deleted or restore-dropped account still acted for a later account of the same name, and a cancel during completion refunded the visitor allowance for a file that still landed. No finding is above medium; the lifecycle ones need an admin to delete or restore and re-use a name.

## Confirmed findings

| Severity | Title | Boundary | Observed |
|---|---|---|---|
| medium | WebDAV PROPPATCH echoes a request-chosen namespace once per property: a 39 KB request yields a 33.6 MB answer (up to about 70 MB at the 64 KB cap) with no output bound | Any account with WebDAV enabled and an app password of scope readwrite (PROPPATCH needs wr… | From the hunter's artifact (verified by source review, not re-executed by me): Status 207, response length 33,626,717 chars from a 38,987 B … |
| low | Backup restore lets the restored older account see and permanently delete the trash of a later same-name account | An admin must restore a backup taken while an older, different account with the same name … | Under the sandbox, the restored first bob logged in (200) and the second bob's password was rejected (401). The first bob's trash listed sec… |
| low | Office link token of a deleted account reads the files of a later account with the same name | The attacker held a valid user account that opened a document in the office editor, which … | 200 with the new owner's file content (NEW-OWNER-PRIVATE-V4). After the delete and before the re-create the same request returned 403.… |
| low | Cancelling an upload while it completes refunds the visitors' daily allowance for a file that still lands | Public (or upload-request-link) uploads must be enabled for anonymous visitors, with a dai… | HTTP-level run, cross-device: 4 files of 24 MiB landed (96 MiB) with the daily counter at 0 of 128 MiB. Same-disk: sporadic hits where DELET… |
| low | A deleted account's pending uploads and quota reservation are charged to and accessible by a later account of the same name | The old account had upload rights and a quota. An admin or manager deletes and re-creates … | 507 quota.exceeded for the new account with an empty home, and GET /api/upload/<old id> returned 200 as the new account.… |

### WebDAV PROPPATCH echoes a request-chosen namespace once per property: a 39 KB request yields a 33.6 MB answer (up to about 70 MB at the 64 KB cap) with no output bound

- Fingerprint: `webdav:proppatch-namespace-echo-response-amplification` — severity **medium** (likelihood medium, impact medium); Phase 5: verified
- Source: `src/index.ts:243`, `src/webdav.ts:128`, `src/webdav.ts:850`, `src/webdav.ts:856`, `src/webdav.ts:858`, `src/webdav.ts:874`
- Lower-trust principal: A normal low-privilege user who made a readwrite app password in their own account.
- Reproduction: The hunter's scripts/qa/sandbox.sh run with agents/h3-dav/artifacts/c1.ts created a dummy admin and a dummy user, made an app password and a file, and called app.handle in-process, sending PROPPATCH requests with growing namespace length and property count up to a single 39 KB request (no concurrency or stress).
- Conditions: Any account with WebDAV enabled and an app password of scope readwrite (PROPPATCH needs write, confirmed via allow(s,'write') at webdav.ts:847). Any existing file or folder in a space the user can write, such as their own home. WebDAV is on, which is the default (policy.webdav() gate at handleDav entry). Concurrency, memory limits and any reverse-proxy rate limiting depend on the deployment. The Docker memory limit was not examined by me or by the hunter.
- Result: From the hunter's artifact (verified by source review, not re-executed by me): Status 207, response length 33,626,717 chars from a 38,987 B request, in 191 ms. Output grows linearly with ns length times prop count across four independently reported points. A request at the 64 KiB cap would give about 70 MB by the same linear relationship. Reported process rss was 354 MB after the full run (includes the companion PROPFIND scope-cost check in the same process).
- Impact: Each request makes the shared single-process server build, copy and send a response about 800x the size of the request. That is tens of MB of transient memory per request and the same again in encoding and sending, with no concurrency limit. Repeated or concurrent requests could pressure memory for all users. The state is not persistent and recovers when the requests stop. Only one request was run (by the hunter), so the real effect at deployment scale depends on container memory limits, which neither the hunter nor I tested. Priority: Needs a valid app password of a normal account, but any user can make one and the request is trivial and cheap.
- Root cause: proppatchMethod() (src/webdav.ts:845-877) writes `<X:${prop.name} xmlns:X="${escAttr(prop.ns)}"/>` for every child of every set/remove prop (line 858). The namespace comes from a request xmlns declaration on d:prop and is inherited by all children, so it costs the attacker once but is output n times. safeName() (src/webdav-xml.ts:131) bounds only the element name to 101 chars; escAttr() (src/webdav-xml.ts:126) only HTML-escapes and does not truncate. There is no PROPFIND_MAX_NS-equivalent length cap on prop.ns, no cap on the number of props beyond the 2000-element parser MAX_ELEMENTS limit, and no aggregate byte budget comparable to PROPFIND_MAX_BYTES (src/webdav.ts:329, enforced only inside propfind() at line 420). The result is built with group()/join() and copied again by xmlResponse() (XML_HEAD + body, line 118) with no size check anywhere in this path.
- Smallest fix: Apply the PROPFIND limits to PROPPATCH: refuse any prop namespace longer than PROPFIND_MAX_NS, limit the number of props (for example PROPFIND_MAX_PROPS), and add a running byte budget that returns 507 or 400 before building a large answer. Better, for non-DAV namespaces declare each distinct namespace once in the multistatus root and refer to it by prefix instead of repeating it. Add a regression test with one long namespace and 1000 children expecting a 400 or a bounded answer.

### Backup restore lets the restored older account see and permanently delete the trash of a later same-name account

- Fingerprint: `backup-restore:later-same-name-account-trash-entries-carry-over` — severity **low** (likelihood low, impact low); Phase 5: verified
- Source: `src/routes/backup.ts:80`, `src/backup.ts:640`, `src/account-records.ts:77`, `src/trash.ts:51`, `src/routes/trash.ts:51`
- Lower-trust principal: A former user whose account was deleted and later reinstated by a restore. A different person has since taken the same username. The former user signs in with the old password after the restore.
- Reproduction: Create user bob (home /users/bob) and take a backup. Delete bob, then create a different bob with a different homedir (/bobtwo). Put a file in its home and move it to the trash. Restore the backup, then run `bun v1.ts check` in a fresh process, which stands in for the restart. Sign in as the first bob. GET /api/me/trash lists the second bob's entry, and DELETE /api/me/trash/<id> returns 200 and purges it.
- Conditions: An admin must restore a backup taken while an older, different account with the same name existed. That account was later deleted and the name re-used. The later account must have trash entries still within retention (owner equal to the shared name). The attacker holds the credentials of the older account, which the restore re-enables. The process runs supervised (the route requires it) and restarts after the restore.
- Result: Under the sandbox, the restored first bob logged in (200) and the second bob's password was rejected (401). The first bob's trash listed secret-plans.txt (deletedBy bob, restorable false). DELETE /api/me/trash/<id> returned 200 and the trash was then empty. When the homes coincide, the entry would also be restorable, but those files are already name-bound in the home.
- Impact: It discloses the names, sizes and deleter of another person's deleted items and lets the older account permanently delete them. Content stays unreadable unless the homes coincide, and the home files themselves are already name-bound. Priority: It needs an admin restore across a delete-and-recreate of the same name, and the older account's holder must still hold the old credentials.
- Root cause: The account-instance rule (lowercase name plus createdAt) was applied to sessions, shares, grants, groups, app passwords, user state, notifications, notify state and guide, but not to the trash. dropRecordsOnDisk has no trash step, and the trash is not a JsonStore. The tombstone mechanism (tombstoneTrashOf in src/trash.ts, called from admin create, admin delete and the group path) is bypassed by restoreBackup, so trashOwner() keeps returning the bare username for the later account's entries.
- Smallest fix: In restoreBackup, before the users.json swap, call tombstoneTrashOf for every name in plan.drop, so owner and deletedBy become an unmatchable tombstone. Alternatively add an equivalent trash step to dropRecordsOnDisk. Add a regression case to tests/security-1132-restore.test.ts: after restoring over a recreated name, GET /api/me/trash for the restored account is empty.

### Office link token of a deleted account reads the files of a later account with the same name

- Fingerprint: `office:link-token-binds-bare-username-survives-account-recreate` — severity **low** (likelihood low, impact medium); Phase 5: replace-nonmaterial
- Source: `src/office.ts:225`, `src/office.ts:175`, `src/routes/admin.ts:201`, `src/office.ts:195`
- Lower-trust principal: A former user who kept the document.url and config.token that the editor page received before the account was deleted.
- Reproduction: As a user, POST /api/office/config for /r.docx and keep document.url and config.token. Admin deletes the user, then re-creates the same name for another person, whose home gets /r.docx. Replay the GET with the old token and JWT.
- Conditions: The attacker held a valid user account that opened a document in the office editor, which gave them the url and JWT. Office integration must be enabled. OFFICE_URL, OFFICE_INTERNAL_URL and OFFICE_JWT_SECRET are set. An admin or manager deletes that account and later creates a new account with the same name (same home path) within 24 h, and a file exists at the same path. Token TTL is 24 h (OFFICE_LIMITS.tokenTtlMs).
- Result: 200 with the new owner's file content (NEW-OWNER-PRIVATE-V4). After the delete and before the re-create the same request returned 403.
- Impact: Read of one file per held token. Edit mode is bound the same way, but the saved-file URL must come from the document server's origin, so write was not shown. Priority: Needs an admin or manager to re-use the name within 24 h, a file at the same path, and an enabled office integration.
- Root cause: OfficeToken identifies the account only by username (u). It carries no createdAt or account instance, and tokenFile only calls findUser(t.u). Account lifecycle code (forgetAccount, dropRecordsOnDisk) does not touch it, although account-records.ts defines an account as the pair (name, createdAt).
- Smallest fix: Bind the token to the account instance: add the account's createdAt to the token and compare it in tokenFile. Alternatively, keep a per-account token epoch that forgetAccount bumps. Add a regression test that deletes and re-creates an account and expects 403.

### Cancelling an upload while it completes refunds the visitors' daily allowance for a file that still lands

- Fingerprint: `upload-cancel-during-complete-refunds-guest-allowance` — severity **low** (likelihood low, impact low); Phase 5: verified
- Source: `src/routes/upload.ts:52`, `src/uploads.ts:376`, `src/uploads.ts:412`, `src/routes/upload.ts:60`, `src/uploads.ts:429`
- Lower-trust principal: Anonymous visitor with public upload permission, or a visitor of an upload-request link charged to the guest allowance.
- Reproduction: Announce a file within the per-address share of the daily allowance and send all chunks. Fire complete without awaiting it, then fire DELETE on the same id. Repeat the DELETE with varied small delays, or poll for the hidden .fc-up-* file when storage is cross-device. When both calls return 200, the file is in storage and the allowance has been refunded. Repeat to accumulate files beyond the daily limit.
- Conditions: Public (or upload-request-link) uploads must be enabled for anonymous visitors, with a daily guest allowance greater than 0. Anonymous. The attacker only needs the upload id that its own announce returned, since all visitors share the owner 'guest'. The DELETE must be handled between the start of the move and finishUpload's synchronous cleanup. On a cross-device layout (DATA_DIR/tmp and STORAGE_DIR on different filesystems) the copy makes the window long and the race reliable. On the default same-disk layout it is a single event-loop turn between the async link/unlink steps (about 1 hit in 40 tries in my run), so the attacker must retry.
- Result: HTTP-level run, cross-device: 4 files of 24 MiB landed (96 MiB) with the daily counter at 0 of 128 MiB. Same-disk: sporadic hits where DELETE and COMPLETE both returned 200, the file landed and its bytes were refunded (1 uncounted MiB out of 12 landed in one 40-try run).
- Impact: It bypasses the shared daily visitor-upload allowance, but each landed file is still bounded by the upload size limit, the per-address pending cap, MIN_FREE_SPACE, and the visitor's request rate. Nothing crosses a user or tenant boundary. The per-user quota double-release was not demonstrated. Priority: Needs public or link guest uploads enabled and a timing race. It is reliable on a cross-device tmp/storage layout and sporadic (a retry loop is needed) on the default same-disk layout.
- Root cause: cancelUpload releases the guest allowance and quota by reading meta.json, and it does not consult the `completing` map. finishUpload does not claim the upload before its awaited putInPlace. meta.json and the upload folder stay in place until after the move, and settleGuest/untrack/rmSync run only afterwards. So a cancel that lands during the await releases the reservation of an upload whose bytes then land anyway. Completion never adds those bytes back to the counter, so a refunded file is never counted.
- Smallest fix: Make completion claim the upload. In finishUpload, before the first await, record the key (for example in the `completing` map keyed by owner and id) and have cancelUpload and the idle/stale droppers (sweepIdle, cleanStaleUploads) refuse or skip an upload that is completing. Release the reservation in exactly one place. After a file lands, keep it counted against the guest daily counter and only settle the per-address pending share.

### A deleted account's pending uploads and quota reservation are charged to and accessible by a later account of the same name

- Fingerprint: `uploads:pending-upload-and-quota-hold-bound-to-bare-username-survive-account-delete` — severity **low** (likelihood low, impact low); Phase 5: verified
- Source: `src/uploads.ts:255`, `src/routes/admin.ts:201`, `src/uploads.ts:42`, `src/quota.ts:112`
- Lower-trust principal: The deleted account's former holder, or simply a new account that inherits the name.
- Reproduction: Run v1.ts in the sandbox.
- Conditions: The old account had upload rights and a quota. An admin or manager deletes and re-creates the name. Effect lasts until the idle limit (UPLOAD_STALE_HOURS, default 3 h) or a restart.
- Result: 507 quota.exceeded for the new account with an empty home, and GET /api/upload/<old id> returned 200 as the new account.
- Impact: The new account is charged and limited for up to 3 h; takeover of the old upload needs the id, which the new account does not learn. Priority: Needs an admin or manager to delete and re-create the same name while an upload is pending.
- Root cause: Meta.owner and Meta.quotaUser are bare usernames. loadMeta compares owner strings only, and quota.reserved and byOwner are keyed by lowercase name. forgetAccount (src/account-records.ts) has no hook to cancel the account's uploads (dropUpload) or to release reservations, and planRestore/dropRecordsOnDisk do not cover DATA_DIR/tmp/<id>/meta.json.
- Smallest fix: In forgetAccount, cancel every upload whose meta.owner or meta.quotaUser matches (dropUpload for the live entries, then release the reservation). Bind the upload to the account instance as well, for example by storing the account createdAt in Meta and checking it in loadMeta. Cover DATA_DIR/tmp in planRestore/dropRecordsOnDisk too.

## Needs validation

None. Every candidate in this run was validated to `confirmed`.

## Hardening notes

27 notes from hunters (full list in `hardening.json` of the run directory). Most relevant:

- (h1-restore) Restore reverts passwordHash and 2FA state for accounts whose createdAt matches, while sessions and app passwords made after the backup are kept. If a credential was rotated after a compromise, the restored old hash becomes valid again. Consider forcing mustChangePassword or destroying sessions for same-instance accounts whose passwordHash or twoFactor differs between the live and restored files.
- (h2-uploads) Visitor drip: one fresh 8 MB chunk per under 15 min keeps a visitor reservation alive; it costs real bytes and gains nothing over simply spending the daily allowance.
- (h3-dav) webdav-xml.ts parseXml copies the whole in-scope prefix Map for every element (new Map(scopeOf())). A 64 KiB body with thousands of xmlns declarations and 2000 children gave about 0.2-0.5 s of event-loop time per authenticated request in a short run. Bounded, but consider sharing the scope map until an element declares a prefix, or capping declarations per element.
- (h3-dav) propfind() holds up to 32 MiB of body parts plus the joined string plus XML_HEAD + body (about three copies) before sending, and there is no per-user concurrency limit on /dav, so a lower PROPFIND_MAX_BYTES or a streaming answer would reduce peak memory. With the default 9 properties, a listing of about 45k entries already exceeds 32 MiB and is answered with 507 although WEBDAV_MAX_ITEMS is 100000, so the two limits do not agree.
- (h3-dav) The Destination header host check adds X-Forwarded-Host whenever TRUST_PROXY is not 'false'. This is limited by the same authorization on the parsed path and has no cross-principal impact. Keep it in mind for deployments that expose the app directly.
- (h4-misc) scripts/qa/sandbox.sh bind-mounts /etc, /var, /home, /opt and /srv of the host read-only into the sandbox, so target code inside it can read host files there (the other agents' homes under /home, /etc contents, /opt/*). It cannot write them. If the audit host can hold sensitive files in those trees, a narrower allowlist of mounts (/usr, /lib, /bin, a minimal /etc, the target) would remove the read exposure.
- (h4-misc) SECURE_COOKIE defaults to false in src/config.ts and TLS is not enforced in-app; this is acceptable for the compose design behind a tunnel, but the config warnings should keep flagging it when the request is not https.
- (h5-wildcard) src/favorites.ts stateOf() uses draft[username] ??= {...}. USERNAME_RE allows names such as constructor, toString, valueOf and __proto__, so for those accounts draft[name] is an inherited object and s.favorites/s.recent is undefined. addFavorite and recordRecent then throw TypeError, so the file read/download routes that call recordRecent return 500 for that account. The effect is limited to that account, and only an admin or manager can choose the name. notify.ts and guide.ts already guard this with Object.hasOwn. Use the same own-property guard in favorites.ts, or reject prototype-key usernames.
- (h5-wildcard) safe-html.js cleanSlide detects external style URLs with /url\s*\(/ and does not decode CSS escapes such as \75rl(. The impact is at most a blocked image beacon, because the page CSP already stops cross-site images.
- (h6-lifecycle) src/backup.ts:641-642 renames users.json into place before dropRecordsOnDisk, and src/account-records.ts:59-63 rewrites 9 JSON files with plain writeFileSync and throws on the first unparsable file. A failure or a crash in between leaves restored users with unswept per-account records and no retry. Suggested fix: run dropRecordsOnDisk (or a plan journal replayed at boot) before the users.json swap, write each file via temp file plus rename, and make rewrite() tolerate a corrupt file.

### Positive patterns observed

- Every run-2 fix held under re-hunting: restore drops records of every name not proven to be the live account (nine stores, case and missing-createdAt variants fail closed); the visitor pending cap and idle release balance across announce, track, untrack and restart; PROPFIND is bounded by namespace length, property count and a 32 MiB budget; the sandbox has no writable host path except the agent scratch.
- App passwords authenticate only their account and scope, are re-checked against the live record per request, and every WebDAV method checks the permission its action implies.
- No committed secrets; compose binds to loopback, drops capabilities, runs read-only as uid 1000; images and CI actions are pinned.

## Coverage

- Ledger: 27 units — candidate 5, covered 6, out_of_scope 16. `out_of_scope` units are run-2 units whose source did not change; they are not covered by this run.
- Critics: critic1 (post-wave) added 2 units (restore failure ordering, per-account record inventory); critic2 (final-clean) reassigned the record-inventory unit (settled by source reading only); critic3 (final-clean) returned `stop: true` with no missing units or reassignments.
- Validators: `validate-findings.cjs` and `validate-coverage-ledger.cjs` pass on the final files.
- Not established: dependency CVEs (no network, no package managers in this run; bun audit runs in CI). Deployment-scale memory effect of the PROPPATCH finding (single requests only). Version creation was not exercised locally (path-keyed by source).

## Fix status (1.13.3, branch `fix/1.13.3`)

Every confirmed finding is fixed, each with a regression test that fails on the audited commit and passes with the fix (`tests/security-1133.test.ts`, `tests/security-1132-restore.test.ts`).

| Finding | Severity | Fix | Commit |
|---|---|---|---|
| `webdav:proppatch-namespace-echo-response-amplification` | medium | PROPPATCH refuses more than 50 properties or a namespace over 256 characters (400), the PROPFIND limits | ba7f6be |
| `backup-restore:later-same-name-account-trash-entries-carry-over` | low | a restore tombstones the trash entries of every dropped name; records are dropped before the users swap | 4d2874b |
| `upload-cancel-during-complete-refunds-guest-allowance` | low | completion claims the upload; a cancel answers 409 `upload.completing`, the idle and stale sweeps skip it | 63a973f |
| `office:link-token-binds-bare-username-survives-account-recreate` | low | office tokens carry the account's createdAt; a token from before 1.13.3 counts only for an account made before it | b7e2333 |
| `uploads:pending-upload-and-quota-hold-bound-to-bare-username-survive-account-delete` | low | account delete, re-create and restore drop the name's unfinished uploads and give their holds back | b7e2333 |

Hardening taken from the notes: own-key access in `src/favorites.ts` (an account named `constructor` or `toString` got 500 on download) and whole-file rewrites of the restore's record files (4b678d7). Left as notes: restore reverting a same-instance account's older password hash keeps its live sessions; the sandbox can read (not write) host /etc, /var, /home, /opt and /srv; the per-address visitor cap needs a correct TRUST_PROXY.
