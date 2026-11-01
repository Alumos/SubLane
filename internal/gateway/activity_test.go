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

func TestActivityFollowsInstanceTimeZoneAcrossWeeks(t *testing.T) {
	ctx := context.Background()
	s, _ := codexGateway(t, transportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream"); return nil, nil }))
	zones, err := timezone.New(ctx, s.db)
	if err != nil {
		t.Fatal(err)
	}
	s.SetTimeZone(zones)
	now := time.Date(2030, 1, 14, 2, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	since := time.Date(2030, 1, 6, 15, 30, 0, 0, time.UTC)
	if _, err := s.db.Exec("UPDATE settings SET value=? WHERE key='usage.hourly.started_at'", since.Unix()); err != nil {
		t.Fatal(err)
	}
	input := int64(7)
	for _, started := range []time.Time{since, since.Add(time.Hour), since.Add(7*24*time.Hour + time.Hour)} {
		if err := recordStatistics(ctx, s.queries, db.RecordRequestParams{UserID: 1, GroupID: 1, StartedAt: started.Unix(), Outcome: "success", InputTokens: &input}); err != nil {
			t.Fatal(err)
		}
	}
	actor := audit.WithActor(ctx, audit.Actor{TenantID: 1, ID: 1, Username: "synthetic-admin", Role: "admin", Source: "user"})
	for _, name := range []string{"Asia/Shanghai", "UTC", "Asia/Shanghai"} {
		if _, err := zones.Save(actor, name); err != nil {
			t.Fatal(err)
		}
		page, err := s.UserStatistics(ctx, 1, 30)
		if err != nil {
			t.Fatal(err)
		}
		if page.Activity.TimeZone != name {
			t.Fatalf("aggregation zone = %s, want %s", page.Activity.TimeZone, name)
		}
		index, previous := 0, 6*24+23
		if name == "UTC" {
			index, previous = 6*24+16, 6*24+15
		}
		cell := page.Activity.Cells[index]
		if cell.Requests != 2 || cell.InputTokens != 14 || cell.InputReported != 2 || cell.Samples != 2 {
			t.Fatalf("%s: wrong local weekday/hour aggregation: %+v", name, cell)
		}
		if cell := page.Activity.Cells[previous]; cell.Requests != 1 || cell.Samples != 2 {
			t.Fatalf("%s: partial first hour lost: %+v", name, cell)
		}
		if name == "Asia/Shanghai" && page.Activity.Cells[11].Samples != 1 {
			t.Fatal("future local hour counted beyond the earlier week")
		}
	}
}

func TestActivityUsesHistoricalDaylightSavingOffsets(t *testing.T) {
	for _, test := range []struct {
		name    string
		start   time.Time
		hours   []int
		samples map[int]int64
	}{
		{"spring", time.Date(2030, 3, 10, 6, 0, 0, 0, time.UTC), []int{0, 1}, map[int]int64{1: 1, 2: 0, 3: 1}},
		{"fall", time.Date(2030, 11, 3, 5, 0, 0, 0, time.UTC), []int{0, 1}, map[int]int64{0: 0, 1: 2, 2: 0}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			s, _ := codexGateway(t, transportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream"); return nil, nil }))
			zones, err := timezone.New(ctx, s.db)
			if err != nil {
				t.Fatal(err)
			}
			s.SetTimeZone(zones)
			actor := audit.WithActor(ctx, audit.Actor{TenantID: 1, ID: 1, Username: "synthetic-admin", Role: "admin", Source: "user"})
			if _, err := zones.Save(actor, "America/New_York"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.db.Exec("UPDATE settings SET value=? WHERE key='usage.hourly.started_at'", test.start.Unix()); err != nil {
				t.Fatal(err)
			}
			s.now = func() time.Time { return test.start.Add(90 * time.Minute) }
			for _, hour := range test.hours {
				if err := recordStatistics(ctx, s.queries, db.RecordRequestParams{UserID: 1, GroupID: 1, StartedAt: test.start.Add(time.Duration(hour) * time.Hour).Unix(), Outcome: "success"}); err != nil {
					t.Fatal(err)
				}
			}
			page, err := s.Statistics(ctx, 1)
			if err != nil {
				t.Fatal(err)
			}
			for hour, samples := range test.samples {
				cell := page.Activity.Cells[6*24+hour]
				if cell.Samples != samples || cell.Requests != samples {
					t.Errorf("local hour %d: got %+v, want %d samples and requests", hour, cell, samples)
				}
			}
		})
	}
}

func TestActivityUsesUTCHoursAndSessionOwnershipAcrossWeeks(t *testing.T) {
	ctx := context.Background()
	s, _ := codexGateway(t, transportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected upstream"); return nil, nil }))
	member := runtimeMember(t, s)
	now := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	since := now.AddDate(0, 0, -7).Add(-90 * time.Minute).Unix()
	if _, err := s.db.Exec("UPDATE settings SET value=? WHERE key='usage.hourly.started_at'", since); err != nil {
		t.Fatal(err)
	}
	input, ownerInput := int64(10), int64(70)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, r := range []db.RecordRequestParams{
		{UserID: member, GroupID: 1, StartedAt: now.AddDate(0, 0, -7).Add(-45 * time.Minute).Unix(), Outcome: "success", InputTokens: &input},
		{UserID: member, GroupID: 1, StartedAt: now.Add(-50 * time.Minute).Unix(), Outcome: "success"},
		{UserID: 1, GroupID: 1, StartedAt: now.AddDate(0, 0, -7).Add(-40 * time.Minute).Unix(), Outcome: "success", InputTokens: &ownerInput},
	} {
		if err := recordStatistics(ctx, s.queries.WithTx(tx), r); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	mine, err := s.UserStatistics(ctx, member, 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(mine.Activity.Cells) != 168 || mine.Activity.TrackingSince != since {
		t.Fatal("unbounded or missing hourly coverage")
	}
	cell := mine.Activity.Cells[9]
	if cell.Weekday != 0 || cell.Hour != 9 || cell.Requests != 2 || cell.InputTokens != 10 || cell.InputReported != 1 || cell.Samples != 2 {
		t.Fatal("wrong owner/hour/week aggregation", cell)
	}
	all, err := s.Statistics(ctx, 30)
	if err != nil || all.Activity.Cells[9].Requests != 3 || all.Activity.Cells[9].InputTokens != 80 {
		t.Fatal("incorrect team aggregation", err)
	}
	today, err := s.UserStatistics(ctx, member, 1)
	if err != nil || today.Activity.Cells[9].Requests != 1 || today.Activity.Cells[9].InputReported != 0 {
		t.Fatal("period filter or missing-token semantics", err)
	}
	if today.Activity.Cells[0].Samples != 1 || today.Activity.Cells[0].Requests != 0 || today.Activity.Cells[10].Samples != 1 || today.Activity.Cells[11].Samples != 0 || today.Activity.Cells[24].Samples != 0 {
		t.Fatal("zero activity and future hours were conflated")
	}
	if _, err := s.db.Exec("UPDATE settings SET value=? WHERE key='usage.hourly.started_at'", now.Unix()); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.UserStatistics(ctx, member, 1)
	if err != nil || fresh.Activity.Cells[9].Samples != 0 || fresh.Activity.Cells[9].Requests != 0 || fresh.Activity.Cells[10].Samples != 1 {
		t.Fatal("pre-collection hours presented as collected", err)
	}
}

func TestHourlyWriteFailureRollsBackHistoryAndDailyCounters(t *testing.T) {
	for _, table := range []string{"usage_hourly", "usage_minutes"} {
		t.Run(table, func(t *testing.T) {
			ctx := context.Background()
			s, _ := codexGateway(t, transportFunc(func(*http.Request) (*http.Response, error) { return syntheticStream(), nil }))
			if _, err := s.db.Exec("CREATE TRIGGER fail_usage BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"); err != nil {
				t.Fatal(err)
			}
			r, err := s.Open(ctx, 1, 1, []byte(`{"model":"synthetic-model","input":"synthetic"}`), nil, Responses)
			if err != nil {
				t.Fatal(err)
			}
			if err := r.Events(func([]byte) error { return nil }); err != nil {
				t.Fatal(err)
			}
			r.Body.Close()
			history, err := s.Requests(ctx, RequestFilter{})
			if err != nil || len(history.Requests) != 0 {
				t.Fatal("history committed without hourly usage", err)
			}
			page, err := s.Statistics(ctx, 7)
			if err != nil || page.Totals.Requests != 0 {
				t.Fatal("daily usage committed without hourly usage", err)
			}
		})
	}
}
