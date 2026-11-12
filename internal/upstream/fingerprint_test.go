package upstream

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"syscall"
	"testing"
	"time"

	"github.com/murongg/SubLane/internal/accounts"
)

func TestCodexAgentPresentsAccountPlatform(t *testing.T) {
	headers := http.Header{}
	applyCodexVersion(headers, "0.155.1", "(Mac OS 15.5.0; arm64) iTerm.app/3.6.1")
	if headers.Get("User-Agent") != "codex_cli_rs/0.155.1 (Mac OS 15.5.0; arm64) iTerm.app/3.6.1" || headers.Get("Version") != "0.155.1" {
		t.Fatal("account platform missing", headers)
	}
	applyCodexVersion(headers, "0.155.1", "")
	if headers.Get("User-Agent") != "codex_cli_rs/0.155.1" {
		t.Fatal("unlearned account changed agent", headers.Get("User-Agent"))
	}
}

func TestConnectFailuresRetryOnlyBeforeRequestBytes(t *testing.T) {
	restore := connectRetryDelays
	connectRetryDelays = []time.Duration{time.Millisecond, time.Millisecond}
	defer func() { connectRetryDelays = restore }()
	for _, test := range []struct {
		name    string
		failure error
		calls   int
		ok      bool
	}{
		{"dial", &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, 2, true},
		{"proxy connect", &net.OpError{Op: "proxyconnect", Err: syscall.ECONNREFUSED}, 2, true},
		{"reset after send", &net.OpError{Op: "read", Err: syscall.ECONNRESET}, 1, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			var bodies []string
			transport := &engineTransport{base: usageTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				raw, _ := io.ReadAll(r.Body)
				bodies = append(bodies, string(raw))
				if calls == 1 {
					return nil, test.failure
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(nil)), Request: r}, nil
			})}
			request, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://synthetic.invalid/v1", bytes.NewReader([]byte("synthetic-body")))
			response, err := transport.RoundTrip(request)
			if response != nil {
				response.Body.Close()
			}
			if calls != test.calls || (err == nil) != test.ok {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
			for _, body := range bodies {
				if body != "synthetic-body" {
					t.Fatal("replayed request lost its body", bodies)
				}
			}
		})
	}
}

func TestClaudeProfileOverridesOnlySetHeaders(t *testing.T) {
	request, _ := http.NewRequest(http.MethodPost, "https://api.anthropic.com/v1/messages", nil)
	request.Header.Set("X-Stainless-Os", "MacOS")
	request.Header.Set("X-Stainless-Runtime-Version", "v26.3.0")
	got := applyClaudeProfile(request, accounts.ClientProfile{OS: "Windows", Arch: "x64"})
	if got.Header.Get("X-Stainless-Os") != "Windows" || got.Header.Get("X-Stainless-Arch") != "x64" || got.Header.Get("X-Stainless-Runtime-Version") != "v26.3.0" {
		t.Fatal("account profile not applied", got.Header)
	}
	if request.Header.Get("X-Stainless-Os") != "MacOS" {
		t.Fatal("SDK request was mutated")
	}
}
