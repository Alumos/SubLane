-- Optional per-group quota failover lets a conversation leave a quota-exhausted account.
ALTER TABLE account_groups ADD COLUMN quota_failover INTEGER NOT NULL DEFAULT 0 CHECK(quota_failover IN (0,1));

-- Fingerprints of encrypted provider state written by previous accounts; later turns strip those
-- items because the current account cannot decrypt them. Bounded to 4,096 16-byte digests.
ALTER TABLE account_affinity ADD COLUMN foreign_state BLOB CHECK(foreign_state IS NULL OR length(foreign_state) <= 65536);
