package server

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/updates"
)

type updateHTTP struct {
	service *updates.Service
	audit   *audit.Service
	version string
}

func (h *updateHTTP) register(router chi.Router) {
	routeErrors(router)
	router.Get("/", h.get)
	router.Post("/check", h.check)
	router.Post("/install", h.install)
}
func (h *updateHTTP) get(w http.ResponseWriter, r *http.Request) {
	if h.service == nil {
		writeJSON(w, 200, updates.State{CurrentVersion: h.version})
		return
	}
	state, _ := h.service.Check(r.Context(), false)
	writeJSON(w, 200, state)
}
func (h *updateHTTP) check(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeJSONLimit(w, r, &input, 1024) {
		return
	}
	if h.service == nil {
		h.failed(w, updates.ErrDisabled)
		return
	}
	state, err := h.service.Check(r.Context(), true)
	if err != nil {
		h.failed(w, err)
		return
	}
	writeJSON(w, 200, state)
}
func (h *updateHTTP) install(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Version         string `json:"version"`
		BackupConfirmed bool   `json:"backup_confirmed"`
	}
	if !decodeJSONLimit(w, r, &input, 1024) {
		return
	}
	if !input.BackupConfirmed {
		h.failed(w, updates.ErrInput)
		return
	}
	if h.service == nil {
		h.failed(w, updates.ErrDisabled)
		return
	}
	// Record the authorized request before publishing any host-side work, not an installation success.
	if h.audit == nil || h.audit.Observation(r.Context(), "updates.request", "settings", "") != nil {
		writeJSON(w, 503, map[string]string{"error": "update_audit_failed"})
		return
	}
	state, err := h.service.Queue(r.Context(), input.Version, input.BackupConfirmed)
	if err != nil {
		h.failed(w, err)
		return
	}
	writeJSON(w, 202, state)
}
func (h *updateHTTP) failed(w http.ResponseWriter, err error) {
	status, code := 503, "update_failed"
	switch {
	case errors.Is(err, updates.ErrInput):
		status, code = 400, "invalid_update"
	case errors.Is(err, updates.ErrDisabled):
		code = "update_unavailable"
	case errors.Is(err, updates.ErrBusy):
		status, code = 409, "update_busy"
	case errors.Is(err, updates.ErrCooldown):
		status, code = 429, "update_cooldown"
		w.Header().Set("Retry-After", "60")
	case errors.Is(err, updates.ErrCheck):
		code = "update_check_failed"
	}
	writeJSON(w, status, map[string]string{"error": code})
}
