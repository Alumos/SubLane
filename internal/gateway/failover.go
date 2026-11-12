package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
)

// Quota failover lets a resource group move an existing Responses conversation off a
// quota-exhausted account. Encrypted reasoning and compaction state belongs to the account that
// produced it, so the binding remembers fingerprints of every encrypted item present when it moved
// and those items are withheld from the new account on this and later turns.

const (
	stateDigestSize = 16
	// Bounds the fingerprint column (migration 035 allows 65,536 bytes).
	foreignStateLimit = 4096
)

type stateDigest [stateDigestSize]byte

// quotaFailover is owned by one Open call; selection fills Strip for the account it leased.
type quotaFailover struct {
	// Movable is false when the request references provider-held state SubLane cannot replay.
	Movable bool
	// Present fingerprints encrypted items carried by the current request.
	Present []stateDigest
	// Strip lists fingerprints the leased account must not receive.
	Strip map[stateDigest]bool
}

type failoverKey struct{}

func withQuotaFailover(ctx context.Context, carrier *quotaFailover) context.Context {
	return context.WithValue(ctx, failoverKey{}, carrier)
}

func quotaFailoverFrom(ctx context.Context) *quotaFailover {
	carrier, _ := ctx.Value(failoverKey{}).(*quotaFailover)
	return carrier
}

func fingerprint(encrypted json.RawMessage) stateDigest {
	// Hash the decoded token so equivalent JSON escaping yields one fingerprint.
	value := []byte(encrypted)
	var text string
	if json.Unmarshal(encrypted, &text) == nil {
		value = []byte(text)
	}
	sum := sha256.Sum256(value)
	var digest stateDigest
	copy(digest[:], sum[:])
	return digest
}

type stateItem struct {
	Type             string          `json:"type"`
	EncryptedContent json.RawMessage `json:"encrypted_content"`
}

func (item stateItem) encrypted() bool {
	return len(item.EncryptedContent) > 0 && string(item.EncryptedContent) != "null"
}

func newQuotaFailover(input map[string]json.RawMessage, kind Kind) *quotaFailover {
	carrier := &quotaFailover{}
	if kind != Responses && kind != Compact {
		return carrier
	}
	for _, key := range []string{"previous_response_id", "conversation", "container"} {
		if value := input[key]; len(value) > 0 && string(value) != "null" && string(value) != `""` {
			return carrier
		}
	}
	var items []stateItem
	if json.Unmarshal(input["input"], &items) != nil {
		// A string input carries no provider state.
		var text string
		carrier.Movable = json.Unmarshal(input["input"], &text) == nil || len(input["input"]) == 0
		return carrier
	}
	seen := map[stateDigest]bool{}
	for _, item := range items {
		// Stored item references live on the original account and cannot be replayed elsewhere.
		if item.Type == "item_reference" {
			return carrier
		}
		if item.encrypted() {
			if digest := fingerprint(item.EncryptedContent); !seen[digest] {
				seen[digest] = true
				carrier.Present = append(carrier.Present, digest)
			}
		}
	}
	carrier.Movable = true
	return carrier
}

func decodeForeignState(raw []byte) map[stateDigest]bool {
	set := make(map[stateDigest]bool, len(raw)/stateDigestSize)
	for len(raw) >= stateDigestSize {
		var digest stateDigest
		copy(digest[:], raw[:stateDigestSize])
		set[digest] = true
		raw = raw[stateDigestSize:]
	}
	return set
}

// mergeForeignState returns the stored fingerprints plus the request's, or false past the bound.
func mergeForeignState(stored []byte, present []stateDigest) (map[stateDigest]bool, []byte, bool) {
	set := decodeForeignState(stored)
	encoded := append([]byte(nil), stored[:len(stored)-len(stored)%stateDigestSize]...)
	for _, digest := range present {
		if !set[digest] {
			set[digest] = true
			encoded = append(encoded, digest[:]...)
		}
	}
	return set, encoded, len(set) <= foreignStateLimit
}

// stripForeignState removes encrypted items another account produced. Visible messages and tool
// calls stay, so the new account continues from the readable transcript.
func stripForeignState(input map[string]json.RawMessage, strip map[stateDigest]bool) error {
	if len(strip) == 0 {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(input["input"], &items) != nil {
		return nil
	}
	kept := items[:0]
	for _, raw := range items {
		var item stateItem
		if json.Unmarshal(raw, &item) == nil && item.encrypted() && strip[fingerprint(item.EncryptedContent)] {
			continue
		}
		kept = append(kept, raw)
	}
	if len(kept) == len(items) {
		return nil
	}
	encoded, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	input["input"] = encoded
	return nil
}
