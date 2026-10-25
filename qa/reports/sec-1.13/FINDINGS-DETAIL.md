# Findings detail (medium and above)

## Unzip of a small zip blocks the single server thread for seconds to minutes

`unzip-event-loop-blocking`

**Trace**

- entrypoint: `src/routes/files.ts:326` (POST /api/unzip): A user with zip and write permission names a .zip file in their own space.
- propagation: `src/routes/files.ts:337` (POST /api/unzip): maxBytes = min(UNZIP_MAX_BYTES (20 GiB), free space minus reserve, quota room). There is no ratio or time limit.
- propagation: `src/routes/files.ts:342` (POST /api/unzip): takeUnzipSlot allows 2 concurrent extractions. This limits how many run at once, not how long each holds the loop.
- sink: `src/zip.ts:210` (unzipTo): writeSync is called per inflated chunk inside entry.getData's WritableStream on the main thread, so the loop is held for the whole extraction.

**Evidence**

- `src/zip.ts:210`: Synchronous writeSync loop for every chunk; zip.js runs with useWebWorkers:false (src/zip.ts line 7), so inflate is on the main thread too.
- `src/config.ts:79`: UNZIP_MAX_BYTES defaults to 20 GiB.
- `agents/h4-resource/artifacts/c3.out:7`: Hunter run through app.handle: a 131096-byte zip expanded to 128 MiB, the call returned in 1.58 s, the 10 ms timer ticked 2 times (about 158 expected), largest gap 1571 ms. Line 8 shows a third concurrent extraction got 503 archive.busy.
- `agents/v2-unzip/artifacts/v1.out:1`: Verifier run of zip.js alone on the same kind of 128 MiB bomb: writeSync sink took 1635 ms with 0 timer ticks (line 1); no-op sink took 178 ms with 0 ticks (line 2); async-write sink had 67 ticks and a 43 ms largest gap (line 3). This shows the sync write is the main cause and inflate is a smaller residual cost.

**Principal:** An authenticated ordinary user with zip and write permission.

**Input:** zip containing one entry of N MiB of zeros, deflate level 1, ratio about 1000:1

**Steps**

1. Upload the zip to the user's home space.
1. POST /api/unzip {space:'home',path:'/bomb.zip'} while a second client polls GET /api/session or a timer tick is observed.
1. Repeat for a larger N within the sandbox limits.

**Observed:** A 131096-byte zip expanding to 128 MiB: /api/unzip returned 200 after about 1.58 s, and the loop ticked only twice. A third concurrent extraction got 503 archive.busy. In the verifier's isolated zip.js run, writeSync took 1635 ms with 0 ticks, a no-op sink took 178 ms with 0 ticks, and an async-write sink let the timer run. Only 128 MiB was tried. The multi-minute stall at 20 GiB is an extrapolation.

**Invariant:** Extraction should not starve other users: use asynchronous writes or a worker/child process for the inflate, a much smaller per-request byte budget or a compression-ratio cap, and a deadline.

**Conditions:** A signed-in user (or guest, if guestPermissions allow it) with zip and write permission in a space.; The attacker uploads a highly compressible .zip of a few KB to MB, within the upload limit.; A small per-user quota or low free disk space, if set, bounds the output and so the stall.

**Fix:** Move extraction off the request thread (child process or worker), or at least use async FileHandle writes so the loop can interleave. Add a compression-ratio cap, a much lower default per-request byte budget than 20 GiB, and a deadline. Make unzip slots per user.

**Regression:** `tests/security-1131.test.ts`. The case fails on 0987b1e and passes on 1.13.1.

