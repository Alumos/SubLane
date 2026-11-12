package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/murongg/SubLane/internal/accounts"
	"github.com/murongg/SubLane/internal/gateway"
	"github.com/murongg/SubLane/internal/oauth"
	"github.com/murongg/SubLane/internal/resets"
	"github.com/murongg/SubLane/internal/upstream"
)

type accountHTTP struct {
	service  *accounts.Service
	oauth    *oauth.Flow
	gateway  *gateway.Service
	resets   *resets.Service
	tenantID int64
}

func (h *accountHTTP) register(router chi.Router) {
	routeErrors(router)
	router.Group(func(accounts chi.Router) {
		accounts.Use(h.available)
		accounts.Get("/", h.list)
		accounts.Get("/runtime", h.runtime)
		accounts.Patch("/{id}/limits", h.limits)
		accounts.Put("/{id}/proxy", h.bindProxy)
		accounts.Get("/{id}/fingerprint", h.fingerprint)
		accounts.Put("/{id}/fingerprint", h.setFingerprint)
		accounts.Delete("/{id}/fingerprint", h.resetFingerprint)
		accounts.Post("/{id}/resume", h.resume)
		accounts.Post("/import", h.importCredential)
		accounts.Post("/api-key", h.saveAPIKey)
		accounts.Post("/oauth", h.beginOAuth)
		accounts.Post("/oauth/complete", h.finishOAuth)
		accounts.Post("/oauth/poll", h.pollOAuth)
		accounts.Delete("/oauth/{state}", h.cancelOAuth)
		accounts.Patch("/{id}", h.setEnabled)
		accounts.Delete("/{id}", h.remove)
		accounts.Post("/{id}/check", h.check)
		accounts.Get("/{id}/models", h.catalog)
		accounts.Post("/{id}/models/refresh", h.refreshCatalog)
		accounts.Post("/{id}/models/check", h.checkModel)
		accounts.Get("/{id}/usage", h.usage)
		accounts.Post("/{id}/usage/refresh", h.refreshUsage)
		accounts.Get("/{id}/resets", h.resetState)
		accounts.Get("/{id}/resets/cards", h.resetCards)
		accounts.Put("/{id}/resets", h.resetSettings)
		accounts.Post("/{id}/resets/consume", h.consumeReset)
		accounts.Post("/{id}/resets/retry", h.retryReset)
	})
}

func (h *accountHTTP) available(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.service == nil {
			writeJSON(w, 503, map[string]string{"error": "unavailable"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *accountHTTP) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.service.List(r.Context())
	if err != nil {
		accountError(w, err)
		return
	}
	subscriptions := make([]accounts.Account, 0, len(rows))
	for _, row := range rows {
		if accounts.SubscriptionProvider(row.Provider) {
			subscriptions = append(subscriptions, row)
		}
	}
	writeJSON(w, 200, map[string]any{"accounts": subscriptions})
}

func (h *accountHTTP) importCredential(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name      string `json:"name"`
		Provider  string `json:"provider"`
		AuthJSON  string `json:"auth_json"`
		ReplaceID string `json:"replace_id"`
		ProxyID   string `json:"proxy_id"`
	}
	if !decodeJSONLimit(w, r, &input, 128<<10) {
		return
	}
	account, err := h.service.ImportProviderWithProxy(r.Context(), input.Provider, input.Name, []byte(input.AuthJSON), input.ReplaceID, input.ProxyID)
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 201, account)
	if h.gateway != nil {
		_, _ = h.gateway.AccountCatalog(r.Context(), account.ID, false)
	}
}

func (h *accountHTTP) saveAPIKey(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name      string `json:"name"`
		APIKey    string `json:"api_key"`
		BaseURL   string `json:"base_url"`
		ReplaceID string `json:"replace_id"`
		ProxyID   string `json:"proxy_id"`
	}
	if !decodeJSONLimit(w, r, &input, 32<<10) {
		return
	}
	raw, err := json.Marshal(map[string]string{"api_key": input.APIKey, "base_url": input.BaseURL})
	if err != nil {
		accountError(w, accounts.ErrInput)
		return
	}
	account, err := h.service.ImportProviderWithProxy(r.Context(), "openai", input.Name, raw, input.ReplaceID, input.ProxyID)
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 201, account)
	if h.gateway != nil {
		_, _ = h.gateway.AccountCatalog(r.Context(), account.ID, false)
	}
}

func (h *accountHTTP) beginOAuth(w http.ResponseWriter, r *http.Request) {
	if h.oauth == nil {
		writeJSON(w, 503, map[string]string{"error": "unavailable"})
		return
	}
	var input struct {
		Name      string `json:"name"`
		Provider  string `json:"provider"`
		ReplaceID string `json:"replace_id"`
		ProxyID   string `json:"proxy_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	pending, err := h.oauth.BeginProviderWithProxy(r.Context(), input.Provider, token(r), input.Name, input.ReplaceID, input.ProxyID)
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 201, pending)
}

func (h *accountHTTP) finishOAuth(w http.ResponseWriter, r *http.Request) {
	if h.oauth == nil {
		writeJSON(w, 503, map[string]string{"error": "unavailable"})
		return
	}
	var input struct {
		State       string `json:"state"`
		CallbackURL string `json:"callback_url"`
	}
	if !decodeJSONLimit(w, r, &input, 16<<10) {
		return
	}
	account, err := h.oauth.Finish(r.Context(), token(r), input.State, input.CallbackURL)
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 201, account)
	if h.gateway != nil {
		_, _ = h.gateway.AccountCatalog(r.Context(), account.ID, false)
	}
}

func (h *accountHTTP) cancelOAuth(w http.ResponseWriter, r *http.Request) {
	if h.oauth == nil {
		writeJSON(w, 503, map[string]string{"error": "unavailable"})
		return
	}
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := h.oauth.Cancel(token(r), chi.URLParam(r, "state")); err != nil {
		accountError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *accountHTTP) setEnabled(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Enabled == nil {
		accountError(w, accounts.ErrInput)
		return
	}
	row, err := h.service.SetEnabled(r.Context(), chi.URLParam(r, "id"), *input.Enabled)
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 200, row)
	if h.gateway != nil && row.Enabled {
		_, _ = h.gateway.AccountCatalog(r.Context(), row.ID, false)
	}
}

func (h *accountHTTP) bindProxy(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ProxyID string `json:"proxy_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	account, err := h.service.BindProxy(r.Context(), chi.URLParam(r, "id"), input.ProxyID)
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 200, account)
}

func (h *accountHTTP) fingerprint(w http.ResponseWriter, r *http.Request) {
	fingerprint, err := h.service.Fingerprint(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 200, fingerprint)
}

func (h *accountHTTP) setFingerprint(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Platform       string `json:"platform"`
		OS             string `json:"os"`
		Arch           string `json:"arch"`
		RuntimeVersion string `json:"runtime_version"`
		PackageVersion string `json:"package_version"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	fingerprint, err := h.service.SetFingerprint(r.Context(), chi.URLParam(r, "id"), accounts.ClientProfile{Platform: input.Platform, OS: input.OS, Arch: input.Arch, RuntimeVersion: input.RuntimeVersion, PackageVersion: input.PackageVersion})
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 200, fingerprint)
}

func (h *accountHTTP) resetFingerprint(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Device bool `json:"device"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	fingerprint, err := h.service.ResetFingerprint(r.Context(), chi.URLParam(r, "id"), input.Device)
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 200, fingerprint)
}

func (h *accountHTTP) remove(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := h.service.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		accountError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *accountHTTP) check(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	if h.gateway == nil {
		writeJSON(w, 503, map[string]string{"error": "unavailable"})
		return
	}
	id := chi.URLParam(r, "id")
	models, err := h.gateway.Check(r.Context(), id)
	if err != nil {
		accountError(w, err)
		return
	}
	account, err := h.service.Get(r.Context(), id)
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"account": account, "models": models})
}

func (h *accountHTTP) usage(w http.ResponseWriter, r *http.Request) {
	h.readUsage(w, r, false)
}

func (h *accountHTTP) refreshUsage(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	h.readUsage(w, r, true)
}

func (h *accountHTTP) readUsage(w http.ResponseWriter, r *http.Request, force bool) {
	if h.gateway == nil {
		writeJSON(w, 503, map[string]string{"error": "unavailable"})
		return
	}
	var usage gateway.UsageSnapshot
	var err error
	if force {
		usage, err = h.gateway.RefreshUsage(r.Context(), chi.URLParam(r, "id"))
	} else {
		usage, err = h.gateway.Usage(r.Context(), chi.URLParam(r, "id"))
	}
	if err != nil {
		accountError(w, err)
		return
	}
	writeJSON(w, 200, usage)
}

func accountError(w http.ResponseWriter, err error) {
	status, code := 503, "unavailable"
	var rejected *upstream.UpstreamError
	switch {
	case errors.Is(err, resets.ErrInput):
		status, code = 400, err.Error()
	case errors.Is(err, resets.ErrBusy), errors.Is(err, resets.ErrNoPending):
		status, code = 409, err.Error()
	case errors.Is(err, resets.ErrUnsupported):
		status, code = 400, err.Error()
	case errors.Is(err, accounts.ErrAllocated):
		status, code = 409, err.Error()
	case errors.Is(err, upstream.ErrUsageUnsupported):
		status, code = 400, "provider_usage_unsupported"
	case errors.Is(err, accounts.ErrFingerprintUnsupported):
		status, code = 400, "fingerprint_unsupported"
	case errors.Is(err, accounts.ErrInput):
		status, code = 400, "invalid_account_input"
	case errors.Is(err, accounts.ErrProviderDisabled):
		status, code = 409, "provider_disabled"
	case errors.Is(err, accounts.ErrProxyInput):
		status, code = 400, "invalid_proxy_input"
	case errors.Is(err, accounts.ErrProxyNotFound):
		status, code = 404, "proxy_not_found"
	case errors.Is(err, accounts.ErrProxyInUse):
		status, code = 409, "proxy_in_use"
	case errors.Is(err, accounts.ErrProxyDuplicate):
		status, code = 409, "proxy_exists"
	case errors.Is(err, accounts.ErrProxyLimit):
		status, code = 409, "proxy_limit"
	case errors.Is(err, accounts.ErrProxyChanged):
		status, code = 409, "proxy_changed"
	case errors.Is(err, accounts.ErrIdentity):
		status, code = 409, "account_identity_mismatch"
	case errors.Is(err, accounts.ErrDuplicate):
		status, code = 409, "account_exists"
	case errors.Is(err, accounts.ErrLimit):
		status, code = 409, "account_limit"
	case errors.Is(err, accounts.ErrNotFound):
		status, code = 404, "account_not_found"
	case errors.Is(err, accounts.ErrDisabled):
		status, code = 409, "account_disabled"
	case errors.Is(err, accounts.ErrReauthorize):
		status, code = 409, "account_reauthorization_required"
	case errors.Is(err, accounts.ErrRefresh):
		status, code = 502, "account_refresh_failed"
	case errors.Is(err, oauth.ErrState):
		status, code = 400, "oauth_state_invalid"
	case errors.Is(err, oauth.ErrCallback):
		status, code = 400, "oauth_callback_invalid"
	case errors.Is(err, oauth.ErrDenied):
		status, code = 400, "oauth_access_denied"
	case errors.Is(err, oauth.ErrBusy), errors.Is(err, gateway.ErrBusy):
		status, code = 429, "gateway_busy"
	case errors.Is(err, upstream.ErrUpstream):
		status, code = 502, "upstream_unavailable"
	case errors.Is(err, upstream.ErrResponse):
		status, code = 502, "invalid_upstream_response"
	case errors.As(err, &rejected):
		status, code = 502, "upstream_rejected_request"
		if rejected.Status == 401 || rejected.Status == 403 {
			status, code = 409, "account_reauthorization_required"
		}
		if rejected.Status == 429 {
			status, code = 429, "upstream_rate_limited"
			retryAfter(w, rejected.RetryAfter)
		}
	}
	writeJSON(w, status, map[string]string{"error": code})
}

func retryAfter(w http.ResponseWriter, value string) {
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 1 || seconds > 3600 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
}
