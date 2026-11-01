-- name: RecordHourlyUsage :exec
INSERT INTO usage_hourly(tenant_id,hour,user_id,requests,input_tokens,output_tokens,input_reported,output_reported,key_id)
VALUES((SELECT tenant_id FROM account_groups WHERE id=sqlc.arg(group_id)),sqlc.arg(hour),sqlc.arg(user_id),sqlc.arg(requests),sqlc.arg(input_tokens),sqlc.arg(output_tokens),sqlc.arg(input_reported),sqlc.arg(output_reported),sqlc.arg(key_id))
ON CONFLICT(tenant_id,hour,user_id,key_id) DO UPDATE SET
requests=usage_hourly.requests+excluded.requests,
input_tokens=usage_hourly.input_tokens+excluded.input_tokens,
output_tokens=usage_hourly.output_tokens+excluded.output_tokens,
input_reported=usage_hourly.input_reported+excluded.input_reported,
output_reported=usage_hourly.output_reported+excluded.output_reported;

-- name: GetHourlyCoverage :one
SELECT value FROM settings WHERE key='usage.hourly.started_at';

-- name: PruneHourlyUsage :execrows
DELETE FROM usage_hourly WHERE rowid IN (SELECT old.rowid FROM usage_hourly old WHERE old.hour<sqlc.arg(before_hour) LIMIT 500);

-- Allow UTC edge dates and offset changes in a 90-local-calendar-day report.
-- name: ListHourlyActivity :many
SELECT h.hour,
CAST(SUM(h.requests) AS INTEGER) AS requests,
CAST(SUM(h.input_tokens) AS INTEGER) AS input_tokens,
CAST(SUM(h.output_tokens) AS INTEGER) AS output_tokens,
CAST(SUM(h.input_reported) AS INTEGER) AS input_reported,
CAST(SUM(h.output_reported) AS INTEGER) AS output_reported
FROM usage_hourly h
WHERE h.tenant_id=sqlc.arg(tenant_id) AND h.hour>=sqlc.arg(from_hour) AND h.hour<sqlc.arg(to_hour) AND (h.user_id=sqlc.arg(user_id) OR sqlc.arg(user_id)=0) AND (h.key_id=sqlc.arg(key_id) OR sqlc.arg(key_id)=0)
GROUP BY h.hour ORDER BY h.hour LIMIT 2208;
