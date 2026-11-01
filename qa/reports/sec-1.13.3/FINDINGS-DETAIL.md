# Findings detail (medium and above) — run 3

## WebDAV PROPPATCH echoes a request-chosen namespace once per property: a 39 KB request yields a 33.6 MB answer (up to about 70 MB at the 64 KB cap) with no output bound

Fingerprint `webdav:proppatch-namespace-echo-response-amplification`, severity medium.

### Trace

1. entrypoint `src/index.ts:243` (onRequest): /dav requests are answered before the /api hooks, with no body-size hook other than webdav's own, so they go straight to handleDav(). Confirmed: line 243 reads `if (isDavPath(...)) return handleDav(...)` before refuseBigBody and before CSRF/session checks.
2. propagation `src/webdav.ts:128` (authenticate): Basic auth with an app password; Ctx carries `scope`. Confirmed at lines 126-157; scope read/readwrite gating is at line 196 (readwrite keeps write) and line 889 (ALLOW_ALL vs ALLOW_READ). PROPPATCH requires write via allow(s,'write') at line 847, so a readwrite app password suffices. No per-user request or concurrency limit is visible anywhere in this file.
3. propagation `src/webdav.ts:850` (proppatchMethod): readXml() accepts a body up to 64 KiB (XML_MAX_BYTES, src/webdav-xml.ts:9), up to 2000 elements (MAX_ELEMENTS, webdav-xml.ts:11) and depth 24 (MAX_DEPTH, webdav-xml.ts:10). A long xmlns:q value declared once on d:prop is inherited by every child node's `ns` field per the parser's scope-copy semantics (also exercised by the companion PROPFIND scope-cost check).
4. propagation `src/webdav.ts:856` (proppatchMethod): Loops over every child of d:prop (`for (const prop of child(op,'prop')?.children ?? [])`). safeName(prop.name) passes for short plain names (regex allows up to 101 chars), so each child reaches the tag builder; this check does nothing to prop.ns.
5. propagation `src/webdav.ts:858` (proppatchMethod): The tag is built with escAttr(prop.ns), writing the full long namespace per child. A non-DAV, non-Win32 child goes to refused.push(tag) at line 869 (confirmed exact line: `else refused.push(tag)`).
6. sink `src/webdav.ts:874` (proppatchMethod): group() joins all the tags (line 872-873) and the function returns xmlResponse(207, ...) which concatenates XML_HEAD + the body (line 118) into a 207 Response. There is no byte budget anywhere in this function, unlike propfind()'s PROPFIND_MAX_BYTES check at line 420.

### Evidence

- `src/webdav.ts:327` PROPFIND got the namespace cap (PROPFIND_MAX_NS=256) after run 2, enforced at line 368. proppatchMethod has no equivalent anywhere in its body (lines 845-877).
- `src/webdav.ts:858` escAttr(prop.ns) is written once per property, confirmed verbatim: `xmlns:X="${escAttr(prop.ns)}"`.
- `src/webdav-xml.ts:9` XML_MAX_BYTES is 64 KiB (confirmed `export const XML_MAX_BYTES = 64 * 1024`) and MAX_ELEMENTS is 2000 (confirmed `const MAX_ELEMENTS = 2000`, line 11). Those are the only bounds on the request; safeName (line 131) and escAttr (line 126) confirmed to only bound/escape the element name, never the namespace length.
- `agents/h3-dav/artifacts/c1.out:1` Hunter's local run (read-only, inspected as-is, not re-executed by me): PROPPATCH ns=28000 chars x 1200 props, request 38987 B -> 207 with 33,626,717 chars in 191 ms (ratio about 863x). Smaller points in the same file: ns=1000/props=200 -> 204,517 chars (ratio 73x); ns=4000/props=400 -> 1,608,917 chars (ratio 212x); ns=16000/props=800 -> 12,817,717 chars (ratio 553x). The monotonic, linear-in-(ns_len*props) growth across these four independently-reported points is internally consistent with the claimed mechanism and needs no further execution to corroborate.

### Reproduction

Principal: A normal low-privilege user who made a readwrite app password in their own account.

- Payload: `PROPPATCH /dav/home/<existing file> with Authorization: Basic <user:fc-secret> and body <D:propertyupdate xmlns:D="DAV:"><D:set><D:prop xmlns:q="u:AAAA...(28000 A)"><q:p0/><q:p1/>...<q:p1199/></D:prop></D:set></D:propertyupdate>`
1. The hunter's scripts/qa/sandbox.sh run with agents/h3-dav/artifacts/c1.ts created a dummy admin and a dummy user, made an app password and a file, and called app.handle in-process, sending PROPPATCH requests with growing namespace length and property count up to a single 39 KB request (no concurrency or stress).

Observed: From the hunter's artifact (verified by source review, not re-executed by me): Status 207, response length 33,626,717 chars from a 38,987 B request, in 191 ms. Output grows linearly with ns length times prop count across four independently reported points. A request at the 64 KiB cap would give about 70 MB by the same linear relationship. Reported process rss was 354 MB after the full run (includes the companion PROPFIND scope-cost check in the same process).

Invariant: A PROPPATCH answer should stay in proportion to the request, or be refused: cap the namespace length (PROPFIND_MAX_NS, 256, as PROPFIND does at lines 367-368), cap the number of properties, and enforce an output byte budget (PROPFIND_MAX_BYTES-style, with a 507 response) before or while building the answer.

Conditions: Any account with WebDAV enabled and an app password of scope readwrite (PROPPATCH needs write, confirmed via allow(s,'write') at webdav.ts:847). Any existing file or folder in a space the user can write, such as their own home. WebDAV is on, which is the default (policy.webdav() gate at handleDav entry). Concurrency, memory limits and any reverse-proxy rate limiting depend on the deployment. The Docker memory limit was not examined by me or by the hunter.

### Remediation

Apply the PROPFIND limits to PROPPATCH: refuse any prop namespace longer than PROPFIND_MAX_NS, limit the number of props (for example PROPFIND_MAX_PROPS), and add a running byte budget that returns 507 or 400 before building a large answer. Better, for non-DAV namespaces declare each distinct namespace once in the multistatus root and refer to it by prefix instead of repeating it. Add a regression test with one long namespace and 1000 children expecting a 400 or a bounded answer.

Regression case: the request above answers 400 (too many properties or namespace too long) instead of a multi-megabyte multistatus.

