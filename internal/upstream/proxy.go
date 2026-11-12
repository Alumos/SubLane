package upstream

import (
	"context"
	"net/http"
	"net/url"
	"sync"

	"github.com/murongg/SubLane/internal/accounts"
)

type proxyContextKey struct{}

// WithProxyURL selects an already validated, workspace-owned proxy for an OAuth exchange.
func WithProxyURL(ctx context.Context, address string) context.Context {
	if address == "" {
		return ctx
	}
	return context.WithValue(ctx, proxyContextKey{}, address)
}

type tlsFingerprintKey struct{}

// usesTLSFingerprint reports whether the account opted in to Claude Code's TLS handshake.
func usesTLSFingerprint(credential accounts.Credential) bool {
	return credential.Kind() == "claude" && credential.Identity.TLS
}

func credentialContext(ctx context.Context, credential accounts.Credential) context.Context {
	if usesTLSFingerprint(credential) {
		ctx = context.WithValue(ctx, tlsFingerprintKey{}, true)
	}
	return WithProxyURL(ctx, credential.ProxyURL)
}

// Some SDK paths create a fresh request context. The per-call transport keeps
// the account's selected exit and TLS identity even when the SDK does not preserve context values.
type boundTransport struct {
	base        http.RoundTripper
	address     string
	fingerprint bool
}

func (t *boundTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if t.address == "" && !t.fingerprint {
		return t.base.RoundTrip(request)
	}
	ctx := WithProxyURL(request.Context(), t.address)
	if t.fingerprint {
		ctx = context.WithValue(ctx, tlsFingerprintKey{}, true)
	}
	return t.base.RoundTrip(request.Clone(ctx))
}

// proxyTransport keeps a separate connection pool per proxy. A request takes one
// snapshot of the binding; an in-flight stream is never moved or replayed.
type proxyTransport struct {
	base   http.RoundTripper
	mu     sync.Mutex
	routes map[string]*http.Transport
	order  []string
}

func (t *proxyTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	address, _ := request.Context().Value(proxyContextKey{}).(string)
	fingerprint, _ := request.Context().Value(tlsFingerprintKey{}).(bool)
	base, real := t.base.(*http.Transport)
	// Only HTTPS through a real transport can carry a custom handshake; synthetic test transports
	// and plain HTTP keep the ordinary route.
	fingerprint = fingerprint && real && request.URL.Scheme == "https"
	if address == "" && !fingerprint {
		return t.base.RoundTrip(request)
	}
	var u *url.URL
	if address != "" {
		var err error
		u, err = url.Parse(address)
		if err != nil || u == nil || u.Host == "" {
			return nil, ErrUpstream
		}
	}
	key := address
	if fingerprint {
		key = "tls|" + address
	}
	t.mu.Lock()
	if t.routes == nil {
		t.routes = make(map[string]*http.Transport)
	}
	transport := t.routes[key]
	if transport == nil {
		// Proxy edits can introduce new addresses indefinitely; retire the oldest
		// idle pool without disturbing requests already using its transport.
		if len(t.order) == 64 {
			oldest := t.order[0]
			t.order = t.order[1:]
			t.routes[oldest].CloseIdleConnections()
			delete(t.routes, oldest)
		}
		if !real {
			base = http.DefaultTransport.(*http.Transport)
		}
		if fingerprint {
			transport = fingerprintTransport(base, u)
		} else {
			transport = base.Clone()
			transport.Proxy = http.ProxyURL(u)
		}
		t.routes[key] = transport
		t.order = append(t.order, key)
	}
	t.mu.Unlock()
	return transport.RoundTrip(request)
}

func (t *proxyTransport) CloseIdleConnections() {
	if base, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		base.CloseIdleConnections()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, transport := range t.routes {
		transport.CloseIdleConnections()
	}
}
