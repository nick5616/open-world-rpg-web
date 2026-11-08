package main

// WP16 multiple zones for bots: the same handoff protocol the browser client
// follows (server/zone/internal/game/handoff.go), plus failover and the
// soak's ownership sampler.
//
//   - ZoneTransfer kind 0: open a second connection to the named zone and
//     say Hello with the token; keep it as a standby. kind 1: close it.
//   - A Welcome on a standby connection: ownership moved there. Make it the
//     active connection, reset the snapshot decoder, resend every frame the
//     old owner may not have applied, keep predicting. The old connection
//     stays open as a standby (the old owner keeps it for the way back).
//   - The active connection dropping (zone killed, shutdown kick): failover.
//     Find the owner of where we stand in the cluster view, connect with a
//     fresh dev ticket and no spawn hint (the zone loads the last
//     checkpoint), adopt the Welcome position, start predicting again.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
)

// botConn is one connection to one zone.
type botConn struct {
	zone      string
	conn      transport.Conn
	done      chan struct{} // reader exited
	welcomeCh chan struct{} // closed on this connection's first Welcome
	welcomed  bool
}

// ---- cluster view (shared by all bots) ----

type zoneEP struct {
	ID         string `json:"ID"`
	Endpoint   string `json:"Endpoint"`
	WTEndpoint string `json:"WTEndpoint"`
}

type clusterView struct {
	mu     sync.Mutex
	seeds  []string // http bases to ask first
	debugs []string // live zones' http bases (from the registry)
	owners [][]string
	zones  map[string]zoneEP
	at     time.Time
	client http.Client
}

type clusterDoc struct {
	ZoneID string            `json:"zoneId"`
	Owners [][]string        `json:"owners"`
	Zones  map[string]zoneEP `json:"zones"`
	Live   []struct {
		ZoneID string `json:"zoneId"`
		Debug  string `json:"debug"`
	} `json:"live"`
	Stats map[string]int64 `json:"stats"`
	View  struct {
		Characters []string         `json:"characters"`
		Epochs     map[string]int64 `json:"epochs"`
		NowMs      int64            `json:"nowMs"`
		Standby    int              `json:"standby"`
		Remote     int              `json:"remote"`
		Pending    int              `json:"pending"`
	} `json:"view"`
}

func newClusterView(seeds []string) *clusterView {
	return &clusterView{seeds: seeds, zones: map[string]zoneEP{}, client: http.Client{Timeout: 2 * time.Second}}
}

func (v *clusterView) get(base string) (*clusterDoc, error) {
	r, err := v.client.Get(strings.TrimSuffix(base, "/") + "/debug/cluster")
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("%s: %s", base, r.Status)
	}
	var d clusterDoc
	return &d, json.NewDecoder(r.Body).Decode(&d)
}

// refresh reads /debug/cluster from the first zone that answers (at most
// once per 500 ms across all callers).
func (v *clusterView) refresh() bool {
	v.mu.Lock()
	if time.Since(v.at) < 500*time.Millisecond && v.owners != nil {
		v.mu.Unlock()
		return true
	}
	cands := append(append([]string(nil), v.debugs...), v.seeds...)
	v.mu.Unlock()
	for _, base := range cands {
		d, err := v.get(base)
		if err != nil || len(d.Owners) == 0 {
			continue
		}
		v.mu.Lock()
		v.owners, v.zones, v.at = d.Owners, d.Zones, time.Now()
		v.debugs = v.debugs[:0]
		for _, e := range d.Live {
			if e.Debug != "" {
				v.debugs = append(v.debugs, e.Debug)
			}
		}
		v.mu.Unlock()
		return true
	}
	return false
}

func regionOf(x, z float64) (int, int) {
	size := float64(constants.RegionChunks * constants.ChunkSizeM)
	c := func(v float64) int { return max(0, min(constants.WorldRegions-1, int(math.Floor(v/size)))) }
	return c(x), c(z)
}

// ownerAt returns the zone owning (x, z).
func (v *clusterView) ownerAt(x, z float64) (zoneEP, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	rx, rz := regionOf(x, z)
	if rx >= len(v.owners) || rz >= len(v.owners[rx]) {
		return zoneEP{}, false
	}
	ep, ok := v.zones[v.owners[rx][rz]]
	return ep, ok && ep.Endpoint != ""
}

// nearestForeign returns a point in the nearest region owned by another
// zone than the one owning (x, z), depth m inside it, and its distance.
func (v *clusterView) nearestForeign(x, z, depth float64) (tx, tz, dist float64, ok bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	rx0, rz0 := regionOf(x, z)
	if rx0 >= len(v.owners) {
		return 0, 0, 0, false
	}
	here := v.owners[rx0][rz0]
	size := float64(constants.RegionChunks * constants.ChunkSizeM)
	dist = math.Inf(1)
	for rx := range v.owners {
		for rz, id := range v.owners[rx] {
			if id == "" || id == here {
				continue
			}
			x0, z0 := float64(rx)*size, float64(rz)*size
			// Closest point of the region, pushed depth m inside.
			cx := math.Max(x0+depth, math.Min(x0+size-depth, x))
			cz := math.Max(z0+depth, math.Min(z0+size-depth, z))
			if d := math.Hypot(cx-x, cz-z); d < dist {
				tx, tz, dist, ok = cx, cz, d, true
			}
		}
	}
	return tx, tz, dist, ok
}

// ---- bot side ----

func (b *bot) devTicket(zone string) string {
	if b.cfg.ticket != "" {
		return b.cfg.ticket
	}
	idRng := rand.New(rand.NewSource(int64(b.id)*7919 + 1))
	return ticket.Sign(b.cfg.priv, ticket.Claims{
		AccountID:     uuidish(idRng),
		CharacterID:   uuidish(idRng),
		CharacterName: fmt.Sprintf("bot-%03d", b.id),
		WorldID:       b.cfg.worldID,
		Audience:      ticket.AudienceZone(zone),
	})
}

// characterID is this bot's (deterministic) character id.
func characterID(id int) string {
	idRng := rand.New(rand.NewSource(int64(id)*7919 + 1))
	_ = uuidish(idRng)
	return uuidish(idRng)
}

// open dials a zone, says Hello with tk and starts its reader.
func (b *bot) open(ctx context.Context, zone, url, tk string) (*botConn, error) {
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	c, err := transport.DialWebSocket(dctx, url)
	cancel()
	if err != nil {
		return nil, err
	}
	bc := &botConn{zone: zone, conn: c, done: make(chan struct{}), welcomeCh: make(chan struct{})}
	b.mu.Lock()
	b.allConns = append(b.allConns, c)
	b.mu.Unlock()
	_ = c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk),
		ClientTime: nowMs(), Transport: proto.TransportWebsocket}))
	go b.reader(bc)
	return bc, nil
}

// preconnect follows a ZoneTransfer kind 0 (own goroutine: dialing blocks).
func (b *bot) preconnect(m *proto.ZoneTransfer) {
	bc, err := b.open(context.Background(), m.ZoneID, m.Endpoint, string(m.Ticket))
	if err != nil {
		b.mu.Lock()
		b.st.PreconnectFails++
		b.mu.Unlock()
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if old := b.standby[m.ZoneID]; old != nil && old != bc {
		old.conn.Close(transport.CloseNormal, "replaced")
	}
	b.standby[m.ZoneID] = bc
	b.st.Preconnects++
}

// handleTransfer is the ZoneTransfer branch of the reader (b.mu held).
func (b *bot) handleTransfer(bc *botConn, m *proto.ZoneTransfer) {
	if bc != b.active {
		return
	}
	if m.Kind == 1 {
		if sb := b.standby[m.ZoneID]; sb != nil {
			delete(b.standby, m.ZoneID)
			sb.conn.Close(transport.CloseNormal, "cancel")
		}
		return
	}
	go b.preconnect(m)
}

// switchTo makes a standby connection active after its Welcome (b.mu held).
func (b *bot) switchTo(bc *botConn, w *proto.Welcome) {
	old := b.active
	gap := time.Since(b.lastSnapAt)
	b.st.Handoffs++
	b.st.HandoffGapsMs = append(b.st.HandoffGapsMs, float64(gap.Microseconds())/1000)
	if w.EntityID != b.entityID {
		b.st.HandoffIDChanges++
	}
	delete(b.standby, bc.zone)
	if old != nil && old != bc {
		b.standby[old.zone] = old // the old owner keeps it for the way back
	}
	b.active = bc
	b.dec = snapshot.Decoder{}
	b.postSwitch = 4
	// Resend what the old owner may not have applied (its last ack onward).
	var frames []proto.InputFrame
	for _, f := range b.sent {
		if f.Seq > b.lastAckSeq {
			frames = append(frames, f)
		}
	}
	for len(frames) > 0 {
		n := min(16, len(frames))
		// Reliable: an unreliable send may be shed when the queue is full,
		// and these frames have no later repeats to cover for them.
		_ = bc.conn.SendReliable(proto.Encode(&proto.Input{Frames: frames[:n]}))
		frames = frames[n:]
	}
}

// failover reconnects after the active connection died. Returns false when
// it gave up (the bot counts as dropped).
func (b *bot) failover(ctx context.Context) bool {
	b.mu.Lock()
	lost := b.active
	last := b.state.Pos
	for z, sb := range b.standby {
		sb.conn.Close(transport.CloseNormal, "failover")
		delete(b.standby, z)
	}
	b.active = nil
	b.st.DropsSeen++
	b.mu.Unlock()
	if lost != nil {
		lost.conn.Close(transport.CloseNormal, "")
	}
	start := time.Now()
	backoff := 250 * time.Millisecond
	for ctx.Err() == nil && time.Since(start) < b.cfg.failoverGiveUp {
		if b.cfg.view != nil {
			b.cfg.view.refresh()
		}
		zone, url := b.cfg.zoneID, b.cfg.url
		if b.cfg.view != nil {
			ep, ok := b.cfg.view.ownerAt(last.X, last.Z)
			if !ok {
				time.Sleep(backoff)
				continue
			}
			zone, url = ep.ID, ep.Endpoint
		}
		bc, err := b.open(ctx, zone, url, b.devTicket(zone))
		if err == nil {
			select {
			case <-bc.welcomeCh:
				b.mu.Lock()
				b.active = bc
				b.st.Failovers++
				b.failedOverAt = time.Now()
				b.st.FailoverMs = append(b.st.FailoverMs, float64(time.Since(start).Milliseconds()))
				b.st.FailoverRewindM = append(b.st.FailoverRewindM, math.Hypot(b.state.Pos.X-last.X, b.state.Pos.Z-last.Z))
				b.mu.Unlock()
				return true
			case <-bc.done:
			case <-time.After(5 * time.Second):
				bc.conn.Close(transport.CloseNormal, "no welcome")
			case <-ctx.Done():
				return false
			}
		}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return false
		}
		backoff = min(2*time.Second, backoff*2)
	}
	b.mu.Lock()
	b.st.Error = "failover gave up"
	b.st.Connected = false
	b.mu.Unlock()
	return false
}

// ---- crossing persona (-mode cross) ----

// crossTarget picks the next point to walk to: inside the nearest region
// another zone owns, 40-120 m past the line, so the bot keeps crossing.
func (b *bot) crossTarget(x, z float64) {
	depth := 40 + b.rng.Float64()*80
	if tx, tz, _, ok := b.cfg.view.nearestForeign(x, z, depth); ok {
		// Spread along the border so bots don't all aim at the same point.
		along := (b.rng.Float64() - 0.5) * 200
		if math.Abs(tx-x) > math.Abs(tz-z) {
			tz += along
		} else {
			tx += along
		}
		b.target = &movement.Vec3{X: tx, Z: tz}
	}
}

// ---- ownership sampler (soak verdict) ----

type ownershipStats struct {
	Samples         int      `json:"samples"`
	MaxDuplicated   int      `json:"maxCharactersOwnedTwice"`
	InFlight        int      `json:"listedTwiceAcrossAHandoff"`
	DuplicateEvents int      `json:"duplicateSamples"`
	MaxUnowned      int      `json:"maxConnectedBotsUnowned"`
	UnownedSustain  int      `json:"botsUnownedTwoSamplesInARow"`
	OwnedPerZone    []string `json:"lastOwnedPerZone"`
}

// sampleOwnership polls every live zone's /debug/cluster and checks that
// each connected bot's character is owned by exactly one zone.
func sampleOwnership(ctx context.Context, view *clusterView, bots []*bot, every time.Duration) *ownershipStats {
	st := &ownershipStats{}
	prevUnowned := map[string]bool{}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return st
		case <-t.C:
		}
		view.refresh()
		view.mu.Lock()
		bases := append([]string(nil), view.debugs...)
		view.mu.Unlock()
		owned := map[string]int{}
		type own struct{ epoch, at int64 }
		by := map[string][]own{}
		per := []string{}
		okAll := true
		for _, base := range bases {
			d, err := view.get(base)
			if err != nil {
				okAll = false
				continue
			}
			for _, c := range d.View.Characters {
				owned[c]++
				by[c] = append(by[c], own{d.View.Epochs[c], d.View.NowMs})
			}
			per = append(per, fmt.Sprintf("%s=%d", d.ZoneID, len(d.View.Characters)))
		}
		if !okAll {
			continue // a zone mid-death: don't judge this sample
		}
		sort.Strings(per)
		st.Samples++
		st.OwnedPerZone = per
		// Zones are polled one after another, so a character handed over
		// between two polls shows up in both lists. That is a true overlap
		// only if every zone listing it already owned it (epoch) before the
		// earliest of those lists was taken.
		dup := 0
		for c, n := range owned {
			if n < 2 {
				continue
			}
			st.InFlight++
			latestEpoch, firstAt := int64(0), int64(1)<<62
			for _, o := range by[c] {
				latestEpoch, firstAt = max(latestEpoch, o.epoch), min(firstAt, o.at)
			}
			if latestEpoch < firstAt {
				dup++
			}
		}
		if dup > 0 {
			st.DuplicateEvents++
		}
		st.MaxDuplicated = max(st.MaxDuplicated, dup)
		unowned := map[string]bool{}
		for _, b := range bots {
			b.mu.Lock()
			playing := b.active != nil && b.active.welcomed && time.Since(b.lastSnapAt) < time.Second
			b.mu.Unlock()
			c := characterID(b.id)
			if playing && owned[c] == 0 {
				unowned[c] = true
				if prevUnowned[c] {
					st.UnownedSustain++
				}
			}
		}
		st.MaxUnowned = max(st.MaxUnowned, len(unowned))
		prevUnowned = unowned
	}
}
