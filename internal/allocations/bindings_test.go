package allocations

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/storage/db"
)

func TestCreatingAllocationBindsExistingMemberKeysAtomically(t *testing.T) {
	for _, failAudit := range []bool{false, true} {
		t.Run(map[bool]string{false: "bind", true: "rollback"}[failAudit], func(t *testing.T) {
			s, conn, member, _ := fixture(t)
			ctx := audit.WithActor(context.Background(), audit.Actor{TenantID: 1, ID: 1, Username: "synthetic-admin", Role: "admin", Source: "user"})
			for _, statement := range []string{
				`INSERT INTO api_keys(id,user_id,group_id,name,prefix,token_hash,created_at) VALUES(101,2,2,'Synthetic active','sl_test',X'0101010101010101010101010101010101010101010101010101010101010101',1)`,
				`INSERT INTO api_keys(id,user_id,group_id,name,prefix,token_hash,created_at,enabled) VALUES(102,2,2,'Synthetic paused','sl_test',X'0202020202020202020202020202020202020202020202020202020202020202',1,0)`,
				`INSERT INTO api_keys(id,user_id,group_id,name,prefix,token_hash,created_at,expires_at) VALUES(103,2,2,'Synthetic expired','sl_test',X'0303030303030303030303030303030303030303030303030303030303030303',1,2)`,
				`INSERT INTO api_keys(id,user_id,group_id,name,prefix,token_hash,created_at,revoked_at) VALUES(104,2,2,'Synthetic revoked','sl_test',X'0404040404040404040404040404040404040404040404040404040404040404',1,2)`,
				`INSERT INTO api_keys(id,user_id,group_id,name,prefix,token_hash,created_at) VALUES(105,1,2,'Synthetic excluded owner','sl_test',X'0505050505050505050505050505050505050505050505050505050505050505',1)`,
				`INSERT INTO api_keys(id,user_id,group_id,name,prefix,token_hash,created_at) VALUES(106,2,1,'Synthetic other pool','sl_test',X'0606060606060606060606060606060606060606060606060606060606060606',1)`,
			} {
				if _, err := conn.Exec(statement); err != nil {
					t.Fatal(err)
				}
			}
			if failAudit {
				if _, err := conn.Exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`); err != nil {
					t.Fatal(err)
				}
			}
			_, err := s.SaveScheme(ctx, 0, SchemeInput{Name: "Synthetic allowance", GroupID: 2, Enabled: true, Config: Config{Mode: "tokens", Period: "day", Members: []Share{{UserID: member, Limit: 100}}}})
			if failAudit && err == nil || !failAudit && err != nil {
				t.Fatalf("save: %v", err)
			}
			var bound, schemes int
			if err := conn.QueryRow(`SELECT count(*) FROM allocation_keys WHERE key_id IN (101,102,103)`).Scan(&bound); err != nil {
				t.Fatal(err)
			}
			if err := conn.QueryRow(`SELECT count(*) FROM allocation_schemes`).Scan(&schemes); err != nil {
				t.Fatal(err)
			}
			if failAudit {
				if bound != 0 || schemes != 0 {
					t.Fatalf("partial allocation survived rollback: bound=%d schemes=%d", bound, schemes)
				}
				return
			}
			var excluded int
			if err := conn.QueryRow(`SELECT count(*) FROM allocation_keys WHERE key_id IN (104,105,106)`).Scan(&excluded); err != nil {
				t.Fatal(err)
			}
			if bound != 3 || excluded != 0 {
				t.Fatalf("wrong keys bound: eligible=%d excluded=%d", bound, excluded)
			}
			var paused int
			if err := conn.QueryRow(`SELECT enabled FROM api_keys WHERE id=102`).Scan(&paused); err != nil || paused != 0 {
				t.Fatal("binding re-enabled a paused key", err)
			}
		})
	}
}

func TestScheduledAllocationBindsKeysWithoutEarlyAccess(t *testing.T) {
	s, conn, member, _ := fixture(t)
	ctx := context.Background()
	now := time.Date(2030, 4, 12, 10, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	if _, err := conn.Exec(`INSERT INTO api_keys(id,user_id,group_id,name,prefix,token_hash,created_at) VALUES(101,2,2,'Synthetic scheduled key','sl_test',zeroblob(32),1)`); err != nil {
		t.Fatal(err)
	}
	scheme, err := s.SaveScheme(ctx, 0, SchemeInput{Name: "Synthetic scheduled allowance", GroupID: 2, Enabled: true, StartNext: true, Config: Config{Mode: "tokens", Period: "month", Members: []Share{{UserID: member, Limit: 100}}}})
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(conn)
	if bound, err := q.GetKeyAllocation(ctx, 101); err != nil || bound != scheme.ID {
		t.Fatal("scheduled key not linked", bound, err)
	}
	if _, err := KeyScheme(ctx, q, 101, member, 2, now.Unix()); !errors.Is(err, ErrUnavailable) {
		t.Fatal("scheduled allowance granted early access", err)
	}
	if _, err := KeyScheme(ctx, q, 101, member, 2, scheme.EffectiveAt); err != nil {
		t.Fatal("bound key unavailable at activation", err)
	}
}
