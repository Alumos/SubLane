package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/murongg/SubLane/internal/apikey"
	"github.com/murongg/SubLane/internal/gateway"
	"github.com/murongg/SubLane/internal/groups"
)

type keyHTTP struct {
	service   *apikey.Service
	groups    *groups.Service
	gateway   *gateway.Service
	publicURL string
	sockets   chan struct{}
}

func (h *keyHTTP) available(w http.ResponseWriter) bool {
	if h.service != nil {
		return true
	}
	writeJSON(w, 503, map[string]string{"error": "unavailable"})
	return false
}

func (h *keyHTTP) register(router chi.Router) {
	router.Group(func(keys chi.Router) {
		keys.Use(h.requireAvailable)
		keys.Get("/", h.list)
		keys.Get("/groups", h.groupChoices)
		keys.Post("/", h.create)
		keys.Post("/{id}/revoke", h.revoke)
		keys.Post("/{id}/secret", h.reveal)
		keys.Get("/{id}/models", h.catalog)
		keys.Get("/{id}/models/availability", h.availability)
		keys.Patch("/{id}", h.update)
		keys.Put("/{id}/group", h.rebind)
	})
}

func (h *keyHTTP) requireAvailable(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.available(w) {
			next.ServeHTTP(w, r)
		}
	})
}

func (h *keyHTTP) list(w http.ResponseWriter, r *http.Request) {
	var filter apikey.Filter
	paging, valid := parsePagination(r.URL.Query())
	if !valid {
		keyError(w, apikey.ErrInput)
		return
	}
	filter.BeforeID, filter.Page, filter.Limit = paging.Cursor, paging.Page, paging.Limit
	if raw := r.URL.Query().Get("include_revoked"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			keyError(w, apikey.ErrInput)
			return
		}
		filter.IncludeRevoked = value
	}
	page, err := h.service.List(r.Context(), sessionUser(r).ID, filter)
	if err != nil {
		keyError(w, err)
		return
	}
	writeJSON(w, 200, page)
}

func (h *keyHTTP) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name      string `json:"name"`
		SchemeID  int64  `json:"scheme_id"`
		GroupID   *int64 `json:"group_id"`
		ExpiresAt *int64 `json:"expires_at"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	var groupID int64
	if input.GroupID != nil {
		groupID = *input.GroupID
	}
	var created apikey.CreatedKey
	var err error
	if input.SchemeID != 0 {
		created, err = h.service.CreateInScheme(r.Context(), sessionUser(r).ID, input.SchemeID, input.Name, input.ExpiresAt)
	} else {
		created, err = h.service.CreateWithExpiry(r.Context(), sessionUser(r).ID, groupID, input.Name, input.ExpiresAt)
	}
	if err != nil {
		keyError(w, err)
		return
	}
	writeJSON(w, 201, created)
}

func (h *keyHTTP) revoke(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil || id <= 0 {
		keyError(w, apikey.ErrInput)
		return
	}
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	key, err := h.service.Revoke(r.Context(), sessionUser(r).ID, id)
	if err != nil {
		keyError(w, err)
		return
	}
	writeJSON(w, 200, key)
}

func keyError(w http.ResponseWriter, err error) {
	status, code := 503, "unavailable"
	switch {
	case errors.Is(err, apikey.ErrInactive):
		status, code = 409, "api_key_inactive"
	case errors.Is(err, groups.ErrUnavailable):
		status, code = 403, "group_unavailable"
	case errors.Is(err, apikey.ErrInput):
		status, code = 400, "invalid_input"
	case errors.Is(err, apikey.ErrNotCopyable):
		status, code = 409, "api_key_not_copyable"
	case errors.Is(err, apikey.ErrRevoked):
		status, code = 409, "api_key_revoked"
	case errors.Is(err, apikey.ErrLimit):
		status, code = 409, "api_key_limit"
	case errors.Is(err, apikey.ErrNotFound):
		status, code = 404, "api_key_not_found"
	case errors.Is(err, apikey.ErrOwnerUnavailable):
		status, code = 401, "unauthorized"
	case errors.Is(err, apikey.ErrInvalidKey):
		status, code = 401, "invalid_api_key"
		w.Header().Set("WWW-Authenticate", "Bearer")
	}
	writeJSON(w, status, map[string]string{"error": code})
}

func (h *keyHTTP) update(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil || id <= 0 {
		keyError(w, apikey.ErrInput)
		return
	}
	var input struct {
		Name      string          `json:"name"`
		Enabled   *bool           `json:"enabled"`
		ExpiresAt json.RawMessage `json:"expires_at"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	var expiry *int64
	if input.Enabled == nil || len(input.ExpiresAt) == 0 || json.Unmarshal(input.ExpiresAt, &expiry) != nil {
		keyError(w, apikey.ErrInput)
		return
	}
	key, err := h.service.Update(r.Context(), sessionUser(r).ID, id, apikey.UpdateInput{Name: input.Name, Enabled: *input.Enabled, ExpiresAt: expiry})
	if err != nil {
		keyError(w, err)
		return
	}
	writeJSON(w, 200, key)
}

func (h *keyHTTP) rebind(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil || id <= 0 {
		keyError(w, apikey.ErrInput)
		return
	}
	var input struct {
		GroupID int64 `json:"group_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	key, err := h.service.Rebind(r.Context(), sessionUser(r).ID, id, input.GroupID)
	if err != nil {
		keyError(w, err)
		return
	}
	writeJSON(w, 200, key)
}

func (h *keyHTTP) reveal(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil || id <= 0 {
		keyError(w, apikey.ErrInput)
		return
	}
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	secret, err := h.service.Reveal(r.Context(), sessionUser(r).ID, id)
	if err != nil {
		keyError(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"secret": secret})
}
