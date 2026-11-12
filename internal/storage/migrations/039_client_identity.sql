-- Identity hardening per account, following sub2api. fingerprint_mode converges Codex device and
-- session identifiers (off, device, session, full) and defaults to session, sub2api's recommended
-- non-off mode; fingerprint_seed is the system-managed random seed converged identifiers derive from;
-- tls_fingerprint makes Claude connections present Claude Code's TLS handshake (opt-in).
ALTER TABLE accounts ADD COLUMN fingerprint_mode TEXT NOT NULL DEFAULT 'session' CHECK(fingerprint_mode IN ('off','device','session','full'));
ALTER TABLE accounts ADD COLUMN fingerprint_seed TEXT CHECK(fingerprint_seed IS NULL OR length(fingerprint_seed) = 36);
ALTER TABLE accounts ADD COLUMN tls_fingerprint INTEGER NOT NULL DEFAULT 0 CHECK(tls_fingerprint IN (0,1));
-- Existing Codex accounts get their own seed now; newer accounts are seeded on first use.
UPDATE accounts SET fingerprint_seed = lower(hex(randomblob(18))) WHERE provider = 'codex';
