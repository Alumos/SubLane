package server

import (
	"context"
	"testing"
	"time"

	"github.com/murongg/SubLane/internal/upstream"
)

func TestIPReportCacheBoundsLookups(t *testing.T) {
	now := time.Unix(1_900_000_000, 0)
	calls := 0
	cache := &ipReportCache{entries: map[string]ipReportEntry{}, now: func() time.Time { return now }, lookup: func(_ context.Context, ip string) (upstream.IPReport, error) {
		calls++
		return upstream.IPReport{IP: ip}, nil
	}}
	ctx := context.Background()
	for range 3 {
		if _, err := cache.get(ctx, "203.0.113.9", false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := cache.get(ctx, "203.0.113.9", true); err != nil || calls != 1 {
		t.Fatal("refresh inside the cooldown reached the service", calls, err)
	}
	now = now.Add(ipReportCooldown)
	if _, err := cache.get(ctx, "203.0.113.9", true); err != nil || calls != 2 {
		t.Fatal("refresh after the cooldown was cached", calls, err)
	}
	now = now.Add(ipReportTTL)
	if _, err := cache.get(ctx, "203.0.113.9", false); err != nil || calls != 3 {
		t.Fatal("expired report was reused", calls, err)
	}
	for i := range ipReportEntries + 5 {
		now = now.Add(time.Second)
		if _, err := cache.get(ctx, string(rune('a'+i%26))+time.Duration(i).String(), false); err != nil {
			t.Fatal(err)
		}
	}
	if len(cache.entries) > ipReportEntries {
		t.Fatal("cache is unbounded", len(cache.entries))
	}
}
