package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/murongg/SubLane/internal/accounts"
	"github.com/murongg/SubLane/internal/apikey"
	"github.com/murongg/SubLane/internal/storage/db"
	"github.com/murongg/SubLane/internal/timezone"
)

type Metrics struct {
	Requests       int64 `json:"requests"`
	Completed      int64 `json:"completed"`
	Incomplete     int64 `json:"incomplete"`
	Errors         int64 `json:"errors"`
	Canceled       int64 `json:"canceled"`
	Rejected       int64 `json:"rejected"`
	DurationMs     int64 `json:"duration_ms"`
	InputTokens    int64 `json:"input_tokens"`
	OutputTokens   int64 `json:"output_tokens"`
	CachedTokens   int64 `json:"cached_tokens"`
	InputReported  int64 `json:"input_reported"`
	OutputReported int64 `json:"output_reported"`
	CachedReported int64 `json:"cached_reported"`
}
type Statistic struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Metrics
}
type Statistics struct {
	TimeZone      string      `json:"time_zone"`
	FromDay       int64       `json:"from_day"`
	ToDay         int64       `json:"to_day"`
	TrackingSince int64       `json:"tracking_since"`
	Totals        Metrics     `json:"totals"`
	Days          []Statistic `json:"days"`
	Members       []Statistic `json:"members"`
	Models        []Statistic `json:"models"`
	Groups        []Statistic `json:"groups"`
	Activity      Activity    `json:"activity"`
}

func (s *Service) Statistics(ctx context.Context, days int64) (Statistics, error) {
	return s.statistics(ctx, 0, days, 0)
}
func (s *Service) UserStatistics(ctx context.Context, userID, days int64) (Statistics, error) {
	if userID <= 0 {
		return Statistics{}, accounts.ErrInput
	}
	return s.statistics(ctx, userID, days, 0)
}
func (s *Service) UserKeyStatistics(ctx context.Context, userID, keyID, days int64) (Statistics, error) {
	if userID <= 0 || keyID <= 0 {
		return Statistics{}, accounts.ErrInput
	}
	return s.statistics(ctx, userID, days, keyID)
}
func (s *Service) statistics(ctx context.Context, userID, days, keyID int64) (Statistics, error) {
	if days != 1 && days != 7 && days != 30 && days != 90 {
		return Statistics{}, accounts.ErrInput
	}
	location := s.location()
	now := s.now()
	windows := calendarWindows(now, days, location)
	// Legacy daily counters are exact only when every requested civil day matches a UTC day.
	legacy := true
	for _, window := range windows {
		legacy = legacy && window[0]%86400 == 0 && window[1]-window[0] == 86400
	}
	page := Statistics{TimeZone: location.String(), FromDay: windows[0][0], ToDay: windows[len(windows)-1][1], Days: []Statistic{}, Members: []Statistic{}, Models: []Statistic{}, Groups: []Statistic{}}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	q := s.queries.WithTx(tx)
	if keyID != 0 {
		// Revoked keys keep their usage, but ownership and workspace still gate every read.
		if _, err := q.GetKey(ctx, db.GetKeyParams{ID: keyID, UserID: userID, TenantID: s.tenantID}); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return page, apikey.ErrNotFound
			}
			return page, err
		}
	}
	// All summaries use one snapshot; concurrent completions cannot make totals and breakdowns disagree.
	page.Activity, err = readActivity(ctx, q, s.tenantID, userID, keyID, page.FromDay, page.ToDay, now.Unix(), location)
	if err != nil {
		return page, err
	}
	var coverage string
	if legacy {
		coverage, err = q.GetStatisticsCoverage(ctx)
	} else {
		coverage, err = q.GetMinuteCoverage(ctx)
	}
	if err != nil {
		return page, err
	}
	// Invalid coverage must fail explicitly instead of presenting an unobserved period as zero.
	page.TrackingSince, err = strconv.ParseInt(coverage, 10, 64)
	if err != nil {
		return page, err
	}
	if keyID != 0 {
		coverage, err = q.GetKeyStatisticsCoverage(ctx)
		if err != nil {
			return page, err
		}
		keySince, err := strconv.ParseInt(coverage, 10, 64)
		if err != nil {
			return page, err
		}
		if legacy {
			page.TrackingSince = keySince
		} else {
			page.TrackingSince = max(page.TrackingSince, keySince)
		}
	}
	from := page.FromDay
	if !legacy {
		// The first collected minute may be partial; its counters contain only new observations.
		from = max(from, page.TrackingSince-page.TrackingSince%60)
	}
	var totals db.GetStatisticsTotalsRow
	if !legacy && userID == 0 {
		minuteTotals, readErr := q.GetMinuteStatisticsTotals(ctx, db.GetMinuteStatisticsTotalsParams{TenantID: s.tenantID, FromDay: from, ToDay: page.ToDay})
		totals, err = db.GetStatisticsTotalsRow(minuteTotals), readErr
	} else if !legacy {
		minuteTotals, readErr := q.GetUserMinuteStatisticsTotals(ctx, db.GetUserMinuteStatisticsTotalsParams{TenantID: s.tenantID, FromDay: from, ToDay: page.ToDay, UserID: userID, KeyID: keyID})
		totals, err = db.GetStatisticsTotalsRow(minuteTotals), readErr
	} else if userID == 0 {
		totals, err = q.GetStatisticsTotals(ctx, db.GetStatisticsTotalsParams{TenantID: s.tenantID, FromDay: page.FromDay, ToDay: page.ToDay})
	} else {
		personal, readErr := q.GetUserStatisticsTotals(ctx, db.GetUserStatisticsTotalsParams{TenantID: s.tenantID, FromDay: page.FromDay, ToDay: page.ToDay, UserID: userID, KeyID: keyID})
		totals, err = db.GetStatisticsTotalsRow(personal), readErr
	}
	if err != nil {
		return page, err
	}
	page.Totals = Metrics(totals)
	list := func(dimension string, maxRows int64) ([]Statistic, error) {
		var rows []db.ListStatisticsRow
		var err error
		// Separate SQL keeps the personal equality filter usable by SQLite's user/day index.
		if !legacy {
			bounds := [][2]int64{{page.FromDay, page.ToDay}}
			if dimension == "day" {
				bounds = windows
			}
			encoded, encodeErr := json.Marshal(bounds)
			if encodeErr != nil {
				return nil, encodeErr
			}
			if userID == 0 {
				minutes, readErr := q.ListMinuteStatistics(ctx, db.ListMinuteStatisticsParams{TenantID: s.tenantID, Dimension: dimension, FromDay: from, ToDay: page.ToDay, Windows: string(encoded), MaxRows: maxRows})
				err = readErr
				for _, row := range minutes {
					rows = append(rows, db.ListStatisticsRow(row))
				}
			} else {
				minutes, readErr := q.ListUserMinuteStatistics(ctx, db.ListUserMinuteStatisticsParams{TenantID: s.tenantID, Dimension: dimension, FromDay: from, ToDay: page.ToDay, Windows: string(encoded), MaxRows: maxRows, UserID: userID, KeyID: keyID})
				err = readErr
				for _, row := range minutes {
					rows = append(rows, db.ListStatisticsRow(row))
				}
			}
		} else if userID == 0 {
			rows, err = q.ListStatistics(ctx, db.ListStatisticsParams{TenantID: s.tenantID, Dimension: dimension, FromDay: page.FromDay, ToDay: page.ToDay, MaxRows: maxRows})
		} else {
			personal, readErr := q.ListUserStatistics(ctx, db.ListUserStatisticsParams{TenantID: s.tenantID, Dimension: dimension, FromDay: page.FromDay, ToDay: page.ToDay, UserID: userID, KeyID: keyID, MaxRows: maxRows})
			err = readErr
			for _, row := range personal {
				rows = append(rows, db.ListStatisticsRow(row))
			}
		}
		if err != nil {
			return nil, err
		}
		values := make([]Statistic, 0, len(rows))
		for _, r := range rows {
			values = append(values, Statistic{ID: r.Bucket, Name: r.Name, Metrics: Metrics{Requests: r.Requests, Completed: r.Completed, Incomplete: r.Incomplete, Errors: r.Errors, Canceled: r.Canceled, Rejected: r.Rejected, DurationMs: r.DurationMs, InputTokens: r.InputTokens, OutputTokens: r.OutputTokens, CachedTokens: r.CachedTokens, InputReported: r.InputReported, OutputReported: r.OutputReported, CachedReported: r.CachedReported}})
		}
		return values, nil
	}
	daily, err := list("day", 90)
	if err != nil {
		return page, err
	}
	byDay := make(map[string]Statistic, len(daily))
	for _, d := range daily {
		byDay[d.ID] = d
	}
	for _, window := range windows {
		day := window[0]
		id := strconv.FormatInt(day, 10)
		row := byDay[id]
		row.ID = id
		row.Name = time.Unix(day, 0).In(location).Format("2006-01-02")
		page.Days = append(page.Days, row)
	}
	if page.Models, err = list("model", 20); err != nil {
		return page, err
	}
	if page.Groups, err = list("group", 20); err != nil {
		return page, err
	}
	if userID == 0 {
		if page.Members, err = list("member", 20); err != nil {
			return page, err
		}
	}
	return page, tx.Commit()
}

func recordStatistics(ctx context.Context, q *db.Queries, r db.RecordRequestParams) error {
	if r.UserID <= 0 {
		return nil
	}
	model := r.Model
	if r.Provider != "" && model != "" {
		model = r.Provider + "/" + strings.TrimPrefix(model, r.Provider+"/")
	}
	// Model names are client-controlled. Bound new labels while retaining every request in totals.
	tracked, err := q.CanTrackStatisticsModel(ctx, db.CanTrackStatisticsModelParams{GroupID: r.GroupID, Day: r.StartedAt - r.StartedAt%86400, UserID: r.UserID, Model: model})
	if err != nil {
		return err
	}
	if tracked == 0 {
		model = "[other models]"
	}
	// Preserve UTC history; the minute counters below supply local calendar boundaries.
	entry := db.RecordStatisticsParams{Day: r.StartedAt - r.StartedAt%86400, UserID: r.UserID, KeyID: r.KeyID, GroupID: r.GroupID, Provider: r.Provider, Model: model, Requests: 1, DurationMs: r.DurationMs}
	switch r.Outcome {
	case "success":
		entry.Completed = 1
		// Completion survives bounded history cleanup and commits with the request's accounting.
		if err := q.RecordFirstRequest(ctx, db.RecordFirstRequestParams{UserID: r.UserID, GroupID: r.GroupID, StartedAt: r.StartedAt}); err != nil {
			return err
		}
	case "incomplete":
		entry.Incomplete = 1
	case "error":
		entry.Errors = 1
	case "canceled":
		entry.Canceled = 1
	case "rejected":
		entry.Rejected = 1
	}
	if r.InputTokens != nil {
		entry.InputTokens = *r.InputTokens
		entry.InputReported = 1
	}
	if r.OutputTokens != nil {
		entry.OutputTokens = *r.OutputTokens
		entry.OutputReported = 1
	}
	if r.CachedTokens != nil {
		entry.CachedTokens = *r.CachedTokens
		entry.CachedReported = 1
	}
	if err := q.RecordStatistics(ctx, entry); err != nil {
		return err
	}
	if err := q.RecordMinuteStatistics(ctx, db.RecordMinuteStatisticsParams{
		Minute: r.StartedAt - r.StartedAt%60, UserID: entry.UserID, KeyID: entry.KeyID, GroupID: entry.GroupID,
		Provider: entry.Provider, Model: entry.Model, Requests: entry.Requests, Completed: entry.Completed,
		Incomplete: entry.Incomplete, Errors: entry.Errors, Canceled: entry.Canceled, Rejected: entry.Rejected,
		DurationMs: entry.DurationMs, InputTokens: entry.InputTokens, OutputTokens: entry.OutputTokens, CachedTokens: entry.CachedTokens,
		InputReported: entry.InputReported, OutputReported: entry.OutputReported, CachedReported: entry.CachedReported,
	}); err != nil {
		return err
	}
	return q.RecordHourlyUsage(ctx, db.RecordHourlyUsageParams{GroupID: r.GroupID, Hour: r.StartedAt - r.StartedAt%3600, UserID: r.UserID, KeyID: r.KeyID, Requests: entry.Requests, InputTokens: entry.InputTokens, OutputTokens: entry.OutputTokens, InputReported: entry.InputReported, OutputReported: entry.OutputReported})
}

func calendarWindows(now time.Time, days int64, location *time.Location) [][2]int64 {
	local := now.In(location)
	date := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1-int(days))
	windows := make([][2]int64, 0, days)
	for i := int64(0); i < days; i++ {
		next := date.AddDate(0, 0, 1)
		start := timezone.DayStart(date.Year(), date.Month(), date.Day(), location).Unix()
		end := timezone.DayStart(next.Year(), next.Month(), next.Day(), location).Unix()
		// A civil date skipped by a time-zone transition has no reporting window.
		if start < end {
			windows = append(windows, [2]int64{start, end})
		}
		date = next
	}
	return windows
}
