package server

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/murongg/SubLane/internal/upstream"
)

const (
	ipReportTTL      = 6 * time.Hour
	ipReportCooldown = 30 * time.Second
	ipReportEntries  = 256
)

var errNoExitIP = errors.New("proxy_exit_ip_unknown")

// ipReportCache keeps third-party reputation lookups bounded: one result per public exit IP,
// shared by every workspace because the data describes the IP rather than any tenant.
type ipReportCache struct {
	mu      sync.Mutex
	entries map[string]ipReportEntry
	now     func() time.Time
	lookup  func(context.Context, string) (upstream.IPReport, error)
}

type ipReportEntry struct {
	report upstream.IPReport
	at     time.Time
}

var ipReports = &ipReportCache{entries: map[string]ipReportEntry{}, now: time.Now, lookup: upstream.LookupIPReport}

func (c *ipReportCache) get(ctx context.Context, ip string, refresh bool) (upstream.IPReport, error) {
	c.mu.Lock()
	entry, ok := c.entries[ip]
	now := c.now()
	// Forced refreshes are paced per IP so repeated clicks cannot flood the public service.
	if ok && (now.Sub(entry.at) < ipReportTTL && !refresh || refresh && now.Sub(entry.at) < ipReportCooldown) {
		c.mu.Unlock()
		return entry.report, nil
	}
	c.mu.Unlock()
	report, err := c.lookup(ctx, ip)
	if err != nil {
		return upstream.IPReport{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= ipReportEntries {
		oldest := ""
		for key, value := range c.entries {
			if oldest == "" || value.at.Before(c.entries[oldest].at) {
				oldest = key
			}
		}
		delete(c.entries, oldest)
	}
	c.entries[ip] = ipReportEntry{report: report, at: now}
	return report, nil
}

func (h *proxyHTTP) ipReport(w http.ResponseWriter, r *http.Request) {
	h.readIPReport(w, r, false)
}

func (h *proxyHTTP) refreshIPReport(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	h.readIPReport(w, r, true)
}

func (h *proxyHTTP) readIPReport(w http.ResponseWriter, r *http.Request, refresh bool) {
	if h.service == nil {
		writeJSON(w, 503, map[string]string{"error": "unavailable"})
		return
	}
	proxies, err := h.service.ListProxies(r.Context())
	if err != nil {
		accountError(w, err)
		return
	}
	id, ip := chi.URLParam(r, "id"), ""
	found := false
	for _, proxy := range proxies {
		if proxy.ID == id {
			found, ip = true, proxy.ExitIP
			break
		}
	}
	if !found {
		writeJSON(w, 404, map[string]string{"error": "proxy_not_found"})
		return
	}
	// Reports describe the exit observed by the last successful check, never the proxy endpoint.
	if ip == "" {
		writeJSON(w, 409, map[string]string{"error": errNoExitIP.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	report, err := ipReports.get(ctx, ip, refresh)
	if err != nil {
		status, code := 502, "ip_report_unavailable"
		var upstreamErr *upstream.UpstreamError
		switch {
		case errors.Is(err, upstream.ErrInput):
			status, code = 422, "ip_report_unsupported"
		case errors.As(err, &upstreamErr) && upstreamErr.Status == 429:
			status, code = 429, "ip_report_rate_limited"
		}
		writeJSON(w, status, map[string]string{"error": code})
		return
	}
	writeJSON(w, 200, report)
}
