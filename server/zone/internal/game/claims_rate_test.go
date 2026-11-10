package game

import (
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// CR 020: a hold-to-fire stream claims every bullet. At the fastest rate
// (AUTO_MAX_RATE_HZ) with every shot a bursting one (4 targets, the zone's
// per-shot cap) for 10 s, the HitClaim budget never refuses (a refusal
// counts toward a rate-limit kick), while a client claiming twice that is
// throttled.
func TestHitClaimBudgetFitsAStream(t *testing.T) {
	b := newBuckets()[proto.MsgHitClaim]
	now := time.Unix(1_800_000_000, 0)
	per := constants.AutoMaxRateHz * 4
	for s := 0; s < 10*constants.AutoMaxRateHz; s++ {
		now = now.Add(time.Second / time.Duration(constants.AutoMaxRateHz))
		for k := 0; k < 4; k++ {
			if !b.Take(now) {
				t.Fatalf("a stream's claims were throttled after %d shots (%d claims/s)", s, per)
			}
		}
	}
	c := newBuckets()[proto.MsgHitClaim]
	refused := 0
	for s := 0; s < 10*constants.AutoMaxRateHz; s++ {
		now = now.Add(time.Second / time.Duration(constants.AutoMaxRateHz))
		for k := 0; k < 8; k++ {
			if !c.Take(now) {
				refused++
			}
		}
	}
	if refused == 0 {
		t.Fatal("twice the stream budget was never throttled")
	}
}
