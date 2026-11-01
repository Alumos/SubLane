package gateway

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/storage/db"
	"github.com/murongg/SubLane/internal/timezone"
)

func TestStatisticsUseLocalTodayAcrossEveryBreakdown(t *testing.T) {
	ctx := context.Background()
	s, _ := codexGateway(t, transportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream"); return nil, nil }))
	zones, err := timezone.New(ctx, s.db)
	if err != nil {
		t.Fatal(err)
	}
	s.SetTimeZone(zones)
	actor := audit.WithActor(ctx, audit.Actor{TenantID: 1, ID: 1, Username: "synthetic-admin", Role: "admin", Source: "user"})
	if _, err := zones.Save(actor, "Asia/Shanghai"); err != nil {
		t.Fatal(err)
	}
	location := zones.Location()
	start := time.Date(2030, 1, 2, 0, 0, 0, 0, location)
	s.now = func() time.Time { return start.Add(30 * time.Minute) }
	member := runtimeMember(t, s)
	var keys []int64
	for i := byte(1); i <= 2; i++ {
		digest := make([]byte, 32)
		digest[0] = i
		key, err := s.queries.CreateKey(ctx, db.CreateKeyParams{UserID: 1, GroupID: 1, Name: "Synthetic key", Prefix: "sl_synthetic", TokenHash: digest, CreatedAt: start.Add(-time.Hour).Unix()})
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key)
	}
	input, output, cached := int64(10), int64(4), int64(2)
	for _, record := range []db.RecordRequestParams{
		{UserID: 1, KeyID: keys[0], GroupID: 1, Provider: "codex", Model: "synthetic-before", StartedAt: start.Add(-time.Second).Unix(), Outcome: "success"},
		{UserID: 1, KeyID: keys[0], GroupID: 1, Provider: "codex", Model: "synthetic-current", StartedAt: start.Unix(), Outcome: "success", DurationMs: 100, InputTokens: &input, OutputTokens: &output, CachedTokens: &cached},
		{UserID: 1, KeyID: keys[1], GroupID: 1, Provider: "codex", Model: "synthetic-current", StartedAt: start.Add(20 * time.Minute).Unix(), Outcome: "error", DurationMs: 300},
		{UserID: 1, KeyID: keys[0], GroupID: 1, Provider: "codex", Model: "synthetic-after", StartedAt: start.AddDate(0, 0, 1).Unix(), Outcome: "success"},
		{UserID: member, GroupID: 1, Provider: "codex", Model: "synthetic-member", StartedAt: start.Add(time.Minute).Unix(), Outcome: "success"},
	} {
		if err := recordStatistics(ctx, s.queries, record); err != nil {
			t.Fatal(err)
		}
	}
	mine, err := s.UserStatistics(ctx, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	want := Metrics{Requests: 2, Completed: 1, Errors: 1, DurationMs: 400, InputTokens: 10, OutputTokens: 4, CachedTokens: 2, InputReported: 1, OutputReported: 1, CachedReported: 1}
	if mine.TimeZone != "Asia/Shanghai" || mine.FromDay != start.Unix() || mine.ToDay != start.AddDate(0, 0, 1).Unix() || mine.Totals != want {
		t.Fatalf("wrong local today: bounds=%d..%d totals=%+v", mine.FromDay, mine.ToDay, mine.Totals)
	}
	if len(mine.Days) != 1 || mine.Days[0].Name != "2030-01-02" || mine.Days[0].Metrics != want || len(mine.Models) != 1 || mine.Models[0].Metrics != want || len(mine.Groups) != 1 || mine.Groups[0].Metrics != want {
		t.Fatalf("daily/model/group views disagree: %+v", mine)
	}
	if mine.Activity.Cells[2*24].Requests != 2 || mine.Activity.Cells[1*24+23].Requests != 0 {
		t.Fatal("activity crossed the local period boundary")
	}
	key, err := s.UserKeyStatistics(ctx, 1, keys[0], 1)
	if err != nil || key.Totals.Requests != 1 || key.Totals.Errors != 0 {
		t.Fatal("selected key did not share the local day", key.Totals, err)
	}
	team, err := s.Statistics(ctx, 1)
	if err != nil || team.Totals.Requests != 3 || len(team.Members) != 2 {
		t.Fatal("workspace did not share the local day", team.Totals, err)
	}
	other := NewForTenant(ctx, s.db, nil, nil, 2)
	defer other.Close()
	other.SetTimeZone(zones)
	other.now = s.now
	isolated, err := other.UserStatistics(ctx, 1, 1)
	if err != nil || isolated.Totals.Requests != 0 || len(isolated.Models) != 0 || len(isolated.Groups) != 0 {
		t.Fatal("minute reports crossed a workspace boundary", isolated.Totals, err)
	}
	if _, err := s.db.Exec("DELETE FROM request_records"); err != nil {
		t.Fatal(err)
	}
	if _, err := zones.Save(actor, "UTC"); err != nil {
		t.Fatal(err)
	}
	utc, err := s.UserStatistics(ctx, 1, 1)
	if err != nil || utc.Totals.Requests != 3 {
		t.Fatal("UTC history changed after switching zones", utc.Totals, err)
	}
	if _, err := zones.Save(actor, "Asia/Shanghai"); err != nil {
		t.Fatal(err)
	}
	again, err := s.UserStatistics(ctx, 1, 1)
	if err != nil || again.Totals != want {
		t.Fatal("local report depended on request history or the previous zone", again.Totals, err)
	}
}

func TestStatisticsFollowCalendarDaysAndMinuteOffsets(t *testing.T) {
	for _, test := range []struct {
		zone       string
		year       int
		month      time.Month
		day, hours int
	}{
		{"America/New_York", 2030, time.March, 10, 23},
		{"America/New_York", 2030, time.November, 3, 25},
		{"Asia/Kolkata", 2030, time.January, 2, 24},
		{"Asia/Kathmandu", 2030, time.January, 2, 24},
		{"America/Santiago", 2026, time.September, 6, 23},
	} {
		t.Run(test.zone+"/"+test.month.String(), func(t *testing.T) {
			ctx := context.Background()
			s, _ := codexGateway(t, transportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream"); return nil, nil }))
			zones, err := timezone.New(ctx, s.db)
			if err != nil {
				t.Fatal(err)
			}
			s.SetTimeZone(zones)
			actor := audit.WithActor(ctx, audit.Actor{TenantID: 1, ID: 1, Username: "synthetic-admin", Role: "admin", Source: "user"})
			if _, err := zones.Save(actor, test.zone); err != nil {
				t.Fatal(err)
			}
			now := time.Date(test.year, test.month, test.day, 12, 0, 0, 0, zones.Location())
			s.now = func() time.Time { return now }
			start := time.Date(test.year, test.month, test.day, 0, 0, 0, 0, zones.Location())
			if test.zone == "America/Santiago" {
				start = time.Date(test.year, test.month, test.day, 1, 0, 0, 0, zones.Location())
			}
			end := time.Date(test.year, test.month, test.day+1, 0, 0, 0, 0, zones.Location())
			if _, err := s.db.Exec("UPDATE settings SET value=? WHERE key IN ('usage.daily.started_at','usage.hourly.started_at','usage.minutes.started_at')", start.AddDate(0, 0, -7).Unix()); err != nil {
				t.Fatal(err)
			}
			for _, stamp := range []time.Time{start.Add(-time.Minute), start, start.Add(time.Minute), end} {
				if err := recordStatistics(ctx, s.queries, db.RecordRequestParams{UserID: 1, GroupID: 1, StartedAt: stamp.Unix(), Outcome: "success"}); err != nil {
					t.Fatal(err)
				}
			}
			page, err := s.UserStatistics(ctx, 1, 1)
			if err != nil || page.FromDay != start.Unix() || page.ToDay != end.Unix() || page.ToDay-page.FromDay != int64(test.hours)*3600 || page.Totals.Requests != 2 {
				t.Fatalf("wrong local boundaries or counts: %d..%d %+v, err=%v", page.FromDay, page.ToDay, page.Totals, err)
			}
			week, err := s.UserStatistics(ctx, 1, 7)
			if err != nil || len(week.Days) != 7 || week.Days[6].ID != page.Days[0].ID {
				t.Fatal("calendar days were stepped as fixed 24-hour windows", week.Days, err)
			}
		})
	}
}

func TestLocalStatisticsPreserveLegacyHistoryWithoutInventingPrecision(t *testing.T) {
	ctx := context.Background()
	s, _ := codexGateway(t, transportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream"); return nil, nil }))
	zones, err := timezone.New(ctx, s.db)
	if err != nil {
		t.Fatal(err)
	}
	s.SetTimeZone(zones)
	now := time.Date(2030, 1, 2, 6, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	since := now.Add(-time.Hour).Unix()
	if _, err := s.db.Exec("UPDATE settings SET value=? WHERE key='usage.minutes.started_at'", since); err != nil {
		t.Fatal(err)
	}
	if err := s.queries.RecordStatistics(ctx, db.RecordStatisticsParams{Day: now.AddDate(0, 0, -1).Truncate(24 * time.Hour).Unix(), UserID: 1, GroupID: 1, Provider: "codex", Model: "synthetic-legacy", Requests: 7, Completed: 7}); err != nil {
		t.Fatal(err)
	}
	legacy, err := s.UserStatistics(ctx, 1, 7)
	if err != nil || legacy.Totals.Requests != 7 {
		t.Fatal("legacy UTC totals changed", legacy.Totals, err)
	}
	actor := audit.WithActor(ctx, audit.Actor{TenantID: 1, ID: 1, Username: "synthetic-admin", Role: "admin", Source: "user"})
	if _, err := zones.Save(actor, "Asia/Shanghai"); err != nil {
		t.Fatal(err)
	}
	local, err := s.UserStatistics(ctx, 1, 7)
	if err != nil || local.Totals.Requests != 0 || local.TrackingSince != since {
		t.Fatal("legacy totals presented as precisely dated observations", local.Totals, local.TrackingSince, err)
	}
	if err := recordStatistics(ctx, s.queries, db.RecordRequestParams{UserID: 1, GroupID: 1, StartedAt: now.Unix(), Outcome: "success"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("DELETE FROM request_records"); err != nil {
		t.Fatal(err)
	}
	restarted := New(ctx, s.db, s.accounts, s.provider)
	defer restarted.Close()
	restarted.SetTimeZone(zones)
	restarted.now = s.now
	page, err := restarted.UserStatistics(ctx, 1, 7)
	if err != nil || page.Totals.Requests != 1 || page.TrackingSince != since {
		t.Fatal("precise totals or coverage did not survive restart", page.Totals, err)
	}
	if _, err := s.db.Exec("UPDATE settings SET value='synthetic-invalid' WHERE key='usage.minutes.started_at'"); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.UserStatistics(ctx, 1, 7); err == nil {
		t.Fatal("corrupt precision coverage was silently accepted")
	}
}

func TestActivityPreservesWholeHourHistoryAcrossNinetyLocalDays(t *testing.T) {
	ctx := context.Background()
	s, _ := codexGateway(t, transportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream"); return nil, nil }))
	if err := s.queries.SaveTimeZone(ctx, "America/New_York"); err != nil {
		t.Fatal(err)
	}
	zones, err := timezone.New(ctx, s.db)
	if err != nil {
		t.Fatal(err)
	}
	s.SetTimeZone(zones)
	end := time.Date(2030, 11, 5, 0, 0, 0, 0, zones.Location())
	s.now = func() time.Time { return end.Add(-time.Minute) }
	start := time.Date(2030, 8, 7, 0, 0, 0, 0, zones.Location())
	if _, err := s.db.Exec("UPDATE settings SET value=? WHERE key='usage.hourly.started_at'", start.Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`WITH RECURSIVE hours(stamp) AS (VALUES(?) UNION ALL SELECT stamp+3600 FROM hours WHERE stamp+3600<?)
INSERT INTO usage_hourly(tenant_id,hour,user_id,key_id,requests,input_tokens,output_tokens,input_reported,output_reported)
SELECT 1,stamp,1,0,1,0,0,0,0 FROM hours`, start.Unix(), end.Unix()); err != nil {
		t.Fatal(err)
	}
	page, err := s.UserStatistics(ctx, 1, 90)
	if err != nil {
		t.Fatal(err)
	}
	var requests, samples int64
	for _, cell := range page.Activity.Cells {
		requests += cell.Requests
		samples += cell.Samples
	}
	want := (end.Unix() - start.Unix()) / 3600
	if page.FromDay != start.Unix() || requests != want || samples != want || page.Activity.TrackingSince != start.Unix() {
		t.Fatalf("legacy hours lost at a local/DST boundary: from=%d requests=%d samples=%d want=%d", page.FromDay, requests, samples, want)
	}
}
