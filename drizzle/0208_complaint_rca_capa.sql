-- Step 10a: Complaint RCA/CAPA capture. Complaint samples and per-test
-- retest flags already exist from an earlier step; only the root-cause and
-- corrective-action fields investigators fill in afterward were missing.
-- Plain nullable text, same shape as the existing amendment_remarks/
-- complaint_remarks columns — no type-matching CHECK constraint either,
-- consistent with those siblings (enforced at the application layer only,
-- via sampleEditableHeaderFields).
ALTER TABLE samples ADD COLUMN complaint_rca text;
ALTER TABLE samples ADD COLUMN complaint_capa text;
