# Needs validation — run 5 (scoped follow-up)

No record ended as `needs_validation`, and every candidate has an independent final disposition (the two zip candidates left open by the first write-up were validated afterwards). The open items below are coverage gaps, not findings.

## Coverage gaps named by the critic (outside this run's scope)

- `src/routes/files.ts#POST /api/unzip` → `src/antivirus.ts#gate`: critic c21: parallel gate-then-write path to files/put-content-stale-auth-after-scan. files.ts:352-355 fixes need(zip,write), quotaUserOf and the destination before extraction; files.ts:395-401 awaits gate() per extracted file; files.ts:405-414 moves the tree in and commits the hold with no re-check of the account instance, rights or quota owner. dropUploadsOf cannot see the staged folder.
- `src/routes/files.ts#POST /api/zip` → `src/zip.ts#zipStream`: critic c21: other zipStream callers were not checked as triggers. files.ts:337-343 builds a server-side archive with collectZipItems (no entry cap) for any user with zip+write; logs.ts:90 zips log files; backup.ts:581 was used only as the victim. Needs an account (guest defaults in settings.ts:90 exclude zip).
