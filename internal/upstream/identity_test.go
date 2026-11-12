package upstream

import (
	"bufio"
	"context"
	"crypto/md5"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/murongg/SubLane/internal/accounts"
)

const identitySeed = "6f1f8e7a-6b1c-4c55-9a43-0c1d2e3f4a5b"

func identityClient() http.Header {
	return http.Header{
		"X-Codex-Installation-Id": {"client-installation"},
		"X-Codex-Window-Id":       {"client-window"},
		"X-Codex-Turn-Metadata":   {`{"installation_id":"client-installation","session_id":"client-session","thread_id":"client-thread","sandbox":"seatbelt"}`},
		"Session_id":              {"isolated-conversation"},
		"Cookie":                  {"synthetic-cookie"},
	}
}

func TestCodexIdentityOffForwardsClientIdentityConsistently(t *testing.T) {
	id := newCodexIdentity(accounts.Credential{Identity: accounts.ClientIdentity{Mode: "off"}}, identityClient())
	headers := http.Header{"session_id": {"sdk-session"}}
	id.apply(headers)
	if headers.Get("X-Codex-Installation-Id") != "client-installation" || headers.Get("X-Codex-Window-Id") != "client-window" || headers.Get("Cookie") != "" {
		t.Fatal("client identity headers not forwarded exactly", headers)
	}
	if len(headers["session_id"]) != 0 || headers.Get("Session_id") != "isolated-conversation" {
		t.Fatal("session header duplicated or not isolated", headers)
	}
	var metadata map[string]string
	if json.Unmarshal([]byte(headers.Get("X-Codex-Turn-Metadata")), &metadata) != nil || metadata["session_id"] != "isolated-conversation" || metadata["installation_id"] != "client-installation" || metadata["sandbox"] != "seatbelt" {
		t.Fatal("turn metadata disagrees with the outgoing session", headers.Get("X-Codex-Turn-Metadata"))
	}
	body := id.rewriteBody([]byte(`{"prompt_cache_key":"0123abcd","client_metadata":{"session_id":"client-session"}}`))
	if !strings.Contains(string(body), `"prompt_cache_key":"isolated-conversation"`) || !strings.Contains(string(body), `"session_id":"isolated-conversation"`) {
		t.Fatal("body identifiers disagree with headers", string(body))
	}
}

func TestCodexIdentityConvergesEveryCarrier(t *testing.T) {
	for _, mode := range []string{"device", "session", "full"} {
		t.Run(mode, func(t *testing.T) {
			id := newCodexIdentity(accounts.Credential{Identity: accounts.ClientIdentity{Mode: mode, Seed: identitySeed}}, identityClient())
			headers := http.Header{}
			id.apply(headers)
			installation, session := accounts.CodexInstallationID(identitySeed), accounts.CodexSessionID(identitySeed)
			thread := session
			if mode == "session" {
				thread = accounts.CodexThreadID(identitySeed, "isolated-conversation")
			}
			var metadata map[string]any
			if json.Unmarshal([]byte(headers.Get("X-Codex-Turn-Metadata")), &metadata) != nil || metadata["installation_id"] != installation || headers.Get("X-Codex-Installation-Id") != installation {
				t.Fatal("installation not converged", headers)
			}
			body := string(id.rewriteBody([]byte(`{"prompt_cache_key":"0123abcd","client_metadata":{"x-codex-installation-id":"client-installation","session_id":"client-session"}}`)))
			if !strings.Contains(body, installation) || strings.Contains(body, "client-installation") {
				t.Fatal("body installation not converged", body)
			}
			if mode == "device" {
				// Device mode leaves each member's own conversation identifiers alone.
				if headers.Get("Session_id") != "isolated-conversation" || headers.Get("X-Codex-Window-Id") != "client-window" {
					t.Fatal("device mode changed conversation identifiers", headers)
				}
				return
			}
			if headers.Get("Session_id") != session || headers.Get("Thread-Id") != thread || headers.Get("X-Client-Request-Id") != thread || headers.Get("X-Codex-Window-Id") != thread+":0" {
				t.Fatal("session identifiers not converged", headers)
			}
			if metadata["session_id"] != session || metadata["thread_id"] != thread || metadata["window_id"] != thread+":0" || metadata["turn_id"] == "" {
				t.Fatal("turn metadata not converged", metadata)
			}
			if !strings.Contains(body, `"prompt_cache_key":"`+session+`"`) || !strings.Contains(body, `"thread_id":"`+thread+`"`) {
				t.Fatal("body session identifiers not converged", body)
			}
		})
	}
}

func TestCodexOverloadInStreamBecomesRetryable(t *testing.T) {
	stream := func(events ...string) *http.Response {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(strings.Join(events, "")))}
	}
	created := "event: response.created\ndata: {\"type\":\"response.created\"}\n\n"
	for name, failure := range map[string]string{
		"error event":     "event: error\ndata: {\"type\":\"error\",\"code\":\"server_is_overloaded\"}\n\n",
		"failed response": "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"slow_down\"}}}\n\n",
	} {
		response, overloaded := detectCodexOverload(stream(created, failure))
		if !overloaded || response.StatusCode != http.StatusServiceUnavailable || response.Header.Get("Retry-After") == "" {
			t.Fatal(name, "not converted", response.StatusCode)
		}
	}
	original := created + "data: {\"type\":\"response.output_text.delta\",\"delta\":\"synthetic\"}\n\n" + "data: {\"type\":\"error\",\"code\":\"server_is_overloaded\"}\n\n"
	response, overloaded := detectCodexOverload(stream(original))
	raw, _ := io.ReadAll(response.Body)
	// Once real output started the stream belongs to the client and is replayed byte for byte.
	if overloaded || string(raw) != original {
		t.Fatal("generated stream altered", overloaded, string(raw))
	}
}

// ja3 computes the JA3 hash of a captured ClientHello, skipping GREASE values as JA3 does.
func ja3(hello *tls.ClientHelloInfo) string {
	grease := func(v uint16) bool { return v&0x0f0f == 0x0a0a && v>>8 == v&0xff }
	join := func(values []uint16) string {
		parts := []string{}
		for _, v := range values {
			if !grease(v) {
				parts = append(parts, fmt.Sprint(v))
			}
		}
		return strings.Join(parts, "-")
	}
	curves := make([]uint16, len(hello.SupportedCurves))
	for i, c := range hello.SupportedCurves {
		curves[i] = uint16(c)
	}
	points := make([]uint16, len(hello.SupportedPoints))
	for i, p := range hello.SupportedPoints {
		points[i] = uint16(p)
	}
	// Every modern client, Node included, sends legacy_version TLS 1.2 (771).
	sum := md5.Sum([]byte("771," + join(hello.CipherSuites) + "," + join(hello.Extensions) + "," + join(curves) + "," + join(points)))
	return hex.EncodeToString(sum[:])
}

// captureHello serves TLS locally and reports the first ClientHello it receives.
func captureHello(t *testing.T) (string, <-chan *tls.ClientHelloInfo) {
	t.Helper()
	hellos := make(chan *tls.ClientHelloInfo, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	server.TLS = &tls.Config{GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		select {
		case hellos <- hello:
		default:
		}
		return nil, nil
	}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server.Listener.Addr().String(), hellos
}

func TestClaudeTLSFingerprintMatchesClaudeCode(t *testing.T) {
	const claudeCodeJA3 = "44f88fca027f27bab4bb08d4af15f23e"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	direct, hellos := captureHello(t)
	// The test certificate is untrusted, so the handshake fails after the ClientHello was sent.
	if conn, err := dialFingerprinted(ctx, nil, direct); err == nil {
		conn.Close()
	}
	hello := <-hellos
	if got := ja3(hello); got != claudeCodeJA3 || len(hello.SupportedProtos) != 1 || hello.SupportedProtos[0] != "http/1.1" {
		t.Fatalf("direct JA3 %s, ALPN %v", got, hello.SupportedProtos)
	}

	// Through an HTTP proxy the handshake must still be ours, inside the CONNECT tunnel.
	target, tunneled := captureHello(t)
	proxy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	go func() {
		conn, err := proxy.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		request, err := http.ReadRequest(bufio.NewReader(conn))
		if err != nil || request.Method != http.MethodConnect || request.Host != target || request.Header.Get("Proxy-Authorization") == "" {
			io.WriteString(conn, "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
			return
		}
		upstream, err := net.Dial("tcp", target)
		if err != nil {
			return
		}
		defer upstream.Close()
		io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go io.Copy(upstream, conn)
		io.Copy(conn, upstream)
	}()
	exit, _ := url.Parse("http://synthetic-user:synthetic-pass@" + proxy.Addr().String())
	if conn, err := dialFingerprinted(ctx, exit, target); err == nil {
		conn.Close()
	}
	select {
	case hello := <-tunneled:
		if got := ja3(hello); got != claudeCodeJA3 {
			t.Fatalf("proxied JA3 %s", got)
		}
	case <-ctx.Done():
		t.Fatal("no ClientHello reached the target through the proxy")
	}
}
