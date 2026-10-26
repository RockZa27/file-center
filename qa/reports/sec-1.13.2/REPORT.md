# File Center 1.13.2 candidate — security audit report (run 2, scoped)

## Run

- **This is a partial pass.** Scoped run of the Cloudflare security-audit skill (pinned c1c8a8c), profile `standard`, covering only source that changed between `0987b1e` (1.13.0, run 1) and `608365e` (1.13.2 candidate on `feature/1.13.2`). 32 changed files; units whose source did not change are `out_of_scope`, not covered.
- Budget 30 agent invocations; spent 25: 9 hunters in 4 waves, 4 coverage critics (one post-wave, three final-clean), 6 Phase-3 candidate verifiers, 6 Phase-5 fresh record verifiers. Reconnaissance was done by the parent: run 1's architecture.md plus a change delta from `git diff`, no recon agents.
- Execution: sandboxed source-and-local-only. Target code ran only under `scripts/qa/sandbox.sh` (own network namespace with loopback, read-only filesystem except the agent scratch, `env -i`, prlimit and timeout); evidence files were promoted by `scripts/qa/promote.py`. Real Chromium (headless) was used inside the sandbox for the HTML sanitisers.
- **Sandbox limitations found during this run.** At the target commit the sandbox bound the host `/dev` read-write and left `/root` and `/tmp` readable (finding `scripts/qa/sandbox.sh:dev-rbind-not-readonly`, fixed during the run in `a0b70f5`). For every agent before the fix, independence between finders and verifiers rested on their prompts, not on isolation: they could have read each other's scratch. Run 1 additionally had no loopback in the sandbox (no `ip` tool), so its local checks could not use sockets.
- Process notes: one hunter (h4-supply) ran `bun audit` outside the sandbox; its result was not used as evidence. One hunter wrote one artifact by hand; those checks were demoted to source-only.
- Prior-run use: run 1's ledger and findings were read. All of run 1's records had their source changed by the 1.13.1/1.13.2 fixes, so none was carried; each became a changed-source revalidation unit.

### Run-1 records revalidated

| Run-1 record | Result in run 2 |
|---|---|
| `admin-2fa-reset-keeps-webdav-app-passwords` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `backup-restore:orphaned-shares-grants-groups-inherited-by-same-name-account` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `cli-revoke-not-applied-to-webdav-and-undone-by-app-password-touch` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `guest-upload-allowance-reserved-at-announce` (confirmed) | **still reproducible** (variant), confirmed again in run 2 |
| `pending-upload-cardinality-sync-scan` (needs_validation) | closed by the fix (re-hunted, not reproduced) |
| `session-store:sessions-survive-restore-and-bind-to-username-only` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `unzip-event-loop-blocking` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `webdav-app-password-bypasses-require2fa-gate` (confirmed) | closed by the fix (re-hunted, not reproduced) |
| `webdav:propfind-duplicate-property-response-amplification` (needs_validation) | **still reproducible** (variant), confirmed again in run 2 |

## Security posture

The 1.13.1 fixes close six of run 1's seven confirmed findings and one of its two leads. Two run-1 problems come back as variants: the visitors' daily allowance can still be held (now by four addresses instead of one), and the PROPFIND answer is still unbounded (distinct long namespaces instead of repeats). The restore session fix closes the direction run 1 found (an old cookie acting as a later account) but not the reverse: a restore still lets a later same-name account act as the restored older one, through sessions and through app passwords, shares, grants and group memberships. A new 1.13.2 control (the pending-upload cap) is shared by every anonymous visitor. No finding is above medium; all need either an authenticated account, an admin opt-in, or an admin restore.

## Confirmed findings

| Severity | Title | Boundary | Observed |
|---|---|---|---|
| medium | WebDAV PROPFIND answer size is not bounded by request size: 50 distinct long-namespace properties multiply every Depth:1 item by about 51 KB | A WebDAV app password for any account. A read-scope password is enough, since PROPFIND nee… | Verifier run with a read-scope app password: 25, 100 and 300 files gave answers of 1.34 MB, 5.20 MB and 15.48 MB, about 51.4 KB per item. Th… |
| low | Backup restore lets a later same-name account's app passwords, share links, grants and group memberships act as the restored older account | An admin must restore a backup taken before the account was deleted and the name re-create… | After restore and restart, A2's app-password secret authenticates as the restored A1 (207 on PROPFIND, 200 on GET /dav/home/shared.txt retur… |
| low | Visitors' daily upload allowance is still lockable: four addresses hold all of it on announced size alone | An upload surface that charges the visitors' allowance must exist. That means an upload-re… | All four announces returned 200. The fifth address was refused with 429 upload.guest-quota both before and after the keepalive chunk writes,… |
| low | Audit sandbox leaves /dev writable, so sandboxed target code can write persistent files to the host's /dev | The harness is launched by a user who can write to the host's /dev. Here it ran as real ro… | The 1-byte write to /dev/v6-probe succeeded inside the sandbox and the file remained on the host after the sandbox exited, as a root-owned r… |
| low | Backup restore keeps sessions of a later, different same-name account, which then authenticate as the restored account | An admin must restore the backup, and the restore needs step-up (confirmPassword). The aff… | In a fresh process the bob#2 cookie returned 200 with user bob and createdAt equal to the restored bob#1 record's createdAt. The bob#1 passw… |
| low | One anonymous visitor can fill the shared 'guest' pending-upload cap and block every other guest upload | The admin has given the guest the upload right in the public space (guestPermissions inclu… | The 501st announce returned 429 upload.too-many-pending. The announce from a second address returned the same 429 after being accepted befor… |

### WebDAV PROPFIND answer size is not bounded by request size: 50 distinct long-namespace properties multiply every Depth:1 item by about 51 KB

- Fingerprint: `webdav:propfind-duplicate-property-response-amplification` — severity **medium** (likelihood medium, impact medium); Phase 5: verified
- Source: `src/webdav.ts:355`, `src/webdav.ts:365`, `src/webdav.ts:397`, `src/webdav.ts:340`, `src/webdav.ts:409`
- Lower-trust principal: A normal user with a WebDAV app password (read scope is enough) and a folder of many small or empty files in their own home.
- Reproduction: Create a folder with N empty files in the account's home. Send the PROPFIND with Depth: 1 and the body above, using Basic auth with an app password. Compare the response size against the de-duplicated 50x <getetag/> request on the same folder.
- Conditions: A WebDAV app password for any account. A read-scope password is enough, since PROPFIND needs only read. WebDAV is enabled and WEBDAV_MAX_ITEMS is at its default (100000) or larger. The attacker's own folder holds many entries. Empty files are enough. Answer size grows linearly with the count, and a folder just under the 100000-entry limit is the worst case.
- Result: Verifier run with a read-scope app password: 25, 100 and 300 files gave answers of 1.34 MB, 5.20 MB and 15.48 MB, about 51.4 KB per item. The de-duplicated request gave 4.5 KB to 52 KB. Process RSS rose from 93 MB to 155 MB at 300 items, and the 300-item answer took 47 ms. Nothing larger was run. The behaviour at the 100000-item cap is extrapolated. Per-item strings alone would reach several GB there. The final join may fail earlier on the engine's maximum string length, but the memory for the per-item strings is already allocated by then.
- Impact: One request makes the shared single-process server build a response whose size is item count times about 51 KB. That risks memory pressure or an out-of-memory crash and stalls other users. Growth was measured only up to 300 items, so the large end is extrapolated. The container and supervisor memory limits are outside the repository. Priority: It needs an authenticated app password (read scope is enough) and a folder with many entries. Empty files are cheap to create, and a single request triggers the amplification.
- Root cause: propfind() caps the number of requested properties (50) and the entry count, but not the total size of the multistatus. The de-dup keys on namespace plus name, so it does not limit the attacker-chosen namespace text that propstat() writes back for each item. There is no aggregate output byte budget and no streaming.
- Smallest fix: Bound the answer, not just the request. Track the running byte total while building the multistatus and return the existing 507 number-of-matches-within-limits error once it passes a cap (for example 32 MB). Alternatively reject or truncate namespace URIs longer than about 100 characters before they are echoed back, or stream the response in chunks instead of joining one string.

### Backup restore lets a later same-name account's app passwords, share links, grants and group memberships act as the restored older account

- Fingerprint: `backup-restore:later-same-name-account-app-passwords-shares-grants-groups-carry-over` — severity **low** (likelihood low, impact medium); Phase 5: verified
- Source: `src/routes/backup.ts:80`, `src/backup.ts:653`, `src/routes/admin.ts:130`, `src/app-passwords.ts:126`
- Lower-trust principal: The holder of the later same-name account, or a holder of a share link or grant that account made, after an admin restore of an older backup.
- Reproduction: Run `SBX_CWD=/home/user/fc-audit2 scripts/qa/sandbox.sh <scratch> bun <scratch>/v1.ts setup diff`, then `... bun <scratch>/v1.ts check diff`. Each phase is a separate process, so check models the restart after a restore. setup: create bob A1 with a file and take a backup. Delete bob. Create bob A2 with a different password and home. As A2 make an app password, a share link, a grant to carol and a group membership. Then call restoreBackup(oldBackup). check: start the app again on the same directories and exercise WebDAV with A2's secret, A2's share token, carol's grants and the restored A1's group list. Repeat with `same` in place of `diff` for the default-home case, where the grant also carries over.
- Conditions: An admin must restore a backup taken before the account was deleted and the name re-created. The restore needs admin plus step-up. Account X existed in the backup. X was later deleted or dropped and a different person was given the name X, with app passwords, share links, grants or group memberships made after the older account's createdAt. Grants carry over only when the grant's path lies inside the restored account's home, which the default /users/<name> makes likely. App passwords, shares and group memberships carry over regardless of home. WebDAV must be enabled for the app-password path. The share, grant and group paths do not depend on it.
- Result: After restore and restart, A2's app-password secret authenticates as the restored A1 (207 on PROPFIND, 200 on GET /dav/home/shared.txt returning A1-FILE in the different-home run). A2's share token serves A1's file. The restored A1 holds A2's team-x membership with edit. In the same-home run carol's grant from A2 lists the restored A1's /pub folder.
- Impact: It crosses account boundaries. The newer account's holder, and holders of its links and grants, reach the restored account's files. The restored account also inherits the newer account's group rights. Access is bounded by the app password's scope and the restored account's permissions. Priority: It needs an admin-initiated restore of a backup that predates a delete-and-recreate of the same username. Account churn and disaster recovery make it plausible but uncommon.
- Root cause: Identity-bound records reference accounts by username with no binding to the account instance. App passwords have only a lower-bound check (record.createdAt >= user.createdAt), which a record made by a newer account passes for an older restored account. Shares, grants and group members have no check at all. restoreBackup() does not reconcile or purge these stores. The clean-up in forgetAccount() runs only in the admin create-user and delete-user handlers, which a restore bypasses.
- Smallest fix: Reconcile the identity-bound stores during restore, in the same step as keepSessionsOf. Drop app passwords, shares, grants and group memberships whose owner or user was created after the restored account's createdAt, and drop records for usernames absent from the restored users.json. Alternatively, give each user a stable account id and store it on each record, then compare it on use. A cheaper hardening is to add the same createdAt bound that usable() applies to sharedItem, grantTarget and memberOf.

### Visitors' daily upload allowance is still lockable: four addresses hold all of it on announced size alone

- Fingerprint: `guest-upload-allowance-reserved-at-announce` — severity **low** (likelihood low, impact medium); Phase 5: replace-nonmaterial
- Source: `src/routes/shares.ts:335`, `src/uploads.ts:285`, `src/uploads.ts:116`, `src/uploads.ts:333`, `src/uploads.ts:116`
- Lower-trust principal: Anonymous visitor with a few client addresses and one upload-request link or a public guest-upload right.
- Reproduction: Set GUEST_UPLOAD_DAILY_BYTES=104857600 in a local instance and enable the guest upload right. From four addresses announce 26214400-byte uploads. Write the last chunk of each upload. From a fifth address announce 1 KiB.
- Conditions: An upload surface that charges the visitors' allowance must exist. That means an upload-request link in the public space, or for an owner without a quota, or the guest upload right enabled by an admin (guestPermissions includes upload). The attacker needs four distinct client addresses as seen by the app. IPv6 /64 rotation makes that cheap. The harness modeled them with TRUST_PROXY=true and X-Forwarded-For. The harness scaled GUEST_UPLOAD_DAILY_BYTES to 100 MiB to stay under the sandbox file limit. The logic is the same at the default 1 GiB, where each address announces 256 MiB. Writing a single small chunk per upload before the idle limit is enough to keep it.
- Result: All four announces returned 200. The fifth address was refused with 429 upload.guest-quota both before and after the keepalive chunk writes, and the four chunk writes returned 200. The verifier reproduced this independently with its own script.
- Impact: Visitor uploads through such surfaces are denied until the day rolls over. Other users, quota-holding owners and stored data are unaffected, and recovery is automatic. Priority: It needs an upload surface that charges the visitors' allowance (an admin opt-in or a public/no-quota upload link) and four distinct addresses. That is cheap with IPv6 but not available to every attacker. Keeping the lock needs periodic chunk writes.
- Root cause: reserveGuest charges the shared daily allowance for the announced size, not for received bytes. The per-address cap (GUEST_PENDING_SHARE = 4, uploads.ts:112) is a fixed fraction of the allowance, so four addresses reach 100%. saveChunk calls touch() after any chunk write, which renews the idle clock (15 minutes for links, 3 hours otherwise) and so keeps the reservation alive.
- Smallest fix: Charge the allowance for bytes actually received, or a small deposit at announce. Release a reservation when no new chunk bytes arrive for a short time. Renew the idle clock only for chunks not received before. Optionally cap the total outstanding reservations of all visitors to half of the allowance.

### Audit sandbox leaves /dev writable, so sandboxed target code can write persistent files to the host's /dev

- Fingerprint: `scripts/qa/sandbox.sh:dev-rbind-not-readonly` — severity **low** (likelihood low, impact low); Phase 5: verified
- Source: `scripts/qa/sandbox.sh:25`, `scripts/qa/sandbox.sh:18`, `scripts/qa/sandbox.sh:21`
- Lower-trust principal: Target-controlled code running under scripts/qa/sandbox.sh during an audit.
- Reproduction: Run `SBX_CWD=<target> <target>/scripts/qa/sandbox.sh <scratch> bun <script>`. In the script, create a file under /dev. After the sandbox exits, list /dev from the host.
- Conditions: The harness is launched by a user who can write to the host's /dev. Here it ran as real root. As a non-root user the user-namespace-mapped uid would probably be denied. The attacker is a dependency or target code that the audit runs inside the sandbox, such as a malicious package or fixture.
- Result: The 1-byte write to /dev/v6-probe succeeded inside the sandbox and the file remained on the host after the sandbox exited, as a root-owned regular file. Writes to /etc, /usr, /tmp and the target repo failed with EROFS. I did not test file sizes beyond 1 byte, so how large a /dev file can grow under the prlimit --fsize cap is not established. I did not attempt raw block device access.
- Impact: It lets sandboxed code leave files on the host outside the declared scratch-only write boundary. The other hunter's observation that raw block device opens were denied was not re-tested here. No network egress or host code execution was shown. Priority: It needs target code to be run in the sandbox by a harness running as a user that can write to /dev, and a malicious target to exploit it deliberately.
- Root cause: Line 21 runs `mount --rbind /dev $R/dev` without the `mount -o remount,bind,ro` step that line 18 applies to every other host directory. The sandbox's own /proc/self/mountinfo lists `/dev rw,relatime - devtmpfs devtmpfs rw`, which is the host's devtmpfs.
- Smallest fix: Remount the /dev bind read-only after the rbind, as is already done for the other host directories, and add nosuid and noexec. Device nodes such as /dev/null stay usable. The sandbox already mounts its own tmpfs on /dev/shm, so /dev/shm stays writable.

### Backup restore keeps sessions of a later, different same-name account, which then authenticate as the restored account

- Fingerprint: `session-store:restore-keeps-sessions-of-later-same-name-account` — severity **low** (likelihood low, impact medium); Phase 5: verified
- Source: `src/routes/backup.ts:73`, `src/backup.ts:652`, `src/backup.ts:626`, `src/context.ts:111`
- Lower-trust principal: The second holder of a re-used username. They are a legitimate user who signed in after the original account was deleted and the name was reused.
- Reproduction: Create bob#1 and take a backup. Delete bob, create bob#2 with a different password, and log in as bob#2 to get a session cookie. Restore the backup. The harness calls restoreBackup() directly because the route needs a supervised process. Start a new process on the same data dir and send the bob#2 session cookie to GET /api/session.
- Conditions: An admin must restore the backup, and the restore needs step-up (confirmPassword). The affected user cannot trigger it. The account was deleted and re-created under the same name for a different person after the backup was taken. The later account's session must still be live (not expired) at restore time. The holder of the later same-name account must hold an authenticated session for that account before the restore.
- Result: In a fresh process the bob#2 cookie returned 200 with user bob and createdAt equal to the restored bob#1 record's createdAt. The bob#1 password logged in again (200) and the bob#2 password was rejected (401). The bob#2 session therefore acts as the restored bob#1 account.
- Impact: A user keeps working as an account that now belongs to another person, with that account's role, files and permissions, until the session expires or is revoked. The effect is limited to a username that was reused across a restore. Priority: It needs an admin to delete and re-create a name for a different person, then restore a backup from before the delete while the later session is still live. The restore is admin-only and needs step-up.
- Root cause: Sessions name their account by username only, and restore decides whether to keep a session by comparing session.created with the restored account's createdAt. That comparison cannot tell an earlier account from a later one with the same name. There is no stable account id or credential epoch in the session. Restore does not purge sessions of an account whose users.json record it replaces.
- Smallest fix: Give each account a stable random id at creation and store it in the session. On restore, drop any session whose id does not match the restored user's id. If a backup lacks ids, drop every non-admin session during restore, or all sessions except the acting admin's. Apply the same id check to app passwords, and purge or id-bind shares, grants and group memberships on restore.

### One anonymous visitor can fill the shared 'guest' pending-upload cap and block every other guest upload

- Fingerprint: `upload-pending-cap-shared-guest-owner` — severity **low** (likelihood low, impact medium); Phase 5: verified
- Source: `src/routes/upload.ts:19`, `src/uploads.ts:285`, `src/uploads.ts:333`, `src/uploads.ts:273`
- Lower-trust principal: Anonymous visitor to a File Center whose admin allows guest uploads in the public space.
- Reproduction: Enable guest upload in a local test instance (admin settings, guestPermissions with upload). As an anonymous client, announce 500 uploads of size 0. As a different anonymous client, announce any upload. Optionally send an empty chunk 0 for an id to renew its idle time.
- Conditions: The admin has given the guest the upload right in the public space (guestPermissions includes upload) and public access is enabled. This is not the default. None. The caller is anonymous and needs one client address. Addresses come from the socket, or from a trusted proxy when TRUST_PROXY is set. The check used X-Forwarded-For with TRUST_PROXY=true to model distinct peers. The attack itself needs only one address.
- Result: The 501st announce returned 429 upload.too-many-pending. The announce from a second address returned the same 429 after being accepted before the attack. The empty chunk write returned 200. After one of the attacker's uploads was cancelled, the second address's announce returned 200.
- Impact: Denies the public upload feature to all other visitors for as long as the attacker renews the uploads. No data is exposed and signed-in users' uploads are unaffected. Priority: Needs the admin to have enabled guest upload, which is off by default, and then a few hundred cheap requests from one address.
- Root cause: The pending-count dimension (owner) is the same string 'guest' for every anonymous principal, and no per-address or per-visitor sub-limit applies to the count. Only announced bytes are limited per address, and zero-byte announces avoid that limit.
- Smallest fix: Key the pending count by address for anonymous callers, for example by counting guest uploads under a per-address key or using owner `guest:<ip>`. Alternatively count a zero-byte announce against a per-address budget. Add a regression test where one address fills its share and a second address still announces.

## Needs validation

None. Every candidate in this run was validated to `confirmed`.

## Hardening notes

45 notes from hunters (full list in `hardening.json` of the run directory). Most relevant:

- (h1-auth) Admin password reset (PUT /api/admin/users/:username with password) and self-service POST /api/password do not call dropLoginTickets. A login ticket issued before the reset (5 minute lifetime, bound to the same address) can still be completed at /api/login/2fa with a valid code and yields a session. It needs the old password plus a TOTP or backup code, so it is low impact. Fix: call dropLoginTickets(username) wherever destroyUserSessions is called on a credential change. Also call it from forgetAccount(). Observed in agents/h1-auth/artifacts/c2.out.
- (h2-restore) POST /api/admin/users does findUser() and then awaits hashPassword() before pushing. Two concurrent creates of the same name can both pass the check and produce duplicate usernames. Only staff can trigger this. Re-check findUser() after the await.
- (h3-uploads) attempts (auth.ts:413) is capped by pruning only, not by size: pruneLoginAttempts removes expired entries only, so a flood of unique ip|username keys can grow the map between prunes. Add a hard cap that evicts the oldest unlocked entries.
- (h4-supply) state.json serverHashes and releases/<name>/server.js both sit in DATA_DIR/app. The hash check protects against partial or accidental modification, but anyone who can write DATA_DIR can also rewrite or delete the hash entry, and serverIntact() returns true when no entry exists. Only server.js is hashed; the release's web/ files are not. It is not a boundary against an attacker with data-volume write access.
- (h4-supply) Update freshness is not bound to a signed statement. latest.json is unsigned and manifests carry no expiry or channel field, so a hostile or compromised UPDATE_SOURCE can withhold updates (a freeze). It can only offer genuinely signed packages with a version greater than the running one. The single Ed25519 key has no rotation or revocation path.
- (h5-client) cleanSlide in web/src/viewers/safe-html.js only matches the literal text `url(` in a style attribute. A CSS-escaped function name (u\72l(...)) or image-set("https://...") survives and issues requests when the page has no CSP (c4 shows only the app CSP img-src blocks them). Suggested fix: drop any slide style containing a backslash, image-set, or any url( that is not blob:/data:image/#, or whitelist properties.
- (h5-client) web/src/viewers/docx.js never sanitises the docx-preview `styles` container, and cleanInPlace leaves <style> elements in place (BASE.FORBID_TAGS lacks 'style'). Add 'style' to the forbidden tags in cleanInPlace and pass the generated CSS through a check.
- (h5-client) Share unlock (/api/s/:token/unlock) and the visitor upload routes are CSRF-exempt by design. Cross-site POSTs to the upload-announce route from a victim's browser would consume that victim address's per-IP upload allowance (SHARE_UPLOADS_PER_IP / guest daily allowance), but they carry no ambient identity. An Origin / Sec-Fetch-Site check on these routes would remove the cross-site path.
- (h6-wildcard) bootstrapAdmin() in src/auth.ts creates the 'admin' account without forgetAccount(). If an operator deletes users.json while sessions.json and the app-passwords file remain, the old 'admin' sessions and app passwords bind to the new account. Calling a shared forgetAccount there closes it.
- (h6-wildcard) In src/uploads.ts sweepIdle()/dropUpload(id, readMeta(id)) skip the quota and guest give-back when meta.json is unreadable. Falling back to the in-memory Live record (owner, size) would let the counters release the reservation.
- (h7-davsettings) savePolicy looks up SPEC[g][key] on plain objects, so keys such as constructor or toString pass the `!spec` check and then throw a TypeError (500). Nothing is saved. Use Object.hasOwn.
- (h7-davsettings) Changing mail.host or mail.port on the web without also re-entering the password makes the stored sealed SMTP password, or the env SMTP_PASS, be sent to the new host. This needs step-up and is an admin-chosen destination, so it fits the comparable-product baseline. Consider asking for the password again when the host changes.
- (h9-depstools) pptx-renderer 1.4.0 defaults externalMedia to 'allow', and web/src/viewers/slides.js does not set it. The SPA CSP (img-src and media-src exclude remote origins, connect-src 'self') blocks the loads. Pass `externalMedia: 'block'` in slides.js as defense in depth in case the CSP is later loosened for ONLYOFFICE.

### Positive patterns observed

- Every cookie-authenticated mutating route (82 checked) refuses a request without the CSRF token; the exempt routes use non-ambient credentials.
- The HTML sanitisers ran 14 XSS/mXSS payloads per viewer in real Chromium with no script execution; the app CSP (`script-src 'self'`, no remote `img-src`) backstops the CSS gaps.
- Update packages: signature over the exact manifest bytes, exact file-set and hash checks, re-verified at apply; CI actions pinned to SHAs and images to digests; lockfile entries all registry + sha512.
- unzip no longer blocks the event loop (loop lag stayed under 50 ms up to 190 MB extracted).
- WebDAV now enforces the forced-2FA gate and the CLI revoke marker; 2FA reset removes app passwords; the settings step-up covers security, mail and alerts.

## Coverage

- Ledger: 25 units — candidate 6, covered 17, out_of_scope 2. `out_of_scope` units are run-1 units whose source did not change; they are not covered by this run.
- Critics: critic1 (post-wave) reassigned 2 units; critic2 (final-clean) reassigned 2; critic3 (final-clean) added 2 units (dependency bumps, audit tooling); critic4 (final-clean) returned `stop: true` with no missing units or reassignments.
- Validators: `validate-findings.cjs` and `validate-coverage-ledger.cjs` pass on the final files.
- Not established without network: registry comparison of the lockfile's sha512 hashes (shape only). OOM thresholds for the PROPFIND finding are extrapolated from measurements up to 400 items.

## Fix status (feature/1.13.2, before release)

| Finding | Fix |
|---|---|
| `webdav:propfind-duplicate-property-response-amplification` (medium) | 524bdfa: requested namespace over 256 characters → 400; answer over 32 MiB → 507 |
| `upload-pending-cap-shared-guest-owner` | 524bdfa: visitors' pending cap counted per address (`guest|<ip>`) |
| `guest-upload-allowance-reserved-at-announce` | 524bdfa: only a chunk not received before renews the idle clock; a visitor upload with no new bytes for 15 min gives its reservation back |
| `session-store:restore-keeps-sessions-of-later-same-name-account` | 44eef1d: an account is (name, createdAt); a restore drops every record of a name not proven to be the live account |
| `backup-restore:later-same-name-account-app-passwords-shares-grants-groups-carry-over` | 44eef1d: same change (app passwords, shares, grants, groups, state, notifications) |
| `scripts/qa/sandbox.sh:dev-rbind-not-readonly` | a0b70f5: minimal read-only /dev, empty read-only /root and /tmp |

Each fix has tests that fail on the code before it (`tests/security-1132.test.ts`, `tests/security-1132-restore.test.ts`) and seeded bugs. Checks on aea040f: `bun run qa` 996/997 (1 skipped), lines 96.37%; `qa:seed` 136/136; `bun audit` 0. Upgrade test on loopback: 1.13.1 → 1.13.2 by the one-click route keeps data; the 1.13.2 launcher records the server.js hash, falls back to the built-in version when the file changed, and still starts a release without a recorded hash. These fixes were not re-audited by a third run.
