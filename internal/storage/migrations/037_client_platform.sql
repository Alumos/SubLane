-- The client platform an account presents upstream, learned once from a native client and then reused
-- for every request on that account, so one upstream account keeps one client fingerprint.
ALTER TABLE accounts ADD COLUMN client_platform TEXT CHECK(client_platform IS NULL OR length(client_platform) BETWEEN 1 AND 160);
