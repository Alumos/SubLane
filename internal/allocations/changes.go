package allocations

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"slices"

	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/storage/db"
)

var (
	ErrVersionRequired   = errors.New("allocation_version_required")
	ErrVersionConflict   = errors.New("allocation_version_conflict")
	ErrEffectiveRequired = errors.New("allocation_effective_at_required")
	ErrEffectiveConflict = errors.New("allocation_effective_at_conflict")
	ErrStateConflict     = errors.New("allocation_state_conflict")
	ErrMemberConflict    = errors.New("allocation_member_conflict")
	ErrFunding           = errors.New("allocation_funding_gap")
	ErrReplacement       = errors.New("allocation_replacement_required")
	ErrInitialSchedule   = errors.New("allocation_initial_schedule_required")
)

// Raw fields preserve the difference between an absent condition and explicit null.
type Conditions struct {
	ExpectedCurrentRevisionID json.RawMessage `json:"expected_current_revision_id,omitempty"`
	ExpectedNextRevisionID    json.RawMessage `json:"expected_next_revision_id,omitempty"`
	ExpectedEffectiveAt       json.RawMessage `json:"expected_effective_at,omitempty"`
}

type WriteConditions struct {
	Current *int64 `json:"expected_current_revision_id"`
	Next    *int64 `json:"expected_next_revision_id"`
}

type MembersInput struct {
	Conditions
	Members []Share `json:"members"`
}

func condition(raw json.RawMessage) (*int64, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value int64
	if json.Unmarshal(raw, &value) != nil || value < 0 {
		return nil, ErrInput
	}
	return &value, nil
}

func effectiveCondition(raw json.RawMessage) (*int64, error) {
	value, err := condition(raw)
	if err != nil {
		return nil, err
	}
	if value != nil && *value > 253402300799 {
		return nil, ErrInput
	}
	return value, nil
}

func checkVersions(in Conditions, state Scheme) error {
	if len(in.ExpectedCurrentRevisionID) == 0 || len(in.ExpectedNextRevisionID) == 0 {
		return ErrVersionRequired
	}
	a, err := condition(in.ExpectedCurrentRevisionID)
	if err != nil {
		return err
	}
	b, err := condition(in.ExpectedNextRevisionID)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(a, state.WriteConditions.Current) || !reflect.DeepEqual(b, state.WriteConditions.Next) {
		return ErrVersionConflict
	}
	return nil
}

func canonicalMembers(members []Share) []Share {
	out := slices.Clone(members)
	for i := range out {
		out[i].WindowOverrides = append([]MemberWindowLimit(nil), out[i].WindowOverrides...)
		slices.SortFunc(out[i].WindowOverrides, func(a, b MemberWindowLimit) int {
			if a.DurationSeconds < b.DurationSeconds {
				return -1
			}
			if a.DurationSeconds > b.DurationSeconds {
				return 1
			}
			return 0
		})
	}
	slices.SortFunc(out, func(a, b Share) int {
		if a.UserID < b.UserID {
			return -1
		}
		if a.UserID > b.UserID {
			return 1
		}
		return 0
	})
	return out
}

func sameMembers(a, b []Share) bool {
	return reflect.DeepEqual(canonicalMembers(a), canonicalMembers(b))
}

func activeRevision(state Scheme) *Revision {
	if state.WriteConditions.Current == nil {
		return nil
	}
	r := state.Revision
	return &r
}

func (s *Service) targetTime(state Scheme, action string, now int64) (int64, error) {
	current := activeRevision(state)
	if action == "reschedule" {
		if state.Next == nil || state.Next.EffectiveAt <= now {
			return 0, ErrEffectiveConflict
		}
		base := current
		if base == nil {
			base = state.Next
		}
		at := nextEffective(base.Config, state.Next.EffectiveAt, s.location(), base.AccountingAnchorAt)
		if at <= state.Next.EffectiveAt || at > 253402300799 {
			return 0, ErrEffectiveConflict
		}
		return at, nil
	}
	if state.Next != nil {
		return state.Next.EffectiveAt, nil
	}
	if current == nil {
		return 0, ErrUnavailable
	}
	return nextEffective(current.Config, now, s.location(), current.AccountingAnchorAt), nil
}

func (s *Service) checkTime(in Conditions, state Scheme, action string) (int64, error) {
	expected, err := effectiveCondition(in.ExpectedEffectiveAt)
	if err != nil {
		return 0, err
	}
	if expected == nil {
		return 0, ErrEffectiveRequired
	}
	now := s.now().Unix()
	target, err := s.targetTime(state, action, now)
	if err != nil {
		return 0, err
	}
	if *expected != target || target <= now || state.Next != nil && state.Next.EffectiveAt <= now {
		return 0, ErrEffectiveConflict
	}
	return target, nil
}

func (s *Service) creationTime(in SchemeInput, now int64) (int64, error) {
	target := now
	if in.StartNext {
		target = nextEffective(in.Config, now, s.location(), now)
	}
	if len(in.ExpectedEffectiveAt) == 0 {
		return target, nil
	}
	expected, err := effectiveCondition(in.ExpectedEffectiveAt)
	if err != nil {
		return 0, err
	}
	if expected == nil {
		return 0, ErrEffectiveRequired
	}
	if !in.StartNext || *expected <= now {
		return 0, ErrEffectiveConflict
	}
	if in.Config.Period == "durations" {
		var longest int64
		for _, w := range in.Config.Windows {
			longest = max(longest, w.DurationSeconds)
		}
		if *expected-now > longest {
			return 0, ErrEffectiveConflict
		}
	} else if *expected != target {
		return 0, ErrEffectiveConflict
	}
	return *expected, nil
}

func (s *Service) validateRecipients(ctx context.Context, q *db.Queries, group int64, members []Share) error {
	for _, m := range members {
		allowed, err := q.CanUseGroup(ctx, db.CanUseGroupParams{UserID: m.UserID, GroupID: group})
		if err != nil {
			return err
		}
		if !allowed {
			return ErrInput
		}
	}
	return nil
}

func appendRevision(ctx context.Context, q *db.Queries, scheme, at, anchor int64, config Config) (int64, error) {
	raw, err := json.Marshal(config)
	if err != nil {
		return 0, err
	}
	return q.SaveAllocationRevision(ctx, db.SaveAllocationRevisionParams{SchemeID: scheme, EffectiveAt: at, AccountingAnchorAt: anchor, Config: string(raw)})
}

func (s *Service) checkFunding(ctx context.Context, q *db.Queries, id int64, current Revision, proposed Config, now int64) error {
	if current.Config.Mode != "ratio" {
		return nil
	}
	windows := effectiveWindows(current, now, s.location())
	accounting := newAccounting(q, id, current, windows)
	for _, window := range windows {
		group, err := accounting.group(ctx, window)
		if err != nil {
			return err
		}
		required := group.used + group.held
		for _, member := range proposed.Members {
			state, err := accounting.member(ctx, member, proposed, window)
			if err != nil {
				return err
			}
			required += max(0, state.limit-state.used-state.risk.reserved)
		}
		if required > window.total(current.Config) {
			// Revocation/reduction is allowed after an overage; it must not fund a new recipient.
			for _, m := range proposed.Members {
				old := int64(0)
				for _, c := range current.Config.Members {
					if c.UserID == m.UserID {
						old = memberLimit(current.Config, c, window)
					}
				}
				if memberLimit(proposed, m, window) > old {
					return ErrFunding
				}
			}
		}
	}
	return nil
}

func (s *Service) applyMembers(ctx context.Context, q *db.Queries, state Scheme, members []Share, now int64) error {
	current := activeRevision(state)
	if current == nil {
		return ErrInitialSchedule
	}
	proposed := current.Config
	proposed.Members = canonicalMembers(members)
	if err := normalize(&proposed); err != nil {
		return err
	}
	if err := s.validateRecipients(ctx, q, state.GroupID, proposed.Members); err != nil {
		return err
	}
	if sameMembers(current.Config.Members, proposed.Members) {
		return nil
	}
	var nextConfig Config
	if state.Next != nil {
		if !sameMembers(current.Config.Members, state.Next.Config.Members) {
			return ErrMemberConflict
		}
		if (current.Config.Mode != "ratio" || state.Next.Config.Mode != "ratio") && !sameSchedule(current.Config, state.Next.Config) {
			return ErrMemberConflict
		}
		nextConfig = state.Next.Config
		nextConfig.Members = proposed.Members
		if err := normalize(&nextConfig); err != nil {
			return ErrMemberConflict
		}
	}
	if err := s.checkFunding(ctx, q, state.ID, *current, proposed, now); err != nil {
		return err
	}
	if _, err := appendRevision(ctx, q, state.ID, now, current.AccountingAnchorAt, proposed); err != nil {
		return err
	}
	if state.Next != nil {
		if _, err := appendRevision(ctx, q, state.ID, state.Next.EffectiveAt, state.Next.AccountingAnchorAt, nextConfig); err != nil {
			return err
		}
	}
	return audit.Record(ctx, q, "allocation.save", "allocation", audit.ID(state.ID))
}

func (s *Service) finishChange(ctx context.Context, tx *sql.Tx, q *db.Queries, state Scheme, in Conditions, action string) (Scheme, error) {
	if state.Next != nil && state.Next.EffectiveAt <= s.now().Unix() {
		return Scheme{}, ErrVersionConflict
	}
	out, err := s.readScheme(ctx, q, state.ID, s.now().Unix())
	if err != nil {
		return out, err
	}
	if state.Next != nil && state.Next.EffectiveAt <= s.now().Unix() {
		return Scheme{}, ErrVersionConflict
	}
	if action != "" {
		if _, err := s.checkTime(in, state, action); err != nil {
			return Scheme{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Scheme{}, err
	}
	return out, nil
}

func (s *Service) UpdateMembers(ctx context.Context, id int64, in MembersInput) (Scheme, error) {
	tx, err := s.conn.BeginTx(ctx, nil)
	if err != nil {
		return Scheme{}, err
	}
	defer tx.Rollback()
	q := db.New(tx)
	state, err := s.readSchemeCore(ctx, q, id, s.now().Unix())
	if err != nil {
		return Scheme{}, err
	}
	if err := checkVersions(in.Conditions, state); err != nil {
		return Scheme{}, err
	}
	if err := s.applyMembers(ctx, q, state, in.Members, s.now().Unix()); err != nil {
		return Scheme{}, err
	}
	return s.finishChange(ctx, tx, q, state, in.Conditions, "")
}

func (s *Service) updateScheme(ctx context.Context, id int64, in SchemeInput) (Scheme, error) {
	tx, err := s.conn.BeginTx(ctx, nil)
	if err != nil {
		return Scheme{}, err
	}
	defer tx.Rollback()
	q := db.New(tx)
	now := s.now().Unix()
	state, err := s.readSchemeCore(ctx, q, id, now)
	if err != nil {
		return Scheme{}, err
	}
	if in.GroupID != state.GroupID {
		return Scheme{}, ErrInput
	}
	if err := checkVersions(in.Conditions, state); err != nil {
		return Scheme{}, err
	}
	if (in.enabledProvided || in.Enabled) && in.Enabled != state.Enabled {
		return Scheme{}, ErrStateConflict
	}
	if in.ApplyNow {
		if in.ConfirmReplacement {
			return Scheme{}, ErrReplacement
		}
		current := activeRevision(state)
		if current == nil {
			return Scheme{}, ErrInitialSchedule
		}
		compatible := sameSchedule(in.Config, current.Config) && in.Config.Total == current.Config.Total && in.Config.RatioUnit == current.Config.RatioUnit
		for _, a := range in.Config.Windows {
			for _, b := range current.Config.Windows {
				if a.DurationSeconds == b.DurationSeconds && a.Limit != b.Limit {
					compatible = false
				}
			}
		}
		if len(in.Config.Rates) > 0 && !reflect.DeepEqual(in.Config.Rates, current.Config.Rates) || in.Config.autoPrices() != current.Config.autoPrices() {
			compatible = false
		}
		if !compatible || in.Name != state.Name {
			return Scheme{}, ErrStateConflict
		}
		if err := s.applyMembers(ctx, q, state, in.Config.Members, now); err != nil {
			return Scheme{}, err
		}
		return s.finishChange(ctx, tx, q, state, in.Conditions, "")
	}
	base := &state.Revision
	if state.Next != nil {
		base = state.Next
	}
	initial := activeRevision(state) == nil && state.Next != nil
	membersChanged := !sameMembers(base.Config.Members, in.Config.Members)
	comparison := base
	if in.ConfirmReplacement && activeRevision(state) != nil {
		comparison = activeRevision(state)
	}
	structural := !sameSchedule(comparison.Config, in.Config)
	if structural != in.ConfirmReplacement {
		return Scheme{}, ErrReplacement
	}
	if !structural && membersChanged && !initial {
		return Scheme{}, ErrMemberConflict
	}
	if initial && membersChanged {
		// Captured history proves prior publication even if a clock change makes current disappear.
		published, err := q.AllocationHasEntries(ctx, id)
		if err != nil {
			return Scheme{}, err
		}
		if published {
			return Scheme{}, ErrStateConflict
		}
	}
	previous := append([]Rate(nil), state.Config.Rates...)
	if state.Next != nil {
		previous = append(previous, state.Next.Config.Rates...)
	}
	if _, err := s.applyPrices(ctx, q, state.GroupID, &in.Config, previous); err != nil {
		return Scheme{}, err
	}
	if err := normalize(&in.Config); err != nil {
		return Scheme{}, err
	}
	// Ordinary edits retain the exact member section; independent revocation must not block them.
	if structural || initial && membersChanged {
		if err := s.validateRecipients(ctx, q, state.GroupID, in.Config.Members); err != nil {
			return Scheme{}, err
		}
	}
	at, err := s.checkTime(in.Conditions, state, "schedule")
	if err != nil {
		return Scheme{}, err
	}
	anchor := base.AccountingAnchorAt
	if structural {
		anchor = at
	}
	if _, err := appendRevision(ctx, q, id, at, anchor, in.Config); err != nil {
		return Scheme{}, err
	}
	if err := q.UpdateAllocationScheme(ctx, db.UpdateAllocationSchemeParams{ID: id, Name: in.Name, Enabled: bit(state.Enabled)}); err != nil {
		return Scheme{}, err
	}
	if err := audit.Record(ctx, q, "allocation.save", "allocation", audit.ID(id)); err != nil {
		return Scheme{}, err
	}
	if _, err := s.checkTime(in.Conditions, state, "schedule"); err != nil {
		return Scheme{}, err
	}
	return s.finishChange(ctx, tx, q, state, in.Conditions, "schedule")
}
