-- name: RecordMinuteStatistics :exec
INSERT INTO usage_minutes(minute,user_id,group_id,provider,model,requests,completed,incomplete,errors,canceled,rejected,duration_ms,input_tokens,output_tokens,cached_tokens,input_reported,output_reported,cached_reported,key_id,tenant_id)
VALUES(sqlc.arg(minute),sqlc.arg(user_id),sqlc.arg(group_id),sqlc.arg(provider),sqlc.arg(model),sqlc.arg(requests),sqlc.arg(completed),sqlc.arg(incomplete),sqlc.arg(errors),sqlc.arg(canceled),sqlc.arg(rejected),sqlc.arg(duration_ms),sqlc.arg(input_tokens),sqlc.arg(output_tokens),sqlc.arg(cached_tokens),sqlc.arg(input_reported),sqlc.arg(output_reported),sqlc.arg(cached_reported),sqlc.arg(key_id),(SELECT tenant_id FROM account_groups WHERE id=sqlc.arg(group_id)))
ON CONFLICT(tenant_id,minute,user_id,group_id,provider,model,key_id) DO UPDATE SET
requests=usage_minutes.requests+excluded.requests,
completed=usage_minutes.completed+excluded.completed,
incomplete=usage_minutes.incomplete+excluded.incomplete,
errors=usage_minutes.errors+excluded.errors,
canceled=usage_minutes.canceled+excluded.canceled,
rejected=usage_minutes.rejected+excluded.rejected,
duration_ms=usage_minutes.duration_ms+excluded.duration_ms,
input_tokens=usage_minutes.input_tokens+excluded.input_tokens,
output_tokens=usage_minutes.output_tokens+excluded.output_tokens,
cached_tokens=usage_minutes.cached_tokens+excluded.cached_tokens,
input_reported=usage_minutes.input_reported+excluded.input_reported,
output_reported=usage_minutes.output_reported+excluded.output_reported,
cached_reported=usage_minutes.cached_reported+excluded.cached_reported;

-- name: GetMinuteCoverage :one
SELECT value FROM settings WHERE key='usage.minutes.started_at';

-- name: PruneMinuteStatistics :execrows
DELETE FROM usage_minutes WHERE rowid IN (SELECT old.rowid FROM usage_minutes old WHERE old.minute<sqlc.arg(before_minute) LIMIT 500);

-- name: GetMinuteStatisticsTotals :one
SELECT CAST(COALESCE(SUM(s.requests),0) AS INTEGER) AS requests,
CAST(COALESCE(SUM(s.completed),0) AS INTEGER) AS completed,
CAST(COALESCE(SUM(s.incomplete),0) AS INTEGER) AS incomplete,
CAST(COALESCE(SUM(s.errors),0) AS INTEGER) AS errors,
CAST(COALESCE(SUM(s.canceled),0) AS INTEGER) AS canceled,
CAST(COALESCE(SUM(s.rejected),0) AS INTEGER) AS rejected,
CAST(COALESCE(SUM(s.duration_ms),0) AS INTEGER) AS duration_ms,
CAST(COALESCE(SUM(s.input_tokens),0) AS INTEGER) AS input_tokens,
CAST(COALESCE(SUM(s.output_tokens),0) AS INTEGER) AS output_tokens,
CAST(COALESCE(SUM(s.cached_tokens),0) AS INTEGER) AS cached_tokens,
CAST(COALESCE(SUM(s.input_reported),0) AS INTEGER) AS input_reported,
CAST(COALESCE(SUM(s.output_reported),0) AS INTEGER) AS output_reported,
CAST(COALESCE(SUM(s.cached_reported),0) AS INTEGER) AS cached_reported
FROM usage_minutes s JOIN account_groups g ON g.id=s.group_id
WHERE s.tenant_id=sqlc.arg(tenant_id) AND g.tenant_id=s.tenant_id AND s.minute>=sqlc.arg(from_day) AND s.minute<sqlc.arg(to_day);

-- Keep windows outermost so each day performs a bounded index range scan.
-- name: ListMinuteStatistics :many
SELECT CAST(CASE sqlc.arg(dimension) WHEN 'day' THEN json_extract(w.value,'$[0]') WHEN 'member' THEN s.user_id WHEN 'group' THEN s.group_id ELSE s.model END AS TEXT) AS bucket,
CAST(COALESCE(CASE sqlc.arg(dimension) WHEN 'day' THEN '' WHEN 'member' THEN u.username WHEN 'group' THEN g.name ELSE s.model END,'') AS TEXT) AS name,
CAST(COALESCE(SUM(s.requests),0) AS INTEGER) AS requests,
CAST(COALESCE(SUM(s.completed),0) AS INTEGER) AS completed,
CAST(COALESCE(SUM(s.incomplete),0) AS INTEGER) AS incomplete,
CAST(COALESCE(SUM(s.errors),0) AS INTEGER) AS errors,
CAST(COALESCE(SUM(s.canceled),0) AS INTEGER) AS canceled,
CAST(COALESCE(SUM(s.rejected),0) AS INTEGER) AS rejected,
CAST(COALESCE(SUM(s.duration_ms),0) AS INTEGER) AS duration_ms,
CAST(COALESCE(SUM(s.input_tokens),0) AS INTEGER) AS input_tokens,
CAST(COALESCE(SUM(s.output_tokens),0) AS INTEGER) AS output_tokens,
CAST(COALESCE(SUM(s.cached_tokens),0) AS INTEGER) AS cached_tokens,
CAST(COALESCE(SUM(s.input_reported),0) AS INTEGER) AS input_reported,
CAST(COALESCE(SUM(s.output_reported),0) AS INTEGER) AS output_reported,
CAST(COALESCE(SUM(s.cached_reported),0) AS INTEGER) AS cached_reported
FROM json_each(CAST(sqlc.arg(windows) AS TEXT)) w CROSS JOIN usage_minutes s LEFT JOIN users u ON u.id=s.user_id JOIN account_groups g ON g.id=s.group_id
WHERE s.tenant_id=sqlc.arg(tenant_id) AND g.tenant_id=s.tenant_id AND s.minute>=MAX(CAST(json_extract(w.value,'$[0]') AS INTEGER),CAST(sqlc.arg(from_day) AS INTEGER)) AND s.minute<MIN(CAST(json_extract(w.value,'$[1]') AS INTEGER),CAST(sqlc.arg(to_day) AS INTEGER))
GROUP BY 1,2 ORDER BY requests DESC,bucket ASC LIMIT sqlc.arg(max_rows);

-- name: GetUserMinuteStatisticsTotals :one
SELECT CAST(COALESCE(SUM(s.requests),0) AS INTEGER) AS requests,
CAST(COALESCE(SUM(s.completed),0) AS INTEGER) AS completed,
CAST(COALESCE(SUM(s.incomplete),0) AS INTEGER) AS incomplete,
CAST(COALESCE(SUM(s.errors),0) AS INTEGER) AS errors,
CAST(COALESCE(SUM(s.canceled),0) AS INTEGER) AS canceled,
CAST(COALESCE(SUM(s.rejected),0) AS INTEGER) AS rejected,
CAST(COALESCE(SUM(s.duration_ms),0) AS INTEGER) AS duration_ms,
CAST(COALESCE(SUM(s.input_tokens),0) AS INTEGER) AS input_tokens,
CAST(COALESCE(SUM(s.output_tokens),0) AS INTEGER) AS output_tokens,
CAST(COALESCE(SUM(s.cached_tokens),0) AS INTEGER) AS cached_tokens,
CAST(COALESCE(SUM(s.input_reported),0) AS INTEGER) AS input_reported,
CAST(COALESCE(SUM(s.output_reported),0) AS INTEGER) AS output_reported,
CAST(COALESCE(SUM(s.cached_reported),0) AS INTEGER) AS cached_reported
FROM usage_minutes s JOIN account_groups g ON g.id=s.group_id
WHERE s.tenant_id=sqlc.arg(tenant_id) AND g.tenant_id=s.tenant_id AND s.minute>=sqlc.arg(from_day) AND s.minute<sqlc.arg(to_day) AND s.user_id=sqlc.arg(user_id) AND (s.key_id=sqlc.arg(key_id) OR sqlc.arg(key_id)=0);

-- Keep windows outermost so each day performs a bounded index range scan.
-- name: ListUserMinuteStatistics :many
SELECT CAST(CASE sqlc.arg(dimension) WHEN 'day' THEN json_extract(w.value,'$[0]') WHEN 'member' THEN s.user_id WHEN 'group' THEN s.group_id ELSE s.model END AS TEXT) AS bucket,
CAST(COALESCE(CASE sqlc.arg(dimension) WHEN 'day' THEN '' WHEN 'member' THEN u.username WHEN 'group' THEN g.name ELSE s.model END,'') AS TEXT) AS name,
CAST(COALESCE(SUM(s.requests),0) AS INTEGER) AS requests,
CAST(COALESCE(SUM(s.completed),0) AS INTEGER) AS completed,
CAST(COALESCE(SUM(s.incomplete),0) AS INTEGER) AS incomplete,
CAST(COALESCE(SUM(s.errors),0) AS INTEGER) AS errors,
CAST(COALESCE(SUM(s.canceled),0) AS INTEGER) AS canceled,
CAST(COALESCE(SUM(s.rejected),0) AS INTEGER) AS rejected,
CAST(COALESCE(SUM(s.duration_ms),0) AS INTEGER) AS duration_ms,
CAST(COALESCE(SUM(s.input_tokens),0) AS INTEGER) AS input_tokens,
CAST(COALESCE(SUM(s.output_tokens),0) AS INTEGER) AS output_tokens,
CAST(COALESCE(SUM(s.cached_tokens),0) AS INTEGER) AS cached_tokens,
CAST(COALESCE(SUM(s.input_reported),0) AS INTEGER) AS input_reported,
CAST(COALESCE(SUM(s.output_reported),0) AS INTEGER) AS output_reported,
CAST(COALESCE(SUM(s.cached_reported),0) AS INTEGER) AS cached_reported
FROM json_each(CAST(sqlc.arg(windows) AS TEXT)) w CROSS JOIN usage_minutes s LEFT JOIN users u ON u.id=s.user_id JOIN account_groups g ON g.id=s.group_id
WHERE s.tenant_id=sqlc.arg(tenant_id) AND g.tenant_id=s.tenant_id AND s.minute>=MAX(CAST(json_extract(w.value,'$[0]') AS INTEGER),CAST(sqlc.arg(from_day) AS INTEGER)) AND s.minute<MIN(CAST(json_extract(w.value,'$[1]') AS INTEGER),CAST(sqlc.arg(to_day) AS INTEGER)) AND s.user_id=sqlc.arg(user_id) AND (s.key_id=sqlc.arg(key_id) OR sqlc.arg(key_id)=0)
GROUP BY 1,2 ORDER BY requests DESC,bucket ASC LIMIT sqlc.arg(max_rows);


-- name: ListMinuteActivity :many
SELECT h.minute,
CAST(SUM(h.requests) AS INTEGER) AS requests,
CAST(SUM(h.input_tokens) AS INTEGER) AS input_tokens,
CAST(SUM(h.output_tokens) AS INTEGER) AS output_tokens,
CAST(SUM(h.input_reported) AS INTEGER) AS input_reported,
CAST(SUM(h.output_reported) AS INTEGER) AS output_reported
FROM usage_minutes h
WHERE h.tenant_id=sqlc.arg(tenant_id) AND h.minute>=sqlc.arg(from_minute) AND h.minute<sqlc.arg(to_minute) AND (h.user_id=sqlc.arg(user_id) OR sqlc.arg(user_id)=0) AND (h.key_id=sqlc.arg(key_id) OR sqlc.arg(key_id)=0)
GROUP BY h.minute ORDER BY h.minute LIMIT 132480;
