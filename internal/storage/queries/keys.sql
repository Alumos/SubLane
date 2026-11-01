-- name: GetKeyOwnerEnabled :one
SELECT enabled FROM users WHERE id = sqlc.arg(user_id);

-- name: CountActiveKeys :one
SELECT count(*) FROM api_keys k JOIN account_groups g ON g.id=k.group_id
WHERE k.user_id = sqlc.arg(user_id) AND g.tenant_id=sqlc.arg(tenant_id) AND k.revoked_at IS NULL;

-- name: ListKeyReadinessCandidates :many
SELECT DISTINCT k.id,k.group_id FROM api_keys k
JOIN account_groups g ON g.id=k.group_id
JOIN users u ON u.id=k.user_id
JOIN routable_group_resources ga ON ga.group_id=g.id
JOIN accounts a ON a.id=ga.account_id
WHERE k.user_id=sqlc.arg(user_id) AND g.tenant_id=sqlc.arg(tenant_id)
AND k.revoked_at IS NULL AND k.enabled=1 AND (k.expires_at IS NULL OR k.expires_at>sqlc.arg(now))
AND u.enabled=1 AND g.enabled=1 AND a.enabled=1 AND a.provider IN ('codex','claude','antigravity','xai','openai') AND a.status='ready'
AND EXISTS(SELECT 1 FROM effective_group_access access WHERE access.group_id=g.id AND access.user_id=u.id)
ORDER BY k.id DESC LIMIT 20;

-- name: CreateKey :execlastid
INSERT INTO api_keys(user_id,group_id,name,prefix,token_hash,created_at,expires_at)
VALUES(sqlc.arg(user_id),sqlc.arg(group_id),sqlc.arg(name),sqlc.arg(prefix),sqlc.arg(token_hash),sqlc.arg(created_at),sqlc.narg(expires_at));

-- name: ListKeys :many
SELECT k.id,k.group_id,g.name AS group_name,
CASE WHEN g.enabled=1 AND u.enabled=1 AND EXISTS(SELECT 1 FROM effective_group_access access WHERE access.group_id=g.id AND access.user_id=u.id) THEN 'allowed' ELSE 'blocked' END AS group_access,
k.name,k.prefix,k.created_at,k.last_used_at,k.revoked_at,k.enabled,k.expires_at,
CAST(k.encrypted_secret IS NOT NULL AND k.revoked_at IS NULL AS BOOLEAN) AS copyable,
CAST(COALESCE((SELECT scheme_id FROM allocation_keys WHERE key_id=k.id),0) AS INTEGER) AS scheme_id,
CAST(COALESCE((SELECT s.name FROM allocation_keys ak JOIN allocation_schemes s ON s.id=ak.scheme_id WHERE ak.key_id=k.id),'') AS TEXT) AS scheme_name
FROM api_keys k JOIN account_groups g ON g.id=k.group_id JOIN users u ON u.id=k.user_id
WHERE k.user_id=sqlc.arg(user_id) AND g.tenant_id=sqlc.arg(tenant_id)
AND (k.revoked_at IS NULL OR CAST(sqlc.arg(include_revoked) AS BOOLEAN))
AND (k.id<sqlc.arg(before_id) OR sqlc.arg(before_id)=0)
ORDER BY k.id DESC LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountKeys :one
SELECT COUNT(*) FROM api_keys k JOIN account_groups g ON g.id=k.group_id JOIN users u ON u.id=k.user_id
WHERE k.user_id=sqlc.arg(user_id) AND g.tenant_id=sqlc.arg(tenant_id)
AND (k.revoked_at IS NULL OR CAST(sqlc.arg(include_revoked) AS BOOLEAN));

-- name: GetKey :one
SELECT k.id,k.group_id,g.name AS group_name,
CASE WHEN g.enabled=1 AND u.enabled=1 AND EXISTS(SELECT 1 FROM effective_group_access access WHERE access.group_id=g.id AND access.user_id=u.id) THEN 'allowed' ELSE 'blocked' END AS group_access,
k.name,k.prefix,k.created_at,k.last_used_at,k.revoked_at,k.enabled,k.expires_at,
CAST(k.encrypted_secret IS NOT NULL AND k.revoked_at IS NULL AS BOOLEAN) AS copyable,
CAST(COALESCE((SELECT scheme_id FROM allocation_keys WHERE key_id=k.id),0) AS INTEGER) AS scheme_id,
CAST(COALESCE((SELECT s.name FROM allocation_keys ak JOIN allocation_schemes s ON s.id=ak.scheme_id WHERE ak.key_id=k.id),'') AS TEXT) AS scheme_name
FROM api_keys k JOIN account_groups g ON g.id=k.group_id JOIN users u ON u.id=k.user_id
WHERE k.id=sqlc.arg(id) AND k.user_id=sqlc.arg(user_id) AND g.tenant_id=sqlc.arg(tenant_id);

-- name: RevokeKey :execrows
UPDATE api_keys SET revoked_at=COALESCE(revoked_at,sqlc.arg(now)),encrypted_secret=NULL WHERE id=sqlc.arg(id) AND user_id=sqlc.arg(user_id);

-- name: AuthenticateKey :one
SELECT k.id,k.user_id,k.group_id FROM api_keys k JOIN users u ON u.id=k.user_id JOIN account_groups g ON g.id=k.group_id
WHERE k.token_hash=sqlc.arg(token_hash) AND g.tenant_id=sqlc.arg(tenant_id)
AND k.revoked_at IS NULL AND k.enabled=1 AND (k.expires_at IS NULL OR k.expires_at>sqlc.arg(now)) AND u.enabled=1 AND g.enabled=1
AND EXISTS(SELECT 1 FROM effective_group_access access WHERE access.group_id=g.id AND access.user_id=u.id);

-- name: TouchKey :exec
UPDATE api_keys SET last_used_at = sqlc.arg(now)
WHERE id = sqlc.arg(id) AND revoked_at IS NULL
AND (last_used_at IS NULL OR last_used_at <= sqlc.arg(threshold));

-- name: UpdateKey :exec
UPDATE api_keys SET name=sqlc.arg(name),enabled=sqlc.arg(enabled),expires_at=sqlc.narg(expires_at)
WHERE id=sqlc.arg(id) AND user_id=sqlc.arg(user_id) AND revoked_at IS NULL;

-- name: RebindKeyGroup :exec
UPDATE api_keys SET group_id=sqlc.arg(group_id)
WHERE id=sqlc.arg(id) AND user_id=sqlc.arg(user_id) AND revoked_at IS NULL;

-- name: ClearKeyAllocation :exec
DELETE FROM allocation_keys WHERE key_id=sqlc.arg(key_id);
