Measure, then make the app faster where the numbers say — never by weakening a security check (password hashing stays at its full cost, every permission check stays).

1. Benchmark (`scripts/bench.ts`, `bun run bench [--json out.json] [--quick]`): starts the app in-process or as a child on a temp STORAGE_DIR/DATA_DIR with a generated tree (default 20,000 files in nested folders, a few large files), then measures with a small built-in load generator (concurrency N, duration D; no new dependencies): requests/s, p50/p95/p99 latency and errors for: GET /api/session, GET /api/list (a folder of 2,000 entries), GET /api/search (indexed), GET /api/download (1 MB and 100 MB, throughput MB/s), chunked upload of 100 MB, POST /api/zip of a 200-file folder, the static page (/ and a hashed asset), login (expected slow: argon2 — measure, do not change); plus cold start time to /api/health and RSS after warm-up. Prints a table and writes JSON. Commit a baseline result for this machine in `qa/bench/baseline.json` with the machine noted.
2. Find and fix the slowest points the numbers show. Likely candidates to check (only change what the measurement proves worth it, and show before/after):
   - static files: precompressed gzip/brotli for web/dist assets (served with `Content-Encoding` and `Vary: Accept-Encoding`), long `Cache-Control: immutable` for hashed assets, short for index.html; ETag/If-None-Match → 304.
   - downloads: streaming with Bun.file (zero copy), Range requests (206) if missing.
   - list/search: avoid per-entry sync stat in hot paths, batch, cache what is safe.
   - JSON stores written on every request (sessions `seen`, recent/favorites): debounce writes.
   - anything else the profile shows (use `bun --cpu-prof` or timing logs).
   Keep behaviour identical: every existing test passes; new tests for each change (e.g. compressed asset served with the right headers and identical bytes after decoding, 304 on matching ETag, Range 206 with correct bytes and 416 on bad ranges, debounced store still on disk after shutdown).
3. CI: a `bench` job running `bun run bench --quick --json bench.json` and uploading it as an artifact (not failing on numbers — runners vary), plus a local guard `bun run bench --compare qa/bench/baseline.json` that prints the difference.
4. README: how to run the benchmark and read it; the results before/after on this machine.
