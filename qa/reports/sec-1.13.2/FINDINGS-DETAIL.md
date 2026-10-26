# Findings detail (medium and above) — run 2

## WebDAV PROPFIND answer size is not bounded by request size: 50 distinct long-namespace properties multiply every Depth:1 item by about 51 KB

Fingerprint `webdav:propfind-duplicate-property-response-amplification`, severity medium.

### Trace

1. entrypoint `src/webdav.ts:355` (propfind()): The PROPFIND body (up to 64 KB) is read and parsed. It may name up to 50 properties, each with its own xmlns attribute (cap check at line 362).
2. propagation `src/webdav.ts:365` (propfind()): The de-dup key is `${ns} ${name}`, so 50 properties with distinct 1 KB namespaces stay as 50 wanted properties.
3. propagation `src/webdav.ts:397` (propfind()): Depth 1 lists every entry of the folder. The only bound is config.davMaxItems (default 100000), which caps item count, not bytes.
4. propagation `src/webdav.ts:340` (propstat()): Each unknown property is written back as `<X:name xmlns:X="{ns}"/>` for every item, so the request-controlled namespace is repeated per item.
5. sink `src/webdav.ts:409` (propfind()): One string per item is built into an array (line 409), then joined into a single in-memory 207 body (line 410) with no total size check.

### Evidence

- `src/webdav.ts:324` PROPFIND_MAX_PROPS = 50 caps only the property count. The comment above it assumes the answer is items x properties of small names.
- `src/webdav-xml.ts:9` The 64 KB body cap allows about 1 KB of namespace text for each of 50 properties.
- `src/config.ts:98` davMaxItems defaults to 100000, the only cardinality bound on a Depth:1 answer.
- `agents/v4-propfind/artifacts/v1.out:1` Independent run in the sandbox with a read-scope app password. A 51,147-byte request gave 1.34 MB at 25 items, 5.20 MB at 100 and 15.48 MB at 300, about 51.4 KB per item and 26x to 303x the request size. The de-duplicated 50x getetag request on the same folders gave 4.5 KB to 52 KB. RSS rose from 93 MB to 155 MB at 300 items.
- `agents/v4-propfind/artifacts/v1.ts:1` The script that produced v1.out. It uses the in-process app, creates a dummy user and a read-scope app password, and measures only up to 300 items.

### Reproduction

Principal: A normal user with a WebDAV app password (read scope is enough) and a folder of many small or empty files in their own home.

- Payload: `PROPFIND /dav/home/<folder>/ with header Depth: 1 and body <propfind xmlns="DAV:"><prop> followed by 50 elements <p xmlns="urn:x:NNN{1000 x 'a'}"/> with NNN = 000 to 049, then </prop></propfind> (51,147 bytes in total)`
1. Create a folder with N empty files in the account's home.
2. Send the PROPFIND with Depth: 1 and the body above, using Basic auth with an app password.
3. Compare the response size against the de-duplicated 50x <getetag/> request on the same folder.

Observed: Verifier run with a read-scope app password: 25, 100 and 300 files gave answers of 1.34 MB, 5.20 MB and 15.48 MB, about 51.4 KB per item. The de-duplicated request gave 4.5 KB to 52 KB. Process RSS rose from 93 MB to 155 MB at 300 items, and the 300-item answer took 47 ms. Nothing larger was run. The behaviour at the 100000-item cap is extrapolated. Per-item strings alone would reach several GB there. The final join may fail earlier on the engine's maximum string length, but the memory for the per-item strings is already allocated by then.

Invariant: A PROPFIND answer should stay within a small multiple of the request size per item, or be refused with 507 once it passes a total byte budget. One app-password client should not be able to make the shared server build a multi-gigabyte set of strings.

Conditions: A WebDAV app password for any account. A read-scope password is enough, since PROPFIND needs only read. WebDAV is enabled and WEBDAV_MAX_ITEMS is at its default (100000) or larger. The attacker's own folder holds many entries. Empty files are enough. Answer size grows linearly with the count, and a folder just under the 100000-entry limit is the worst case.

### Remediation

Bound the answer, not just the request. Track the running byte total while building the multistatus and return the existing 507 number-of-matches-within-limits error once it passes a cap (for example 32 MB). Alternatively reject or truncate namespace URIs longer than about 100 characters before they are echoed back, or stream the response in chunks instead of joining one string.

Regression case: the request above answers 400 (namespace too long) or 507 (answer over the byte cap) instead of a multi-megabyte multistatus.

