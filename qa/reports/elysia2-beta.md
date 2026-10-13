# Beta: Elysia 2.0.0-beta.30

Branch `beta/elysia2`, from main 1.7.2. Not merged and not released: no server receives it.

## Moving the code
Every test passes: qa reports 487/488 (1 skipped, the same as on main) and qa:seed catches 54/54 planted bugs. No existing test was changed. `tests/http-edges.test.ts` is new and holds the old behaviours in place.

Breaking changes met:
- **Route arguments:** `(path, hook, handler)` replaces `(path, handler, hook)`. 54 routes were changed.
- **Hook scope:** `{ as: 'global' }` becomes `'global'`.
- **Errors:** `.error()` and error code strings are gone. `onError` now checks the class with `instanceof ValidationError / NotFound / ParseError`.
- **maxItems:** the limit is read from `error.errors[].params.limit` instead of the schema.
- **HEAD requests:** these no longer get the GET answer (404 instead). A catch-all `.head('/*')` sends them to the GET route, and `socketIpOverride` carries the client address for that second request.
- **Body type:** a body whose type does not match the schema gets 415, and an empty JSON body is a ParseError. Both are mapped back to 422 `request.invalid`.

Still different from main: a body sent as `+json` (for example `application/vnd.api+json`) is accepted as JSON, where main answered 422.

Size: the server bundle grows from 1,377,735 to 1,677,512 bytes (+21.8%).

## Speed (`bun run bench`, full, 2 runs each, alternated, average)
| test | 1.4.30 rps | 2.0 beta rps | difference |
|---|---|---|---|
| session | 7278 | 7476 | +2.7% |
| list 2,000 files | 51.9 | 50.9 | −2.0% |
| search | 52.8 | 49.2 | −6.6% |
| download 1 MB | 907 | 856 | −5.7% |
| download 100 MB (MB/s) | 785 | 758 | −3.4% |
| static page | 5534 | 5263 | −4.9% |
| static asset | 2109 | 1965 | −6.8% |
| zip 200 files | 8.6 | 8.8 | +2.3% |
| upload 100 MB (MB/s) | 117 | 113 | −3.4% |
| login (argon2) | 9.7 | 9.5 | −2.1% |
| cold start (ms) | 806 / 826 | 1027 / 869 | slower |
| RSS (MB) | 167 / 233 | 178 / 197 | similar |

Runs of the same version differ by up to about ±8% on this machine (for example, static page on main: 5911 and 5157). Every difference above is within that spread, apart from a slower cold start.

## Recommendation
**Not worth moving now.**
- Elysia's speed gain is in routing and validation. File Center's time goes to disk, compression, argon2 and the file system, so Elysia 2 does not make it faster.
- The beta adds a larger bundle and a slower cold start.
- It needs a workaround for HEAD requests, and its documentation and migration guide are not out yet.

Keep the branch and look again when 2.0 is stable. Move only if the HEAD behaviour is fixed upstream and the benchmark shows a clear gain.
