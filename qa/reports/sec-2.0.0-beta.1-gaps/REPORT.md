# File Center 2.0.0-beta.1 — security audit, critic gaps (run 6, scoped)

## Fixed after this run

The record below describes source ref `ecefa9b` and is left as found. It was fixed for `2.0.0-beta.2`: after the scan (antivirus on) or after the extraction (antivirus off), `POST /api/unzip` asks again for the account instance (name, `createdAt`), `zip` + `write` at the destination and the quota owner, and refuses with 401/403 with nothing landed. `tests/security-202.test.ts` covers a rights downgrade and an account deletion during the scan (both 200 with files landed before), and the seeded bug `unzip-no-recheck` is caught. The `POST /api/zip` stall noted below is fixed with the zip findings of run 5. The three coverage gaps the critic named were not reviewed by an audit run; they were closed by the same kind of recheck instead (`2.0.0-beta.2`): an upload and an upload-link file ask again after the scan (covered by `tests/security-203.test.ts`, seeded bug `upload-no-recheck-after-scan`), and `POST /api/zip` asks again after the archive is written and deletes it on a mismatch (no timed test: the write is too fast to change the account in between).

## Run

- **Scoped run, not a full audit.** Only the two units the run-5 coverage critic named outside its scope were reviewed (`qa/reports/sec-2.0.0-beta.1-followup/NEEDS-VALIDATION.md`): `POST /api/unzip` against account and rights changes during the antivirus scan, and the cost and quota accounting of server-side zips (`POST /api/zip`, the admin log zip). Every other unit is `out_of_scope` here and keeps its earlier result.
- `run_status: complete` for both units. Cloudflare security-audit skill (pinned c1c8a8c), profile `standard`, source ref `ecefa9b` (clean worktree).
- Budget 9 agent invocations, 7 spent: 2 hunters, 1 coverage critic, 1 Phase 3 candidate verifier, 1 Phase 5 record verifier (plus 2 unused validation slots). Both hunters first returned source-only results and were sent back once for the required sandbox checks; this resumed the same agents.
- Execution: sandboxed source-and-local-only, as in runs 4 and 5 (`scripts/qa/sandbox.sh`, evidence promoted by `scripts/qa/promote.py`); dummy data only, sizes no larger than run 5's.
- Process notes (coordinator actions):
  - critic c31: not clean; 3 missing units outside the 2-unit scope recorded as out_of_scope (upload complete, share upload complete, POST /api/zip stale authorization); no reassign_ids. h31/h32: first results were source-only and were sent back once for the required sandbox checks (same agents, no extra budget).

## Result

One finding is confirmed and passed Phase 5 (low). No code was changed by this run.

- Low: `POST /api/unzip` with the antivirus on places the extracted files after the scan with the rights and account from before it. A user lowered to read-only, deleted, or deleted and re-created under the same name while the scan runs still gets the files written (200), while a new request is refused (403). The hunter's claim that the new account was charged the quota was not reproduced and is not part of the record.
- `POST /api/zip` adds no new finding. It stalls the event loop like `zipstream-no-yield-eventloop-stall-large-tree` (3.4–3.6 s, 0 timer ticks, for 20,000 one-byte files), which is the same root cause through another entry point, so fixing `collectZipItems`/`zipStream` covers it. It consumes its own stream, so it holds no codec slots (4 concurrent server-side zips, a batch zip and a backup all finished in under 0.4 s). The quota holds: a zip larger than the room left is refused with 507, and the committed usage equals the bytes on disk. The admin log zip is admin-only with a fixed file list.

## Confirmed findings

### POST /api/unzip lands extracted files after the antivirus scan without re-checking the account, rights or quota owner

- Fingerprint: `files/unzip-stale-auth-after-scan` — severity **low** (likelihood low, impact low); confidence high
- Source: `src/routes/files.ts:367`, `src/routes/files.ts:408`, `src/routes/files.ts:420`, `src/routes/files.ts:237`, `src/routes/files.ts:415`
- Lower-trust principal: A user whose rights are being removed, or an in-flight request of a deleted account.
- Conditions: antivirus enabled so the staged scan window exists; caller held zip/write when the request started; rights removed or account deleted/replaced during the scan; the change must fall inside the scan of the extracted files
- Reproduction (local, dummy data): scratch/run.ts <downgrade|delete|recreate> boots the app in-process in the sandbox, enables antivirus against a pausing fake clamd, starts the unzip, changes the account once the scan is reached, releases the scan and prints status and tree
- Result: 2 of 2 runs per variant: downgrade, delete and delete+recreate(adoptHome) all returned unzip 200 with p/a.txt and p/b.txt landed; control unzip after downgrade 403; new account usage read 0 (not charged at that read).
- What it is: With the antivirus on, unzip extracts to a staging folder, awaits gate() per file, then creates the destination and moves the tree in. need(zip,write), quotaUserOf and the user come from before the scan and are not re-checked. Reproduced in a sandbox with a pausing fake clamd: (a) permissions lowered to read during the scan: unzip still 200 and p/a.txt, p/b.txt landed, while a new unzip gave 403; (b) account deleted during the scan: 200 and the files landed in the orphaned home; (c) deleted and re-created with adoptHome during the scan: 200 and files landed in the new account's home. Charging of the new account's quota was not observed (usage read 0).
- Priority: likelihood low (needs antivirus on, an admin change inside the scan window); impact low (a revoked or deleted account's in-flight request writes up to the unzip budget into its own former/orphaned home; no other user's data is read or changed).
- Root cause: No findUser/createdAt/need/quotaUserOf recheck between the gate loop and mkdirSync/moveTree/hold.commit in the unzip handler.
- Smallest fix: Run the current() check of PUT /api/content (findUser, createdAt, need(write), quotaUserOf) after the gate loop and before mkdirSync(landed); release the hold and refuse on mismatch; commit against the re-resolved quota owner.

## Coverage

| Unit (surface → boundary) | Status | Result |
|---|---|---|
| `src/routes/files.ts#POST /api/unzip` → `src/antivirus.ts#gate` | candidate | `files/unzip-stale-auth-after-scan` |
| `src/routes/files.ts#POST /api/zip` → `src/zip.ts#zipStream` | covered | no new finding |

The coverage critic was not clean: it named three more gaps of the same kind outside this run's scope, recorded as `out_of_scope` (see NEEDS-VALIDATION.md).

## Hardening notes (not findings)

- POST /api/zip (src/routes/files.ts:348) is another entry to zipstream-no-yield-eventloop-stall-large-tree: any account with zip+write stalls the event loop for the whole request (measured 3.4-3.6 s, 0 timer ticks, for 20,000 one-byte files). Not a new finding. Fixing collectZipItems and the zipStream add loop (async walk, yield, entry cap) fixes every caller.
- The quota hold for POST /api/zip is the sum of file sizes taken at collect time. Files that grow during the write can make the archive slightly larger than the hold. commit() records the real size, so the effect is a small overshoot only.
