# Needs validation

## Unbounded pending uploads make every upload-link announce scan all of them synchronously

`pending-upload-cardinality-sync-scan`

POST /api/upload has no per-user cap on pending uploads, and size 0 is accepted. Each announce writes a tmp/<id> directory with an empty data file and a meta.json, which stay for UPLOAD_STALE_HOURS (3 by default). Every announce on an upload-request link calls shareUploadLoad before the per-link and per-IP checks. That call runs allMetas, which does a readdirSync and a readFileSync/JSON.parse of every meta.json in the shared tmp folder on the event loop. Stale-upload dropping inside shareUploadLoad applies only to share uploads, so ordinary pending uploads stay in the scan for the full 3 hours. I found no rate limit on /api/upload or on the share announce route. The hunter measured announce time rising linearly from 5.7 ms with no pending uploads to 52.2 ms at 4000, about 13 microseconds per pending upload. That is ordinary performance cost, not meaningful shared unavailability. A stall of roughly 1 s per announce is an extrapolation to about 100k pending uploads. Whether that is reachable depends on things I could not observe from source. Those are the inode and disk limits on the data volume, ensureSpace and minFreeSpace, any reverse-proxy rate limit, and the real per-announce cost on production storage. The finding is therefore hardening-level until it is shown at scale. I checked the source and the hunter's artifact c2.out. I did not complete an independent run, so the hunter's timings are not independently reproduced.

**Claimed root cause:** Pending-upload count is unbounded per owner, and the announce path does a full synchronous directory scan of all owners' uploads in shareUploadLoad/allMetas instead of using an in-memory index.

**Trace**

- entrypoint: `src/routes/upload.ts:12`: An authenticated user with upload permission announces files repeatedly, including with size 0. There is no count check.
- propagation: `src/uploads.ts:180`: Each call creates tmp/<id>/data and meta.json, with no cap on pending uploads per owner or in total.
- propagation: `src/routes/shares.ts:348`: Any visitor's announce on an upload-request link calls shareUploadLoad before the per-link and per-IP limits are applied, so even a refused announce pays the scan.
- sink: `src/uploads.ts:135`: Synchronous readdirSync plus readFileSync/JSON.parse of every meta.json in the shared tmp folder, so cost grows with the total pending count.

**Evidence**

- `src/uploads.ts:155`: shareUploadLoad iterates every allMetas entry and statSyncs each share upload. Only share uploads are dropped as idle here; other pending uploads stay for UPLOAD_STALE_HOURS.
- `agents/h4-resource/artifacts/c2.out:1`: Hunter measurement: announce latency 5.7 ms with no pending uploads, then 7.2, 16.5, 28.5 and 52.2 ms at 500, 1000, 2000 and 4000. Linear, and nowhere near a meaningful stall at the measured sizes.

**Blockers**

- Nothing in the measured range (up to 4000 pending uploads, 52 ms) shows a meaningful shared availability effect. The claimed 1 s or longer stall at about 100k pending uploads is extrapolated and was not measured.
- Inode and free-space limits on the DATA_DIR volume, and ensureSpace/minFreeSpace, may stop an attacker from creating that many tmp entries. These are deployment facts.
- Any reverse-proxy or WAF rate limit in front of /api/upload is deployment-dependent. The application has none for this route.
- Real per-entry scan cost on production storage (network or overlay filesystem, cold cache) differs from the sandbox tmpfs measurement.

**local plan:** In the sandbox, use the in-process harness with a fresh DATA_DIR. As one user, create pending zero-byte uploads in steps of at most 4000. After each step, time 20 refused or accepted announces on an upload-request link from another client, and record the median and p95. Also time an unrelated cheap endpoint concurrently, to show the event-loop stall rather than per-request cost. Fit the per-entry slope and check it holds across repeated runs. Do not go past 4000 entries locally.

**deployment plan:** The owner should check the filesystem inode headroom on the DATA_DIR volume, the reverse-proxy rate limits on /api/upload, and the p95 latency of the share announce endpoint in a staging copy. In staging, create pending uploads in stages with one test account, up to the largest count the volume allows. Confirm whether announce latency or other endpoints degrade beyond an acceptable bound, and how long recovery takes after the 3-hour stale cleanup.

## WebDAV PROPFIND allows 50 repeated copies of the same property, multiplying the Depth:1 answer for large folders

`webdav:propfind-duplicate-property-response-amplification`

An app-password client with write access can send a PROPFIND with Depth: 1 naming one property 50 times (e.g. <D:displayname/>), a body under the 64 KB cap. propfind() caps only the count of requested property names (PROPFIND_MAX_PROPS = 50), not distinct names, so propstat() emits the same value 50 times per item. Locally reproduced at 50-4,000 entries (240-char names): the repeated-50 answer is a stable ~21.7x the single-property answer (~14,690 bytes/item vs ~676 bytes/item), confirming linear, non-superlinear growth with a fixed per-item multiplier - the hunter's own ~43x figure measured only the duplicated-property fragment in isolation, not the full per-item response including the fixed href/propstat overhead; end-to-end the real amplification is ~21.7x. The only cardinality bound on the folder is davMaxItems (config.davMaxItems, default 100,000); there is no total-byte cap and no streaming - propfind() builds one string per item, joins them, then wraps and returns the whole multistatus in one Response. Linearly extrapolating the measured per-item costs to davMaxItems-1 (99,999) gives roughly 1.47 GB for the joined XML string alone, before counting the intermediate per-item string array, against docker-compose.yml's mem_limit of 2g for the single shared process. Quota is byte-based only (src/quota.ts via src/webdav.ts:422-427) with no per-folder or per-user file-count cap, and WebDAV PUT/MKCOL carry no additional per-request throttling beyond the login-failure lockouts, so a write-capable account is not blocked from growing one folder's entry count by any source-visible control other than time.

**Claimed root cause:** propfind() caps only the number of requested properties (PROPFIND_MAX_PROPS = 50), not distinct properties, and caps only the number of entries (config.davMaxItems), not the total answer size. propstat() therefore emits each repeated name per item (src/webdav.ts:339, not the hunter's cited 329, which is an unrelated local-variable declaration), and the whole multistatus is materialized as an array of per-item strings and joined in memory before the response is built (src/webdav.ts:405-406).

**Trace**

- entrypoint: `src/webdav.ts:351`: PROPFIND with Depth: 1 and an XML body naming one property 50 times; the count is checked against the 50-property cap a few lines later (line 360).
- propagation: `src/webdav.ts:361`: wanted = prop.children.map(c => ({ ns: c.ns, name: c.name })) keeps every duplicate name from the request body.
- propagation: `src/webdav.ts:393`: The only cardinality bound is readdirSync(place.abs).length >= config.davMaxItems (100,000, config.ts:96); below that, listStats builds an Item for every entry with no total-size check.
- propagation: `src/webdav.ts:339`: else ok.push(namesOnly || value === '' ? ... ) emits one <D:name>value</D:name> (or <D:name/>) per entry in `wanted`, including exact duplicates, so a 255-character displayname is written 50 times for one item (verified local measurement: ~14,690 bytes/item at 50 repeats vs ~676 bytes/item for one, a stable ~21.7x across 50-4,000 items).
- sink: `src/webdav.ts:406`: xmlResponse(207, `<D:multistatus ...>${body.join('')}</D:multistatus>`) concatenates every item's full response string (line 405: body = items.map(...)) into one string in memory, with no size cap or streaming, before the Response is created.

**Evidence**

- `src/webdav.ts:320`: Doc comment: "100,000 items x 50 properties stays in the tens of MB, a photo folder of 20,000 still lists" - the design assumption behind leaving the answer unbounded in total size (the constant PROPFIND_MAX_PROPS = 50 itself is declared two lines later, at line 323).
- `src/webdav.ts:405`: const body = items.map(it => `<D:response>...</D:response>`) fully materializes every item's XML before the join at line 406; no size cap is applied anywhere in propfind().
- `src/config.ts:96`: davMaxItems defaults to 100_000 and is documented as bounding entry count, not answer size ("a WebDAV folder listing ... answers folders with fewer entries than this; bigger ones get 507").
- `docker-compose.yml:50`: mem_limit defaults to 2g (${FC_MEMORY_LIMIT:-2g}) for the single shared server process that every user's requests, including WebDAV, run in.

**Blockers**

- Peak memory of a PROPFIND answering near davMaxItems (100,000) entries with 50 repeated properties, against the deployed mem_limit, was not run. A safe local measurement up to the 4,000-entry ceiling used here (agents/v9-propfind/artifacts/v1.out, script at agents/v9-propfind/artifacts/v1.ts) showed linear, stable per-item cost (~676 bytes/item for one property, ~14,690 bytes/item for 50 repeated, a steady ~21.7x ratio across 50/100/200/500/1000/2000/4000 entries) and a response that reached 58.8 MB at 4,000 items. Linearly extrapolating to 99,999 items gives roughly 1.47 GB for the joined XML string alone (not counting the intermediate per-item string array built by items.map before the join), against the compose mem_limit of 2g - but no run was made at or near that scale, so the real peak RSS, whether Bun's string/array overhead multiplies that further, and whether the shared process is actually OOM-killed at the deployed limit remain unmeasured here.
- Whether a normal, non-admin, write-capable user can realistically grow one folder to the tens of thousands of entries needed is not fully established from source alone. Quota is confirmed byte-based only (src/webdav.ts:422-427, via src/quota.ts) with no per-folder or per-user file-count cap, and WebDAV PUT/MKCOL carry no additional per-request throttling beyond the login-failure lockouts (src/webdav.ts:122-155) - so the only source-visible friction is the time needed to issue on the order of 100k authenticated requests. An owner must check realistic PUT/MKCOL throughput against this server and any operational policy that limits file count in practice.
- How the launcher/supervisor behaves after the shared process is OOM-killed (restart time, whether in-flight requests from other tenants are dropped, whether this is a one-shot or repeatable denial-of-service) was not inspected here and needs an owner observation on a staging deployment.

**local plan:** Already done, safely, at 50-4,000 entries with 240-character names: measured PROPFIND response size and process RSS for one vs. 50 repeated <D:displayname/> properties (agents/v9-propfind/artifacts/v1.ts, output agents/v9-propfind/artifacts/v1.out). The per-item byte cost and the ~21.7x amplification ratio were stable across that whole range, supporting linear (not superlinear) growth. No further local run should go materially beyond this range or attempt to approach davMaxItems - that would cross from a bounded local check into a stress test of the shared sandbox.

**deployment plan:** On a staging copy with the production mem_limit and the real launcher/supervisor wired up, give a test non-admin user write/upload permission and roughly 50,000-99,999 zero-byte, long-named files in one folder, then send one PROPFIND with 50 repeated properties and observe: peak RSS of the server process, whether it is OOM-killed, how long the service is unavailable to other users while the supervisor restarts it, and whether the same 50k-99,999 files could realistically be created by that account under normal upload throughput and any operational file-count policy.

