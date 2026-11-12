package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/gateway"
	"github.com/murongg/SubLane/internal/logging"
)

type auditHTTP struct{ service *audit.Service }

func (h *auditHTTP) list(w http.ResponseWriter, r *http.Request) {
	if h.service == nil {
		writeJSON(w, 503, map[string]string{"error": "unavailable"})
		return
	}
	paging, valid := parsePagination(r.URL.Query())
	if !valid {
		writeJSON(w, 400, map[string]string{"error": "invalid_input"})
		return
	}
	page, err := h.service.List(r.Context(), audit.Filter{BeforeID: paging.Cursor, Page: paging.Page, Limit: paging.Limit, Resource: r.URL.Query().Get("resource"), Outcome: r.URL.Query().Get("outcome")})
	if err != nil {
		status, code := 503, "unavailable"
		if errors.Is(err, audit.ErrInput) {
			status, code = 400, "invalid_input"
		}
		writeJSON(w, status, map[string]string{"error": code})
		return
	}
	writeJSON(w, 200, page)
}
func (h *authHTTP) auditRequest(next http.Handler, w http.ResponseWriter, r *http.Request) {
	action, resource, id := auditTarget(r)
	if h.audit == nil || action == "" {
		next.ServeHTTP(w, r)
		return
	}
	writer := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
	next.ServeHTTP(writer, r)
	if writer.Status() < 400 {
		return
	}
	// Failed attempts contain only a fixed action and validated target ID, never bodies, URLs or raw errors.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Second)
	defer cancel()
	if err := h.audit.Failure(ctx, action, resource, id, writer.Status()); err != nil {
		logging.From(r.Context()).ErrorContext(ctx, "failed to persist management audit attempt",
			"request_id", gateway.RequestID(r.Context()), "tenant_id", h.tenantID,
			"action", action, "resource", resource, "resource_id", id,
			"status", writer.Status(), "error_code", "persist_audit_failed")
	}
}
func auditTarget(r *http.Request) (string, string, string) {
	if r.Method == "GET" || r.Method == "HEAD" {
		return "", "", ""
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	action, resource, id := "", "", ""
	switch {
	case path == "/api/allocations" && r.Method == "POST":
		action, resource = "allocation.save", "allocation"
	case r.Method == "POST" && path == "/api/settings/backup/export":
		action, resource = "backup.export", "backup"
	case r.Method == "POST" && path == "/api/settings/backup/verify":
		action, resource = "backup.verify", "backup"
	case r.Method == "POST" && path == "/api/settings/backup/restore":
		action, resource = "backup.prepare", "backup"
	case path == "/api/settings/codex" && r.Method == "PATCH":
		action, resource, id = "settings.update", "settings", "codex"
	case path == "/api/keys" && r.Method == "POST":
		action, resource = "key.create", "key"
	case path == "/api/members" && r.Method == "POST":
		action, resource = "member.create", "member"
	case path == "/api/groups" && r.Method == "POST":
		action, resource = "group.create", "group"
	case path == "/api/proxies" && r.Method == "POST":
		action, resource = "proxy.create", "proxy"
	case path == "/api/proxies/import" && r.Method == "POST":
		action, resource = "proxy.import", "proxy"
	case path == "/api/proxies/prune" && r.Method == "POST":
		action, resource = "proxy.prune", "proxy"
	case path == "/api/me/password" && r.Method == "POST":
		action, resource, id = "user.password", "user", audit.ID(sessionUser(r).ID)
	case (path == "/api/accounts/import" || path == "/api/accounts/oauth/complete") && r.Method == "POST":
		action, resource = "account.authorize", "account"
	default:
		parts := strings.Split(strings.TrimPrefix(path, "/api/"), "/")
		if len(parts) == 4 && parts[0] == "accounts" && parts[2] == "resets" && (parts[3] == "consume" || parts[3] == "retry") && r.Method == "POST" && audit.ValidTarget("account.reset_use", "account", parts[1]) {
			return "account.reset_use", "account", parts[1]
		}
		if len(parts) < 2 || len(parts) > 3 {
			return "", "", ""
		}
		id = parts[1]
		tail := ""
		if len(parts) == 3 {
			tail = parts[2]
		}
		switch parts[0] {
		case "allocations":
			if r.Method == "PATCH" && tail == "" {
				action, resource = "allocation.save", "allocation"
			}
			if r.Method == "POST" && tail == "enabled" {
				action, resource = "allocation.save", "allocation"
			}
			if r.Method == "POST" && tail == "settle" {
				action, resource = "allocation.settle", "allocation"
			}
		case "keys":
			resource = "key"
			if tail == "" && r.Method == "PATCH" {
				action = "key.update"
			}
			if tail == "group" && r.Method == "PUT" {
				action = "key.update"
			}
			if tail == "secret" && r.Method == "POST" {
				action = "key.reveal"
			}
			if tail == "revoke" && r.Method == "POST" {
				action = "key.revoke"
			}
		case "members":
			resource = "member"
			if tail == "" && r.Method == "DELETE" {
				action = "member.remove"
			}
			if tail == "" && r.Method == "PATCH" {
				action = "member.update"
			}
			if tail == "limits" && r.Method == "PATCH" {
				action = "member.limits"
			}
			if tail == "password" && r.Method == "POST" {
				action = "member.password"
			}
		case "groups":
			resource = "group"
			if tail == "" && r.Method == "PATCH" {
				action = "group.update"
			}
			if parts[1] == "members" && len(parts) == 3 && r.Method == "PUT" {
				action, resource, id = "member.groups", "member", parts[2]
			}
		case "accounts":
			resource = "account"
			if tail == "resets" && r.Method == "PUT" {
				action = "account.reset_settings"
			}
			if tail == "proxy" && r.Method == "PUT" {
				action = "account.proxy"
			}
			if tail == "fingerprint" && r.Method == "PUT" {
				action = "account.fingerprint"
			}
			if tail == "fingerprint" && r.Method == "DELETE" {
				action = "account.fingerprint_reset"
			}
			if tail == "" && r.Method == "PATCH" {
				action = "account.update"
			}
			if tail == "" && r.Method == "DELETE" {
				action = "account.delete"
			}
			if tail == "limits" && r.Method == "PATCH" {
				action = "account.concurrency"
			}
			if tail == "resume" && r.Method == "POST" {
				action = "account.resume"
			}
		case "proxies":
			resource = "proxy"
			if tail == "" && r.Method == "PUT" {
				action = "proxy.update"
			}
			if tail == "" && r.Method == "DELETE" {
				action = "proxy.delete"
			}
		}
	}
	if !audit.ValidTarget(action, resource, id) {
		return "", "", ""
	}
	return action, resource, id
}
