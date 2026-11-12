package upstream

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"unicode"

	"github.com/murongg/SubLane/internal/accounts"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	exec "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

func channelExecutor(credential accounts.Credential) string {
	switch credential.APIConfig().Protocol {
	case "anthropic":
		return "claude"
	case "gemini":
		return "gemini"
	default:
		return "openai"
	}
}

func channelAuth(credential accounts.Credential) *core.Auth {
	provider, base := channelExecutor(credential), credential.BaseURL
	switch provider {
	case "claude":
		base = strings.TrimSuffix(base, "/v1")
	case "gemini":
		base = strings.TrimSuffix(base, "/v1beta")
	default:
		provider = "openai-compatibility"
	}
	return &core.Auth{ID: "openai:" + credential.AccountID, Provider: provider, Status: core.StatusActive, Attributes: map[string]string{"api_key": credential.AccessToken, "base_url": base}}
}

type channelTransport struct {
	base       http.RoundTripper
	credential accounts.Credential
	session    string
}

func (t *channelTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	base, err := url.Parse(t.credential.BaseURL)
	models, _ := url.Parse(channelModelsURL(t.credential))
	if err != nil || request.URL.Path != path.Clean(request.URL.Path) || request.URL.Scheme != base.Scheme || request.URL.Host != base.Host ||
		!strings.HasPrefix(request.URL.Path, base.Path+"/") && request.URL.Path != models.Path {
		return nil, ErrUpstream
	}
	request = request.Clone(request.Context())
	config := t.credential.APIConfig()
	request.Header.Del("Authorization")
	request.Header.Del("X-Api-Key")
	request.Header.Del("X-Goog-Api-Key")
	request.Header.Del("Api-Key")
	request.Header.Set("User-Agent", "SubLane")
	openCode := config.Platform == "opencode" || config.Platform == "opencode-go"
	switch {
	case config.Platform == "azure":
		request.Header.Set("Api-Key", t.credential.AccessToken)
	case openCode:
		request.Header.Set("Authorization", "Bearer "+t.credential.AccessToken)
		request.Header.Set("X-Opencode-Session", t.session)
	case config.Protocol == "anthropic":
		request.Header.Set("X-Api-Key", t.credential.AccessToken)
	case config.Protocol == "gemini":
		request.Header.Set("X-Goog-Api-Key", t.credential.AccessToken)
	default:
		request.Header.Set("Authorization", "Bearer "+t.credential.AccessToken)
	}
	if config.Protocol == "anthropic" {
		request.Header.Set("Anthropic-Version", "2023-06-01")
		query := request.URL.Query()
		query.Del("beta")
		request.URL.RawQuery = query.Encode()
	}
	return t.base.RoundTrip(request)
}

func channelSession(headers http.Header, body []byte) string {
	// Gateway Session_id is already scoped to the member and group. Prefer it over raw client identifiers.
	var payload struct {
		CacheKey string `json:"prompt_cache_key"`
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	_ = json.Unmarshal(body, &payload)
	for _, value := range []string{headers.Get("Session_id"), headers.Get("X-Opencode-Session"), payload.CacheKey, payload.Metadata.UserID} {
		if value != "" && len(value) <= 1024 && strings.IndexFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) < 0 {
			return value
		}
	}
	// Stateless calls and management probes must not share one upstream conversation.
	return rand.Text()
}

func (c *Client) executionTransport(credential accounts.Credential, headers http.Header, body []byte) *engineTransport {
	var base http.RoundTripper = &boundTransport{base: c.inference.Transport, address: credential.ProxyURL}
	if credential.Kind() == "openai" {
		base = &channelTransport{base: base, credential: credential, session: channelSession(headers, body)}
	}
	return &engineTransport{base: base, codexVersion: c.codexVersion(), codexPlatform: credential.ClientPlatform, grokVersion: c.currentGrokVersion(), provider: credential.Kind()}
}

// The pinned SDK's compatible executor always generates Chat Completions.
// Use its public authenticated HTTP seam and translators for channels that require Responses.
func (c *Client) channelResponses(ctx context.Context, executor core.ProviderExecutor, credential accounts.Credential, body []byte, opts exec.Options, transport *engineTransport) (*http.Response, error) {
	var model struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &model) != nil || model.Model == "" {
		return nil, ErrInput
	}
	// The SDK registers native-client Responses conversions under its Codex wire format.
	payload := c.registry.TranslateRequest(opts.SourceFormat, translator.FormatCodex, model.Model, body, opts.Stream)
	var input map[string]json.RawMessage
	if json.Unmarshal(payload, &input) != nil || input == nil {
		return nil, ErrInput
	}
	var original struct {
		MaxOutput  json.RawMessage `json:"max_output_tokens"`
		MaxTokens  json.RawMessage `json:"max_tokens"`
		Generation struct {
			MaxOutput json.RawMessage `json:"maxOutputTokens"`
		} `json:"generationConfig"`
	}
	if json.Unmarshal(body, &original) != nil {
		return nil, ErrInput
	}
	limit := original.MaxOutput
	switch opts.SourceFormat {
	case translator.FormatClaude:
		limit = original.MaxTokens
	case translator.FormatGemini:
		limit = original.Generation.MaxOutput
	}
	if len(limit) > 0 && string(limit) != "null" {
		var tokens int64
		if json.Unmarshal(limit, &tokens) != nil || tokens <= 0 {
			return nil, ErrInput
		}
		// The SDK's Codex conversion drops native limits; an API channel must retain the caller's ceiling.
		input["max_output_tokens"] = limit
	}
	input["stream"], _ = json.Marshal(opts.Stream)
	payload, err := json.Marshal(input)
	if err != nil {
		return nil, ErrInput
	}
	if int64(len(payload)) > c.MaxRequestBody() {
		return nil, ErrInput
	}
	operation, cancel := context.WithCancel(ctx)
	request, err := http.NewRequestWithContext(operation, http.MethodPost, credential.BaseURL+"/responses", bytes.NewReader(payload))
	if err != nil {
		cancel()
		return nil, ErrInput
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if opts.Stream {
		request.Header.Set("Accept", "text/event-stream")
	}
	response, err := executor.HttpRequest(operation, channelAuth(credential), request)
	if err != nil {
		cancel()
		logSDKFailure(ctx, "execute", err, transport)
		return sdkFailureResponse(err, transport)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		cancel()
		err := &UpstreamError{Status: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
		logSDKFailure(ctx, "execute", err, transport)
		return sdkFailureResponse(err, transport)
	}
	format := opts.ResponseFormat
	if format == "" {
		format = opts.SourceFormat
	}
	if format == translator.FormatOpenAIResponse {
		response.Body = &cancelBody{ReadCloser: response.Body, cancel: cancel}
		return response, nil
	}
	if !opts.Stream {
		defer cancel()
		defer response.Body.Close()
		raw, err := readBounded(response.Body, MaxBody)
		if err != nil {
			return nil, err
		}
		var state any
		var envelope struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope.Status != "completed" && envelope.Status != "incomplete" {
			return nil, ErrResponse
		}
		terminal, _ := json.Marshal(map[string]any{"type": "response." + envelope.Status, "response": json.RawMessage(raw)})
		result := c.registry.TranslateNonStream(operation, translator.FormatCodex, format, model.Model, body, payload, terminal, &state)
		if len(result) > MaxBody {
			return nil, ErrResponse
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(bytes.NewReader(result))}, nil
	}
	reader, writer := io.Pipe()
	go func() {
		defer cancel()
		defer response.Body.Close()
		defer writer.Close()
		var state any
		err := readEvents(response.Body, func(raw []byte) error {
			var event struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(raw, &event)
			for _, chunk := range c.registry.TranslateStream(operation, translator.FormatCodex, format, model.Model, body, payload, append([]byte("data: "), raw...), &state) {
				if len(chunk) > MaxBody {
					return ErrResponse
				}
				if format == translator.FormatGemini && event.Type == "response.completed" {
					// This SDK converter omits STOP; add it only after a validated upstream terminal event.
					var reply map[string]json.RawMessage
					var candidates []map[string]json.RawMessage
					if json.Unmarshal(chunk, &reply) != nil || json.Unmarshal(reply["candidates"], &candidates) != nil {
						return ErrResponse
					}
					for _, candidate := range candidates {
						if len(candidate["finishReason"]) == 0 {
							candidate["finishReason"] = json.RawMessage(`"STOP"`)
						}
					}
					reply["candidates"], _ = json.Marshal(candidates)
					chunk, _ = json.Marshal(reply)
				}
				if json.Valid(bytes.TrimSpace(chunk)) {
					chunk = append([]byte("data: "), chunk...)
				}
				if _, err := writer.Write(append(chunk, '\n', '\n')); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			writer.CloseWithError(err)
		}
	}()
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: &cancelBody{ReadCloser: reader, cancel: cancel}}, nil
}
