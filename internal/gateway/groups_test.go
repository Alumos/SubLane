package gateway

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/murongg/SubLane/internal/accounts"
	"github.com/murongg/SubLane/internal/groups"
)

func TestGroupRoutingAndAffinityNeverEscapeTheirPool(t *testing.T) {
	ctx := context.Background()
	gateway, ids := providerGateway(t, transportFunc(func(r *http.Request) (*http.Response, error) {
		subject := r.Header.Get("Chatgpt-Account-Id")
		body := `data: {"type":"response.completed","response":{"id":"synthetic-response","output":[]}}` + "\n\n"
		headers := http.Header{"Content-Type": {"text/event-stream"}}
		if strings.HasSuffix(r.URL.Path, "/models") {
			body = `{"models":[{"slug":"synthetic-model"},{"slug":"` + subject + `"}]}`
			headers.Set("Content-Type", "application/json")
		}
		if subject != "synthetic-subject" && subject != "synthetic-second" {
			t.Error("unexpected upstream identity")
		}
		return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
	}))
	second, err := gateway.accounts.Authorize(ctx, "Second", accounts.Credential{AccountID: "synthetic-second", AccessToken: "synthetic-second-access", RefreshToken: "synthetic-second-refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()}, "")
	if err != nil {
		t.Fatal(err)
	}
	pools := groups.New(gateway.db)
	a, err := pools.Save(ctx, 0, groups.Input{Name: "Alpha", Enabled: true, AccountIDs: []string{ids["codex"]}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := pools.Save(ctx, 0, groups.Input{Name: "Beta", Enabled: true, AccountIDs: []string{second.ID}})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		id      int64
		account string
	}{{a.ID, ids["codex"]}, {b.ID, second.ID}} {
		id, _, err := gateway.selectAccount(ctx, 1, test.id, "same-session", "codex", "", Responses)
		if err != nil || id != test.account {
			t.Fatal("cross-group affinity", id, err)
		}
	}
	catalog, err := gateway.Models(ctx, 1, b.ID)
	if err != nil || len(catalog) != 2 || catalog[1].ID != "synthetic-second" {
		t.Fatal("models escaped pool", catalog, err)
	}
	if _, err := pools.Save(ctx, a.ID, groups.Input{Name: a.Name, Enabled: true, AccountIDs: []string{second.ID}}); err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"model":"synthetic-model","input":"synthetic prompt"}`)
	strictBinding(t, gateway, a.ID)
	if _, err := gateway.Open(ctx, 1, a.ID, raw, http.Header{"Session_id": {"same-session"}}, Responses); !errors.Is(err, ErrAffinityUnavailable) {
		t.Fatal("removed account silently replaced", err)
	}
	result, err := gateway.Open(ctx, 1, a.ID, raw, http.Header{"Session_id": {"new-session"}}, Responses)
	if err != nil {
		t.Fatal(err)
	}
	result.Body.Close()
	if _, err := gateway.Open(ctx, 1, a.ID, []byte(`{"model":"claude/synthetic-model","input":"synthetic"}`), nil, Responses); !errors.Is(err, ErrNoAccount) {
		t.Fatal("provider outside pool selected", err)
	}
}
