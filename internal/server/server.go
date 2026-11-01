package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/netip"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/murongg/SubLane/internal/accounts"
	"github.com/murongg/SubLane/internal/alerts"
	"github.com/murongg/SubLane/internal/apikey"
	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/auth"
	"github.com/murongg/SubLane/internal/channels"
	"github.com/murongg/SubLane/internal/content"
	"github.com/murongg/SubLane/internal/gateway"
	"github.com/murongg/SubLane/internal/groups"
	"github.com/murongg/SubLane/internal/oauth"
	"github.com/murongg/SubLane/internal/pricing"
	"github.com/murongg/SubLane/internal/resets"
	"github.com/murongg/SubLane/internal/tenants"
	"github.com/murongg/SubLane/internal/timezone"
	"github.com/murongg/SubLane/internal/turnstile"
	"github.com/murongg/SubLane/internal/updates"
	"github.com/murongg/SubLane/internal/upstream"
	"github.com/murongg/SubLane/internal/versions"
)

type Options struct {
	Demo               *DemoCredentials
	DataDir            string
	CredentialsKeyFile string
	Assets             fs.FS
	Version            string
	StartedAt          time.Time
	Ping               func(context.Context) error
	Audit              *audit.Service
	Alerts             *alerts.Service
	Content            *content.Service
	Auth               *auth.Service
	Keys               *apikey.Service
	Accounts           *accounts.Service
	OAuth              *oauth.Flow
	Gateway            *gateway.Service
	ResetCredits       *resets.Service
	Pricing            *pricing.Service
	Groups             *groups.Service
	Tenants            *tenants.Service
	TenantID           int64
	PublicURL          string
	TrustedProxies     []netip.Prefix
	LoginLimiter       *LoginLimiter
	EnrollmentLimiter  *LoginLimiter
	CodexVersions      *versions.Service
	GrokVersions       *versions.Service
	ClaudeVersions     *versions.Service
	TimeZone           *timezone.Service
	Turnstile          *turnstile.Service
	Updates            *updates.Service
	ProxyCheck         func(context.Context, string) (upstream.ProxyCheck, error)
}

func New(o Options) http.Handler {
	router := chi.NewRouter()
	router.Use(
		requestLogging,
		middleware.SetHeader("X-Content-Type-Options", "nosniff"),
		middleware.SetHeader("Referrer-Policy", "same-origin"),
		middleware.SetHeader("X-Frame-Options", "DENY"),
	)
	routeErrors(router)
	tenantID := o.TenantID
	if tenantID == 0 {
		tenantID = 1
	}
	loginLimiter, enrollmentLimiter := o.LoginLimiter, o.EnrollmentLimiter
	if loginLimiter == nil {
		loginLimiter = NewLoginLimiter()
	}
	if enrollmentLimiter == nil {
		enrollmentLimiter = NewLoginLimiter()
	}
	login := &authHTTP{demo: o.Demo, audit: o.Audit, service: o.Auth, tenants: o.Tenants, timeZone: o.TimeZone, tenantID: tenantID, publicURL: o.PublicURL, limiter: loginLimiter, enrollmentLimiter: enrollmentLimiter, trustedProxies: o.TrustedProxies}
	login.turnstile = o.Turnstile
	keys := &keyHTTP{groups: o.Groups, service: o.Keys, gateway: o.Gateway, publicURL: o.PublicURL, sockets: make(chan struct{}, 8)}
	accountManagement := &accountHTTP{service: o.Accounts, oauth: o.OAuth, gateway: o.Gateway, resets: o.ResetCredits, tenantID: tenantID}
	memberManagement := &memberHTTP{gateway: o.Gateway}
	allocationManagement := &allocationHTTP{gateway: o.Gateway}

	health := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	}
	readiness := func(w http.ResponseWriter, r *http.Request) {
		if !ready(r.Context(), o.Ping) {
			writeJSON(w, 503, map[string]string{"error": "storage_unavailable"})
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	}
	system := func(w http.ResponseWriter, r *http.Request) {
		if !ready(r.Context(), o.Ping) {
			writeJSON(w, 503, map[string]string{"error": "storage_unavailable"})
			return
		}
		summary, err := accountSummary(r.Context(), o.Accounts)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "storage_unavailable"})
			return
		}
		if o.Groups != nil {
			status, err := o.Groups.Connection(r.Context(), sessionUser(r).ID)
			if err != nil {
				writeJSON(w, 503, map[string]string{"error": "storage_unavailable"})
				return
			}
			summary["status"] = status
		}
		usableKey := false
		if o.Keys != nil {
			usableKey, err = o.Keys.HasUsableKey(r.Context(), sessionUser(r).ID)
			if err != nil {
				writeJSON(w, 503, map[string]string{"error": "storage_unavailable"})
				return
			}
		}
		summary["has_usable_key"] = usableKey
		if o.Gateway != nil {
			progress, err := o.Gateway.SetupProgress(r.Context(), sessionUser(r).ID, true, usableKey)
			if err != nil {
				writeJSON(w, 503, map[string]string{"error": "unavailable"})
				return
			}
			summary["setup"] = progress
		}
		writeJSON(w, 200, map[string]any{
			"name": "SubLane", "version": o.Version, "status": "ok", "uptime_seconds": max(0, int64(time.Since(o.StartedAt).Seconds())),
			"storage": map[string]string{"engine": "sqlite", "status": "ready"},
			"gateway": summary,
		})
	}
	router.Get("/healthz", health)
	router.Head("/healthz", health)
	router.Get("/readyz", readiness)
	router.Head("/readyz", readiness)

	router.Route("/api", func(api chi.Router) {
		routeErrors(api)
		api.Route("/auth", login.register)
		api.Route("/tenants", func(workspaces chi.Router) {
			routeErrors(workspaces)
			workspaces.Use(login.requireUser)
			(&tenantHTTP{service: o.Tenants, tenantID: tenantID}).register(workspaces)
		})
		api.Route("/pricing", func(prices chi.Router) {
			routeErrors(prices)
			prices.Use(login.requireUser)
			prices.NotFound(requireAdminRole(http.HandlerFunc(notFound)).ServeHTTP)
			prices.Get("/", (&pricingHTTP{service: o.Pricing}).catalog)
		})
		api.Route("/connection", func(common chi.Router) {
			routeErrors(common)
			common.Use(login.requireUser)
			common.NotFound(requireAdminRole(http.HandlerFunc(notFound)).ServeHTTP)
			common.Get("/", func(w http.ResponseWriter, r *http.Request) {
				if o.Groups == nil {
					writeJSON(w, 503, map[string]string{"error": "unavailable"})
					return
				}
				status, err := o.Groups.Connection(r.Context(), sessionUser(r).ID)
				if err != nil {
					writeJSON(w, 503, map[string]string{"error": "unavailable"})
					return
				}
				result := map[string]any{"status": status}
				if o.Gateway != nil && o.Keys != nil {
					usable, err := o.Keys.HasUsableKey(r.Context(), sessionUser(r).ID)
					if err != nil {
						writeJSON(w, 503, map[string]string{"error": "unavailable"})
						return
					}
					progress, err := o.Gateway.SetupProgress(r.Context(), sessionUser(r).ID, sessionUser(r).Role == "admin", usable)
					if err != nil {
						writeJSON(w, 503, map[string]string{"error": "unavailable"})
						return
					}
					result["setup"] = progress
				}
				writeJSON(w, 200, result)
			})
		})
		api.Route("/keys", func(personal chi.Router) {
			routeErrors(personal)
			personal.Use(login.requireUser)
			// Only the explicit personal endpoints are exceptions to the default administrator boundary.
			personal.NotFound(requireAdminRole(http.HandlerFunc(notFound)).ServeHTTP)
			keys.register(personal)
		})
		api.Route("/me", func(personal chi.Router) {
			routeErrors(personal)
			personal.Use(login.requireUser)
			personal.NotFound(requireAdminRole(http.HandlerFunc(notFound)).ServeHTTP)
			login.registerSecurity(personal)
			personal.Get("/requests", accountManagement.personalRequests)
			personal.Get("/requests/filters", accountManagement.personalRequestFilters)
			personal.With(login.throttleLogin).Post("/password", login.changePassword)
			personal.Get("/allocations", allocationManagement.own)
			personal.Get("/limits", memberManagement.ownLimits)
			personal.Get("/usage", memberManagement.ownUsage)
		})
		management := chi.NewRouter()
		routeErrors(management)
		// Router middleware also protects 404/405 responses; inline With would only protect matched methods.
		management.Use(login.requireAdmin)
		management.Get("/system", system)
		management.Head("/system", system)
		management.Route("/members", func(members chi.Router) {
			login.registerMembers(members)
			members.Get("/{id}/limits", memberManagement.limits)
			members.Patch("/{id}/limits", memberManagement.updateLimits)
		})
		management.Get("/usage", memberManagement.usage)
		management.Route("/alerts", (&alertHTTP{service: o.Alerts, tenantID: tenantID}).register)
		management.Route("/content", (&contentHTTP{service: o.Content}).register)
		management.Get("/audit", (&auditHTTP{service: o.Audit}).list)
		management.Route("/settings/updates", func(settings chi.Router) {
			settings.Use(requirePlatformAdmin(tenantID))
			(&updateHTTP{service: o.Updates, audit: o.Audit, version: o.Version}).register(settings)
		})
		management.Route("/settings/backup", func(settings chi.Router) {
			settings.Use(requirePlatformAdmin(tenantID))
			(&backupHTTP{directory: o.DataDir, keyFile: o.CredentialsKeyFile, version: o.Version, auth: o.Auth, audit: o.Audit, slots: make(chan struct{}, 1)}).register(settings)
		})
		management.Route("/settings/codex", func(settings chi.Router) {
			settings.Use(requirePlatformAdmin(tenantID))
			(&versionHTTP{service: o.CodexVersions, provider: versions.Codex}).register(settings)
		})
		management.Route("/settings/grok", func(settings chi.Router) {
			settings.Use(requirePlatformAdmin(tenantID))
			(&versionHTTP{service: o.GrokVersions, provider: versions.Grok}).register(settings)
		})
		management.Route("/settings/claude", func(settings chi.Router) {
			settings.Use(requirePlatformAdmin(tenantID))
			(&versionHTTP{service: o.ClaudeVersions, provider: versions.Claude}).register(settings)
		})
		management.Route("/settings/turnstile", func(settings chi.Router) {
			settings.Use(requirePlatformAdmin(tenantID))
			(&turnstileHTTP{service: o.Turnstile}).register(settings)
		})
		management.Route("/settings/timezone", func(settings chi.Router) {
			settings.Use(requirePlatformAdmin(tenantID))
			(&timeZoneHTTP{service: o.TimeZone}).register(settings)
		})
		management.Route("/accounts", accountManagement.register)
		management.Route("/channels", (&channelHTTP{service: channels.New(o.Accounts), resources: o.Accounts, gateway: o.Gateway}).register)
		management.Route("/proxies", (&proxyHTTP{service: o.Accounts, check: o.ProxyCheck}).register)
		management.Get("/requests", accountManagement.requests)
		management.Get("/requests/filters", accountManagement.requestFilters)
		management.Route("/allocations", allocationManagement.register)
		management.Route("/groups", (&groupHTTP{service: o.Groups, gateway: o.Gateway}).register)
		api.Mount("/", management)
	})
	router.HandleFunc("/api", notFound)
	router.Route("/v1", keys.registerGateway)
	router.Route("/v1beta", keys.registerGemini)
	router.Route("/v0", func(legacy chi.Router) { routeErrors(legacy) })

	spa := assets(o.Assets)
	router.Get("/*", spa.ServeHTTP)
	router.Head("/*", spa.ServeHTTP)
	return router
}

func ready(parent context.Context, ping func(context.Context) error) bool {
	if ping == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	return ping(ctx) == nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func assets(files fs.FS) http.Handler {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if files == nil {
			writeJSON(w, 503, map[string]string{"error": "frontend_not_built", "message": "Use the Vite development server or make build."})
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "." {
			name = "index.html"
		}
		info, err := fs.Stat(files, name)
		if err != nil || info.IsDir() {
			if strings.HasPrefix(name, "assets/") || path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			name = "index.html"
		}
		w.Header().Set("Cache-Control", "no-cache")
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.ServeFileFS(w, r, files, name)
	})
	compressed := middleware.Compress(5, "text/html", "text/css", "text/javascript", "application/javascript", "image/svg+xml")(handler)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Range offsets describe the identity representation; API/SSE routes never enter this handler.
		if r.Header.Get("Range") == "" && acceptsGzip(r.Header.Get("Accept-Encoding")) {
			request := r.Clone(r.Context())
			request.Header.Set("Accept-Encoding", "gzip")
			compressed.ServeHTTP(w, request)
			return
		}
		w.Header().Add("Vary", "Accept-Encoding")
		handler.ServeHTTP(w, r)
	})
}

func acceptsGzip(header string) bool {
	wildcard := false
	// chi's compressor matches encoding substrings and ignores q=0, so negotiate before invoking it.
	for _, entry := range strings.Split(strings.ToLower(header), ",") {
		coding, parameters, _ := strings.Cut(strings.TrimSpace(entry), ";")
		if coding != "gzip" && coding != "*" {
			continue
		}
		quality := 1.0
		for _, parameter := range strings.Split(parameters, ";") {
			name, value, _ := strings.Cut(strings.TrimSpace(parameter), "=")
			if name == "q" {
				parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
				if err != nil {
					return false
				}
				quality = parsed
			}
		}
		accepted := quality > 0 && quality <= 1
		if coding == "gzip" {
			return accepted
		}
		wildcard = accepted
	}
	return wildcard
}

func accountSummary(ctx context.Context, service *accounts.Service) (map[string]any, error) {
	summary := map[string]any{"provider": "multi", "status": "not_configured", "accounts_total": 0, "accounts_enabled": 0}
	if service == nil {
		return summary, nil
	}
	if !service.ProviderEnabled("claude") {
		summary["provider"] = "codex"
	}
	list, err := service.List(ctx)
	if err != nil {
		return nil, err
	}
	enabled, ready := 0, 0
	for _, account := range list {
		if account.Enabled && service.ProviderEnabled(account.Provider) {
			enabled++
			if account.Status == "ready" {
				ready++
			}
		}
	}
	summary["accounts_total"], summary["accounts_enabled"] = len(list), enabled
	if ready > 0 {
		summary["status"] = "ready"
	} else if enabled > 0 {
		summary["status"] = "needs_attention"
	}
	return summary, nil
}
