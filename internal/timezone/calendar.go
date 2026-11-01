package timezone

import "time"

// DayStart returns the first instant of a civil date, including skipped or repeated midnight.
func DayStart(year int, month time.Month, day int, location *time.Location) time.Time {
	date := func(v time.Time) bool {
		return v.Year() == year && v.Month() == month && v.Day() == day
	}
	guess := time.Date(year, month, day, 0, 0, 0, 0, location)
	if local := guess.In(location); date(local) && local.Hour() == 0 && local.Minute() == 0 && !date(guess.Add(-time.Second).In(location)) {
		return guess
	}
	// Midnight may be skipped or repeated. Find the first instant in the target civil day.
	base := time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
	lo, hi := base.Add(-48*time.Hour).Unix(), base.Add(48*time.Hour).Unix()
	for lo < hi {
		mid := lo + (hi-lo)/2
		local := time.Unix(mid, 0).In(location)
		if local.Year() > year || local.Year() == year && (local.Month() > month || local.Month() == month && local.Day() >= day) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return time.Unix(lo, 0)
}
