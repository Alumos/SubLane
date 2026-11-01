package gateway

import (
	"context"
	"strconv"
	"time"

	"github.com/murongg/SubLane/internal/storage/db"
)

type ActivityCell struct {
	Weekday        int64 `json:"weekday"`
	Hour           int64 `json:"hour"`
	Samples        int64 `json:"samples"`
	Requests       int64 `json:"requests"`
	InputTokens    int64 `json:"input_tokens"`
	OutputTokens   int64 `json:"output_tokens"`
	InputReported  int64 `json:"input_reported"`
	OutputReported int64 `json:"output_reported"`
}

type Activity struct {
	TimeZone      string         `json:"time_zone"`
	TrackingSince int64          `json:"tracking_since"`
	ObservedUntil int64          `json:"observed_until"`
	Cells         []ActivityCell `json:"cells"`
}

func readActivity(ctx context.Context, q *db.Queries, tenantID, userID, keyID, from, to, now int64, location *time.Location) (Activity, error) {
	precise := activityNeedsMinutes(from, to, location)
	result := Activity{TimeZone: location.String(), Cells: make([]ActivityCell, 168), ObservedUntil: min(now, to-1)}
	for i := range result.Cells {
		result.Cells[i].Weekday = int64(i / 24)
		result.Cells[i].Hour = int64(i % 24)
	}
	coverage, err := q.GetHourlyCoverage(ctx)
	if err != nil {
		return result, err
	}
	since, err := strconv.ParseInt(coverage, 10, 64)
	if err != nil {
		return result, err
	}
	if precise {
		coverage, err := q.GetMinuteCoverage(ctx)
		if err != nil {
			return result, err
		}
		minuteSince, err := strconv.ParseInt(coverage, 10, 64)
		if err != nil {
			return result, err
		}
		since = max(since, minuteSince)
	}
	if keyID != 0 {
		coverage, err := q.GetKeyStatisticsCoverage(ctx)
		if err != nil {
			return result, err
		}
		keySince, err := strconv.ParseInt(coverage, 10, 64)
		if err != nil {
			return result, err
		}
		// Legacy hourly buckets have no key attribution; those hours must remain unobserved.
		since = max(since, keySince)
	}
	result.TrackingSince = since
	start := max(from, since)
	if start > result.ObservedUntil {
		return result, nil
	}
	step := int64(3600)
	if precise {
		step = 60
	}
	first := start - start%step
	// Count distinct observed local-hour occurrences; repeated DST hours remain two samples.
	previousHour := int64(-1)
	for stamp := first; stamp <= result.ObservedUntil; stamp += step {
		local := time.Unix(stamp, 0).In(location)
		hour := stamp - int64(local.Minute()*60+local.Second())
		if hour != previousHour {
			result.Cells[activityIndex(stamp, location)].Samples++
			previousHour = hour
		}
	}
	add := func(stamp, requests, input, output, inputReported, outputReported int64) {
		cell := &result.Cells[activityIndex(stamp, location)]
		cell.Requests += requests
		cell.InputTokens += input
		cell.OutputTokens += output
		cell.InputReported += inputReported
		cell.OutputReported += outputReported
	}
	end := result.ObservedUntil - result.ObservedUntil%step + step
	if precise {
		rows, err := q.ListMinuteActivity(ctx, db.ListMinuteActivityParams{TenantID: tenantID, UserID: userID, KeyID: keyID, FromMinute: first, ToMinute: end})
		if err != nil {
			return result, err
		}
		for _, row := range rows {
			add(row.Minute, row.Requests, row.InputTokens, row.OutputTokens, row.InputReported, row.OutputReported)
		}
	} else {
		rows, err := q.ListHourlyActivity(ctx, db.ListHourlyActivityParams{TenantID: tenantID, UserID: userID, KeyID: keyID, FromHour: first, ToHour: end})
		if err != nil {
			return result, err
		}
		for _, row := range rows {
			add(row.Hour, row.Requests, row.InputTokens, row.OutputTokens, row.InputReported, row.OutputReported)
		}
	}
	return result, nil
}

func activityIndex(hour int64, location *time.Location) int {
	stamp := time.Unix(hour, 0).In(location)
	return (int(stamp.Weekday())+6)%7*24 + stamp.Hour()
}

func activityNeedsMinutes(from, to int64, location *time.Location) bool {
	if from%3600 != 0 || to%3600 != 0 {
		return true
	}
	// Preserve historical hourly data whenever every local hour aligns with a stored UTC hour.
	for stamp := time.Unix(from, 0); stamp.Unix() < to; {
		local := stamp.In(location)
		_, offset := local.Zone()
		if offset%3600 != 0 {
			return true
		}
		_, next := local.ZoneBounds()
		if next.IsZero() {
			break
		}
		stamp = next
	}
	return false
}
