package gateway

import (
	"context"
	"strings"
	"testing"

	"github.com/murongg/SubLane/internal/timezone"
)

func TestPersonalStatisticsUseTheUserIndex(t *testing.T) {
	for _, zone := range []string{"UTC", "Asia/Shanghai"} {
		t.Run(zone, func(t *testing.T) {
			s, meter := measuredGateway(t, 1)
			if err := s.queries.SaveTimeZone(context.Background(), zone); err != nil {
				t.Fatal(err)
			}
			zones, err := timezone.New(context.Background(), s.db)
			if err != nil {
				t.Fatal(err)
			}
			s.SetTimeZone(zones)
			index := "usage_daily_user"
			if zone != "UTC" {
				index = "usage_minutes_user"
			}
			if _, err := s.UserStatistics(context.Background(), 1, 90); err != nil {
				t.Fatal(err)
			}
			checked := 0
			for _, query := range meter.take() {
				if !strings.Contains(query.sql, "SUM(s.requests)") {
					continue
				}
				rows, err := s.db.Query("EXPLAIN QUERY PLAN "+query.sql, query.args...)
				if err != nil {
					t.Fatal(err)
				}
				indexed := false
				windowScan, minuteSearch, step := -1, -1, 0
				for rows.Next() {
					var id, parent, unused int
					var detail string
					if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
						t.Fatal(err)
					}
					indexed = indexed || strings.Contains(detail, index)
					if strings.HasPrefix(detail, "SCAN w ") {
						windowScan = step
					}
					if strings.Contains(detail, "SEARCH s USING INDEX usage_minutes_user") {
						minuteSearch = step
					}
					step++
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				rows.Close()
				if !indexed {
					t.Errorf("personal summary scans other users: %s", strings.SplitN(query.sql, "\n", 2)[0])
				}
				if zone != "UTC" && strings.Contains(query.sql, "json_each") && (windowScan < 0 || minuteSearch <= windowScan) {
					t.Error("calendar windows must bound each indexed minute scan, rather than scanning the full period for every day")
				}
				checked++
			}
			if checked != 4 {
				t.Fatalf("checked %d personal summary queries, want 4", checked)
			}
		})
	}
}
