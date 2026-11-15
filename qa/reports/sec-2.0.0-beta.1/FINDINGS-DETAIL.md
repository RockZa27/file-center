# Findings detail — run 4 (confirmed medium and above)

Local reproduction only: an in-process app with dummy accounts and files inside the audit sandbox. Nothing here is an instruction to test a deployed server.

## POST /api/batch retains one token entry per call with no cap, reachable by an anonymous visitor in the default configuration

Fingerprint `files:batch-token-map-unbounded` — **medium**

### Trace
1. [entrypoint] `src/routes/files.ts:440` (POST /api/batch): need(space, download, batchdownload) passes for an anonymous session on the public space with default guestPermissions
2. [propagation] `src/routes/files.ts:445` (POST /api/batch): existingNames dedupes and checks that up to 2000 names exist; this is the only per-request bound
3. [sink] `src/routes/files.ts:449` (POST /api/batch): batches.set(token, {... names ...}) with no size check

### Evidence
- `src/routes/files.ts:448`: The only removal is the sweep of expired entries, run on the next POST
- `src/routes/files.ts:111`: batches is a plain module-level Map with no limit
- `src/settings.ts:90`: Default guestPermissions include download and batchdownload, so anonymous visitors qualify while the public page is on

### Dummy attacker and affected resource
Anonymous visitor with a session cookie and CSRF token, calling the batch endpoint repeatedly. Each POST /api/batch stores {owner, space, root, dir, names[], expires} in the module-level Map batches for 5 minutes. The only removal is the expiry sweep on the next POST; there is no per-session, per-address or global cap. In an in-process run in the sandbox, an anonymous session with its CSRF token called POST /api/batch 2000 times on a public folder of 300 files (name length about 55 chars), naming all files. All 2000 calls returned 200 with a token, and the first and the last token were still redeemable (GET /api/batch/:token gave 200). Heap grew by about 82.8 MB (about 42 KB per entry, about 140 bytes per name) in about 1.3 to 1.6 s of handler time (about 1 ms per call, so the O(n) sweep was not a limiter at this size). No app-level rate limit was found on this route. Arithmetic, not measured: at the same per-call cost, 100000 calls would hold about 4 GB for 5 minutes, and a folder near the 2000-name per-request limit would hold about 280 KB per entry. Real HTTP overhead and any proxy rate limit or container memory limit would change the rate; those are deployment facts that were not observed. No saturation was run.

### Input and bounded instructions
- `POST /api/batch {"space":"public","path":"/","items":["<all 300 existing file names>"]} repeated 2000 times`

1. GET /api/session, keep the fc_sid cookie and csrf
2. POST /api/batch with the public space and all file names, 2000 times
3. GET /api/batch/<first token> and <last token> to see that both are still live

### Observed output and the invariant it proves
2000 of 2000 calls returned 200; first and last token redeemable with 200; heap grew about 82.8 MB (about 42 KB per entry) in two runs (82816 and 82820 KB); about 1 ms per call.

Intended behaviour: Batch tokens should be bounded like the other visitor-reachable maps (anonymous sessions 5000, auditOnce 5000, attempts 10000): cap total and per-owner entries, or evict the oldest, or encode the selection in a signed token instead of server memory.

### Conditions and containment
- (authentication_level) Anonymous session plus its CSRF token (GET /api/session); no login
- (system_configuration) Public page on (default) and guestPermissions include download and batchdownload (default)
- (data_state) The public folder holds at least one file; entry size scales with the number of names (up to 2000 per call)
- (network_routing) A rate limit in a reverse proxy or tunnel and the container memory limit were not observed and decide how fast it grows

### Remediation and regression case
Cap the Map (global and per owner, evicting the oldest or refusing with 429 when full), and sweep on a timer; or make the token self-contained and signed so that no server memory is held.

## An admin session alone can mint a new admin with a chosen password and then pass every password step-up

Fingerprint `stepup:admin-account-create-and-password-set-without-step-up` — **medium**

### Trace
1. [entrypoint] `src/routes/admin.ts:153` (POST /api/admin/users): requireStaff at 160; an admin may pass role admin (162 refuses only non-admins); no password asked; hashes the supplied password at 190
2. [propagation] `src/routes/admin.ts:232` (PUT /api/admin/users/:username): reset = !!passwordHash && !isAdmin(admin): step-up only for managers; an admin sets any password (and role) with none
3. [sink] `src/auth.ts:524` (confirmPassword): verifies the supplied password against the signed-in account's own hash, so the attacker-made admin passes it

### Evidence
- `src/routes/admin.ts:162`: only non-admins are refused a role other than user
- `src/routes/admin.ts:558`: PUT /admin/settings calls confirmPassword for security/mail/alerts/etc groups; passes with the new admin's password
- `tests/roles-fixes.test.ts:129`: admin password reset without confirmation is intentional, so the gap is by design for single resets but defeats the documented step-up in combination

### Dummy attacker and affected resource
Holder of a stolen admin session only (cookie + csrf), password unknown. POST /api/admin/users with role admin, and PUT /api/admin/users/:username with a password, ask an admin caller for no password. A holder of only an admin session cookie creates a second admin with a password of their choosing, signs in as it, and passes confirmPassword on step-up routes (observed: PUT /api/admin/settings with a security group returned 200 using the new admin's password and 403 with a wrong one). docs/security.md says a stolen session alone cannot change sign-in rules because the admin password is asked. The settings step-up field is body.password, not confirmPassword.

### Input and bounded instructions
- `POST /api/admin/users {username:evil2,name:E,password:<chosen>,role:admin,permissions:[read],publicPermissions:[]}`
- `POST /api/login evil2/<chosen>`
- `PUT /api/admin/settings {security:{sessionTtlHours:100},password:<chosen>}`

1. Login as admin A, keep only its cookie/csrf
2. Create admin evil2 with a chosen password: 200
3. Login as evil2 in a second client: 200
4. PUT /api/admin/settings with security group and evil2's password: 200 (a wrong password gives 403)
5. PUT /api/admin/users/evil2 {password} from the session-only client: 200 without confirmation

### Observed output and the invariant it proves
All steps returned 200 in an in-process sandbox run (re-run by the final verifier, exit 42); the wrong-password control gave 403. With REQUIRE_2FA=admin and an admin already enrolled in 2FA, the new admin enrolled its own 2FA and the step-up still gave 200 (wrong password 403).

Intended behaviour: Creating an admin, promoting to admin, or setting another admin's password should need the acting admin's own password (confirmPassword), like the other sensitive admin actions, so a stolen session alone cannot obtain a password it knows.

### Conditions and containment
- (authentication_level) attacker holds a valid admin session cookie and CSRF token (stolen session); no admin password known
- (system_configuration) with REQUIRE_2FA=admin the stolen session must belong to an admin that already has 2FA (an unenrolled admin is blocked with 403 auth.2fa-required); the new admin then enrolls its own 2FA with its known password and a self-computed TOTP, after which the step-up passes (tested), so 2FA is not a barrier

### Remediation and regression case
Require confirmPassword of the acting admin on create with role admin, on role promotion to admin, and on an admin setting another account's password (at least for admin targets); keep the audit trail and consider alerting on new admin creation.

## Central-directory entry/size pre-check bypassed by a fake EOCD hidden in the real EOCD comment

Fingerprint `zip-checkdirectory-eocd-mismatch-bypass` — **medium**

### Trace
1. [entrypoint] `src/routes/archive.ts:32` (GET /api/archive/list): authenticated user (or share-link holder via the share archive routes) asks to list a zip they or a share owner placed: listArchive(abs)
2. [propagation] `src/zip.ts:27` (checkDirectory): takes the last 0x06054b50 in the tail, so a fake EOCD placed in the real EOCD comment is the one validated
3. [sink] `src/zip.ts:181` (unzipTo): reader.getEntries() loads the entire directory into memory (listArchive does the same through getEntriesGenerator) after the cap was skipped

### Evidence
- `src/zip.ts:50`: entry cap compared only against the EOCD chosen at line 27
- `src/zip.ts:49`: byte cap likewise compared only against the chosen EOCD
- `src/archive.ts:63`: listArchive/archive-file rely on checkDirectory alone before creating ZipReader
- `src/zip.ts:183`: unzipTo file-count check runs only after getEntries has loaded all entries
- `src/config.ts:160`: uploadMaxSize default 10 GB is the only remaining bound on directory size

### Dummy attacker and affected resource
low-privilege user who stores a crafted zip and requests its listing or extraction. checkDirectory reads the last PK\5\6 signature in the file tail, while zip.js uses the EOCD that actually locates the directory. A zip whose real (ZIP64) EOCD has a 22-byte comment holding a zero-count EOCD passes the check, yet zip.js still loads the whole directory. Locally a 120000-entry zip (cap 100000) was refused 413 when plain but passed when crafted; zip.js getEntries then read 120000 entries and grew RSS by about 300 MB for a roughly 6 MB file (about 50x). The pre-check exists solely to stop zip.js holding an oversized directory in memory. After the bypass only the file size (UPLOAD_MAX_SIZE default 10 GB), the post-hoc files.length check in unzipTo (read after getEntries) and the 10000-entry display cut in listArchive (applied after the directory is loaded) remain, and none bound zip.js memory. Reached through archive list/file, unzip, and the share archive routes.

### Input and bounded instructions
- `ZIP64 zip with more than 100000 central-directory records whose real EOCD comment (length 22) contains an EOCD with zero counts`

1. Build 120000-entry ZIP64 zip plain and with the fake EOCD in the comment
2. Call checkDirectory and listArchive on both, then zip.js getEntries, measuring RSS growth, in the sandbox

### Observed output and the invariant it proves
plain: refused 413; crafted: check passed, listArchive returned 10000 entries (truncated), zip.js read 120000 entries, RSS growth about 314-343 MB versus 367-372 MB for the plain file. Runs repeated twice. Not scaled further.

Intended behaviour: DIRECTORY_MAX_BYTES and DIRECTORY_MAX_ENTRIES are enforced on the same EOCD record zip.js will parse, so an oversized directory is refused before zip.js reads it.

### Conditions and containment
- (authentication_level) an account (or public-space guest, or upload-request visitor) able to place a zip that someone can list or unzip, or a share-link holder of a folder containing it

### Remediation and regression case
Mirror zip.js EOCD selection, or reject any archive with more than one EOCD signature in the tail or whose EOCD comment length does not end the file; additionally stream/limit entries while reading so the cap does not depend on the pre-check.
