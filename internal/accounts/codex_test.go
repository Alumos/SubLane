package accounts

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func codexToken(t *testing.T, payload map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return "e30." + base64.RawURLEncoding.EncodeToString(raw) + ".synthetic"
}

func codexCredential(t *testing.T, workspace, member string) Credential {
	t.Helper()
	return Credential{
		AccountID: workspace, AccessToken: "synthetic-access-" + member,
		RefreshToken: "synthetic-refresh-" + member, ExpiresAt: 2_000_003_600,
		IDToken: codexToken(t, map[string]any{
			"sub": "synthetic-subject-" + member, "email": member + "@example.test",
			"https://api.openai.com/auth": map[string]string{
				"chatgpt_account_id": workspace, "chatgpt_user_id": member, "chatgpt_plan_type": "team",
			},
		}),
	}
}

func importCodex(t *testing.T, s *Service, c Credential, replaceID string) (Account, error) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"auth_mode": "chatgpt", "tokens": c})
	if err != nil {
		t.Fatal(err)
	}
	return s.Import(context.Background(), "Synthetic member", raw, replaceID)
}

func TestCodexTeamMembersHaveSeparateIdentities(t *testing.T) {
	for _, mode := range []string{"import", "authorization"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _ := refreshFixture(t, "codex", time.Hour)
			save := func(c Credential, replaceID string) (Account, error) {
				if mode == "import" {
					return importCodex(t, s, c, replaceID)
				}
				return s.Authorize(context.Background(), "Synthetic member", c, replaceID)
			}
			first := codexCredential(t, "synthetic-team", "synthetic-member-a")
			second := codexCredential(t, "synthetic-team", "synthetic-member-b")
			a, err := save(first, "")
			if err != nil {
				t.Fatal(err)
			}
			b, err := save(second, "")
			if err != nil || a.ID == b.ID {
				t.Fatalf("different team members must be accepted separately: %v", err)
			}
			first.AccessToken = "synthetic-rotated-access"
			first.Email = "renamed@example.test"
			if _, err := save(first, ""); !errors.Is(err, ErrDuplicate) {
				t.Fatalf("rotating tokens or changing email bypassed duplicate detection: %v", err)
			}
			if _, err := save(first, a.ID); err != nil {
				t.Fatalf("same-member reauthorization failed: %v", err)
			}
			otherWorkspace := codexCredential(t, "synthetic-other-team", "synthetic-member-a")
			if _, err := save(otherWorkspace, ""); err != nil {
				t.Fatalf("same member in another workspace was rejected: %v", err)
			}
			restarted := New(s.db, s.vault)
			restarted.now = s.now
			if err := restarted.Verify(context.Background()); err != nil {
				t.Fatal(err)
			}
			prepared, err := restarted.Prepare(context.Background(), a.ID, nil)
			if err != nil || prepared.AccountID != "synthetic-team" || prepared.AccessToken != first.AccessToken {
				t.Fatalf("restart lost member credentials or changed upstream workspace routing: %v", err)
			}
		})
	}
}

func TestCodexReauthorizationAndRefreshPreserveMember(t *testing.T) {
	for _, mode := range []string{"import", "authorization", "refresh", "missing-member", "access-subject", "lost-user-claim", "refresh-lost-user-claim"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _ := refreshFixture(t, "codex", time.Hour)
			ctx := context.Background()
			first := codexCredential(t, "synthetic-team", "synthetic-member-a")
			a, err := s.Authorize(ctx, "Synthetic member", first, "")
			if err != nil {
				t.Fatal(err)
			}
			other := codexCredential(t, "synthetic-team", "synthetic-member-b")
			switch mode {
			case "import":
				_, err = importCodex(t, s, other, a.ID)
			case "authorization":
				_, err = s.Authorize(ctx, "Synthetic replacement", other, a.ID)
			case "refresh":
				_, err = s.RefreshAfterRejection(ctx, a.ID, first.AccessToken, func(context.Context, Credential) (Credential, error) { return other, nil })
			case "missing-member":
				other.IDToken = ""
				_, err = s.Authorize(ctx, "Synthetic replacement", other, a.ID)
			case "access-subject":
				other.IDToken = first.IDToken
				other.AccessToken = codexToken(t, map[string]any{"sub": "synthetic-subject-synthetic-member-b"})
				_, err = s.RefreshAfterRejection(ctx, a.ID, first.AccessToken, func(context.Context, Credential) (Credential, error) { return other, nil })
			case "lost-user-claim", "refresh-lost-user-claim":
				other.IDToken = codexToken(t, map[string]any{"sub": "synthetic-subject-synthetic-member-a"})
				if mode == "lost-user-claim" {
					_, err = s.Authorize(ctx, "Synthetic replacement", other, a.ID)
				} else {
					_, err = s.RefreshAfterRejection(ctx, a.ID, first.AccessToken, func(context.Context, Credential) (Credential, error) { return other, nil })
				}
			}
			if !errors.Is(err, ErrIdentity) {
				t.Fatalf("replacement changed the upstream member: %v", err)
			}
			row, err := s.get(ctx, a.ID)
			if err != nil {
				t.Fatal(err)
			}
			saved, err := s.decrypt(row)
			if err != nil || saved.AccessToken != first.AccessToken {
				t.Fatalf("failed replacement modified credentials: %v", err)
			}
		})
	}
}

func TestCodexLegacyWorkspaceIdentityRemainsUsable(t *testing.T) {
	for _, mode := range []string{"reauthorization", "refresh"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _ := refreshFixture(t, "codex", time.Hour)
			ctx := context.Background()
			first := codexCredential(t, "synthetic-team", "synthetic-member-a")
			a, err := importCodex(t, s, first, "")
			if err != nil {
				t.Fatal(err)
			}
			// v0.19.1 stored only the workspace ID beside the encrypted credential.
			if _, err := s.db.Exec("UPDATE accounts SET account_id=? WHERE id=?", first.AccountID, a.ID); err != nil {
				t.Fatal(err)
			}
			s = New(s.db, s.vault)
			s.now = func() time.Time { return time.Unix(2_000_000_000, 0) }
			if err := s.Verify(ctx); err != nil {
				t.Fatalf("legacy credential verification failed: %v", err)
			}
			if _, err := importCodex(t, s, first, ""); !errors.Is(err, ErrDuplicate) {
				t.Fatalf("legacy member was imported twice: %v", err)
			}
			if _, err := importCodex(t, s, codexCredential(t, first.AccountID, "synthetic-member-b"), ""); err != nil {
				t.Fatalf("legacy member blocked a different team member: %v", err)
			}
			first.AccessToken = "synthetic-rotated-access"
			if mode == "reauthorization" {
				_, err = s.Authorize(ctx, "Synthetic reauthorization", first, a.ID)
			} else {
				_, err = s.RefreshAfterRejection(ctx, a.ID, "synthetic-access-synthetic-member-a", func(context.Context, Credential) (Credential, error) { return first, nil })
			}
			if err != nil {
				t.Fatalf("legacy credential rotation failed: %v", err)
			}
			if _, err := importCodex(t, s, first, ""); !errors.Is(err, ErrDuplicate) {
				t.Fatalf("rotated legacy member lost duplicate protection: %v", err)
			}
			if err := s.Verify(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCodexMemberClaimAliases(t *testing.T) {
	for _, source := range []string{"chatgpt_user_id", "user_id", "access-token", "subject"} {
		t.Run(source, func(t *testing.T) {
			s, _, _ := refreshFixture(t, "codex", time.Hour)
			for _, member := range []string{"synthetic-member-a", "synthetic-member-b"} {
				c := codexCredential(t, "synthetic-team", member)
				auth := map[string]string{"chatgpt_account_id": c.AccountID}
				payload := map[string]any{"https://api.openai.com/auth": auth}
				if source == "subject" {
					payload["sub"] = member
				} else if source == "access-token" {
					auth["chatgpt_user_id"] = member
					c.AccessToken = codexToken(t, payload)
					payload = map[string]any{}
				} else {
					auth[source] = member
				}
				c.IDToken = codexToken(t, payload)
				if _, err := importCodex(t, s, c, ""); err != nil {
					t.Fatalf("member claim %s did not distinguish team members: %v", source, err)
				}
			}
		})
	}
}

func TestCodexRejectsConflictingOrInvalidMemberClaims(t *testing.T) {
	for _, tc := range []struct {
		name, member string
		want         error
	}{
		{"conflicting", "synthetic-other-member", ErrIdentity},
		{"subject", "synthetic-other-subject", ErrIdentity},
		{"alias", "synthetic-other-member", ErrIdentity},
		{"oversized", strings.Repeat("a", 257), ErrInput},
		{"control", "synthetic\nmember", ErrInput},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, _ := refreshFixture(t, "codex", time.Hour)
			c := codexCredential(t, "synthetic-team", "synthetic-member-a")
			if tc.want == ErrInput {
				c.IDToken = ""
			}
			payload := map[string]any{"https://api.openai.com/auth": map[string]string{"chatgpt_user_id": tc.member}}
			if tc.name == "subject" {
				payload = map[string]any{"sub": tc.member}
			} else if tc.name == "alias" {
				payload = map[string]any{"https://api.openai.com/auth": map[string]string{"chatgpt_user_id": "synthetic-member-a", "user_id": tc.member}}
			}
			c.AccessToken = codexToken(t, payload)
			if _, err := importCodex(t, s, c, ""); !errors.Is(err, tc.want) {
				t.Fatalf("conflicting or invalid token member identity: %v", err)
			}
		})
	}
}

func TestCodexMemberClaimUpgradePreservesIdentity(t *testing.T) {
	for _, mode := range []string{"reauthorization", "refresh"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _ := refreshFixture(t, "codex", time.Hour)
			ctx := context.Background()
			full := codexCredential(t, "synthetic-team", "synthetic-member-a")
			legacy := full
			legacy.IDToken = codexToken(t, map[string]any{"sub": "synthetic-subject-synthetic-member-a"})
			a, err := importCodex(t, s, legacy, "")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := importCodex(t, s, full, ""); !errors.Is(err, ErrDuplicate) {
				t.Fatalf("adding canonical user claims bypassed duplicate protection: %v", err)
			}
			full.AccessToken = "synthetic-rotated-access"
			if mode == "reauthorization" {
				_, err = s.Authorize(ctx, "Synthetic member", full, a.ID)
			} else {
				_, err = s.RefreshAfterRejection(ctx, a.ID, legacy.AccessToken, func(context.Context, Credential) (Credential, error) { return full, nil })
			}
			if err != nil {
				t.Fatalf("canonical user claims prevented same-member rotation: %v", err)
			}
			if _, err := importCodex(t, s, legacy, ""); !errors.Is(err, ErrDuplicate) {
				t.Fatalf("subject-only claims bypassed canonical member identity: %v", err)
			}
		})
	}
}

func TestCodexMissingMemberCannotBypassDuplicateProtection(t *testing.T) {
	for _, knownFirst := range []bool{true, false} {
		s, _, _ := refreshFixture(t, "codex", time.Hour)
		known := codexCredential(t, "synthetic-team", "synthetic-member-a")
		unknown := known
		unknown.IDToken = ""
		first, second := known, unknown
		if !knownFirst {
			first, second = second, first
		}
		if _, err := importCodex(t, s, first, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := importCodex(t, s, second, ""); !errors.Is(err, ErrDuplicate) {
			t.Fatalf("missing member claims bypassed duplicate protection: %v", err)
		}
	}
}

func TestCodexAmbiguousMemberClaimsCannotCreateDuplicate(t *testing.T) {
	for _, mode := range []string{"no-shared-claim", "conflicting-subject"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _ := refreshFixture(t, "codex", time.Hour)
			first := codexCredential(t, "synthetic-team", "synthetic-member-a")
			if mode == "no-shared-claim" {
				first.IDToken = codexToken(t, map[string]any{"https://api.openai.com/auth": map[string]string{"chatgpt_user_id": "synthetic-member-a"}})
			}
			a, err := importCodex(t, s, first, "")
			if err != nil {
				t.Fatal(err)
			}
			// Exercise duplicate detection before an older row acquires its member key.
			if _, err := s.db.Exec("UPDATE accounts SET account_id=? WHERE id=?", first.AccountID, a.ID); err != nil {
				t.Fatal(err)
			}
			other := first
			if mode == "no-shared-claim" {
				other.IDToken = codexToken(t, map[string]any{"sub": "synthetic-unrelated-subject"})
			} else {
				other.IDToken = codexToken(t, map[string]any{"sub": "synthetic-unrelated-subject", "https://api.openai.com/auth": map[string]string{"chatgpt_user_id": "synthetic-member-a"}})
			}
			if _, err := importCodex(t, s, other, ""); !errors.Is(err, ErrDuplicate) {
				t.Fatalf("ambiguous member identity bypassed duplicate protection: %v", err)
			}
		})
	}
}
