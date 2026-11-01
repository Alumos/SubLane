package storage

import (
	"bytes"
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestKeyGroupMigrationPreservesKeyAndHistory(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "synthetic.db")
	previous, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := previous.Exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "028_key_groups.sql" {
			break
		}
		if err := apply(ctx, previous, entry.Name()); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []string{
		`INSERT INTO users(id,username,password_hash,role,created_at) VALUES(1,'synthetic-owner','synthetic-hash','admin',1)`,
		`INSERT INTO tenants(id,name,owner_user_id,created_at) VALUES(1,'Synthetic workspace',1,1),(2,'Synthetic other workspace',1,1)`,
		`INSERT INTO account_groups(id,tenant_id,name,enabled,created_at,updated_at) VALUES(1,1,'Synthetic source',1,1,1),(2,1,'Synthetic destination',1,1,1),(3,2,'Synthetic foreign',1,1,1)`,
		`INSERT INTO api_keys(id,user_id,group_id,name,prefix,token_hash,encrypted_secret,created_at) VALUES(1,1,1,'Synthetic key','sl_test',zeroblob(32),X'1234',1)`,
		`INSERT INTO request_records(user_id,key_id,group_id,model,transport,operation,started_at,duration_ms,outcome) VALUES(1,1,1,'synthetic-model','http','responses',1,1,'success')`,
	} {
		if _, err := previous.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := previous.Exec(`UPDATE api_keys SET group_id=2 WHERE id=1`); err == nil {
		t.Fatal("fixture did not use the previous immutable binding")
	}
	if err := previous.Close(); err != nil {
		t.Fatal(err)
	}
	conn, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Exec(`UPDATE api_keys SET group_id=2 WHERE id=1`); err != nil {
		t.Fatal("same-workspace rebind blocked", err)
	}
	var hash, secret []byte
	var historicalGroup int64
	if err := conn.QueryRow(`SELECT token_hash,encrypted_secret FROM api_keys WHERE id=1`).Scan(&hash, &secret); err != nil || !bytes.Equal(hash, make([]byte, 32)) || !bytes.Equal(secret, []byte{0x12, 0x34}) {
		t.Fatal("key material changed", err)
	}
	if err := conn.QueryRow(`SELECT group_id FROM request_records WHERE key_id=1`).Scan(&historicalGroup); err != nil || historicalGroup != 1 {
		t.Fatal("historical group changed", historicalGroup, err)
	}
	if _, err := conn.Exec(`UPDATE api_keys SET group_id=3 WHERE id=1`); err == nil {
		t.Fatal("cross-workspace rebind accepted")
	}
}
