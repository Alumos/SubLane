package apikey

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/murongg/SubLane/internal/allocations"
	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/groups"
	"github.com/murongg/SubLane/internal/pagination"
	"github.com/murongg/SubLane/internal/storage/db"
	"github.com/murongg/SubLane/internal/vault"
)

var (
	ErrNotCopyable      = errors.New("api_key_not_copyable")
	ErrRevoked          = errors.New("api_key_revoked")
	ErrInput            = errors.New("invalid_input")
	ErrLimit            = errors.New("api_key_limit")
	ErrNotFound         = errors.New("api_key_not_found")
	ErrInvalidKey       = errors.New("invalid_api_key")
	ErrOwnerUnavailable = errors.New("unauthorized")
)

const maxActiveKeys = 20

type Key struct {
	ID                 int64  `json:"id"`
	GroupID            int64  `json:"group_id"`
	GroupName          string `json:"group_name"`
	GroupAccess        string `json:"group_access"`
	Name               string `json:"name"`
	Prefix             string `json:"prefix"`
	CreatedAt          int64  `json:"created_at"`
	LastUsedAt         *int64 `json:"last_used_at"`
	RevokedAt          *int64 `json:"revoked_at"`
	Enabled            bool   `json:"enabled"`
	ExpiresAt          *int64 `json:"expires_at"`
	Copyable           bool   `json:"copyable"`
	SchemeID           int64  `json:"scheme_id"`
	SchemeName         string `json:"scheme_name"`
	AllocationRequired bool   `json:"allocation_required"`
	CanRestore         bool   `json:"can_restore"`
}
type UpdateInput struct {
	Name      string `json:"name"`
	Enabled   bool   `json:"enabled"`
	ExpiresAt *int64 `json:"expires_at"`
}
type CreatedKey struct {
	Key    Key    `json:"key"`
	Secret string `json:"secret"`
}
type Page struct {
	pagination.Metadata
	ServerTime int64 `json:"server_time"`
	Keys       []Key `json:"keys"`
	NextCursor int64 `json:"next_cursor"`
}
type Filter struct {
	BeforeID       int64
	Page, Limit    int64
	IncludeRevoked bool
}
type Principal struct{ KeyID, UserID, GroupID, TenantID int64 }
type Service struct {
	vault    *vault.Vault
	db       *sql.DB
	queries  *db.Queries
	tenantID int64
	now      func() time.Time
}

func New(connection *sql.DB, cipher *vault.Vault) *Service {
	return NewForTenant(connection, cipher, 1)
}

func NewForTenant(connection *sql.DB, cipher *vault.Vault, tenantID int64) *Service {
	return &Service{vault: cipher, db: connection, queries: db.New(connection), tenantID: tenantID, now: time.Now}
}

func (s *Service) HasUsableKey(ctx context.Context, userID int64) (bool, error) {
	now := s.now().Unix()
	candidates, err := s.queries.ListKeyReadinessCandidates(ctx, db.ListKeyReadinessCandidatesParams{UserID: userID, TenantID: s.tenantID, Now: &now})
	if err != nil {
		return false, err
	}
	for _, key := range candidates {
		// A key in a reserved pool is usable only while its bound allowance admits the member.
		if _, err := allocations.KeyScheme(ctx, s.queries, key.ID, userID, key.GroupID, now); err == nil {
			return true, nil
		} else if !errors.Is(err, allocations.ErrUnavailable) {
			return false, err
		}
	}
	return false, nil
}

// Deprecated: use CreateInGroup or CreateInScheme to choose an explicit scope.
func (s *Service) Create(ctx context.Context, userID int64, name string) (CreatedKey, error) {
	// A new key requires an explicit pool or resource; never guess its scope.
	return CreatedKey{}, ErrInput
}

func (s *Service) CreateInGroup(ctx context.Context, userID, groupID int64, name string) (CreatedKey, error) {
	return s.CreateWithExpiry(ctx, userID, groupID, name, nil)
}

func (s *Service) CreateWithExpiry(ctx context.Context, userID, groupID int64, name string, expiry *int64) (CreatedKey, error) {
	return s.create(ctx, userID, groupID, 0, name, expiry)
}
func (s *Service) CreateInScheme(ctx context.Context, userID, schemeID int64, name string, expiry *int64) (CreatedKey, error) {
	if schemeID <= 0 {
		return CreatedKey{}, ErrInput
	}
	row, err := s.queries.GetAllocationScheme(ctx, schemeID)
	if err != nil {
		return CreatedKey{}, groups.ErrUnavailable
	}
	return s.create(ctx, userID, row.GroupID, schemeID, name, expiry)
}
func (s *Service) create(ctx context.Context, userID, groupID, schemeID int64, name string, expiry *int64) (CreatedKey, error) {
	if groupID <= 0 || !validExpiry(expiry, s.now().Unix()) {
		return CreatedKey{}, ErrInput
	}
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 64 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return CreatedKey{}, ErrInput
	}
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	secret := "sl_" + base64.RawURLEncoding.EncodeToString(raw)
	digest := sha256.Sum256([]byte(secret))
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CreatedKey{}, err
	}
	defer tx.Rollback()
	queries := s.queries.WithTx(tx)
	enabled, err := queries.GetKeyOwnerEnabled(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !enabled) {
		return CreatedKey{}, ErrOwnerUnavailable
	}
	if err != nil {
		return CreatedKey{}, err
	}
	allowed, err := queries.CanUseGroup(ctx, db.CanUseGroupParams{UserID: userID, GroupID: groupID})
	if err != nil {
		return CreatedKey{}, err
	}
	if !allowed {
		return CreatedKey{}, groups.ErrUnavailable
	}
	if schemeID != 0 {
		if _, err := allocations.Authorize(ctx, queries, schemeID, userID, groupID, s.now().Unix()); err != nil {
			return CreatedKey{}, groups.ErrUnavailable
		}
	} else {
		if _, err := queries.GetPoolAllocation(ctx, groupID); err == nil {
			return CreatedKey{}, groups.ErrUnavailable
		} else if !errors.Is(err, sql.ErrNoRows) {
			return CreatedKey{}, err
		}
	}
	group, err := queries.GetTenantGroup(ctx, db.GetTenantGroupParams{ID: groupID, TenantID: s.tenantID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return CreatedKey{}, groups.ErrUnavailable
		}
		return CreatedKey{}, err
	}
	count, err := queries.CountActiveKeys(ctx, db.CountActiveKeysParams{UserID: userID, TenantID: s.tenantID})
	if err != nil {
		return CreatedKey{}, err
	}
	if count >= maxActiveKeys {
		return CreatedKey{}, ErrLimit
	}
	key := Key{GroupID: groupID, GroupName: group.Name, GroupAccess: "allowed", Name: name, Prefix: secret[:11], CreatedAt: s.now().Unix(), Enabled: true, ExpiresAt: expiry}
	key.ID, err = queries.CreateKey(ctx, db.CreateKeyParams{GroupID: groupID, UserID: userID, Name: name, Prefix: key.Prefix, TokenHash: digest[:], CreatedAt: key.CreatedAt, ExpiresAt: expiry})
	if err != nil {
		return CreatedKey{}, err
	}
	encrypted, err := s.vault.SealAPIKey(userID, key.ID, []byte(secret))
	if err != nil {
		return CreatedKey{}, err
	}
	if err := queries.SaveKeySecret(ctx, db.SaveKeySecretParams{KeyID: key.ID, Secret: encrypted}); err != nil {
		return CreatedKey{}, err
	}
	if schemeID != 0 {
		if err := queries.BindKeyAllocation(ctx, db.BindKeyAllocationParams{KeyID: key.ID, SchemeID: schemeID}); err != nil {
			return CreatedKey{}, err
		}
		scheme, err := queries.GetAllocationScheme(ctx, schemeID)
		if err != nil {
			return CreatedKey{}, err
		}
		key.SchemeID = schemeID
		key.SchemeName = scheme.Name
	}
	key.Copyable = true
	if err := audit.Record(ctx, queries, "key.create", "key", audit.ID(key.ID)); err != nil {
		return CreatedKey{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreatedKey{}, err
	}
	return CreatedKey{Key: key, Secret: secret}, nil
}

func (s *Service) List(ctx context.Context, userID int64, filter Filter) (Page, error) {
	page := Page{Keys: []Key{}, ServerTime: s.now().Unix()}
	bounds := pagination.Input{Page: filter.Page, Limit: filter.Limit, Cursor: filter.BeforeID}
	if !bounds.Valid() {
		return page, ErrInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	q := s.queries.WithTx(tx)
	total, err := q.CountKeys(ctx, db.CountKeysParams{UserID: userID, TenantID: s.tenantID, IncludeRevoked: filter.IncludeRevoked})
	if err != nil {
		return page, err
	}
	page.Metadata = bounds.Resolve(total)
	rows, err := q.ListKeys(ctx, db.ListKeysParams{UserID: userID, TenantID: s.tenantID, BeforeID: filter.BeforeID, IncludeRevoked: filter.IncludeRevoked, PageLimit: page.PageSize + 1, PageOffset: page.Offset()})
	if err != nil {
		return page, err
	}
	if int64(len(rows)) > page.PageSize {
		rows = rows[:page.PageSize]
		page.NextCursor = rows[len(rows)-1].ID
	}
	// Group changes and allowance recovery must be described from the same snapshot as the key metadata.
	for _, row := range rows {
		key, err := describeKey(ctx, q, keyValue(db.GetKeyRow(row)), userID, s.now().Unix())
		if err != nil {
			return page, err
		}
		page.Keys = append(page.Keys, key)
	}
	return page, tx.Commit()
}

var ErrInactive = errors.New("api_key_inactive")

// CatalogGroup authorizes model discovery without decrypting the user's gateway key.
func (s *Service) CatalogGroup(ctx context.Context, userID, keyID int64) (int64, error) {
	row, err := s.queries.GetKey(ctx, db.GetKeyParams{ID: keyID, UserID: userID, TenantID: s.tenantID})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if row.RevokedAt != nil || !row.Enabled || (row.ExpiresAt != nil && *row.ExpiresAt <= s.now().Unix()) {
		return 0, ErrInactive
	}
	if _, err := allocations.KeyScheme(ctx, s.queries, row.ID, userID, row.GroupID, s.now().Unix()); err != nil {
		return 0, groups.ErrUnavailable
	}
	if row.GroupAccess != "allowed" {
		return 0, groups.ErrUnavailable
	}
	return row.GroupID, nil
}

func validExpiry(expiry *int64, now int64) bool {
	return expiry == nil || (*expiry > now && *expiry <= 253402300799)
}

func (s *Service) Update(ctx context.Context, userID, keyID int64, input UpdateInput) (Key, error) {
	input.Name = strings.TrimSpace(input.Name)
	if !utf8.ValidString(input.Name) || utf8.RuneCountInString(input.Name) < 1 || utf8.RuneCountInString(input.Name) > 64 || strings.IndexFunc(input.Name, unicode.IsControl) >= 0 {
		return Key{}, ErrInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Key{}, err
	}
	defer tx.Rollback()
	q := s.queries.WithTx(tx)
	row, err := q.GetKey(ctx, db.GetKeyParams{ID: keyID, UserID: userID, TenantID: s.tenantID})
	if errors.Is(err, sql.ErrNoRows) {
		return Key{}, ErrNotFound
	}
	if err != nil {
		return Key{}, err
	}
	if row.RevokedAt != nil {
		return Key{}, ErrRevoked
	}
	// An unchanged past deadline may be retained when renaming an already expired key.
	unchanged := row.ExpiresAt != nil && input.ExpiresAt != nil && *row.ExpiresAt == *input.ExpiresAt
	if !unchanged && !validExpiry(input.ExpiresAt, s.now().Unix()) {
		return Key{}, ErrInput
	}
	if err := q.UpdateKey(ctx, db.UpdateKeyParams{ID: keyID, UserID: userID, Name: input.Name, Enabled: input.Enabled, ExpiresAt: input.ExpiresAt}); err != nil {
		return Key{}, err
	}
	if err := audit.Record(ctx, q, "key.update", "key", audit.ID(keyID)); err != nil {
		return Key{}, err
	}
	row.Name, row.Enabled, row.ExpiresAt = input.Name, input.Enabled, input.ExpiresAt
	key, err := describeKey(ctx, q, keyValue(row), userID, s.now().Unix())
	if err != nil {
		return Key{}, err
	}
	return key, tx.Commit()
}
func (s *Service) Revoke(ctx context.Context, userID, keyID int64) (Key, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Key{}, err
	}
	defer tx.Rollback()
	q := s.queries.WithTx(tx)
	row, err := q.GetKey(ctx, db.GetKeyParams{ID: keyID, UserID: userID, TenantID: s.tenantID})
	if errors.Is(err, sql.ErrNoRows) {
		return Key{}, ErrNotFound
	}
	if err != nil {
		return Key{}, err
	}
	if row.RevokedAt == nil {
		now := s.now().Unix()
		if _, err := q.RevokeKey(ctx, db.RevokeKeyParams{Now: &now, ID: keyID, UserID: userID}); err != nil {
			return Key{}, err
		}
		row.Copyable = false
		if err := audit.Record(ctx, q, "key.revoke", "key", audit.ID(keyID)); err != nil {
			return Key{}, err
		}
		row.RevokedAt = &now
	}
	return keyValue(row), tx.Commit()
}

func (s *Service) Authenticate(ctx context.Context, secret string) (Principal, error) {
	if len(secret) != 46 || !strings.HasPrefix(secret, "sl_") {
		return Principal{}, ErrInvalidKey
	}
	raw, err := base64.RawURLEncoding.DecodeString(secret[3:])
	if err != nil || len(raw) != 32 {
		return Principal{}, ErrInvalidKey
	}
	digest := sha256.Sum256([]byte(secret))
	// Recheck membership and pool enablement on every request, including later WebSocket turns.
	now := s.now().Unix()
	row, err := s.queries.AuthenticateKey(ctx, db.AuthenticateKeyParams{TokenHash: digest[:], TenantID: s.tenantID, Now: &now})
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, ErrInvalidKey
	}
	if err != nil {
		return Principal{}, err
	}
	if _, err := allocations.KeyScheme(ctx, s.queries, row.ID, row.UserID, row.GroupID, now); err != nil {
		if errors.Is(err, allocations.ErrUnavailable) {
			return Principal{}, ErrInvalidKey
		}
		return Principal{}, err
	}
	threshold := now - 60
	// Track usage without writing to SQLite for every request in a burst.
	err = s.queries.TouchKey(ctx, db.TouchKeyParams{Now: &now, ID: row.ID, Threshold: &threshold})
	return Principal{KeyID: row.ID, UserID: row.UserID, GroupID: row.GroupID, TenantID: s.tenantID}, err
}
