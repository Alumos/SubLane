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
	firstHour := start - start%3600
	// Count only elapsed/started hourly windows. Pre-migration and future slots are not zero activity.
	// The first and current hours may be partial; the coverage timestamps expose those bounds.
	for hour := firstHour; hour <= result.ObservedUntil; hour += 3600 {
		result.Cells[activityIndex(hour, location)].Samples++
	}
	rows, err := q.ListHourlyActivity(ctx, db.ListHourlyActivityParams{TenantID: tenantID, UserID: userID, KeyID: keyID, FromHour: firstHour, ToHour: result.ObservedUntil - result.ObservedUntil%3600 + 3600})
	if err != nil {
		return result, err
	}
	for _, row := range rows {
		cell := &result.Cells[activityIndex(row.Hour, location)]
		cell.Requests += row.Requests
		cell.InputTokens += row.InputTokens
		cell.OutputTokens += row.OutputTokens
		cell.InputReported += row.InputReported
		cell.OutputReported += row.OutputReported
	}
	return result, nil
}

func activityIndex(hour int64, location *time.Location) int {
	// UTC buckets are indivisible; use their start and historical offset, including DST changes.
	stamp := time.Unix(hour, 0).In(location)
	return (int(stamp.Weekday())+6)%7*24 + stamp.Hour()
}
