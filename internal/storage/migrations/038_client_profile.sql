-- One client fingerprint per account for every provider that has one (Codex platform, Claude
-- device platform and runtime). Replaces the Codex-only client_platform column from 037.
ALTER TABLE accounts ADD COLUMN client_profile TEXT CHECK(client_profile IS NULL OR (length(client_profile) <= 1024 AND json_valid(client_profile)));
UPDATE accounts SET client_profile = json_object('source', 'learned', 'platform', client_platform) WHERE client_platform IS NOT NULL;
ALTER TABLE accounts DROP COLUMN client_platform;
