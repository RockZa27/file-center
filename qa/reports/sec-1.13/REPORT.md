# File Center 1.13.0 — security audit report (run 1)

## Run

- **Skill:** Cloudflare `security-audit` (pinned c1c8a8c, `.claude/skills/security-audit/`).
- **Profile:** `standard`. **Scope:** the whole repository: `src/`, `web/src/`, `scripts/`, Dockerfile, compose, CI, lockfile.
- **Source ref:** `0987b1e` (1.13.0, clean tree).
- **Budget:** 45 agent invocations; 39 spent. They were 3 reconnaissance, 12 hunters (one of which declined its first launch and was relaunched), 4 critics, 11 Phase 3 verifiers (two malformed results were discarded and re-run) and 9 Phase 5 verifiers.
- **Execution:** sandboxed source-and-local-only.
  - Target code ran only through `scripts/qa/sandbox.sh`: its own network namespace (loopback only), a read-only filesystem except the agent's scratch directory, an `env -i` allowlist, and `prlimit` plus a 300 s timeout.
  - Evidence was promoted by `scripts/qa/promote.py`: no-follow descriptor walk, regular files with a single link, 256 KiB/2 MiB caps, exclusive create.
  - No deployed system, external service or real credential was touched.
- **Prior runs:** none. This is the first skill ledger. Earlier in-house rounds r1–r9 used planted bugs and are not coverage evidence.
- **Coverage loop:**
  - Three hunter waves. The post-wave critics added 1 unit after wave 1 (sessions vs restore) plus 1 reassignment, then 4 units after wave 2.
  - The post-wave-3 critic and a distinct final-clean critic accepted no further work.
- **Deferred / out-of-scope units:** none. Excluded companions are memory-safety (no native code), AI/LLM (no model at runtime), desktop/mobile/IPC (none) and RPC/messaging (only the HMAC LINE webhook, reviewed under outbound).

## Security posture

The core access model held under every hunter, including authorization per space, path containment, CSRF, share-link re-authorization, the signed updater, the thumbnail tool isolation and the web renderers. No critical or high finding was confirmed. The confirmed defects are of two kinds:
- lifecycle gaps where one path to an account skips a control the others apply (WebDAV versus the /api hooks, restore versus delete);
- two availability issues.

## Confirmed findings

| Severity | Title | Boundary | Observed |
|---|---|---|---|
| medium | Unzip of a small zip blocks the single server thread for seconds to minutes | `src/zip.ts:210` | A 131096-byte zip expanding to 128 MiB: /api/unzip returned 200 after about 1.58 s, and the loop ticked only twice. A third concurrent extraction got 503 archiv… |
| low | Admin 2FA reset leaves the user's WebDAV app passwords working | `src/webdav.ts:143` | Verifier's own run (agents/v8-2fareset/artifacts/v1.out): PROPFIND returned 207 before the reset and 207 after the 2FA reset. After the admin password reset it … |
| low | Backup restore leaves shares, grants and group memberships of removed accounts, which a new same-name account inherits | `src/groups.ts:75` | users.json = [admin, alice]; shares.json, grants.json and groups.json still reference bob. Old share link: 404 before the new account, 200 with name 'old-bob.tx… |
| low | Operator CLI 'sessions-revoke' is ignored by WebDAV and is silently undone by the app's stale app-password store | `src/app-passwords.ts:164` | Verifier run (v1.out): DAV status 207 before the CLI revoke, 207 after it with no API call, file 0 items right after the CLI. After 62 s real time a DAV request… |
| low | A single upload-link visitor can lock the visitors' daily upload allowance for everyone | `src/uploads.ts:114` | B received 429 upload.guest-quota. After A cancelled, B's announce returned 200. The chunk-refresh and idle-expiry behaviour comes from reading the source, not … |
| low | Sessions are bound only to a username and survive backup restore, so an old cookie signs in as a later same-name account | `src/context.ts:111` | Before the account was recreated the old cookie returned user null, and sessions.json still held it. After an admin created a new bob, the old cookie returned u… |
| low | WebDAV app-password sign-in ignores the forced-2FA setup gate | `src/webdav.ts:154` | Before the policy change PROPFIND /dav/ returned 207. After require2fa='all', /api/session showed mustSetup2fa true and /api/me/notify-prefs returned 403. PROPF… |

### Unzip of a small zip blocks the single server thread for seconds to minutes

- **Fingerprint:** `unzip-event-loop-blocking`
- **Severity:** medium (likelihood medium, impact medium). **Confidence:** medium.
- **Source:** `src/routes/files.ts:326`, `src/routes/files.ts:337`, `src/routes/files.ts:342`, `src/zip.ts:210`
- **Principal:** An authenticated ordinary user with zip and write permission.
- **Conditions:** A signed-in user (or guest, if guestPermissions allow it) with zip and write permission in a space.; The attacker uploads a highly compressible .zip of a few KB to MB, within the upload limit.; A small per-user quota or low free disk space, if set, bounds the output and so the stall.
- **Result:** A 131096-byte zip expanding to 128 MiB: /api/unzip returned 200 after about 1.58 s, and the loop ticked only twice. A third concurrent extraction got 503 archive.busy. In the verifier's isolated zip.js run, writeSync took 1635 ms with 0 ticks, a no-op sink took 178 ms with 0 ticks, and an async-write sink let the timer run. Only 128 MiB was tried. The multi-minute stall at 20 GiB is an extrapolation.
- **Impact:** The whole server is unresponsive while the extraction runs, and the time scales with the cap (minutes at the 20 GiB default). It recovers on its own, and the extracted data stays on disk until deleted. A per-user quota, if set, reduces it. It needs an authenticated account and only costs availability.
- **Smallest fix:** Move extraction off the request thread (child process or worker), or at least use async FileHandle writes so the loop can interleave. Add a compression-ratio cap, a much lower default per-request byte budget than 20 GiB, and a deadline. Make unzip slots per user.

### Admin 2FA reset leaves the user's WebDAV app passwords working

- **Fingerprint:** `admin-2fa-reset-keeps-webdav-app-passwords`
- **Severity:** low (likelihood low, impact low). **Confidence:** high.
- **Source:** `src/routes/admin.ts:232`, `src/routes/admin.ts:236`, `src/webdav.ts:143`
- **Principal:** A holder of a leaked or stolen app password for a user whose 2FA was just reset by an admin.
- **Conditions:** A manager or admin must run the 2FA reset and confirm their own password.; The target must already hold an app password, and WebDAV must be enabled.; The holder of the app password must be someone who should no longer have access, such as a lost or stolen device or a leaked secret. Without that there is no security consequence.
- **Result:** Verifier's own run (agents/v8-2fareset/artifacts/v1.out): PROPFIND returned 207 before the reset and 207 after the 2FA reset. After the admin password reset it returned 401.
- **Impact:** The old credential keeps only the access the account already had, at the app password's read or readwrite scope. It gives no escalation, and the user could have created it only with a password step-up.
- **Smallest fix:** Revoke the target's app passwords in the 2FA reset handler and in the CLI reset-2fa branch, and record the count in the audit detail. Add a regression test: create an app password, run the 2FA reset, and expect 401 on /dav. If keeping them is intended, say so in docs/admin-guide.md and the reset dialog.

### Backup restore leaves shares, grants and group memberships of removed accounts, which a new same-name account inherits

- **Fingerprint:** `backup-restore:orphaned-shares-grants-groups-inherited-by-same-name-account`
- **Severity:** low (likelihood low, impact medium). **Confidence:** high.
- **Source:** `src/routes/backup.ts:73`, `src/backup.ts:618`, `src/routes/admin.ts:193`, `src/shares.ts:149`, `src/grants.ts:61`, `src/groups.ts:75`
- **Principal:** A new account holder (or an anonymous holder of an old share link) who benefits from the stale records after the admin's restore and re-creation of the name.
- **Conditions:** An admin restores a backup older than some accounts (needs password step-up and a supervised process).; The removed account had shares, received grants or group memberships.; An admin (or a manager, when the home folder is not already taken) later creates a new account with the same username, possibly for a different person.
- **Result:** users.json = [admin, alice]; shares.json, grants.json and groups.json still reference bob. Old share link: 404 before the new account, 200 with name 'old-bob.txt' after. New bob lists grants received: [alice proj view]; lists alice's folder and downloads alice-private.txt (200, 'ALICE-DATA'). New bob groups: [team, edit].
- **Impact:** The new account gains read access to other users' granted folders and group folders (with the old member's rights), and anonymous holders of old share links regain access to the new account's files.
- **Smallest fix:** In restoreBackup, after swapping users.json, revoke shares, drop grants and remove group memberships (and app passwords) for every username absent from the restored list or whose createdAt differs, and tombstone their trash. Also bind records to the account (store owner createdAt or a stable account id) and refuse them in sharedItem, grantPermsFor and groupSpace when the account is newer than the record. Consider purging leftovers in POST /admin/users. Add a regression test: restore, recreate the same name, then assert 404 and no grants or groups.

### Operator CLI 'sessions-revoke' is ignored by WebDAV and is silently undone by the app's stale app-password store

- **Fingerprint:** `cli-revoke-not-applied-to-webdav-and-undone-by-app-password-touch`
- **Severity:** low (likelihood low, impact medium). **Confidence:** high.
- **Source:** `src/cli.ts:39`, `src/index.ts:243`, `src/webdav.ts:153`, `src/app-passwords.ts:164`
- **Principal:** Holder of a revoked (stolen) WebDAV app password of a normal user.
- **Conditions:** The attacker holds a valid WebDAV app password for the account, for example one stolen from a client device. The operator then revokes it with the CLI.; WebDAV is enabled (policy.webdav) and the operator runs `bun src/cli.ts sessions-revoke` against a running instance.; The revocation is ignored on /dav until some /api request arrives. Permanent resurrection needs a DAV request after lastUsedAt is more than 60 s old and before any /api request, so that the touch write-back fires. The check waited 62 s of real time and did not simulate it.
- **Result:** Verifier run (v1.out): DAV status 207 before the CLI revoke, 207 after it with no API call, file 0 items right after the CLI. After 62 s real time a DAV request returned 207 and the file went from 0 to 1 items 6.5 s later. After an API request and a cache clear, DAV still returned 207 and the file held 1 item. Control (v2.out): an API request immediately after the CLI gave a DAV 401 and 0 items.
- **Impact:** A compromised account's WebDAV access, with the read/write rights of its scope, survives or returns after the operator's emergency revocation, and the CLI reports success.
- **Smallest fix:** Call reloadIfChangedByCli() at the start of handleDav, before authenticate, so the CLI's change is read before any DAV state is used. Also make the write-back safe: re-read the file before touchAppPassword persists, or do not persist lastUsedAt through a store that can overwrite a newer file. Add a regression test that creates an app password, runs the CLI revoke, expects 401 on /dav without any prior /api call, and expects app-passwords.json to stay at 0 items after another DAV attempt.

### A single upload-link visitor can lock the visitors' daily upload allowance for everyone

- **Fingerprint:** `guest-upload-allowance-reserved-at-announce`
- **Severity:** low (likelihood medium, impact low). **Confidence:** high.
- **Source:** `src/routes/shares.ts:332`, `src/routes/shares.ts:361`, `src/uploads.ts:212`, `src/uploads.ts:114`
- **Principal:** An anonymous visitor of an upload-request link.
- **Conditions:** The target link is in the public space or its owner has no quota (the default for new users). Home-space links of owners with a quota are charged to the owner instead.; The attacker only needs any upload-request link, or an enabled public upload. No account is needed.; Holding past 15 minutes needs one valid 8 MiB chunk re-sent before each idle window ends. Without that, the hold ends at the next announce-triggered cleanup or the hourly cleanup.
- **Result:** B received 429 upload.guest-quota. After A cancelled, B's announce returned 200. The chunk-refresh and idle-expiry behaviour comes from reading the source, not from a local run.
- **Impact:** Visitor and guest uploads stop sitewide for up to the day. Signed-in uploads and all other functions are unaffected, and the hold ends at midnight.
- **Smallest fix:** Do not reserve the daily allowance at announce time. Count it per chunk received or at completion. Alternatively, give each link and each IP a bounded slice of the allowance. Do not renew the idle timer from chunk writes on an upload that is already holding a reservation, and cap the total lifetime of an incomplete upload.

### Sessions are bound only to a username and survive backup restore, so an old cookie signs in as a later same-name account

- **Fingerprint:** `session-store:sessions-survive-restore-and-bind-to-username-only`
- **Severity:** low (likelihood low, impact medium). **Confidence:** high.
- **Source:** `src/routes/backup.ts:73`, `src/backup.ts:633`, `src/routes/admin.ts:98`, `src/auth.ts:229`, `src/context.ts:111`
- **Principal:** A former holder of a valid session cookie for an account that a restore later removed from users.json. The holder waits until an admin re-creates that username for someone else.
- **Conditions:** An admin runs a restore from a backup in which the user is absent. The server must be supervised (FC_SUPERVISED=1).; The old cookie must still be within the session TTL when a new account with that name is created. Each request refreshes the session's last-seen time.; An admin creates a new account with the same name for a different person.
- **Result:** Before the account was recreated the old cookie returned user null, and sessions.json still held it. After an admin created a new bob, the old cookie returned user bob with the new account's createdAt, which matched the new bob's own login.
- **Impact:** The previous holder gets authenticated access as the new account, including its home folder and any grants or shares the account holds.
- **Smallest fix:** Add a per-account identifier or credential epoch to the session record and compare it in getSession or derive. As a minimum, call destroyUserSessions(username) in POST /admin/users and in the CLI create path. In restoreBackup, drop every signed-in session whose username is missing from the restored users, or all sessions, since credentials and roles were replaced.

### WebDAV app-password sign-in ignores the forced-2FA setup gate

- **Fingerprint:** `webdav-app-password-bypasses-require2fa-gate`
- **Severity:** low (likelihood low, impact medium). **Confidence:** medium.
- **Source:** `src/index.ts:243`, `src/webdav.ts:127`, `src/webdav.ts:152`, `src/webdav.ts:154`
- **Principal:** Holder of a valid app password (a stolen or leaked one) for an account that the policy now requires to have 2FA, but which has not enrolled.
- **Conditions:** An admin has set security.require2fa to admin, staff or all, and WebDAV is enabled.; The affected account has no 2FA enrolled and holds an app password. The password was made before the policy tightened, or while the account was not yet affected.; The caller needs a valid app password for the account (a first-factor-equivalent secret). That is the only credential WebDAV asks for.
- **Result:** Before the policy change PROPFIND /dav/ returned 207. After require2fa='all', /api/session showed mustSetup2fa true and /api/me/notify-prefs returned 403. PROPFIND /dav/ with the same app password still returned 207, so listing was reachable without the second factor. PUT /dav/poc.txt returned 403 both before and after the change (cause not investigated), so write access was not demonstrated and is inferred only from the readwrite scope.
- **Impact:** The forced-2FA guarantee is undermined for WebDAV file access. Listing was observed; read and write follow from the scope and the account's rights, but write was not shown. The access stays within the account's own rights and the app password's scope.
- **Smallest fix:** In webdav.ts authenticate(), reject the request when policy.mustSetup2fa(found.user), as is already done for mustChangePassword. Optionally also revoke or suspend the account's app passwords when require2fa is tightened.

## Needs validation

No severity is assigned to these, and they are not confirmed vulnerabilities.

| Title | Trace | Blocker | Local next step | Owner check |
|---|---|---|---|---|
| Unbounded pending uploads make every upload-link announce scan all of them synchronously | `src/routes/upload.ts:12` → `src/uploads.ts:180` → `src/routes/shares.ts:348` → `src/uploads.ts:135` | Nothing in the measured range (up to 4000 pending uploads, 52 ms) shows a meaningful shared availability effect. The claimed 1 s or longer stall at about 100k pending uploads is extrapolated and was n | In the sandbox, use the in-process harness with a fresh DATA_DIR. As one user, create pending zero-byte uploads in steps of at most 4000. After each step, time 20 refused or accepted announces on an u | The owner should check the filesystem inode headroom on the DATA_DIR volume, the reverse-proxy rate limits on /api/upload, and the p95 latency of the share announce endpoint in a staging copy. In stag |
| WebDAV PROPFIND allows 50 repeated copies of the same property, multiplying the Depth:1 answer for large folders | `src/webdav.ts:351` → `src/webdav.ts:361` → `src/webdav.ts:393` → `src/webdav.ts:339` → `src/webdav.ts:406` | Peak memory of a PROPFIND answering near davMaxItems (100,000) entries with 50 repeated properties, against the deployed mem_limit, was not run. A safe local measurement up to the 4,000-entry ceiling  | Already done, safely, at 50-4,000 entries with 240-character names: measured PROPFIND response size and process RSS for one vs. 50 repeated <D:displayname/> properties (agents/v9-propfind/artifacts/v1 | On a staging copy with the production mem_limit and the real launcher/supervisor wired up, give a test non-admin user write/upload permission and roughly 50,000-99,999 zero-byte, long-named files in o |

## Hardening notes

These are not findings: another layer blocks each one, or each needs host access. The selected notes below are from hunter reports, and the full list is in `hardening.json`:

- settings.logo is used unvalidated in path joins (src/routes/admin.ts:72 read on the unauthenticated GET /api/branding/logo, and :413/:423 rmSync). A settings.json restored from a backup could carry a ../ ext. Reaching it needs a hand-crafted backup zip placed in BACKUP_DIR, and no upload route exists. Add a /^[a-z0-9]{1,5}:\d+$/ check when loading settings and in checkData.
- src/policy.ts: STEP_UP_GROUPS covers `security` and `mail` but not `alerts`. A session-only admin attacker (no password) can repoint or disable the alert webhook, and the admin's settings-security alert is raised only for `security.*` keys. Consider step-up for alerts.webhookUrl and an alert on mail and alerts changes.
- The launcher boots DATA_DIR/app/releases/<name>/server.js with the full environment and no re-hash or re-verify, and rollback to a history release is likewise not re-verified. Safe only while DATA_DIR/app is writable solely by the app/host. Storing the verified server.js SHA-256 in state.json and checking it at launch would cap the damage of any future arbitrary-write bug.
- latest.json and latest-beta.json are unsigned and carry no expiry or monotonic floor. A compromised update source can freeze updates or offer any older signed package that is still newer than the running version. No signed timestamp, minimum-version or revocation metadata exists, and an admin who rolled back to the builtin version can then install a previously signed vulnerable build. Consider a signed latest manifest with expiry and a persisted minimum-version floor.
- GitHub Actions are pinned to mutable release tags (actions/checkout@v7.0.1, trivy-action@v0.36.0 and others) and container bases to tags rather than commit or image digests. CI has read-only permissions and no secrets, so impact is limited to CI integrity; pin to SHAs/digests.
- Share-link unlock lockout is keyed only by share|id|ip with no per-link cap across addresses. It relies entirely on clientIp being trustworthy. A per-share failure ceiling like the account-wide login counter would make it robust to a TRUST_PROXY misconfiguration.
- Document that TRUST_PROXY=true takes the last X-Forwarded-For entry. This is correct for exactly one trusted proxy. With a CDN plus a reverse proxy, all clients collapse to the intermediate proxy's address and the per-address lockouts become a shared denial-of-service lever.
- web/src/viewers/safe-html.js: the Markdown path allows the style attribute (only the style tag is forbidden), and the docx path also allows style tags. Untrusted shared files can overlay or restyle the preview (position:fixed). This gives UI redress or phishing at most, because the CSP blocks script and external images. Consider FORBID_ATTR 'style' for Markdown, or contain the preview with `contain: paint` or an iframe.
- web/src/viewers/slides.js: pptx-renderer output is only link-filtered by cleanLinks. It is not sanitised like docx and Markdown. This is safe today because of script-src 'self'. A DOMPurify pass or a renderer-output allowlist would remove the dependence on the CSP.
- src/routes/files.ts fileResponse and src/archive.ts: inline .pdf responses carry no CSP and no frame-ancestors. Read-only content, so hardening only. Clickjacking of a state-changing action was not found on the download routes.
- src/routes/admin.ts POST /admin/users: a manager chooses the new user's password and does not set mustChangePassword. The PUT reset path does set it, and requires the manager's own password, to stop a manager keeping a password that bypasses the read-only, audited view. Setting mustChangePassword for manager-created accounts would make the two paths consistent. A manager can reach the new user's account only until that user changes the password, and the login is audited.
- src/routes/files.ts POST /api/newfile uses writeFileSync(target, '') after existsSync(target). A dangling symlink in storage would be followed. The app never creates symlinks, so this is not reachable today. Opening with the 'wx' flag would remove the dependency.
- POST /api/s/:token/upload/:id/complete calls recordUpload and notify on every call, although completeUpload returns again:true for a repeat. A visitor can inflate uploadedFiles and uploadedBytes, fill the link's maxFiles and maxTotalBytes limits, evict other visitors' entries from the 2000-entry log, and spam owner notifications. A visitor can already upload tiny files up to the limit, so little capability is gained. Skip recordUpload and notify when done.again is true.
- /api/s/:token/thumb at size 1024 serves a near-full-resolution image without counting against maxDownloads, so a one-download link can be previewed repeatedly (src/routes/thumbs.ts).
- webdav-xml.ts copies the whole in-scope namespace Map for every element. With about 2000 xmlns declarations and 1999 elements one parse blocks the event loop for about 100 ms (about 0.3 s at the 64 KB cap). Limit the number of attributes or declarations per tag, or share the scope until a tag declares a namespace.
- index.ts housekeeping() runs repairTrash, purgeExpired, purgeExpiredVersions and the rest inside one try block. A throw from rmSync in purgeExpired skips the remaining jobs for that hour. Wrap each job separately.
- The thumbnail queue is global (2 running, 16 queued) with no per-user fairness. A timeout is not remembered as a failure, so a file that times out is retried at 10 s per request. One user can degrade thumbnails for others. Core file functions are not affected.
- Share links store the path relative to the owner's current home root. If an owner is promoted to admin (home becomes the storage root) or the admin changes homedir, the same relative path re-resolves to a different file, whereas grants store an absolute storage path. This needs an admin action. Store the absolute path in shares as grants do.
- The archive viewer holds one of 4 global slots until the response stream finishes. A client that reads the first chunk and then stalls keeps the slot until Bun's 255 s idle timeout. This was not tested.

**Positive patterns:**
- `need()`/`accessFor` re-evaluated per request.
- `resolveIn` uses realpath containment.
- Grants and shares are re-checked on every use.
- Ed25519 manifest plus per-file SHA-256 updater with a password step-up.
- argv-only tool spawns with a minimal env.
- `script-src 'self'` CSP.
- `redirect:'error'` on every outbound fetch.
- Sealed secrets.
- CSV formula guard.

## Coverage

- **Units:** 23. Covered 13, candidate 10, blocked 0, deferred 0.
- **Final critic:** no missing units, no reassignments.
- **Limits:**
  - Chromium could not start under the sandbox address-space cap, so the web sanitiser was judged from source and CSP only.
  - Availability findings were measured only at small growth points.
  - Deployment facts (proxy, TLS, `TRUST_PROXY`, memory limit) are outside the repository.
