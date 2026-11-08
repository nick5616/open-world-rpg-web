package main

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/weather"
	"lodestone/server/pkg/worldhost"
)

// persona picks a movement pattern. Exploring players mostly walk with long
// straight segments; the mix keeps snapshots realistic (heading changes,
// accelerations and jumps all dirty extra fields).
// adapted from wizard-wars server/src/systems/BotAI.js (decision interval,
// strafe flips every 400-900 ms, intent separate from the per-step input).
type persona int

const (
	walker persona = iota
	strafer
	jumper
	idler
)

func (p persona) String() string { return [...]string{"walker", "strafer", "jumper", "idler"}[p] }

type botConfig struct {
	url        string
	zoneID     string
	worldID    string
	priv       ed25519.PrivateKey
	centerX    float64
	centerZ    float64
	radius     float64 // clustered: steer back inside this disc; spread: 0
	worldM     float64
	warmup     time.Duration
	pingPeriod time.Duration
	ticket     string             // use this ticket (e.g. from the director) instead of signing one
	terrain    *worldhost.Terrain // WP07: shared by all bots (safe for concurrent use); nil = flat
}

// bot is one headless player: it signs a dev ticket, connects, runs Hello,
// sends 30 Hz input packets carrying 60 Hz frames (newest two plus one
// repeat), acks snapshots, decodes every frame with the generated codec and
// predicts its own movement with the shared movement package to check the
// server agrees.
type bot struct {
	id      int
	cfg     *botConfig
	rng     *rand.Rand
	persona persona
	spawnX  float64
	spawnZ  float64

	conn transport.Conn

	mu       sync.Mutex
	dec      snapshot.Decoder
	pred     [512]movement.State // predicted state after frame seq (seq % 512)
	predSeq  [512]uint32
	state    movement.State
	welcomed bool
	seed     uint64 // world seed from Welcome: the weather stub's rain (WP10)

	// intent
	heading     float64 // where we want to face
	yaw         float64 // smoothed facing
	segmentEnds time.Time
	sprint      bool
	idle        bool
	strafeBits  uint16
	strafeFlip  time.Time
	nextJump    time.Time
	jumpFrames  int
	doubleAt    int
	seq         uint32
	lastFrame   proto.InputFrame
	terrainAt   time.Time // next chunk-interest / water check

	// stats (reader goroutine writes under mu)
	st botStats
}

type botStats struct {
	Persona       string    `json:"persona"`
	Connected     bool      `json:"connected"`
	Error         string    `json:"error,omitempty"`
	Kick          string    `json:"kick,omitempty"`
	Snapshots     int       `json:"snapshots"`
	FullSnapshots int       `json:"fullSnapshots"`
	DecodeErrors  int       `json:"decodeErrors"`
	ApplyErrors   int       `json:"applyErrors"`
	EntsSum       int64     `json:"-"`
	EntsMax       int       `json:"entsMax"`
	EntsAvg       float64   `json:"entsAvg"`
	SnapBytes     int64     `json:"-"`
	SnapBytesAvg  float64   `json:"snapBytesAvg"`
	PredChecks    int       `json:"predChecks"`
	PredErrMaxCm  int32     `json:"predErrMaxCm"`
	PredResyncs   int       `json:"predResyncs"`
	PredMismatch  int       `json:"predMismatches"` // checks differing by >= 1 cm while still exact, i.e. before this bot's first resync (after one, the bot replays from cm-quantized state and 1 cm rounding noise is expected)
	RTTs          []float64 `json:"-"`
	RTTp50        float64   `json:"rttP50Ms"`
	DownKbps      float64   `json:"downKbps"`
	UpKbps        float64   `json:"upKbps"`

	warmIn, warmOut int64
	warmAt          time.Time
}

func newBot(id int, cfg *botConfig, seed int64, x, z float64) *bot {
	rng := rand.New(rand.NewSource(seed))
	b := &bot{id: id, cfg: cfg, rng: rng, spawnX: x, spawnZ: z}
	r := rng.Float64()
	switch {
	case r < 0.40:
		b.persona = walker
	case r < 0.60:
		b.persona = strafer
	case r < 0.85:
		b.persona = jumper
	default:
		b.persona = idler
	}
	b.st.Persona = b.persona.String()
	b.heading = rng.Float64() * 2 * math.Pi
	b.yaw = b.heading
	// WP10: a full stamina wheel, like the zone's join (sprinting drains it).
	b.state = movement.NewState(movement.Vec3{X: x, Z: z})
	return b
}

func uuidish(rng *rand.Rand) string {
	var b [16]byte
	rng.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// run connects and plays until ctx ends.
func (b *bot) run(ctx context.Context) {
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	url := fmt.Sprintf("%s?spawn=%.2f,%.2f", b.cfg.url, b.spawnX, b.spawnZ)
	if b.cfg.ticket != "" {
		url = b.cfg.url // a real character spawns where its row says
	}
	c, err := transport.DialWebSocket(dctx, url)
	cancel()
	if err != nil {
		b.mu.Lock()
		b.st.Error = err.Error()
		b.mu.Unlock()
		return
	}
	b.conn = c
	defer c.Close(transport.CloseNormal, "")

	idRng := rand.New(rand.NewSource(int64(b.id)*7919 + 1))
	tk := ticket.Sign(b.cfg.priv, ticket.Claims{
		AccountID:     uuidish(idRng),
		CharacterID:   uuidish(idRng),
		CharacterName: fmt.Sprintf("bot-%03d", b.id),
		WorldID:       b.cfg.worldID,
		Audience:      ticket.AudienceZone(b.cfg.zoneID),
	})
	if b.cfg.ticket != "" {
		tk = b.cfg.ticket
	}
	_ = c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk),
		ClientTime: nowMs(), Transport: proto.TransportWebsocket}))

	readDone := make(chan struct{})
	go b.reader(readDone)

	// Wait for Welcome before sending input.
	deadline := time.After(10 * time.Second)
	for {
		b.mu.Lock()
		ok, kicked := b.welcomed, b.st.Kick != ""
		b.mu.Unlock()
		if ok {
			break
		}
		if kicked {
			return
		}
		select {
		case <-readDone:
			return
		case <-deadline:
			b.mu.Lock()
			b.st.Error = "no welcome"
			b.mu.Unlock()
			return
		case <-time.After(5 * time.Millisecond):
		}
	}

	period := time.Second / constants.InputSendHz
	tick := time.NewTicker(period)
	defer tick.Stop()
	ping := time.NewTicker(b.cfg.pingPeriod)
	defer ping.Stop()
	warm := time.After(b.cfg.warmup)
	framesPerPacket := constants.MoveStepHz / constants.InputSendHz
	for {
		select {
		case <-ctx.Done():
			b.finish()
			_ = c.SendReliable(proto.Encode(&proto.Bye{}))
			return
		case <-readDone:
			b.finish()
			return
		case <-warm:
			st := c.Stats()
			b.mu.Lock()
			b.st.warmIn, b.st.warmOut, b.st.warmAt = st.BytesIn.Load(), st.BytesOut.Load(), time.Now()
			b.mu.Unlock()
		case <-ping.C:
			_ = c.SendUnreliable(proto.Encode(&proto.ClockPing{T1: nowMs()}))
		case now := <-tick.C:
			b.decide(now)
			frames := make([]proto.InputFrame, 0, constants.InputRedundancy)
			if b.seq > 0 {
				frames = append(frames, b.lastFrame) // repeat of the previous newest
			}
			b.mu.Lock()
			for k := 0; k < framesPerPacket; k++ {
				f := b.nextFrame()
				frames = append(frames, f)
				// WP10: same env as the zone (rain from the weather stub at
				// world time; bots share the zone's clock on one machine).
				env := movement.Env{Raining: weather.IsRaining(b.seed, weather.WorldTimeS(nowMs()))}
				b.state = movement.StepFrameEnv(b.state, f, b.cfg.ground(), env)
				clampWorld(&b.state, b.cfg.worldM)
				b.pred[f.Seq%512], b.predSeq[f.Seq%512] = b.state, f.Seq
				b.lastFrame = f
			}
			ack := b.dec.Latest()
			b.mu.Unlock()
			// Keep only the newest INPUT_REDUNDANCY frames.
			if len(frames) > constants.InputRedundancy {
				frames = frames[len(frames)-constants.InputRedundancy:]
			}
			_ = c.SendUnreliable(proto.Encode(&proto.Input{AckTick: ack, Frames: frames}))
		}
	}
}

// clampWorld mirrors the zone's world-edge clamp so prediction stays exact.
func clampWorld(s *movement.State, worldM float64) {
	maxXZ := worldM - 0.01
	if s.Pos.X < 0 || s.Pos.X > maxXZ {
		s.Pos.X = math.Max(0, math.Min(maxXZ, s.Pos.X))
		s.Vel.X = 0
	}
	if s.Pos.Z < 0 || s.Pos.Z > maxXZ {
		s.Pos.Z = math.Max(0, math.Min(maxXZ, s.Pos.Z))
		s.Vel.Z = 0
	}
}

// decide updates intent (BotAI-style: decisions on segments, smooth steps).
func (b *bot) decide(now time.Time) {
	b.mu.Lock()
	px, pz, spd := b.state.Pos.X, b.state.Pos.Z, movement.HorizontalSpeed(b.state)
	b.mu.Unlock()
	if now.After(b.segmentEnds) {
		b.segmentEnds = now.Add(time.Duration(2000+b.rng.Intn(4000)) * time.Millisecond)
		b.heading += (b.rng.Float64() - 0.5) * math.Pi // turn up to 90 degrees either way
		b.sprint = b.persona != idler && b.rng.Float64() < 0.2
		b.idle = b.persona == idler && b.rng.Float64() < 0.7
	}
	// Terrain (WP07): keep the shared chunk cache warm around this bot and
	// turn back from the sea, twice a second (not every packet: a turn
	// takes a while and re-deciding mid-turn would flap).
	if b.cfg.terrain != nil && now.After(b.terrainAt) {
		b.terrainAt = now.Add(500 * time.Millisecond)
		b.cfg.terrain.Want(px, pz, 48+spd*3)
		if math.Abs(math.Remainder(b.heading-b.yaw, 2*math.Pi)) < 0.3 {
			b.avoidWater(px, pz)
		}
	}
	// Steering: clustered bots stay in their disc; spread bots avoid edges.
	dx, dz := b.cfg.centerX-px, b.cfg.centerZ-pz
	out := false
	if b.cfg.radius > 0 {
		out = math.Hypot(dx, dz) > b.cfg.radius
	} else {
		const margin = 60
		out = px < margin || pz < margin || px > b.cfg.worldM-margin || pz > b.cfg.worldM-margin
	}
	if out {
		b.heading = math.Atan2(-dx, -dz) // yaw convention: forward = (-sin, -cos)
		b.idle = false
	}
	// Turn toward heading at most 3 rad/s (mouse-like, not snapping).
	diff := math.Remainder(b.heading-b.yaw, 2*math.Pi)
	maxStep := 3.0 / constants.InputSendHz
	b.yaw += math.Max(-maxStep, math.Min(maxStep, diff))

	if b.persona == strafer && now.After(b.strafeFlip) {
		b.strafeFlip = now.Add(time.Duration(400+b.rng.Intn(500)) * time.Millisecond)
		if b.rng.Intn(2) == 0 {
			b.strafeBits = proto.InputFlagLeft
		} else {
			b.strafeBits = proto.InputFlagRight
		}
	}
	if b.persona == jumper && now.After(b.nextJump) && b.jumpFrames == 0 {
		b.nextJump = now.Add(time.Duration(1000+b.rng.Intn(2000)) * time.Millisecond)
		b.jumpFrames = 1
		b.doubleAt = 0
		if b.rng.Intn(2) == 0 {
			b.doubleAt = 14 + b.rng.Intn(8) // second press while airborne
		}
	}
}

// nextFrame builds one 1/60 s input frame from the current intent.
func (b *bot) nextFrame() proto.InputFrame {
	b.seq++
	var flags uint16
	if !b.idle {
		flags |= proto.InputFlagForward
		if b.sprint {
			flags |= proto.InputFlagSprint
		}
		if b.persona == strafer {
			flags |= b.strafeBits
		}
	}
	if b.jumpFrames > 0 {
		switch {
		case b.jumpFrames == 1:
			flags |= proto.InputFlagJump | proto.InputFlagJumpEdge // press
		case b.jumpFrames <= 6:
			flags |= proto.InputFlagJump // held
		case b.doubleAt > 0 && b.jumpFrames == b.doubleAt:
			flags |= proto.InputFlagJump | proto.InputFlagJumpEdge // double jump press
		}
		b.jumpFrames++
		if b.jumpFrames > 40 {
			b.jumpFrames = 0
		}
	}
	return proto.InputFrame{Seq: b.seq, Flags: flags, Yaw: proto.YawToU16(b.yaw)}
}

func (b *bot) reader(done chan struct{}) {
	defer close(done)
	for {
		raw, err := b.conn.Recv(context.Background())
		if err != nil {
			return
		}
		m, err := proto.DecodeMessage(raw)
		b.mu.Lock()
		if err != nil {
			b.st.DecodeErrors++
			b.mu.Unlock()
			continue
		}
		switch msg := m.(type) {
		case *proto.Welcome:
			b.welcomed = true
			b.st.Connected = true
			b.seed = msg.Seed
			b.state.Pos = movement.Vec3{X: proto.CmToMeters(msg.X), Y: proto.CmToMeters(msg.Y), Z: proto.CmToMeters(msg.Z)}
			if b.cfg.terrain != nil && b.cfg.ticket == "" {
				// Dev spawn: x and z are our exact %.2f hint, but Welcome's y is
				// cm-rounded while the server stands exactly on the ground. Take
				// y from our own (bit-identical) terrain, or the first steps would
				// start a few mm off the ground and diverge.
				b.state.Pos.Y = b.cfg.terrain.HeightAt(b.state.Pos.X, b.state.Pos.Z)
			}
		case *proto.Kick:
			b.st.Kick = fmt.Sprintf("%d %s", msg.Code, msg.Reason)
		case *proto.ClockPong:
			b.st.RTTs = append(b.st.RTTs, nowMs()-msg.T1-(msg.T3-msg.T2))
		case *proto.Snapshot:
			f, err := b.dec.Apply(msg)
			if err != nil {
				b.st.ApplyErrors++
				break
			}
			b.st.Snapshots++
			if msg.BaselineTick == 0 {
				b.st.FullSnapshots++
			}
			b.st.EntsSum += int64(len(f.Ents))
			if len(f.Ents) > b.st.EntsMax {
				b.st.EntsMax = len(f.Ents)
			}
			b.st.SnapBytes += int64(len(raw))
			b.checkPrediction(msg.AckInputSeq, &f.Self)
		}
		b.mu.Unlock()
	}
}

// checkPrediction compares the server's state after frame seq with ours.
// They run the same Go movement code, so any difference means a protocol or
// sequencing bug (or dropped frames), which is what this guards.
func (b *bot) checkPrediction(seq uint32, self *proto.SelfState) {
	if seq == 0 || b.predSeq[seq%512] != seq {
		return
	}
	p := b.pred[seq%512]
	e := max(abs32(self.X-proto.MetersToCm(p.Pos.X)), abs32(self.Y-proto.MetersToCm(p.Pos.Y)), abs32(self.Z-proto.MetersToCm(p.Pos.Z)))
	b.st.PredChecks++
	if e > 0 && b.st.PredResyncs == 0 {
		b.st.PredMismatch++
	}
	if e > b.st.PredErrMaxCm {
		b.st.PredErrMaxCm = e
	}
	if e > 5 {
		// Diverged (e.g. frames dropped by the server's frame budget): adopt
		// the server state, like a client reconciliation would.
		b.st.PredResyncs++
		// WP10: SelfState carries the whole movement state (mode, stamina, timers).
		b.state = movement.FromSelf(*self)
		for i := range b.predSeq {
			b.predSeq[i] = 0
		}
	}
}

// finish computes per-bot rates over [warmup end, now].
func (b *bot) finish() {
	if b.conn == nil {
		return
	}
	st := b.conn.Stats()
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.st.warmAt.IsZero() {
		dt := time.Since(b.st.warmAt).Seconds()
		if dt > 0 {
			b.st.DownKbps = float64(st.BytesIn.Load()-b.st.warmIn) * 8 / 1000 / dt
			b.st.UpKbps = float64(st.BytesOut.Load()-b.st.warmOut) * 8 / 1000 / dt
		}
	}
	if b.st.Snapshots > 0 {
		b.st.EntsAvg = float64(b.st.EntsSum) / float64(b.st.Snapshots)
		b.st.SnapBytesAvg = float64(b.st.SnapBytes) / float64(b.st.Snapshots)
	}
	b.st.RTTp50 = pct(b.st.RTTs, 0.5)
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

func nowMs() float64 { return float64(time.Now().UnixMicro()) / 1000 }
