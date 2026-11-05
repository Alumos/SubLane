package accounts

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"strings"

	"github.com/murongg/SubLane/internal/storage/db"
)

type codexMember struct {
	userID, subject string
}

func (c Credential) codexMember() codexMember {
	var member codexMember
	for _, token := range []claims{tokenClaims(c.IDToken), tokenClaims(c.AccessToken)} {
		if member.userID == "" {
			member.userID = token.UserID
		}
		if member.subject == "" {
			member.subject = token.Subject
		}
	}
	return member
}

func (c Credential) identity() string {
	if c.Kind() != "codex" {
		return c.AccountID
	}
	member := c.codexMember()
	userID := member.userID
	if userID == "" {
		userID = member.subject
	}
	if userID == "" {
		return c.AccountID
	}
	// Codex account IDs identify workspaces. Keep member identity separate from the ID sent upstream.
	digest := sha256.Sum256([]byte(userID))
	return codexWorkspaceKey(c.AccountID) + hex.EncodeToString(digest[:])
}

func codexWorkspaceKey(accountID string) string {
	digest := sha256.Sum256([]byte(accountID))
	return "codex:" + hex.EncodeToString(digest[:]) + ":"
}

func sameIdentity(previous, next Credential) bool {
	if previous.Kind() != next.Kind() || previous.AccountID != next.AccountID {
		return false
	}
	if previous.Kind() != "codex" {
		return true
	}
	a, b := previous.codexMember(), next.codexMember()
	// Do not discard known user identity and allow a later rotation to replace it through the subject fallback.
	if a.userID != "" && b.userID == "" {
		return false
	}
	sharedUser := a.userID != "" && b.userID != ""
	sharedSubject := a.subject != "" && b.subject != ""
	if sharedUser && a.userID != b.userID || sharedSubject && a.subject != b.subject {
		return false
	}
	// A shared subject preserves continuity when older tokens gain a canonical user claim.
	return sharedUser || sharedSubject || a == b
}

// The scan shares the write transaction because legacy and member keys can describe the same account.
func (s *Service) checkDuplicate(ctx context.Context, q *db.Queries, c Credential, replaceID string) error {
	if c.Kind() != "codex" && c.Kind() != "openai" {
		return nil
	}
	rows, err := q.ListAccounts(ctx, s.tenantID)
	if err != nil {
		return err
	}
	for _, existing := range rows {
		if existing.Provider != c.Kind() || existing.ID == replaceID {
			continue
		}
		row, err := q.GetAccount(ctx, db.GetAccountParams{ID: existing.ID, TenantID: s.tenantID})
		if err != nil {
			return err
		}
		// Other workspaces cannot conflict, including legacy rows whose credentials are unavailable.
		if c.Kind() == "codex" && row.AccountID != c.AccountID && !strings.HasPrefix(row.AccountID, codexWorkspaceKey(c.AccountID)) {
			continue
		}
		previous, err := s.decrypt(row)
		if err != nil {
			return err
		}
		if c.Kind() == "openai" {
			if previous.BaseURL == c.BaseURL && previous.AccessToken == c.AccessToken {
				return ErrDuplicate
			}
		} else if previous.AccountID == c.AccountID {
			a, b := previous.codexMember(), c.codexMember()
			sharedUser := a.userID != "" && b.userID != ""
			sharedSubject := a.subject != "" && b.subject != ""
			// Legacy keys need a credential comparison; incomparable claims cannot prove distinct membership.
			if !sharedUser && !sharedSubject || sharedUser && a.userID == b.userID || sharedSubject && a.subject == b.subject {
				return ErrDuplicate
			}
		}
	}
	return nil
}

func prepareClaudeIdentity(c Credential, deviceID string) (Credential, bool, error) {
	if c.Kind() != "claude" {
		return c, false, nil
	}
	if deviceID == "" {
		deviceID = claudeDeviceID(c.Metadata)
	}
	if deviceID == "" {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return Credential{}, false, err
		}
		deviceID = hex.EncodeToString(raw)
	}
	// The pinned executor uses one canonical device per credential. Store it on
	// the account so temporary execution Auth values cannot create new devices.
	encoded, err := json.Marshal([]string{deviceID})
	if err != nil {
		return Credential{}, false, err
	}
	if bytes.Equal(c.Metadata["claude_device_ids"], encoded) {
		return c, false, nil
	}
	c.Metadata = maps.Clone(c.Metadata)
	if c.Metadata == nil {
		c.Metadata = make(map[string]json.RawMessage)
	}
	c.Metadata["claude_device_ids"] = encoded
	return c, true, nil
}

func claudeDeviceID(metadata map[string]json.RawMessage) string {
	var devices []string
	if json.Unmarshal(metadata["claude_device_ids"], &devices) != nil {
		return ""
	}
	for _, value := range devices {
		value = strings.ToLower(strings.TrimSpace(value))
		if len(value) != 64 {
			continue
		}
		if raw, err := hex.DecodeString(value); err == nil && len(raw) == 32 {
			return value
		}
	}
	return ""
}
