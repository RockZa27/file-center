# Needs validation — run 4

No `needs_validation` record: every candidate of this run was validated to `confirmed`. The items below are open for other reasons. None carries a severity, and none is a confirmed vulnerability.

## Pending Phase 5 severity proposals (need one more independent verifier each)

### `lifecycle.user-create-concurrent-duplicate-username`
- Current record (Phase 3): confirmed, low.
- Phase 5 proposal, not applied: Severity changed from low to informational. The race is real (re-run in sandbox: 200/200, two bobby entries, second password 401 until first deleted, then 200; manager case 409), and all cited lines are correct. But only an admin can trigger it, an admin already controls every account, and no boundary is crossed and no other principal's data is read or changed. That is a robustness/uniqueness-invariant defect with minimal impact, which fits 'informational' rather than 'low'. Also added the checkAdoptHome step (line 177) the second admin request passes.
- To close: one fresh verifier checks the proposed record against the severity anchors; apply it if it holds.

## Blocked units (owner-side check on a real image)

### `src/routes/thumbs.ts#GET /api/thumb` — Injection
- Reviewed: `src/thumbs.ts`, `src/routes/thumbs.ts`
- Open: vips tools are not installed here, so the image branch of generate() (vipsheader pixel gate, vipsthumbnail loaders, VIPS_BLOCK_UNTRUSTED behaviour on a polyglot file) was reviewed from source only. Owner check: on an image with libvips-tools, request a thumbnail of an SVG, PDF or MagickCore-only file renamed .jpg and confirm it answers 404 and no external loader ran.

### `web/src/viewers/safe-html.js#safeFragment` — DOM-based XSS
- Reviewed: `web/src/viewers/safe-html.js`, `web/src/viewers/markdown.js`, `web/src/components/TextEditor.vue`, `web/src/viewers/docx.js`, `web/src/viewers/slides.js`, `web/src/viewers/sheet.js`, `web/src/viewers/xls.js`, `web/src/viewers/csv.js`, `web/src/components/SheetGrid.vue`, `web/src/components/CsvTable.vue`, `web/src/components/DocumentPreview.vue`, `web/src/components/ZipViewer.vue`, `web/src/components/PreviewModal.vue`, `src/routes/files.ts`, `src/archive.ts`, `src/index.ts`
- Open: pptx-renderer runtime behaviour was not exercised with a crafted .pptx: ECharts charts (tooltip: trigger item/axis) and lazily resolved media are created by the library after or outside the cleanSlide call, so whether chart tooltip HTML (series/category names from the file) is encoded was verified only by reading imports, not by rendering. Safe owner check: render a pptx whose chart series name is <img src=x onerror=...> in the sandboxed Chromium, hover the chart, and look for an <img> in the tooltip div. docx-preview was not run on a crafted .docx; the sanitizer was exercised on hand-written DOM equivalent to its output, and the library source was read for hyperlink/iframe/innerHTML paths only.

## Deferred units (not hunted; bounded local checks for the next run)

> Follow-up: all four units below were hunted in the scoped run 5 at `33f1abb`. Results: `qa/reports/sec-2.0.0-beta.1-followup/REPORT.md` (3 medium and 2 low confirmed; the 2 zip findings were validated with 3 extra agents).

### `src/cli.ts#sessions-revoke` → `src/auth.ts#reloadIfChangedByCli` — Stale authorization and derived copy use
- Start at: `src/cli.ts`, `src/auth.ts`, `src/app-passwords.ts`, `src/store.ts`, `src/webdav.ts`, `src/context.ts`, `src/index.ts`
- Gap and local check: critic 2: the CLI process and the running app write the same JSON files; a timer write of the app (app-password lastUsedAt after 5 s, hourly session purge, getSession save, queued persist retries) landing between the CLI write and the next request could bring revoked sessions or app passwords back. Prior finding cli-revoke-not-applied-to-webdav was re-checked from source only. Local check: two bun processes on one scratch DATA_DIR, an active WebDAV client, sessions-revoke, authenticate again after the timer.

### `src/routes/files.ts#GET /api/batch/:token` → `src/zip.ts#collectZipItems` — Worker, pool, and priority starvation
- Start at: `src/zip.ts`, `src/routes/files.ts`, `src/routes/shares.ts`, `src/policy.ts`
- Gap and local check: critic 2: archive creation has no unit. GET /api/batch/:token (anonymous by default) and a folder share download walk the whole subtree synchronously (collectZipItems, no entry or depth cap) and deflate on the main thread with no concurrency cap. Local check: event-loop delay of the walk on a bounded tree and of N concurrent anonymous batch downloads; does the generator stop when the client disconnects.

### `src/routes/files.ts#GET /api/search` → `src/search-index.ts#searchEntries` — Database and downstream query amplification
- Start at: `src/search-index.ts`, `src/routes/files.ts`, `src/routes/shares.ts`
- Gap and local check: critic 2: search was reviewed for access control only. For a needle under 3 characters or with more than 1000 trigram hits the query runs synchronously on bun:sqlite as an instr() scan over every indexed entry of the storage root, callable by anonymous visitors on the public space with no rate limit. Local check: time a 2-character non-matching anonymous query on a seeded index of bounded size and the event-loop delay.

### `src/webdav.ts#PUT` → `src/quota.ts#holdNow` — Quota-accounting scope and reset gaps
- Start at: `src/webdav.ts`, `src/quota.ts`, `src/account-records.ts`, `src/routes/admin.ts`, `src/backup.ts`, `src/app-passwords.ts`, `src/routes/files.ts`, `src/office.ts`
- Gap and local check: critic 2: parallel write paths to the confirmed uploads/inflight-complete-survives-account-drop: a slow WebDAV PUT (and PUT /api/content, the office save) fixes the quota user and target before the body and the scan, and re-checks neither the account instance nor the app password afterwards; dropUploadsOf cannot see them. Local check: slow DAV PUT, delete and re-create the user or revoke the app password, finish the body, see where the file lands and who is charged.

## Deployment facts the source cannot establish (owner-observed)

- `TRUST_PROXY` / `TRUSTED_PROXIES` as actually set, and which peer addresses reach the app port: every per-address lockout and upload cap depends on it.
- HTTPS in front of the app with `SECURE_COOKIE=true`; the bind address and host firewall; whether the reverse proxy or tunnel rate-limits requests per client (bears on the likelihood of the batch-token, audit-rotation and zip findings).
- The container memory limit in force (bears on the two memory findings).
- Whether production runs repository `src` or an installed update bundle under DATA_DIR.
