package allocations

import (
	"context"
	"sort"

	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/storage/db"
)

// BackfillPrices adds catalog prices for pool models that a rule's active or pending revision has
// not priced yet, so a newly listed model works without waiting for the next period.
//
// Accounting stays exact: requests for an unpriced model were rejected, so no settled entry used
// the missing price, and every existing rate is copied unchanged. The active revision is followed
// by a revision effective now on the same accounting anchor (usage continues in the same windows);
// a pending revision is replaced at its own effective time. Rules with AutoPrices off are skipped.
func (s *Service) BackfillPrices(ctx context.Context, id int64) (int, error) {
	if s.pricing == nil {
		return 0, nil
	}
	tx, err := s.conn.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	q := db.New(tx)
	now := s.now().Unix()
	state, err := s.readSchemeCore(ctx, q, id, now)
	if err != nil {
		return 0, err
	}
	catalog, err := loadPoolModelCatalog(ctx, q, state.GroupID)
	if err != nil {
		return 0, err
	}
	extend := func(config Config) (Config, int) {
		if !pricedConfig(config) || !config.autoPrices() {
			return config, 0
		}
		priced := make(map[string]bool, len(config.Rates))
		for _, rate := range config.Rates {
			priced[rate.Model] = true
		}
		rates := append([]Rate(nil), config.Rates...)
		for _, model := range catalog.models {
			if priced[model] {
				continue
			}
			if price, ok := s.pricing.Lookup(model); ok {
				rates = append(rates, Rate{Model: model, Input: price.Input, Cached: price.Cached, Output: price.Output, ImageInput: price.ImageInput})
			}
		}
		added := len(rates) - len(config.Rates)
		sort.Slice(rates, func(i, j int) bool { return rates[i].Model < rates[j].Model })
		config.Rates = rates
		return config, added
	}
	total := 0
	if active := activeRevision(state); active != nil {
		if config, added := extend(active.Config); added > 0 {
			if _, err := appendRevision(ctx, q, id, now, active.AccountingAnchorAt, config); err != nil {
				return 0, err
			}
			total += added
		}
	}
	if next := state.Next; next != nil && next.EffectiveAt > now {
		if config, added := extend(next.Config); added > 0 {
			if err := q.DeleteAllocationPendingAt(ctx, db.DeleteAllocationPendingAtParams{SchemeID: id, EffectiveAt: next.EffectiveAt, Now: now}); err != nil {
				return 0, err
			}
			if _, err := appendRevision(ctx, q, id, next.EffectiveAt, next.AccountingAnchorAt, config); err != nil {
				return 0, err
			}
			total += added
		}
	}
	if total == 0 {
		return 0, nil
	}
	if err := audit.Record(ctx, q, "allocation.prices", "allocation", audit.ID(id)); err != nil {
		return 0, err
	}
	return total, tx.Commit()
}
