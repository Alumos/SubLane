-- Legacy UTC daily totals cannot be split into local calendar dates. Preserve them unchanged.
CREATE TABLE usage_minutes (
 tenant_id INTEGER NOT NULL REFERENCES tenants(id),
 minute INTEGER NOT NULL CHECK(minute%60=0),
 user_id INTEGER NOT NULL,
 group_id INTEGER NOT NULL,
 provider TEXT NOT NULL,
 model TEXT NOT NULL CHECK(length(model)<=180),
 requests INTEGER NOT NULL DEFAULT 0 CHECK(requests>=0),
 completed INTEGER NOT NULL DEFAULT 0 CHECK(completed>=0),
 incomplete INTEGER NOT NULL DEFAULT 0 CHECK(incomplete>=0),
 errors INTEGER NOT NULL DEFAULT 0 CHECK(errors>=0),
 canceled INTEGER NOT NULL DEFAULT 0 CHECK(canceled>=0),
 rejected INTEGER NOT NULL DEFAULT 0 CHECK(rejected>=0),
 duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms>=0),
 input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
 output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 cached_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cached_tokens>=0),
 input_reported INTEGER NOT NULL DEFAULT 0 CHECK(input_reported>=0),
 output_reported INTEGER NOT NULL DEFAULT 0 CHECK(output_reported>=0),
 cached_reported INTEGER NOT NULL DEFAULT 0 CHECK(cached_reported>=0),
 key_id INTEGER NOT NULL DEFAULT 0 CHECK(key_id>=0),
 PRIMARY KEY(tenant_id,minute,user_id,group_id,provider,model,key_id),
 CHECK(input_reported<=requests AND output_reported<=requests AND cached_reported<=requests)
);

CREATE INDEX usage_minutes_user ON usage_minutes(tenant_id,user_id,minute);
CREATE INDEX usage_minutes_retention ON usage_minutes(minute);

INSERT INTO settings(key,value) VALUES('usage.minutes.started_at',CAST(unixepoch() AS TEXT));
