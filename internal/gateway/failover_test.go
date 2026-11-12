package gateway

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/murongg/SubLane/internal/accounts"
	"github.com/murongg/SubLane/internal/upstream"
)

type capturedRequest struct{ account, body string }

// failoverGateway returns the account a new conversation was bound to and the other pool member.
func failoverGateway(t *testing.T, enabled bool) (*Service, string, string, func() []capturedRequest) {
	t.Helper()
	var mu sync.Mutex
	var seen []capturedRequest
	s, ids := codexGateway(t, transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.Body != nil && strings.HasSuffix(r.URL.Path, "/responses") {
			raw, _ := io.ReadAll(r.Body)
			mu.Lock()
			seen = append(seen, capturedRequest{r.Header.Get("Chatgpt-Account-Id"), string(raw)})
			mu.Unlock()
		}
		return syntheticStream(), nil
	}))
	ctx := context.Background()
	second, err := s.accounts.Authorize(ctx, "Synthetic second", accounts.Credential{AccountID: "failover-second", AccessToken: "synthetic-access", RefreshToken: "synthetic-refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()}, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.accounts.SaveCatalog(ctx, second.ID, 0, []string{"synthetic-model"}, s.now().Unix(), upstream.CatalogSource("codex")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("INSERT INTO group_accounts(group_id,account_id) VALUES(1,?)", second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE account_groups SET quota_failover=? WHERE id=1", enabled); err != nil {
		t.Fatal(err)
	}
	if err := openTurn(t, s, failoverUser); err != nil {
		t.Fatal("initial binding", err)
	}
	first, other := boundAccount(t, s), second.ID
	if first == second.ID {
		other = ids["codex"]
	}
	return s, first, other, func() []capturedRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]capturedRequest(nil), seen...)
	}
}

func openTurn(t *testing.T, s *Service, input string) error {
	t.Helper()
	response, err := s.Open(context.Background(), 1, 1, []byte(`{"model":"synthetic-model","input":[`+input+`]}`), http.Header{"Session_id": {"synthetic-failover"}}, Responses)
	if err == nil {
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
	}
	return err
}

func boundAccount(t *testing.T, s *Service) string {
	t.Helper()
	var account string
	if err := s.db.QueryRow("SELECT account_id FROM account_affinity").Scan(&account); err != nil {
		t.Fatal(err)
	}
	return account
}

const (
	failoverUser     = `{"role":"user","content":"Synthetic question"}`
	failoverOld      = `{"type":"reasoning","summary":[],"encrypted_content":"gAAAA-synthetic-old"}`
	failoverReply    = `{"role":"assistant","content":[{"type":"output_text","text":"Synthetic answer"}]}`
	failoverNew      = `{"type":"reasoning","summary":[],"encrypted_content":"gAAAA-synthetic-new"}`
	failoverFollowUp = `{"role":"user","content":"Synthetic follow-up"}`
)

func TestQuotaFailoverMovesConversationAndWithholdsForeignState(t *testing.T) {
	s, first, second, requests := failoverGateway(t, true)
	saveExhaustedQuota(t, s, first)
	if err := openTurn(t, s, strings.Join([]string{failoverUser, failoverOld, failoverReply, failoverFollowUp}, ",")); err != nil {
		t.Fatal("exhausted conversation did not fail over", err)
	}
	if boundAccount(t, s) != second {
		t.Fatal("binding did not move")
	}
	// A restart must keep withholding the previous account's state while new state passes through.
	restarted := New(context.Background(), s.db, s.accounts, s.provider)
	defer restarted.Close()
	if err := openTurn(t, restarted, strings.Join([]string{failoverUser, failoverOld, failoverReply, failoverFollowUp, failoverNew, failoverReply, failoverFollowUp}, ",")); err != nil {
		t.Fatal(err)
	}
	seen := requests()
	secondSubject := seen[1].account
	if secondSubject == seen[0].account {
		t.Fatal("moved turn reused the exhausted account")
	}
	if len(seen) != 3 {
		t.Fatal("unexpected upstream requests", len(seen))
	}
	for i, request := range seen[1:] {
		if request.account != secondSubject || strings.Contains(request.body, "synthetic-old") || !strings.Contains(request.body, "Synthetic follow-up") {
			t.Fatal("moved turn leaked foreign state or lost transcript", i, request.account, request.body)
		}
	}
	// The SDK may drop synthetic token text, so count reasoning items: only the current account's remains.
	if strings.Count(seen[1].body, `"type":"reasoning"`) != 0 || strings.Count(seen[2].body, `"type":"reasoning"`) != 1 {
		t.Fatal("state from the current account was withheld", seen[2].body)
	}
}

func TestQuotaFailoverDisabledKeepsStrictBinding(t *testing.T) {
	s, first, _, _ := failoverGateway(t, false)
	saveExhaustedQuota(t, s, first)
	if err := openTurn(t, s, strings.Join([]string{failoverUser, failoverOld, failoverReply, failoverFollowUp}, ",")); !errors.Is(err, ErrQuotaExhausted) || boundAccount(t, s) != first {
		t.Fatal("conversation moved without opt-in", err)
	}
}

func TestQuotaFailoverRefusesServerHeldState(t *testing.T) {
	s, first, _, _ := failoverGateway(t, true)
	saveExhaustedQuota(t, s, first)
	if err := openTurn(t, s, `{"type":"item_reference","id":"synthetic-item"},`+failoverFollowUp); !errors.Is(err, ErrQuotaExhausted) || boundAccount(t, s) != first {
		t.Fatal("stored provider state moved accounts", err)
	}
}
