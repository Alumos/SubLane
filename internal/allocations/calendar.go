package allocations

import (
	"regexp"
	"strconv"
	"time"

	"github.com/murongg/SubLane/internal/timezone"
)

var resetClock = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)

func validPeriod(c Config) bool {
	if !validResetSchedule(c) {
		return false
	}
	if c.Period == "durations" {
		return c.Mode == "windows" || c.Mode == "ratio"
	}
	return (c.Period == "day" || c.Period == "month") && c.Mode != "windows"
}

func sameSchedule(a, b Config) bool {
	if !validPeriod(a) || !validPeriod(b) {
		return false
	}
	if a.Mode != b.Mode || entryMode(a) != entryMode(b) || a.Period != b.Period || resetMinutes(a) != resetMinutes(b) || max(1, a.ResetDay) != max(1, b.ResetDay) || len(a.Windows) != len(b.Windows) {
		return false
	}
	for _, x := range a.Windows {
		found := false
		for _, y := range b.Windows {
			found = found || x.DurationSeconds == y.DurationSeconds
		}
		if !found {
			return false
		}
	}
	return true
}

func validResetSchedule(c Config) bool {
	if c.Period == "durations" {
		return c.ResetTime == "" && c.ResetDay == 0
	}
	if c.ResetTime != "" && !resetClock.MatchString(c.ResetTime) {
		return false
	}
	if c.Period == "day" {
		return c.ResetDay == 0
	}
	return c.ResetDay >= 0 && c.ResetDay <= 31
}

func resetMinutes(c Config) int {
	if c.ResetTime == "" {
		return 0
	}
	hour, _ := strconv.Atoi(c.ResetTime[:2])
	minute, _ := strconv.Atoi(c.ResetTime[3:])
	return hour*60 + minute
}

func Window(now time.Time, c Config, location *time.Location) (int64, int64) {
	local := now.In(location)
	date := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	if c.Period == "month" {
		date = time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, time.UTC)
	}
	current := resetOn(date, c, location)
	if now.Before(current) {
		if c.Period == "month" {
			return resetOn(date.AddDate(0, -1, 0), c, location).Unix(), current.Unix()
		}
		return resetOn(date.AddDate(0, 0, -1), c, location).Unix(), current.Unix()
	}
	if c.Period == "month" {
		return current.Unix(), resetOn(date.AddDate(0, 1, 0), c, location).Unix()
	}
	return current.Unix(), resetOn(date.AddDate(0, 0, 1), c, location).Unix()
}

func resetOn(date time.Time, c Config, location *time.Location) time.Time {
	day := date.Day()
	if c.Period == "month" {
		day = max(1, c.ResetDay)
		last := time.Date(date.Year(), date.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
		// A missing 29th–31st resets on the month's last day, then resumes the chosen day next month.
		day = min(day, last)
	}
	return wallTime(date.Year(), date.Month(), day, resetMinutes(c), location)
}

func wallTime(year int, month time.Month, day, minute int, location *time.Location) time.Time {
	start := timezone.DayStart(year, month, day, location)
	next := time.Date(year, month, day+1, 0, 0, 0, 0, time.UTC)
	end := timezone.DayStart(next.Year(), next.Month(), next.Day(), location)
	want := time.Date(year, month, day, 0, 0, 0, 0, time.UTC).Add(time.Duration(minute) * time.Minute)
	// Walk offset segments in order so skipped times use the next valid instant and repeated times use the first occurrence.
	for segment := start; segment.Before(end); {
		_, offset := segment.In(location).Zone()
		_, boundary := segment.In(location).ZoneBounds()
		if boundary.IsZero() || boundary.After(end) {
			boundary = end
		}
		candidate := want.Add(-time.Duration(offset) * time.Second)
		if candidate.Before(segment) {
			candidate = segment
		}
		if candidate.Before(boundary) {
			return candidate
		}
		segment = boundary
	}
	return end
}

type allocationWindow struct {
	kind       string
	start, end int64
	seconds    int64
	limit      int64
}

func durationWindow(now, anchor, seconds int64) allocationWindow {
	if now < anchor {
		return allocationWindow{start: anchor, end: anchor + seconds}
	}
	start := anchor + (now-anchor)/seconds*seconds
	return allocationWindow{start: start, end: start + seconds}
}

func effectiveWindows(rev Revision, now int64, location *time.Location) []allocationWindow {
	if rev.Config.Period == "durations" {
		windows := make([]allocationWindow, 0, len(rev.Config.Windows))
		for _, condition := range rev.Config.Windows {
			window := durationWindow(now, rev.AccountingAnchorAt, condition.DurationSeconds)
			window.kind = "duration"
			window.seconds = condition.DurationSeconds
			window.limit = condition.Limit
			windows = append(windows, window)
		}
		return windows
	}
	start, end := Window(unix(now), rev.Config, location)
	return []allocationWindow{{kind: rev.Config.Period, start: max(start, rev.AccountingAnchorAt), end: end}}
}

func nextEffective(c Config, now int64, location *time.Location, anchor int64) int64 {
	if c.Period == "durations" {
		longest := int64(0)
		for _, condition := range c.Windows {
			longest = max(longest, condition.DurationSeconds)
		}
		return durationWindow(now, anchor, longest).end
	}
	_, end := Window(unix(now), c, location)
	return end
}
