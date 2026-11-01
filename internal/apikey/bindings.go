package apikey

import (
	"context"
	"database/sql"
	"errors"

	"github.com/murongg/SubLane/internal/allocations"
	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/groups"
	"github.com/murongg/SubLane/internal/storage/db"
)

func keyValue(row db.GetKeyRow) Key {
	return Key{ID: row.ID, GroupID: row.GroupID, GroupName: row.GroupName, GroupAccess: row.GroupAccess,
		Name: row.Name, Prefix: row.Prefix, CreatedAt: row.CreatedAt, LastUsedAt: row.LastUsedAt,
		RevokedAt: row.RevokedAt, Enabled: row.Enabled, ExpiresAt: row.ExpiresAt, Copyable: row.Copyable,
		SchemeID: row.SchemeID, SchemeName: row.SchemeName}
}

func describeKey(ctx context.Context, q *db.Queries, key Key, userID, now int64) (Key, error) {
	if _, err := allocations.KeyScheme(ctx, q, key.ID, userID, key.GroupID, now); err != nil {
		if !errors.Is(err, allocations.ErrUnavailable) {
			return Key{}, err
		}
		if key.SchemeID == 0 {
			scheme, err := q.GetPoolAllocation(ctx, key.GroupID)
			if err != nil {
				return Key{}, err
			}
			key.AllocationRequired = true
			if key.GroupAccess == "allowed" && key.Enabled && key.RevokedAt == nil && (key.ExpiresAt == nil || *key.ExpiresAt > now) {
				_, err := allocations.Authorize(ctx, q, scheme, userID, key.GroupID, now)
				if err != nil && !errors.Is(err, allocations.ErrUnavailable) {
					return Key{}, err
				}
				key.CanRestore = err == nil
			}
		}
		key.GroupAccess = "blocked"
	}
	return key, nil
}

// Rebind retains the secret and usage records; only subsequent requests use the destination pool and allowance.
func (s *Service) Rebind(ctx context.Context, userID, keyID, groupID int64) (Key, error) {
	if keyID <= 0 || groupID <= 0 {
		return Key{}, ErrInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Key{}, err
	}
	defer tx.Rollback()
	q := s.queries.WithTx(tx)
	key, err := q.GetKey(ctx, db.GetKeyParams{ID: keyID, UserID: userID, TenantID: s.tenantID})
	if errors.Is(err, sql.ErrNoRows) {
		return Key{}, ErrNotFound
	}
	if err != nil {
		return Key{}, err
	}
	if key.RevokedAt != nil {
		return Key{}, ErrRevoked
	}
	if _, err := q.GetTenantGroup(ctx, db.GetTenantGroupParams{ID: groupID, TenantID: s.tenantID}); errors.Is(err, sql.ErrNoRows) {
		return Key{}, groups.ErrUnavailable
	} else if err != nil {
		return Key{}, err
	}
	allowed, err := q.CanUseGroup(ctx, db.CanUseGroupParams{UserID: userID, GroupID: groupID})
	if err != nil {
		return Key{}, err
	}
	if !allowed {
		return Key{}, groups.ErrUnavailable
	}
	schemeID, err := q.GetPoolAllocation(ctx, groupID)
	if err == nil {
		if _, err := allocations.Authorize(ctx, q, schemeID, userID, groupID, s.now().Unix()); err != nil {
			if errors.Is(err, allocations.ErrUnavailable) {
				return Key{}, groups.ErrUnavailable
			}
			return Key{}, err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Key{}, err
	}
	// Validate the destination before replacing either binding, and commit both with their audit event.
	if err := q.ClearKeyAllocation(ctx, keyID); err != nil {
		return Key{}, err
	}
	if err := q.RebindKeyGroup(ctx, db.RebindKeyGroupParams{ID: keyID, UserID: userID, GroupID: groupID}); err != nil {
		return Key{}, err
	}
	if schemeID != 0 {
		if err := q.BindKeyAllocation(ctx, db.BindKeyAllocationParams{KeyID: keyID, SchemeID: schemeID}); err != nil {
			return Key{}, err
		}
	}
	if err := audit.Record(ctx, q, "key.update", "key", audit.ID(keyID)); err != nil {
		return Key{}, err
	}
	row, err := q.GetKey(ctx, db.GetKeyParams{ID: keyID, UserID: userID, TenantID: s.tenantID})
	if err != nil {
		return Key{}, err
	}
	return keyValue(row), tx.Commit()
}
