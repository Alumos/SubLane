package apikey

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/auth"
	"github.com/murongg/SubLane/internal/groups"
	"github.com/murongg/SubLane/internal/storage"
	"github.com/murongg/SubLane/internal/tenants"
)

func TestPersonalKeyGroupChangesAndRestoration(t *testing.T) {
	ctx := context.Background()
	conn, err := storage.Open(ctx, filepath.Join(t.TempDir(), "synthetic.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	identity, err := auth.New(conn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := identity.Setup(ctx, "synthetic-owner", "synthetic-password", "Synthetic workspace"); err != nil {
		t.Fatal(err)
	}
	member, err := identity.CreateMember(ctx, "synthetic-member", "synthetic-password")
	if err != nil {
		t.Fatal(err)
	}
	keys := newTestKeys(t, conn)
	ctx = audit.WithActor(ctx, audit.Actor{TenantID: 1, ID: member.ID, Username: member.Username, Role: "member", Source: "user"})
	created, err := keys.CreateInGroup(ctx, member.ID, 1, "Synthetic key")
	if err != nil {
		t.Fatal(err)
	}
	target, err := groups.New(conn).Save(ctx, 0, groups.Input{Name: "Synthetic destination", Enabled: true, AccountIDs: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Rebind(ctx, 1, created.Key.ID, target.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("another user changed the key", err)
	}
	if _, err := keys.Rebind(ctx, member.ID, created.Key.ID, target.ID); !errors.Is(err, groups.ErrUnavailable) {
		t.Fatal("unauthorized destination accepted", err)
	}
	if err := groups.New(conn).SetMemberGroups(ctx, member.ID, []int64{1, target.ID}); err != nil {
		t.Fatal(err)
	}
	other, err := tenants.New(conn).Create(ctx, member.ID, "Synthetic other workspace")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := groups.NewForTenant(conn, other.ID).Save(ctx, 0, groups.Input{Name: "Synthetic foreign group", Enabled: true, AccountIDs: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Rebind(ctx, member.ID, created.Key.ID, foreign.ID); !errors.Is(err, groups.ErrUnavailable) {
		t.Fatal("cross-workspace change accepted", err)
	}
	if _, err := conn.Exec(`UPDATE api_keys SET group_id=? WHERE id=?`, foreign.ID, created.Key.ID); err == nil {
		t.Fatal("database lost workspace guard")
	}
	changed, err := keys.Rebind(ctx, member.ID, created.Key.ID, target.ID)
	if err != nil || changed.GroupID != target.ID || changed.GroupAccess != "allowed" {
		t.Fatal("rebind", changed, err)
	}
	if secret, err := keys.Reveal(ctx, member.ID, created.Key.ID); err != nil || secret != created.Secret {
		t.Fatal("secret changed", err)
	}
	for _, stmt := range []string{
		`INSERT INTO allocation_schemes(id,name,group_id,enabled,created_at) VALUES(1,'Synthetic allowance',2,1,1)`,
		`INSERT INTO allocation_revisions(scheme_id,effective_at,accounting_anchor_at,config) VALUES(1,1,1,'{"mode":"tokens","period":"day","members":[{"user_id":2,"limit":100}],"rates":[]}')`,
	} {
		if _, err := conn.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	for _, change := range []struct{ deny, reset string }{
		{`UPDATE allocation_schemes SET enabled=0`, `UPDATE allocation_schemes SET enabled=1`},
		{`UPDATE allocation_revisions SET effective_at=unixepoch()+86400`, `UPDATE allocation_revisions SET effective_at=1`},
		{`UPDATE allocation_revisions SET config=json_set(config,'$.members[0].user_id',1)`, `UPDATE allocation_revisions SET config=json_set(config,'$.members[0].user_id',2)`},
	} {
		if _, err := conn.Exec(change.deny); err != nil {
			t.Fatal(err)
		}
		if _, err := keys.Rebind(ctx, member.ID, created.Key.ID, target.ID); !errors.Is(err, groups.ErrUnavailable) {
			t.Fatal("unavailable allowance accepted", err)
		}
		page, err := keys.List(ctx, member.ID, Filter{})
		if err != nil || page.Keys[0].CanRestore {
			t.Fatal("unusable restoration offered", page, err)
		}
		if _, err := conn.Exec(change.reset); err != nil {
			t.Fatal(err)
		}
	}
	page, err := keys.List(ctx, member.ID, Filter{})
	if err != nil || len(page.Keys) != 1 || !page.Keys[0].CanRestore || !page.Keys[0].AllocationRequired || page.Keys[0].GroupAccess != "blocked" {
		t.Fatal("missing recovery metadata", page, err)
	}
	if _, err := keys.Authenticate(ctx, created.Secret); !errors.Is(err, ErrInvalidKey) {
		t.Fatal("unbound key authenticated", err)
	}
	if _, err := conn.Exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Rebind(ctx, member.ID, created.Key.ID, target.ID); err == nil {
		t.Fatal("binding committed without audit")
	}
	var bindings int
	if err := conn.QueryRow(`SELECT count(*) FROM allocation_keys WHERE key_id=?`, created.Key.ID).Scan(&bindings); err != nil || bindings != 0 {
		t.Fatal("binding survived rollback", bindings, err)
	}
	if _, err := conn.Exec(`DROP TRIGGER fail_audit`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		restored, err := keys.Rebind(ctx, member.ID, created.Key.ID, target.ID)
		if err != nil || restored.GroupAccess != "allowed" || restored.SchemeID != 1 || restored.CanRestore {
			t.Fatal("restore", restored, err)
		}
	}
	principal, err := keys.Authenticate(ctx, created.Secret)
	if err != nil || principal.GroupID != target.ID {
		t.Fatal("restored secret rejected", err)
	}
	if _, err := keys.Rebind(ctx, member.ID, created.Key.ID, 1); err != nil {
		t.Fatal("return to ordinary group", err)
	}
	if err := conn.QueryRow(`SELECT count(*) FROM allocation_keys WHERE key_id=?`, created.Key.ID).Scan(&bindings); err != nil || bindings != 0 {
		t.Fatal("old allowance retained", bindings, err)
	}
	if _, err := keys.Update(ctx, member.ID, created.Key.ID, UpdateInput{Name: "Synthetic paused", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	paused, err := keys.Rebind(ctx, member.ID, created.Key.ID, target.ID)
	if err != nil || paused.Enabled {
		t.Fatal("rebind changed pause state", paused, err)
	}
	if _, err := keys.Authenticate(ctx, created.Secret); !errors.Is(err, ErrInvalidKey) {
		t.Fatal("rebind reactivated key", err)
	}
	if _, err := keys.Update(ctx, member.ID, created.Key.ID, UpdateInput{Name: "Synthetic key", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	changedGroups := make(chan error, 1)
	go func() {
		for range 50 {
			for _, groupID := range []int64{1, target.ID} {
				if _, err := keys.Rebind(ctx, member.ID, created.Key.ID, groupID); err != nil {
					changedGroups <- err
					return
				}
			}
		}
		changedGroups <- nil
	}()
	var listError error
	for range 100 {
		if _, err := keys.List(ctx, member.ID, Filter{}); err != nil {
			listError = err
			break
		}
	}
	if err := <-changedGroups; err != nil {
		t.Fatal(err)
	}
	if listError != nil {
		t.Fatal("list mixed metadata from different group bindings", listError)
	}
	if _, err := keys.Revoke(ctx, member.ID, created.Key.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Rebind(ctx, member.ID, created.Key.ID, target.ID); !errors.Is(err, ErrRevoked) {
		t.Fatal("revoked key restored", err)
	}
}
