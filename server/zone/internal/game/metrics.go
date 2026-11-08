package game

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync/atomic"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/svc"
)

var (
	errWrongWorld  = errors.New("ticket: wrong world")
	errNoCharacter = errors.New("ticket: no character")
)

// metrics holds counters written by the tick and reader goroutines and
// published to Prometheus once a second (spec 13: tick time, players, bytes
// in/out per client, AOI set sizes, write-behind queue depth).
type metrics struct {
	reg *svc.Metrics

	players         atomic.Int64
	frames          atomic.Int64
	framesDropped   atomic.Int64
	speedViolations atomic.Int64
	rateLimited     atomic.Int64
	protoErrors     atomic.Int64
	snapshotsShed   atomic.Int64
	// Byte budget (decision 0005): records sent vs deferred to a later tick.
	recordsSent, recordsDeferred atomic.Int64
	framesSkipped                atomic.Int64    // lost frames given up on (hole longer than maxSynthFrames)
	framesSynthesized            atomic.Int64    // lost frames filled by repeating the last input
	transports                   [3]atomic.Int64 // live sessions by proto.Transport
	// Mining (WP09).
	veinsMined, veinsRespawned, itemsGranted, editsSent atomic.Int64

	// AOI accumulators (tick writes, publisher swaps out).
	aoiSamples, aoiNear, aoiMid, aoiFar, aoiParty, aoiMax, snapBytes, snapCount atomic.Int64
}

func (m *metrics) init(reg *svc.Metrics) {
	m.reg = reg
	reg.Help("zone_tick_ms", "Tick duration quantiles over the last 60 s (ms).")
	reg.Help("zone_tick_ms_lifetime", "Tick duration quantiles since start (ms, 10 us buckets).")
	reg.Help("zone_tick_jitter_ms", "|tick spacing - 33.33 ms| quantiles over the last 60 s.")
	reg.Help("zone_tick_jitter_ms_lifetime", "Tick jitter quantiles since start.")
	reg.Help("zone_tick_spacing_ms", "Tick start spacing quantiles over the last 60 s.")
	reg.Help("zone_players", "Connected players.")
	reg.Help("zone_client_down_kbps", "Per-client downlink over the last 5 s, quantiles across clients (incl. WebSocket framing).")
	reg.Help("zone_client_up_kbps", "Per-client uplink over the last 5 s, quantiles across clients.")
	reg.Help("zone_aoi_entities_avg", "Average interest set size per client by ring, last second.")
	reg.Help("zone_aoi_entities_max", "Largest interest set of any client, last second.")
	reg.Help("zone_snapshot_bytes_avg", "Average encoded snapshot size, last second.")
	reg.Help("zone_writebehind_depth", "Write-behind queue depth (ops waiting or running).")
	reg.Help("zone_kicks_total", "Kicks by KickCode.")
	for _, c := range kickNames {
		reg.Add(fmt.Sprintf(`zone_kicks_total{code=%q}`, c), 0)
	}
}

var kickNames = map[proto.KickCode]string{
	proto.KickCodeBadTicket: "bad_ticket", proto.KickCodeVersionMismatch: "version_mismatch",
	proto.KickCodeDuplicateLogin: "duplicate_login", proto.KickCodeServerFull: "server_full",
	proto.KickCodeRateLimited: "rate_limited", proto.KickCodeShutdown: "shutdown", proto.KickCodeTransferred: "transferred",
}

func (m *metrics) kick(code proto.KickCode) {
	m.reg.Add(fmt.Sprintf(`zone_kicks_total{code=%q}`, kickNames[code]), 1)
}

func (m *metrics) aoiAccum(clients int, near, mid, far, party, max, bytes int64) {
	if clients == 0 {
		return
	}
	m.aoiSamples.Add(int64(clients))
	m.aoiNear.Add(near)
	m.aoiMid.Add(mid)
	m.aoiFar.Add(far)
	m.aoiParty.Add(party)
	m.snapBytes.Add(bytes)
	m.snapCount.Add(int64(clients))
	for {
		cur := m.aoiMax.Load()
		if max <= cur || m.aoiMax.CompareAndSwap(cur, max) {
			break
		}
	}
}

type bwSample struct {
	t       time.Time
	in, out int64
}

// RunMetrics publishes metrics every second until ctx ends.
func (s *Server) RunMetrics(ctx context.Context, depth func() int, extra func(*svc.Metrics)) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	hist := map[*session][]bwSample{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		s.publish(hist, depth, extra)
	}
}

func (s *Server) publish(hist map[*session][]bwSample, depth func() int, extra func(*svc.Metrics)) {
	r := s.m.reg
	sum := s.stats.Summary()
	q := func(name string, v float64, quant string) { r.SetFloat(fmt.Sprintf(`%s{q=%q}`, name, quant), v) }
	q("zone_tick_ms", sum.WinTick.P50, "p50")
	q("zone_tick_ms", sum.WinTick.P99, "p99")
	q("zone_tick_ms", sum.WinTick.Max, "max")
	q("zone_tick_ms_lifetime", sum.LifeTick.P50, "p50")
	q("zone_tick_ms_lifetime", sum.LifeTick.P99, "p99")
	q("zone_tick_ms_lifetime", sum.LifeTick.Max, "max")
	q("zone_tick_jitter_ms", sum.WinJitter.P50, "p50")
	q("zone_tick_jitter_ms", sum.WinJitter.P99, "p99")
	q("zone_tick_jitter_ms", sum.WinJitter.Max, "max")
	q("zone_tick_jitter_ms_lifetime", sum.LifeJit.P50, "p50")
	q("zone_tick_jitter_ms_lifetime", sum.LifeJit.P99, "p99")
	q("zone_tick_jitter_ms_lifetime", sum.LifeJit.Max, "max")
	q("zone_tick_spacing_ms", sum.WinSpace.P50, "p50")
	q("zone_tick_spacing_ms", sum.WinSpace.Max, "max")
	r.SetInt("zone_ticks_total", sum.Ticks)
	r.SetInt("zone_tick_overruns_total", sum.Overruns)
	r.SetInt("zone_tick_forgiven_total", sum.Forgiven)
	if s.sched != nil {
		r.SetFloat("zone_spin_seconds_total", s.sched.SpinTotal().Seconds())
	}
	r.SetInt("zone_players", s.m.players.Load())
	r.SetInt("zone_input_frames_total", s.m.frames.Load())
	r.SetInt("zone_input_frames_dropped_total", s.m.framesDropped.Load())
	r.SetInt("zone_input_frames_skipped_total", s.m.framesSkipped.Load())
	r.SetInt("zone_input_frames_synthesized_total", s.m.framesSynthesized.Load())
	r.SetInt("zone_veins_mined_total", s.m.veinsMined.Load())
	r.SetInt("zone_veins_respawned_total", s.m.veinsRespawned.Load())
	r.SetInt("zone_items_granted_total", s.m.itemsGranted.Load())
	r.SetInt("zone_world_edits_sent_total", s.m.editsSent.Load())
	r.SetInt("zone_speed_violations_total", s.m.speedViolations.Load())
	r.SetInt("zone_rate_limited_total", s.m.rateLimited.Load())
	r.SetInt("zone_protocol_errors_total", s.m.protoErrors.Load())
	r.SetInt("zone_snapshots_shed_total", s.m.snapshotsShed.Load())
	r.SetInt("zone_budget_records_sent_total", s.m.recordsSent.Load())
	r.SetInt("zone_budget_records_deferred_total", s.m.recordsDeferred.Load())
	r.SetFloat("zone_downlink_budget_kbps", s.cfg.DownBudgetKbps)
	r.SetInt(`zone_sessions{transport="websocket"}`, s.m.transports[proto.TransportWebsocket].Load())
	r.SetInt(`zone_sessions{transport="webtransport"}`, s.m.transports[proto.TransportWebtransport].Load())
	if depth != nil {
		r.SetInt("zone_writebehind_depth", int64(depth()))
	}

	if n := s.m.aoiSamples.Swap(0); n > 0 {
		f := float64(n)
		r.SetFloat(`zone_aoi_entities_avg{ring="near"}`, round2(float64(s.m.aoiNear.Swap(0))/f))
		r.SetFloat(`zone_aoi_entities_avg{ring="mid"}`, round2(float64(s.m.aoiMid.Swap(0))/f))
		r.SetFloat(`zone_aoi_entities_avg{ring="far"}`, round2(float64(s.m.aoiFar.Swap(0))/f))
		r.SetFloat(`zone_aoi_entities_avg{ring="party"}`, round2(float64(s.m.aoiParty.Swap(0))/f))
		r.SetInt("zone_aoi_entities_max", s.m.aoiMax.Swap(0))
		if c := s.m.snapCount.Swap(0); c > 0 {
			r.SetFloat("zone_snapshot_bytes_avg", round2(float64(s.m.snapBytes.Swap(0))/float64(c)))
		}
	}

	// Per-client bandwidth over the last 5 s, plus zone totals.
	now := time.Now()
	s.connsMu.Lock()
	live := make([]*session, 0, len(s.conns))
	for sess := range s.conns {
		live = append(live, sess)
	}
	s.connsMu.Unlock()
	var down, up []float64
	var totIn, totOut int64
	seen := map[*session]bool{}
	for _, sess := range live {
		seen[sess] = true
		st := sess.conn.Stats()
		smp := bwSample{now, st.BytesIn.Load(), st.BytesOut.Load()}
		h := append(hist[sess], smp)
		if len(h) > 6 {
			h = h[len(h)-6:]
		}
		hist[sess] = h
		if len(h) >= 2 {
			dt := h[len(h)-1].t.Sub(h[0].t).Seconds()
			down = append(down, float64(h[len(h)-1].out-h[0].out)*8/1000/dt)
			up = append(up, float64(h[len(h)-1].in-h[0].in)*8/1000/dt)
		}
	}
	for sess := range hist {
		if !seen[sess] {
			delete(hist, sess)
		}
	}
	for sess := range hist {
		h := hist[sess]
		totIn += h[len(h)-1].in
		totOut += h[len(h)-1].out
	}
	r.SetInt("zone_bytes_in_live_clients", totIn)
	r.SetInt("zone_bytes_out_live_clients", totOut)
	for name, v := range map[string][]float64{"zone_client_down_kbps": down, "zone_client_up_kbps": up} {
		if len(v) == 0 {
			continue
		}
		slices.Sort(v)
		var avg float64
		for _, x := range v {
			avg += x
		}
		avg /= float64(len(v))
		q(name, round2(v[len(v)/2]), "p50")
		q(name, round2(v[min(len(v)-1, len(v)*99/100)]), "p99")
		q(name, round2(v[len(v)-1]), "max")
		q(name, round2(avg), "avg")
	}
	if extra != nil {
		extra(r)
	}
}

func round2(x float64) float64 { return float64(int64(x*100+0.5)) / 100 }
