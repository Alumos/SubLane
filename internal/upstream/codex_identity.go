package upstream

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/murongg/SubLane/internal/accounts"
)

// codexIdentity is the client identity one Codex request presents upstream. It follows sub2api's
// proven rules: the agent, originator and version always come from SubLane's managed identity (see
// applyCodexVersion); identity headers real clients send are forwarded; and an account may opt in
// to converging installation, session and thread identifiers so several users look like one
// device. Every carrier of an identifier (headers, turn metadata, client_metadata and
// prompt_cache_key) is rewritten together, because mismatches between them are themselves a signal.
type codexIdentity struct {
	headers http.Header
	fields  map[string]any
	// session is the outgoing session ID that prompt_cache_key and client_metadata must match.
	session string
	mode    string
	ids     map[string]string
}

// Identity headers Codex sends on Responses requests; everything else from the client is dropped.
var codexIdentityHeaders = []string{"X-Codex-Installation-Id", "X-Codex-Window-Id", "X-Codex-Turn-State", "X-Codex-Turn-Metadata", "X-Client-Request-Id", "X-Codex-Beta-Features", "Session_id"}

func newCodexIdentity(credential accounts.Credential, client http.Header) *codexIdentity {
	id := &codexIdentity{headers: make(http.Header), fields: map[string]any{}, ids: map[string]string{}, mode: credential.Identity.Mode}
	for _, key := range codexIdentityHeaders {
		if value := client.Get(key); value != "" && len(value) <= 4096 {
			id.headers.Set(key, value)
		}
	}
	// The gateway already replaced the client's session with one isolated per member conversation.
	conversation := id.headers.Get("Session_id")
	seed := credential.Identity.Seed
	if id.mode != "off" && id.mode != "" && seed != "" {
		installation := accounts.CodexInstallationID(seed)
		id.headers.Set("X-Codex-Installation-Id", installation)
		id.fields["installation_id"], id.ids["x-codex-installation-id"] = installation, installation
		if id.mode == "session" || id.mode == "full" {
			session := accounts.CodexSessionID(seed)
			// Session mode keeps one thread per real conversation, like a user running several
			// windows or subagents; full mode collapses everything into one thread.
			thread := session
			if id.mode == "session" && conversation != "" {
				thread = accounts.CodexThreadID(seed, conversation)
			}
			window, turn := thread+":0", randomUUID()
			id.headers.Set("X-Codex-Window-Id", window)
			id.headers.Set("X-Client-Request-Id", thread)
			id.headers.Set("Thread-Id", thread)
			conversation = session
			id.fields["thread_id"], id.fields["turn_id"], id.fields["window_id"] = thread, turn, window
			id.fields["turn_started_at_unix_ms"] = time.Now().UnixMilli()
			id.ids["thread_id"], id.ids["turn_id"], id.ids["x-codex-window-id"] = thread, turn, window
		}
	}
	if conversation != "" {
		id.headers.Set("Session_id", conversation)
		id.fields["session_id"], id.ids["session_id"], id.session = conversation, conversation, conversation
	}
	if raw := id.headers.Get("X-Codex-Turn-Metadata"); raw != "" {
		if rebuilt, ok := rewriteTurnMetadata(raw, id.fields); ok {
			id.headers.Set("X-Codex-Turn-Metadata", rebuilt)
		} else {
			id.headers.Del("X-Codex-Turn-Metadata")
		}
	}
	return id
}

// apply replaces every case variant of each identity header, so SDK-set values cannot duplicate them.
func (id *codexIdentity) apply(h http.Header) {
	if id == nil {
		return
	}
	for key, values := range id.headers {
		for existing := range h {
			if strings.EqualFold(existing, key) || key == "Session_id" && strings.EqualFold(existing, "Session-Id") || key == "Thread-Id" && strings.EqualFold(existing, "Thread_id") {
				delete(h, existing)
			}
		}
		h[key] = []string{values[0]}
	}
}

// rewriteBody keeps the body's identifiers in step with the outgoing headers.
func (id *codexIdentity) rewriteBody(body []byte) []byte {
	if id == nil || len(body) == 0 {
		return body
	}
	var input map[string]json.RawMessage
	if json.Unmarshal(body, &input) != nil || input == nil {
		return body
	}
	changed := false
	// Native Codex sends its session ID as prompt_cache_key.
	if id.session != "" && len(input["prompt_cache_key"]) > 0 {
		input["prompt_cache_key"], _ = json.Marshal(id.session)
		changed = true
	}
	var metadata map[string]any
	if raw := input["client_metadata"]; len(raw) > 0 && json.Unmarshal(raw, &metadata) == nil && metadata != nil {
		for key, value := range id.ids {
			metadata[key] = value
		}
		if embedded, ok := metadata["x-codex-turn-metadata"].(string); ok {
			if rebuilt, ok := rewriteTurnMetadata(embedded, id.fields); ok {
				metadata["x-codex-turn-metadata"] = rebuilt
			}
		}
		input["client_metadata"], _ = json.Marshal(metadata)
		changed = true
	}
	if !changed {
		return body
	}
	rewritten, err := json.Marshal(input)
	if err != nil {
		return body
	}
	return rewritten
}

// rewriteTurnMetadata overwrites identifier fields of Codex turn metadata. Codex also carries it as
// an HTTP header, so the result escapes non-ASCII as JSON \u sequences.
func rewriteTurnMetadata(raw string, fields map[string]any) (string, bool) {
	var metadata map[string]any
	if json.Unmarshal([]byte(raw), &metadata) != nil || metadata == nil {
		return "", false
	}
	for key, value := range fields {
		metadata[key] = value
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return "", false
	}
	var out strings.Builder
	for _, r := range string(encoded) {
		switch {
		case r < 0x7f:
			out.WriteRune(r)
		case r <= 0xffff:
			fmt.Fprintf(&out, `\u%04x`, r)
		default:
			high, low := utf16.EncodeRune(r)
			fmt.Fprintf(&out, `\u%04x\u%04x`, high, low)
		}
	}
	return out.String(), true
}

func randomUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// When capacity is short, the Codex backend sheds load by client identity: it answers HTTP 200 and
// the stream's first real event reports server_is_overloaded (or slow_down). Nothing has reached the
// client yet, so the response becomes a retryable 503 that the gateway retries and fails over.
const overloadPeekLimit = 64 << 10

var codexOverloadCodes = map[string]bool{"server_is_overloaded": true, "slow_down": true}

func detectCodexOverload(response *http.Response) (*http.Response, bool) {
	reader := bufio.NewReaderSize(response.Body, 4096)
	var seen bytes.Buffer
	for seen.Len() < overloadPeekLimit {
		line, err := reader.ReadBytes('\n')
		seen.Write(line)
		if data, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:")); ok {
			var event struct {
				Type  string `json:"type"`
				Code  string `json:"code"`
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
				Response struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				} `json:"response"`
			}
			if json.Unmarshal(bytes.TrimSpace(data), &event) == nil {
				switch event.Type {
				case "response.created", "response.in_progress":
					// Handshake events carry nothing the client needs before the first real event.
				case "error", "response.failed":
					if codexOverloadCodes[event.Code] || codexOverloadCodes[event.Error.Code] || codexOverloadCodes[event.Response.Error.Code] {
						response.Body.Close()
						return &http.Response{StatusCode: http.StatusServiceUnavailable, Status: "503 Service Unavailable", Header: http.Header{"Retry-After": {"1"}, "Content-Type": {"application/json"}},
							Body: io.NopCloser(strings.NewReader(`{"error":{"code":"server_is_overloaded"}}`)), Request: response.Request}, true
					}
					return replayBody(response, &seen, reader), false
				default:
					return replayBody(response, &seen, reader), false
				}
			}
		}
		if err != nil {
			break
		}
	}
	return replayBody(response, &seen, reader), false
}

func replayBody(response *http.Response, seen *bytes.Buffer, rest io.Reader) *http.Response {
	response.Body = &replayedBody{Reader: io.MultiReader(bytes.NewReader(seen.Bytes()), rest), Closer: response.Body}
	return response
}

type replayedBody struct {
	io.Reader
	io.Closer
}
