# Needs validation — run 6 (scoped, critic gaps)

No record ended as `needs_validation`, and the one candidate has an independent final disposition. The open items below are coverage gaps, not findings.

## Coverage gaps named by the critic (outside this run's scope)

- `src/routes/files.ts#POST /api/zip` → `src/quota.ts#holdNow`: critic c31: need(zip,write) and quotaUserOf are fixed at src/routes/files.ts:337-338; after the long await Bun.write(target, zipStream(...)) (354) hold.commit uses the stale owner and the archive stays in the home (360) with no re-check of rights or account instance. G2 covered cost and quota totals only.
- `src/routes/shares.ts#POST /api/s/:token/upload/:id/complete` → `src/antivirus.ts#gate`: critic c31: visitorUpload is checked once (src/routes/shares.ts:438) before completeUpload (439); stillAllowed returns early without meta.space (src/uploads.ts:61); after await gate() (429) nothing re-checks that the share is still live and allows uploads, or that the share owner (quota owner) is the same account, before putInPlace (441) and commit (455).
- `src/routes/upload.ts#POST /api/upload/:id/complete` → `src/antivirus.ts#gate`: critic c31: finishUpload (src/uploads.ts:413) runs stillAllowed/stillThere (418-419) and then awaits gate() (429); putInPlace (441-449) and commitBytes(meta.quotaUser) (455) follow with no re-check of rights, account instance or quota owner, and dropUploadsOf skips uploads in `finishing` (500). Overlaps the run-4 finding uploads/inflight-complete-survives-account-drop (account drop during completion); the rights-downgrade-during-scan variant is not covered by it.
