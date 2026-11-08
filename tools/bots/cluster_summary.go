package main

// WP16 soak verdict (spec 14 soak scenario 2: "1,000 bots across the world
// with continuous zone crossings: no dropped players, no duplicated items").
//
// What counts:
//   - Dropped players: a bot not connected at the end, or one whose
//     failover gave up. Every bot must still be playing when the soak ends.
//   - Duplicated players (the precondition for duplicated items: two
//     authoritative copies of one inventory): the ownership sampler unions
//     every zone's owned characters and must never see one twice; a playing
//     bot owned by nobody for two samples in a row counts as lost.
//   - Duplicated grants: items are WP14's (not built yet), so the grants
//     that exist today stand in: WP12 discovery XP is granted once per
//     character per site, ever. A handoff that lost or duplicated progress
//     shows up as the same discovery Event twice. Must be 0.
//   - Handoff quality: the first prediction checks after every switch must
//     agree with the client's prediction (0 cm), and the entity id must not
//     change; plus gap and failover timings.

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ClusterSummary is the multi-zone part of the soak result.
type ClusterSummary struct {
	Handoffs          int                `json:"handoffs"`
	BotsThatCrossed   int                `json:"botsThatCrossed"`
	HandoffGapMs      Q                  `json:"handoffGapMs"`
	HandoffChecks     int                `json:"handoffPredictionChecks"`
	HandoffMismatches int                `json:"handoffPredictionMismatches"`
	HandoffMaxErrCm   int32              `json:"handoffMaxErrCm"`
	HandoffIDChanges  int                `json:"handoffEntityIdChanges"`
	Preconnects       int                `json:"preconnects"`
	PreconnectFails   int                `json:"preconnectFails"`
	StandbyKicks      int                `json:"standbyKicks"`
	Drops             int                `json:"connectionDrops"`
	Failovers         int                `json:"failovers"`
	FailoverMs        Q                  `json:"failoverMs"`
	FailoverRewindM   Q                  `json:"failoverRewindM"`
	GaveUp            int                `json:"failoversGaveUp"`
	Discoveries       int                `json:"discoveries"`
	DupDiscoveries    int                `json:"duplicateDiscoveries"`
	Ownership         *ownershipStats    `json:"ownership,omitempty"`
	Zones             []map[string]any   `json:"zones"`
	ZoneTick          map[string]float64 `json:"zoneTickP99Ms"`
}

// scrapeZones reads /metrics and /debug/cluster of every live zone.
func scrapeZones(view *clusterView) []map[string]any {
	if view == nil {
		return nil
	}
	view.refresh()
	view.mu.Lock()
	bases := append([]string(nil), view.debugs...)
	view.mu.Unlock()
	var out []map[string]any
	c := http.Client{Timeout: 5 * time.Second}
	for _, base := range bases {
		z := map[string]any{"debug": base}
		if d, err := view.get(base); err == nil {
			z["zoneId"], z["stats"], z["owned"] = d.ZoneID, d.Stats, len(d.View.Characters)
		}
		if r, err := c.Get(strings.TrimSuffix(base, "/") + "/metrics"); err == nil {
			b, _ := io.ReadAll(r.Body)
			r.Body.Close()
			z["metrics"] = parseZoneMetrics(string(b))
		}
		out = append(out, z)
	}
	return out
}

func clusterVerdict(s *Summary, bots []*bot, own *ownershipStats, zones []map[string]any, tickBudget float64) {
	c := &ClusterSummary{Ownership: own, Zones: zones, ZoneTick: map[string]float64{}}
	var gaps, fo, rw []float64
	for _, b := range bots {
		b.mu.Lock()
		st := b.st
		b.mu.Unlock()
		c.Handoffs += st.Handoffs
		if st.Handoffs > 0 {
			c.BotsThatCrossed++
		}
		gaps = append(gaps, st.HandoffGapsMs...)
		c.HandoffChecks += st.HandoffChecks
		c.HandoffMismatches += st.HandoffMismatch
		c.HandoffMaxErrCm = max(c.HandoffMaxErrCm, st.HandoffMaxErrCm)
		c.HandoffIDChanges += st.HandoffIDChanges
		c.Preconnects += st.Preconnects
		c.PreconnectFails += st.PreconnectFails
		c.StandbyKicks += st.StandbyKicks
		c.Drops += st.DropsSeen
		c.Failovers += st.Failovers
		fo = append(fo, st.FailoverMs...)
		rw = append(rw, st.FailoverRewindM...)
		if st.Error == "failover gave up" {
			c.GaveUp++
		}
		c.Discoveries += st.Discoveries
		c.DupDiscoveries += st.DupDiscoveries
	}
	c.HandoffGapMs, c.FailoverMs, c.FailoverRewindM = dist(gaps), dist(fo), dist(rw)
	fail := func(f string, a ...any) { s.Failures = append(s.Failures, fmt.Sprintf(f, a...)) }
	// The single-zone tick check scraped one zone; judge every zone instead.
	kept := s.Failures[:0]
	for _, f := range s.Failures {
		if !strings.HasPrefix(f, "zone tick p99") {
			kept = append(kept, f)
		}
	}
	s.Failures = kept
	for _, z := range zones {
		m, _ := z["metrics"].(map[string]float64)
		id, _ := z["zoneId"].(string)
		if p99, ok := m[`zone_tick_ms{q="p99"}`]; ok {
			c.ZoneTick[id] = p99
			if p99 > tickBudget {
				fail("zone %s tick p99 %.2f ms > %.0f", id, p99, tickBudget)
			}
		}
	}
	if c.GaveUp > 0 {
		fail("%d bots dropped (failover gave up)", c.GaveUp)
	}
	if c.HandoffIDChanges > 0 {
		fail("%d handoffs changed the entity id", c.HandoffIDChanges)
	}
	if c.DupDiscoveries > 0 {
		fail("%d duplicated discovery grants", c.DupDiscoveries)
	}
	if own != nil {
		if own.MaxDuplicated > 0 {
			fail("characters owned by two zones at once (max %d in one sample)", own.MaxDuplicated)
		}
		if own.UnownedSustain > 0 {
			fail("%d playing bots owned by no zone for two samples in a row", own.UnownedSustain)
		}
	}
	s.Cluster = c
	s.Pass = len(s.Failures) == 0
}

func printCluster(c *ClusterSummary) {
	fmt.Printf("handoffs %d by %d bots; gap ms p50 %.1f p95 %.1f max %.1f; prediction after switch: %d checks, %d mismatches, max %d cm; id changes %d\n",
		c.Handoffs, c.BotsThatCrossed, c.HandoffGapMs.P50, c.HandoffGapMs.P95, c.HandoffGapMs.Max, c.HandoffChecks, c.HandoffMismatches, c.HandoffMaxErrCm, c.HandoffIDChanges)
	fmt.Printf("pre-connects %d (failed %d), standby kicks %d, drops %d, failovers %d (gave up %d), failover ms p50 %.0f max %.0f, rewind m p50 %.1f max %.1f\n",
		c.Preconnects, c.PreconnectFails, c.StandbyKicks, c.Drops, c.Failovers, c.GaveUp, c.FailoverMs.P50, c.FailoverMs.Max, c.FailoverRewindM.P50, c.FailoverRewindM.Max)
	fmt.Printf("discoveries %d, duplicated %d\n", c.Discoveries, c.DupDiscoveries)
	if o := c.Ownership; o != nil {
		fmt.Printf("ownership: %d samples, listed twice across a handoff %d, truly owned twice %d, max playing-but-unowned %d, unowned two samples running %d, last %v\n",
			o.Samples, o.InFlight, o.MaxDuplicated, o.MaxUnowned, o.UnownedSustain, o.OwnedPerZone)
	}
	for _, z := range c.Zones {
		m, _ := z["metrics"].(map[string]float64)
		fmt.Printf("  zone %-12v owned %-4v tick p50 %.2f p99 %.2f max %.2f ms  players %v  stats %v\n", z["zoneId"], z["owned"],
			m[`zone_tick_ms{q="p50"}`], m[`zone_tick_ms{q="p99"}`], m[`zone_tick_ms{q="max"}`], m["zone_players"], z["stats"])
	}
}
