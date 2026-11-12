package upstream

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/murongg/SubLane/internal/accounts"
	sdkapi "github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	exec "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/sirupsen/logrus"
)

type sdkRuntime struct {
	manager              *core.Manager
	address              string
	cancel               context.CancelFunc
	done                 chan error
	dir                  string
	claudeCachedVersion  string
	claudeCachedExecutor core.ProviderExecutor
}

// The manager is only an executor registry. Credentials remain in SubLane's encrypted store.
type emptyStore struct{}

func (emptyStore) List(context.Context) ([]*core.Auth, error) { return []*core.Auth{}, nil }
func (emptyStore) Save(context.Context, *core.Auth) (string, error) {
	return "", errors.New("SDK credential writes are not permitted")
}
func (emptyStore) Delete(context.Context, string) error {
	return errors.New("SDK credential writes are not permitted")
}

func (c *Client) Start(parent context.Context) error {
	c.lifecycleMu.Lock()
	defer c.lifecycleMu.Unlock()
	if c.closed {
		return ErrUpstream
	}
	c.engineOnce.Do(func() { c.runtime, c.engineErr = c.startEngine(parent) })
	return c.engineErr
}
func (c *Client) startEngine(parent context.Context, claudeVersions ...string) (*sdkRuntime, error) {
	dir, err := os.MkdirTemp("", "sublane-engine-")
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*sdkRuntime, error) { os.RemoveAll(dir); return nil, err }
	cfgPath := filepath.Join(dir, "config.yaml")
	if err = os.WriteFile(cfgPath, []byte("host: 127.0.0.1\n"), 0600); err != nil {
		return fail(err)
	}
	gin.SetMode(gin.ReleaseMode)
	// Provider errors can contain tokens or upstream body fragments; SubLane reports its own sanitized errors.
	logrus.SetLevel(logrus.PanicLevel)
	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fail(err)
	}
	address := reservation.Addr().String()
	port := reservation.Addr().(*net.TCPAddr).Port
	reservation.Close()
	cfg := &sdkconfig.Config{Host: "127.0.0.1", Port: port, AuthDir: dir, RemoteManagement: sdkconfig.RemoteManagement{DisableControlPanel: true, DisableAutoUpdatePanel: true}}
	claudeVersion := DefaultClaudeVersion
	if len(claudeVersions) != 0 {
		claudeVersion = claudeVersions[0]
	}
	cfg.ClaudeHeaderDefaults.UserAgent = claudeUserAgent(claudeVersion)
	// Pin each Claude account to one device profile (User-Agent and X-Stainless OS, arch, runtime and
	// package versions), as CLIProxyAPI does, so clients on different machines sharing an account
	// present a single fingerprint. Profiles are keyed by the stable execution Auth ID.
	stabilize := true
	cfg.ClaudeHeaderDefaults.StabilizeDeviceProfile = &stabilize
	// Preserve caller tool definitions; do not inject an image tool into every coding request.
	if err := json.Unmarshal([]byte(`"passthrough"`), &cfg.DisableImageGeneration); err != nil {
		return fail(err)
	}
	key := make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return fail(err)
	}
	cfg.APIKeys = []string{hex.EncodeToString(key)}
	manager := core.NewManager(emptyStore{}, nil, nil)
	ready := make(chan struct{})
	listening := make(chan struct{})
	var listeningOnce sync.Once
	svc, err := cliproxy.NewBuilder().WithConfig(cfg).WithConfigPath(cfgPath).WithCoreAuthManager(manager).
		WithWatcherFactory(func(string, string, func(*sdkconfig.Config)) (*cliproxy.WatcherWrapper, error) {
			return &cliproxy.WatcherWrapper{}, nil
		}).
		WithServerOptions(sdkapi.WithMiddleware(func(g *gin.Context) {
			if g.GetHeader("X-SubLane-Probe") == cfg.APIKeys[0] {
				listeningOnce.Do(func() { close(listening) })
			}
			g.AbortWithStatus(http.StatusNotFound)
		})).
		WithHooks(cliproxy.Hooks{OnAfterStart: func(*cliproxy.Service) { manager.StopAutoRefresh(); close(ready) }}).Build()
	if err != nil {
		return fail(err)
	}
	// The SDK's startup hook does not guarantee listener readiness. Complete an
	// in-process handler handshake before cancellation may trigger SDK shutdown.
	ctx, cancel := context.WithCancel(context.WithoutCancel(parent))
	rt := &sdkRuntime{manager: manager, address: address, cancel: cancel, done: make(chan error, 1), dir: dir}
	go func() { err := svc.Run(ctx); os.RemoveAll(dir); rt.done <- err; close(rt.done) }()

	probeCtx, stopProbe := context.WithTimeout(context.Background(), 10*time.Second)
	defer stopProbe()
	go func() {
		transport := &http.Transport{Proxy: nil}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, Timeout: time.Second}
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			req, _ := http.NewRequestWithContext(probeCtx, "GET", "http://"+address+"/", nil)
			req.Header.Set("X-SubLane-Probe", cfg.APIKeys[0])
			response, err := client.Do(req)
			if err == nil {
				response.Body.Close()
			}
			select {
			case <-listening:
				return
			case <-probeCtx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	select {
	case <-ready:
	case err := <-rt.done:
		cancel()
		if err == nil {
			err = ErrUpstream
		}
		return nil, err
	}
	select {
	case <-listening:
		context.AfterFunc(parent, cancel)
		if err := parent.Err(); err != nil {
			cancel()
			<-rt.done
			return nil, err
		}
		return rt, nil
	case err := <-rt.done:
		cancel()
		if err == nil {
			err = ErrUpstream
		}
		return nil, err
	case <-probeCtx.Done():
		cancel()
		return nil, errors.New("SDK initialization timeout")
	}

}
func (c *Client) executor(provider string) (core.ProviderExecutor, error) {
	if !accounts.ValidProvider(provider) && provider != "gemini" {
		return nil, ErrInput
	}
	if provider == "openai" {
		provider = "openai-compatibility"
	}
	if err := c.Start(context.Background()); err != nil {
		return nil, err
	}
	c.lifecycleMu.Lock()
	defer c.lifecycleMu.Unlock()
	if c.closed {
		return nil, ErrUpstream
	}
	executor, ok := c.runtime.manager.Executor(provider)
	if !ok {
		return nil, ErrUpstream
	}
	return executor, nil
}
func sdkAuth(c accounts.Credential) *core.Auth {
	if c.Kind() == "openai" {
		// The shared SDK executor receives only this account's ephemeral key and endpoint; its store stays empty.
		return channelAuth(c)
	}
	metadata := map[string]any{}
	for key, value := range c.Metadata {
		var v any
		if json.Unmarshal(value, &v) == nil {
			metadata[key] = v
		}
	}
	if c.Kind() == "xai" {
		// Without this marker the SDK routes the same token to metered API billing.
		metadata["auth_kind"] = "oauth"
	}
	if c.Kind() == "antigravity" {
		// SubLane owns durable, lifecycle-aware cooldowns. SDK-local timers can
		// turn a model-specific response into an unscoped 429 before transport IO.
		metadata["disable_cooling"] = true
	}
	metadata["access_token"] = c.AccessToken
	// Execution must never rotate credentials outside the accounts service’s durable write path.
	delete(metadata, "refresh_token")
	metadata["id_token"] = c.IDToken
	metadata["account_id"] = c.AccountID
	metadata["email"] = c.Email
	metadata["expired"] = time.Unix(c.ExpiresAt, 0).UTC().Format(time.RFC3339)
	return &core.Auth{ID: c.Kind() + ":" + c.AccountID, Provider: c.Kind(), Status: core.StatusActive, Metadata: metadata}
}
func (c *Client) sdkContext(ctx context.Context, credential accounts.Credential) context.Context {
	// This is the public SDK's documented per-request transport hook; it also provides a synthetic test seam.
	return context.WithValue(ctx, "cliproxy.roundtripper", c.executionTransport(credential, nil, nil))
}
func sdkError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return context.DeadlineExceeded
	}
	var rejected *UpstreamError
	if errors.As(err, &rejected) {
		return rejected
	}
	if errors.Is(err, ErrInterrupted) {
		return ErrInterrupted
	}
	if errors.Is(err, ErrResponse) {
		return ErrResponse
	}
	var status exec.StatusError
	if errors.As(err, &status) {
		result := &UpstreamError{Status: status.StatusCode()}
		var timed interface{ RetryAfter() *time.Duration }
		if errors.As(err, &timed) {
			if wait := timed.RetryAfter(); wait != nil {
				result.RetryAfter = strconv.Itoa(int(math.Ceil(wait.Seconds())))
			}
		}
		return result
	}
	return ErrUpstream
}
func (c *Client) runSDK(ctx context.Context, credential accounts.Credential, body []byte, headers http.Header, opts exec.Options) (*http.Response, error) {
	ctx = credentialContext(ctx, credential)
	// Check before protocol dispatch so a Responses channel cannot turn compaction into generation.
	if opts.Alt == "responses/compact" && credential.Kind() != "codex" {
		return nil, ErrInput
	}
	provider := credential.Kind()
	if provider == "openai" {
		provider = channelExecutor(credential)
	}
	executor, err := c.executor(provider)
	if err != nil {
		return nil, err
	}
	if credential.Kind() == "openai" {
		if scoped, ok := executor.(core.APIKeyConfigExecutor); ok {
			executor = scoped.ForAPIKey()
		}
	}
	if credential.Kind() == "claude" {
		executor, err = c.versionedClaudeExecutor(ctx, c.currentClaudeVersion())
		if err != nil {
			return nil, err
		}
		body, opts, err = c.prepareClaude(body, opts)
		if err != nil {
			return nil, err
		}
	}
	version := c.codexVersion()
	transport := c.executionTransport(credential, headers, body)
	transport.validateGeminiStream = credential.Kind() == "antigravity" && (opts.SourceFormat == translator.FormatClaude || opts.SourceFormat == translator.FormatGemini)
	if !opts.Stream {
		transport.maxResponseBytes = MaxBody
	}
	ctx = context.WithValue(ctx, "cliproxy.roundtripper", transport)
	if credential.Kind() == "openai" && credential.APIConfig().Protocol == "responses" {
		return c.channelResponses(ctx, executor, credential, body, opts, transport)
	}
	auth := sdkAuth(credential)
	if credential.Kind() == "codex" {
		auth.Attributes = map[string]string{"base_url": c.baseURL}
	}
	var request struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &request) != nil {
		return nil, ErrInput
	}
	transport.requestedModel = CatalogModelID(request.Model)
	if opts.SourceFormat == translator.FormatGemini {
		var native map[string]json.RawMessage
		if json.Unmarshal(body, &native) != nil || native == nil {
			return nil, ErrInput
		}
		delete(native, "model")
		delete(native, "stream")
		body, err = json.Marshal(native)
		if err != nil {
			return nil, ErrInput
		}
	}
	clean := make(http.Header)
	for _, key := range []string{"Version", "X-Codex-Turn-Metadata", "X-Client-Request-Id", "Session_id", "X-Codex-Beta-Features", "Anthropic-Version", "Anthropic-Beta"} {
		if value := headers.Get(key); len(value) > 0 && len(value) <= 1024 {
			clean.Set(key, value)
		}
	}
	if credential.Kind() == "codex" {
		clean.Set("Version", version)
	}
	opts.Headers, opts.OriginalRequest = clean, body
	req := exec.Request{Model: request.Model, Payload: body}
	if !opts.Stream {
		result, err := executor.Execute(ctx, auth, req, opts)
		if err != nil {
			logSDKFailure(ctx, "execute", err, transport)
			return sdkFailureResponse(err, transport)
		}
		if len(result.Payload) > MaxBody {
			return nil, ErrResponse
		}
		return &http.Response{StatusCode: 200, Header: result.Headers, Body: io.NopCloser(bytes.NewReader(result.Payload))}, nil
	}
	operation, cancel := context.WithCancel(ctx)
	result, err := executor.ExecuteStream(operation, auth, req, opts)
	if err != nil {
		cancel()
		logSDKFailure(ctx, "execute", err, transport)
		return sdkFailureResponse(err, transport)
	}
	reader, writer := io.Pipe()
	go func() {
		defer writer.Close()
		defer cancel()
		for chunk := range result.Chunks {
			if chunk.Err != nil {
				logSDKFailure(ctx, "stream", chunk.Err, transport)
				writer.CloseWithError(sdkError(chunk.Err))
				return
			}
			if len(chunk.Payload) > MaxBody {
				writer.CloseWithError(ErrResponse)
				return
			}
			payload := bytes.TrimSpace(chunk.Payload)
			if json.Valid(payload) {
				payload = append([]byte("data: "), payload...)
			}
			if _, err := writer.Write(payload); err != nil {
				return
			}
			if _, err := writer.Write([]byte("\n\n")); err != nil {
				return
			}
		}
	}()
	return &http.Response{StatusCode: 200, Header: result.Headers, Body: &cancelBody{ReadCloser: reader, cancel: cancel}}, nil
}

func sdkFailureResponse(err error, transport *engineTransport) (*http.Response, error) {
	if failure, ok := sdkError(err).(*UpstreamError); ok {
		headers := make(http.Header)
		wait := transport.retry()
		if wait == "" {
			wait = failure.RetryAfter
		}
		headers.Set("Retry-After", wait)
		if model := transport.limitedModel(failure.Status); model != "" {
			failure.LimitedModel, failure.RetryAfter = model, wait
			return nil, failure
		}
		return &http.Response{StatusCode: failure.Status, Header: headers, Body: io.NopCloser(bytes.NewReader(nil))}, nil
	}
	return nil, sdkError(err)
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelBody) Close() error { b.cancel(); return b.ReadCloser.Close() }

// The SDK may discard Retry-After when converting HTTP failures to errors. Keep the header at the transport boundary.
type engineTransport struct {
	validateGeminiStream bool
	maxResponseBytes     int64
	codexVersion         string
	codexPlatform        string
	claudeProfile        accounts.ClientProfile
	grokVersion          string
	base                 http.RoundTripper
	mu                   sync.Mutex
	retryAfter           string
	provider             string
	requestedModel       string
	rateModel            string
	lastStatus           int
	lastRequestID        string
	failureKind          string
	responseEpoch        uint64
}

func (t *engineTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if t.codexVersion != "" && r.URL.Host == "chatgpt.com" && strings.HasPrefix(r.URL.Path, "/backend-api/codex/") {
		// Clone before overriding SDK headers; unrelated providers and shared request objects remain untouched.
		r = r.Clone(r.Context())
		applyCodexVersion(r.Header, t.codexVersion, t.codexPlatform)
	}
	if t.provider == "claude" && r.URL.Host == "api.anthropic.com" {
		// The account's own platform replaces the SDK's shared baseline; empty fields keep it.
		r = applyClaudeProfile(r, t.claudeProfile)
	}
	if t.grokVersion != "" && r.URL.Host == "cli-chat-proxy.grok.com" && strings.HasPrefix(r.URL.Path, "/v1/") {
		// Apply the durable policy after the pinned SDK's obsolete headers, without mutating its request.
		r = r.Clone(r.Context())
		applyGrokVersion(r.Header, t.grokVersion)
	}
	response, err := t.roundTripConnect(r)
	if err != nil {
		t.mu.Lock()
		t.lastStatus, t.lastRequestID = 0, ""
		t.failureKind = diagnosticErrorKind(err)
		t.mu.Unlock()
		return nil, err
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		response.Body.Close()
		return nil, ErrUpstream
	}
	t.mu.Lock()
	t.responseEpoch++
	epoch := t.responseEpoch
	t.lastStatus, t.rateModel = response.StatusCode, ""
	t.failureKind, t.lastRequestID = "", ""
	for _, header := range []string{"X-Request-ID", "Request-ID"} {
		if id := response.Header.Get(header); diagnosticRequestID.MatchString(id) {
			t.lastRequestID = id
			break
		}
	}
	if response.StatusCode >= 400 {
		t.retryAfter = response.Header.Get("Retry-After")
	}
	t.mu.Unlock()
	limit := t.maxResponseBytes
	if limit == 0 && response.StatusCode >= 400 {
		limit = MaxBody
	}
	if limit > 0 {
		response.Body = &responseLimitBody{ReadCloser: response.Body, remaining: limit}
	}
	if response.StatusCode == http.StatusTooManyRequests && t.provider == "antigravity" {
		response.Body = &limitMetadataBody{ReadCloser: response.Body, complete: func(raw []byte) {
			model := antigravityLimitedModel(raw, t.requestedModel)
			t.mu.Lock()
			defer t.mu.Unlock()
			// SDK fallback can leave an older response body open. Only the last
			// fully observed attempt may narrow the final error's scope.
			if t.responseEpoch == epoch {
				t.rateModel = model
			}
		}}
	}
	if t.validateGeminiStream && response.StatusCode >= 200 && response.StatusCode < 300 && strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		response.Body = guardGeminiStream(response.Body)
	}
	return response, nil
}

func (t *engineTransport) limitedModel(status int) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if status == http.StatusTooManyRequests && t.lastStatus == status {
		return t.rateModel
	}
	return ""
}

type responseLimitBody struct {
	io.ReadCloser
	remaining int64
}

func (b *responseLimitBody) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if b.remaining == 0 {
		var probe [1]byte
		n, err := b.ReadCloser.Read(probe[:])
		if n > 0 {
			return 0, ErrResponse
		}
		return 0, err
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.ReadCloser.Read(p)
	b.remaining -= int64(n)
	return n, err
}
func (t *engineTransport) retry() string { t.mu.Lock(); defer t.mu.Unlock(); return t.retryAfter }

func (c *Client) Close() {
	c.lifecycleMu.Lock()
	if c.closed {
		c.lifecycleMu.Unlock()
		return
	}
	c.closed = true
	runtime := c.runtime
	c.lifecycleMu.Unlock()
	if runtime != nil {
		runtime.cancel()
		select {
		case <-runtime.done:
		case <-time.After(5 * time.Second):
		}
	}
	c.http.CloseIdleConnections()
	c.inference.CloseIdleConnections()
}

// Connection-phase failures (DNS, TCP dial, proxy CONNECT) happen before any request byte reaches the
// provider, so replaying them cannot duplicate work or billing. Anything later is never replayed.
var connectRetryDelays = []time.Duration{250 * time.Millisecond, time.Second}

func connectFailure(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && (op.Op == "dial" || op.Op == "proxyconnect")
}

func (t *engineTransport) roundTripConnect(r *http.Request) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		request := r
		if attempt > 0 {
			request = r.Clone(r.Context())
			if r.Body != nil && r.Body != http.NoBody {
				body, err := r.GetBody()
				if err != nil {
					return nil, err
				}
				request.Body = body
			}
		}
		response, err := t.base.RoundTrip(request)
		if err == nil || !connectFailure(err) || attempt >= len(connectRetryDelays) || r.Body != nil && r.Body != http.NoBody && r.GetBody == nil {
			return response, err
		}
		timer := time.NewTimer(connectRetryDelays[attempt])
		select {
		case <-r.Context().Done():
			timer.Stop()
			return nil, err
		case <-timer.C:
		}
	}
}

func applyClaudeProfile(r *http.Request, profile accounts.ClientProfile) *http.Request {
	values := [][2]string{{"X-Stainless-Os", profile.OS}, {"X-Stainless-Arch", profile.Arch}, {"X-Stainless-Runtime-Version", profile.RuntimeVersion}, {"X-Stainless-Package-Version", profile.PackageVersion}}
	cloned := false
	for _, value := range values {
		if value[1] == "" {
			continue
		}
		if !cloned {
			r, cloned = r.Clone(r.Context()), true
		}
		r.Header.Set(value[0], value[1])
	}
	return r
}
