// Command combatbots is WP13's networked acceptance run: a party of two
// headless fighters connects to a real zone process over the binary
// protocol, walks to a camp, clears it, regroups, then clears a boss in its
// arena, logging every kill, phase, down and claim verdict.
//
//	go run ./server/zone/cmd/combatbots -url ws://127.0.0.1:PORT/ws -out run.txt
//
// Targets come from the zone's /debug/combat (generated camps and boss
// arenas from the world's atlas sites, or dev placements with
// LODESTONE_ZONE_DEBUG_CAMP/_BOSS); the bots predict their own movement on
// the zone's world (worldhost, towers, caves) like tools/bots do, and fight
// with internal/combat/combatbot's Brain (the same real weapon timelines
// and claims a browser client produces).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/combat/combatbot"
	"lodestone/server/zone/internal/game"
)

type zoneInfo struct {
	ZoneID     string          `json:"zoneId"`
	WorldID    string          `json:"worldId"`
	Seed       uint64          `json:"seed"`
	GenVersion string          `json:"genVersion"`
	Spec       json.RawMessage `json:"spec"`
	AtlasHash  string          `json:"atlasHash"`
}

var (
	logMu  sync.Mutex
	logOut io.Writer = os.Stdout
	start            = time.Now()
)

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	fmt.Fprintf(logOut, "[%7.2fs] %s\n", time.Since(start).Seconds(), fmt.Sprintf(format, a...))
}

func getJSON(url string, v any) error {
	c := http.Client{Timeout: 5 * time.Second}
	r, err := c.Get(url)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}

func main() {
	var (
		url      = flag.String("url", "ws://127.0.0.1:8092/ws", "zone WebSocket endpoint")
		out      = flag.String("out", "", "also write the log here")
		jsonOut  = flag.String("json", "", "write the summary JSON here")
		timeout  = flag.Duration("timeout", 15*time.Minute, "give up after")
		from     = flag.String("from", "", "pick the boss nearest to x,z (default: the atlas spawn)")
		approach = flag.Float64("approach", 45, "spawn this far from the camp")
	)
	flag.Parse()
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		defer f.Close()
		logOut = io.MultiWriter(os.Stdout, f)
	}
	base := strings.Replace(strings.TrimSuffix(*url, "/ws"), "ws://", "http://", 1)
	var info zoneInfo
	if err := getJSON(base+"/debug/zone", &info); err != nil {
		fail("zone identity: %v", err)
	}
	ground, err := openGround(info)
	if err != nil {
		fail("ground: %v", err)
	}
	var dbg game.CombatDebugInfo
	for i := 0; i < 50 && len(dbg.Groups) == 0; i++ {
		_ = getJSON(base+"/debug/combat", &dbg)
		time.Sleep(200 * time.Millisecond)
	}
	fx, fz := 2048.0, 2048.0
	if *from != "" {
		fmt.Sscanf(*from, "%f,%f", &fx, &fz)
	} else if a := atlasSpawn(info); a != nil {
		fx, fz = a[0], a[1]
	}
	boss, camp := pickTargets(dbg.Groups, fx, fz)
	if boss == nil || camp == nil {
		fail("no boss arena or camp in /debug/combat (%d groups)", len(dbg.Groups))
	}
	logf("world %s seed %d; boss group #%d %s (%s, lvl %d) at (%.0f, %.0f) r %.0f; camp #%d %s (%d members, lvl %d) at (%.0f, %.0f), %.0f m from the boss",
		info.WorldID, info.Seed, boss.ID, boss.Boss, boss.Name, boss.Level, boss.X, boss.Z, boss.Radius, camp.ID, camp.Kind, camp.Members, camp.Level, camp.X, camp.Z, math.Hypot(boss.X-camp.X, boss.Z-camp.Z))

	priv, _, err := ticket.PrivateKeyFromEnv()
	if err != nil {
		fail("ticket key: %v", err)
	}
	// Spawn on the side of the camp away from the boss.
	dx, dz := camp.X-boss.X, camp.Z-boss.Z
	d := math.Max(1, math.Hypot(dx, dz))
	sx, sz := camp.X+dx/d**approach, camp.Z+dz/d**approach
	party := []*bot{
		newBot("Alyssa", "sword", priv, info, ground, *url, sx-1.5, sz),
		newBot("Bruno", "spear", priv, info, ground, *url, sx+1.5, sz),
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	var wg sync.WaitGroup
	for _, b := range party {
		wg.Add(1)
		go func(b *bot) { defer wg.Done(); b.run(ctx) }(b)
	}
	res := coordinate(ctx, base, party, camp, boss)
	cancel()
	wg.Wait()
	res.Bots = map[string]any{}
	for _, b := range party {
		res.Bots[b.name] = b.summary()
	}
	logf("RESULT camp cleared: %v (%.1f s)  boss defeated: %v (fight %.0f s, %d phases)  downs %d  claims accepted %d refused %d",
		res.CampCleared, res.CampSeconds, res.BossDefeated, res.BossFightSeconds, res.BossPhases, res.Downs, res.Accepted, res.Refused)
	if *jsonOut != "" {
		b, _ := json.MarshalIndent(res, "", "  ")
		_ = os.WriteFile(*jsonOut, b, 0o644)
	}
	if !res.CampCleared || !res.BossDefeated {
		logf("FAIL")
		os.Exit(1)
	}
	logf("PASS: a party of two cleared a camp and a boss against the zone process")
}

func fail(f string, a ...any) {
	logf("FAIL: "+f, a...)
	os.Exit(1)
}

func atlasSpawn(info zoneInfo) []float64 {
	t, err := openTerrain(info)
	if err != nil || t == nil {
		return nil
	}
	a, err := structures.ParseAtlas(t.World().Atlas)
	if err != nil {
		return nil
	}
	return []float64{a.SpawnX, a.SpawnZ}
}

// pickTargets: the boss arena nearest to (fx, fz), and the camp-like group
// (camp, guardian, pack; level at most the boss's) nearest to that boss,
// 60 m or more from it.
func pickTargets(gs []game.CombatGroupDebug, fx, fz float64) (boss, camp *game.CombatGroupDebug) {
	for i := range gs {
		g := &gs[i]
		if g.Kind == "boss" && !g.Cleared && (boss == nil || math.Hypot(g.X-fx, g.Z-fz) < math.Hypot(boss.X-fx, boss.Z-fz)) {
			boss = g
		}
	}
	if boss == nil {
		return nil, nil
	}
	for i := range gs {
		g := &gs[i]
		if g.Kind == "boss" || g.Cleared {
			continue
		}
		dd := math.Hypot(g.X-boss.X, g.Z-boss.Z)
		// A fair fight for fresh characters: no stronger than the boss.
		if dd < 60 || g.Level > boss.Level || (g.Kind != "camp" && g.Kind != "pack" && g.Kind != "guardian" && g.Kind != "test") {
			continue
		}
		if camp == nil || dd < math.Hypot(camp.X-boss.X, camp.Z-boss.Z) {
			camp = g
		}
	}
	return boss, camp
}

// Result is the run summary (docs/evidence/wp13-party-clear.json).
type Result struct {
	CampCleared      bool           `json:"campCleared"`
	CampSeconds      float64        `json:"campSeconds"`
	BossDefeated     bool           `json:"bossDefeated"`
	BossFightSeconds float64        `json:"bossFightSeconds"`
	BossPhases       int            `json:"bossPhases"`
	Downs            int            `json:"downs"`
	Accepted         int            `json:"claimsAccepted"`
	Refused          int            `json:"claimsRefused"`
	Kills            []string       `json:"kills"`
	Bots             map[string]any `json:"bots"`
}

// coordinate runs the party plan: camp -> regroup -> boss.
func coordinate(ctx context.Context, base string, party []*bot, camp, boss *game.CombatGroupDebug) Result {
	var res Result
	campAt := movement.Vec3{X: camp.X, Z: camp.Z}
	bossAt := movement.Vec3{X: boss.X, Z: boss.Z}
	dx, dz := camp.X-boss.X, camp.Z-boss.Z
	d := math.Max(1, math.Hypot(dx, dz))
	stage := movement.Vec3{X: boss.X + dx/d*(boss.Radius+14), Z: boss.Z + dz/d*(boss.Radius+14)}
	inArea := func(c movement.Vec3, r float64) func(combatbot.EnemyView) bool {
		return func(e combatbot.EnemyView) bool { return math.Hypot(e.Pos.X-c.X, e.Pos.Z-c.Z) <= r }
	}
	for _, b := range party {
		// Kiting enemies (archers, wisps) roam up to ENEMY_LEASH_M from home.
		b.setPlan(&campAt, 10, inArea(campAt, camp.Radius+constants.EnemyLeashM+10))
	}
	phase := "camp"
	t0 := time.Now()
	var bossT0 time.Time
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			logf("timeout in phase %s", phase)
			collect(&res, party)
			return res
		case <-tick.C:
		}
		var dbg game.CombatDebugInfo
		if getJSON(base+"/debug/combat", &dbg) != nil {
			continue
		}
		var cg, bg *game.CombatGroupDebug
		for i := range dbg.Groups {
			switch dbg.Groups[i].ID {
			case camp.ID:
				cg = &dbg.Groups[i]
			case boss.ID:
				bg = &dbg.Groups[i]
			}
		}
		switch phase {
		case "camp":
			if cg != nil && cg.Cleared {
				res.CampCleared, res.CampSeconds = true, time.Since(t0).Seconds()
				logf("CAMP CLEARED: group #%d (%s) in %.1f s; regrouping at (%.0f, %.0f) outside the arena", camp.ID, camp.Kind, res.CampSeconds, stage.X, stage.Z)
				phase = "regroup"
				for _, b := range party {
					b.setPlan(&stage, 2, func(combatbot.EnemyView) bool { return false })
				}
			}
		case "regroup":
			ready := true
			for _, b := range party {
				if p := b.pos(); math.Hypot(p.X-stage.X, p.Z-stage.Z) > 5 {
					ready = false
				}
			}
			if ready {
				logf("party regrouped; pulling the boss")
				phase = "boss"
				bossT0 = time.Now()
				for _, b := range party {
					// Fight in the arena; anyone sent back to their respawn point
					// walks back to the staging point and rejoins (the boss only
					// resets if the whole party is gone for 15 s).
					b.setPlan(&stage, boss.Radius+30, inArea(bossAt, boss.Radius+16))
					b.mu.Lock()
					b.safe = &stage
					b.mu.Unlock()
				}
			}
		case "boss":
			if bg != nil && bg.Cleared {
				res.BossDefeated = true
				logf("BOSS GROUP CLEARED %.0f s after the pull", time.Since(bossT0).Seconds())
				collect(&res, party)
				return res
			}
		}
	}
}

func collect(res *Result, party []*bot) {
	seen := map[string]bool{}
	for _, b := range party {
		b.mu.Lock()
		res.Downs += b.downs
		res.Accepted += b.accepted
		res.Refused += b.refused
		if b.bossSecs > res.BossFightSeconds {
			res.BossFightSeconds = b.bossSecs
		}
		if b.phases > res.BossPhases {
			res.BossPhases = b.phases
		}
		for _, k := range b.kills {
			if !seen[k] {
				seen[k] = true
				res.Kills = append(res.Kills, k)
			}
		}
		b.mu.Unlock()
	}
}

// ---- one bot ----

type bot struct {
	name, weapon string
	priv         []byte
	info         zoneInfo
	ground       movement.Ground
	url          string
	spawn        movement.Vec3

	mu        sync.Mutex
	brain     *combatbot.Brain
	dec       snapshot.Decoder
	frame     *snapshot.Frame
	welcome   *proto.Welcome
	pred      [512]movement.State
	predSeq   [512]uint32
	frames    [512]proto.InputFrame
	entityID  uint32
	ackSeq    uint32
	corr      int
	accepted  int
	refused   int
	refusedBy map[uint8]int
	downs     int
	kills     []string
	bossSecs  float64
	phases    int
	dmgDealt  int
	hurt      int
	evaded    int
	planGoal  *movement.Vec3
	planLeash float64
	planPref  func(combatbot.EnemyView) bool
	planDirty bool
	safe      *movement.Vec3
	kickMsg   string
}

func newBot(name, weapon string, priv []byte, info zoneInfo, g movement.Ground, url string, x, z float64) *bot {
	return &bot{name: name, weapon: weapon, priv: priv, info: info, ground: g, url: url, spawn: movement.Vec3{X: x, Z: z}, refusedBy: map[uint8]int{}}
}

func (b *bot) setPlan(goal *movement.Vec3, leash float64, pref func(combatbot.EnemyView) bool) {
	b.mu.Lock()
	b.planGoal, b.planLeash, b.planPref, b.planDirty = goal, leash, pref, true
	b.mu.Unlock()
}

func (b *bot) pos() movement.Vec3 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.brain == nil {
		return b.spawn
	}
	return b.brain.State.Pos
}

func (b *bot) run(ctx context.Context) {
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	c, err := transport.DialWebSocket(dctx, fmt.Sprintf("%s?spawn=%.2f,%.2f", b.url, b.spawn.X, b.spawn.Z))
	cancel()
	if err != nil {
		logf("%s: dial: %v", b.name, err)
		return
	}
	defer c.Close(transport.CloseNormal, "")
	tk := ticket.Sign(b.priv, ticket.Claims{AccountID: "wp13-" + b.name, CharacterID: "wp13-combat-" + strings.ToLower(b.name), CharacterName: b.name,
		WorldID: b.info.WorldID, Audience: ticket.AudienceZone(b.info.ZoneID)})
	_ = c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: nowMs(), Transport: proto.TransportWebsocket}))
	done := make(chan struct{})
	go b.reader(c, done)
	for {
		b.mu.Lock()
		ok := b.welcome != nil
		b.mu.Unlock()
		if ok {
			break
		}
		select {
		case <-done:
			logf("%s: closed before welcome (%s)", b.name, b.kickMsg)
			return
		case <-time.After(5 * time.Millisecond):
		}
	}
	// Equip the weapon on loadout 0 (Interact 50, ActEquipWeapon).
	w := combatdefs.D.WeaponByKey(b.weapon)
	_ = c.SendReliable(proto.Encode(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActEquipWeapon, Arg: uint32(w.ID) << 8}))
	period := time.Second / constants.InputSendHz
	t := time.NewTicker(period)
	defer t.Stop()
	var last proto.InputFrame
	status := time.NewTicker(15 * time.Second)
	defer status.Stop()
	for {
		select {
		case <-status.C:
			b.mu.Lock()
			if b.brain != nil {
				p := b.brain.State.Pos
				logf("%s at (%.0f, %.0f, %.0f) hp %.0f%%  attacks %d casts %d dodges %d  accepted %d refused %d  corrections %d", b.name, p.X, p.Y, p.Z, b.brain.HP*100, b.brain.Attacks, b.brain.Casts, b.brain.Dodges, b.accepted, b.refused, b.corr)
			}
			b.mu.Unlock()
		default:
		}
		select {
		case <-ctx.Done():
			_ = c.SendReliable(proto.Encode(&proto.Bye{}))
			return
		case <-done:
			logf("%s: disconnected (%s)", b.name, b.kickMsg)
			return
		case <-t.C:
		}
		b.mu.Lock()
		if b.planDirty {
			b.brain.Goal, b.brain.Leash, b.brain.PreferIDs, b.brain.Safe = b.planGoal, b.planLeash, b.planPref, b.safe
			if b.planGoal == nil {
				b.brain.Leash = 1e9
			}
			b.planDirty = false
		}
		views := b.views()
		tick := b.dec.Latest()
		var frames []proto.InputFrame
		var claims []proto.HitClaim
		if last.Seq != 0 {
			frames = append(frames, last)
		}
		for k := 0; k < constants.MoveStepHz/constants.InputSendHz; k++ {
			f, cl := b.brain.Step(views, tick)
			frames = append(frames, f)
			claims = append(claims, cl...)
			b.pred[f.Seq%512], b.predSeq[f.Seq%512], b.frames[f.Seq%512] = b.brain.State, f.Seq, f
			last = f
		}
		ack := b.dec.Latest()
		b.mu.Unlock()
		_ = c.SendUnreliable(proto.Encode(&proto.Input{AckTick: ack, Frames: frames}))
		for i := range claims {
			_ = c.SendReliable(proto.Encode(&claims[i]))
		}
	}
}

// views are the enemies in the newest snapshot (bot lock held).
func (b *bot) views() []combatbot.EnemyView {
	if b.frame == nil {
		return nil
	}
	var out []combatbot.EnemyView
	for _, e := range b.frame.Ents {
		if e.Kind != proto.EntityKindEnemy || e.HealthPct == 0 {
			continue
		}
		out = append(out, combatbot.EnemyView{ID: e.ID, Pos: movement.Vec3{X: proto.CmToMeters(e.X), Y: proto.CmToMeters(e.Y), Z: proto.CmToMeters(e.Z)}, HPPct: e.HealthPct, TypeID: e.TypeID})
	}
	return out
}

func (b *bot) reader(c transport.Conn, done chan struct{}) {
	defer close(done)
	for {
		raw, err := c.Recv(context.Background())
		if err != nil {
			return
		}
		m, err := proto.DecodeMessage(raw)
		if err != nil {
			continue
		}
		b.mu.Lock()
		switch msg := m.(type) {
		case *proto.Welcome:
			b.welcome = msg
			b.entityID = msg.EntityID
			pos := movement.Vec3{X: proto.CmToMeters(msg.X), Y: proto.CmToMeters(msg.Y), Z: proto.CmToMeters(msg.Z)}
			if g := b.ground.HeightAt(pos.X, pos.Z); math.Abs(g-pos.Y) < 0.01 {
				pos.Y = g
			}
			b.brain = combatbot.New(b.name, b.weapon, b.ground, movement.NewState(pos))
			logf("%s joined as entity %d at (%.1f, %.1f, %.1f) with a %s", b.name, msg.EntityID, pos.X, pos.Y, pos.Z, b.weapon)
		case *proto.Snapshot:
			if f, err := b.dec.Apply(msg); err == nil {
				b.frame = f
				b.reconcile(f.Self, msg.AckInputSeq)
			}
		case *proto.HitResult:
			if msg.Accepted {
				b.accepted++
				b.dmgDealt += int(msg.Damage)
			} else {
				b.refused++
				b.refusedBy[msg.Flags]++
			}
		case *proto.Event:
			b.event(msg)
		case *proto.Kick:
			b.kickMsg = msg.Reason
		}
		b.mu.Unlock()
	}
}

// reconcile rebases the brain onto the server's state when the prediction
// at the acked frame disagrees, then replays the unacked frames.
func (b *bot) reconcile(self proto.SelfState, ack uint32) {
	if b.brain == nil || ack == 0 || b.predSeq[ack%512] != ack {
		return
	}
	b.brain.HP = float64(self.Health) / math.Max(1, float64(self.HealthMax))
	srv := movement.FromSelf(self)
	p := b.pred[ack%512]
	if math.Abs(proto.CmToMeters(proto.MetersToCm(p.Pos.X))-srv.Pos.X) < 0.02 && math.Abs(proto.CmToMeters(proto.MetersToCm(p.Pos.Z))-srv.Pos.Z) < 0.02 && math.Abs(p.Pos.Y-srv.Pos.Y) < 0.05 && p.Dash == srv.Dash {
		return
	}
	b.corr++
	s := srv
	for seq := ack + 1; seq <= b.brain.Seq; seq++ {
		if b.predSeq[seq%512] != seq {
			break
		}
		s = movement.StepFrame(s, b.frames[seq%512], b.ground)
		b.pred[seq%512] = s
	}
	b.brain.Rebase(s)
}

func (b *bot) event(ev *proto.Event) {
	switch ev.Kind {
	case combat.EvTelegraph:
		if t, ok := combatbot.DecodeTelegraph(*ev); ok && b.brain != nil {
			b.brain.SeeTelegraph(t)
		}
	case combat.EvProjectile:
		if b.brain != nil {
			b.brain.SeeProjectile(*ev)
		}
	case combat.EvEnemyDied:
		name := string(ev.Data)
		if ev.TargetID == b.entityID {
			label := name
			if label == "" {
				label = fmt.Sprintf("enemy %d", ev.EntityID)
			}
			b.kills = append(b.kills, label)
			logf("%s killed %s (+%d xp)", b.name, label, ev.Value)
		}
	case combat.EvPlayerDowned:
		if ev.EntityID == b.entityID {
			b.downs++
			logf("%s was downed (respawn in %d ms)", b.name, ev.Value)
		}
	case combat.EvPlayerHurt:
		b.hurt += int(ev.Value)
	case combat.EvEvaded:
		b.evaded++
	case combat.EvBossEngaged:
		logf("%s: boss engaged: %s (%d hp after party scaling)", b.name, ev.Data, ev.Value)
	case combat.EvBossPhase:
		b.phases = max(b.phases, int(ev.TargetID)+1)
		logf("%s: BOSS PHASE %d/%d: %s", b.name, ev.TargetID+1, ev.Value, ev.Data[2:])
	case combat.EvBossDefeated:
		b.bossSecs = float64(ev.Value)
		logf("%s: BOSS DEFEATED: %s after a %d s fight", b.name, ev.Data, ev.Value)
	case combat.EvCampCleared:
		logf("%s: camp cleared (group %d)", b.name, ev.TargetID)
	case 2: // teleport (respawn)
		if ev.EntityID == b.entityID && b.brain != nil {
			b.brain.Rebase(movement.NewState(movement.Vec3{X: proto.CmToMeters(ev.X), Y: proto.CmToMeters(ev.Y), Z: proto.CmToMeters(ev.Z)}))
		}
	}
}

func (b *bot) summary() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := map[string]any{"weapon": b.weapon, "claimsAccepted": b.accepted, "claimsRefused": b.refused, "refusedBy": b.refusedBy,
		"damageDealt": b.dmgDealt, "damageTaken": b.hurt, "evaded": b.evaded, "downs": b.downs, "corrections": b.corr, "kills": b.kills}
	if b.brain != nil {
		s["attacks"], s["dodges"], s["drinks"], s["casts"], s["retreats"] = b.brain.Attacks, b.brain.Dodges, b.brain.Drinks, b.brain.Casts, b.brain.Retreats
	}
	return s
}

func nowMs() float64 { return float64(time.Now().UnixMicro()) / 1000 }

// ---- the zone's ground (as tools/bots builds it) ----

func openTerrain(info zoneInfo) (*worldhost.Terrain, error) {
	if info.AtlasHash == "" {
		return nil, nil
	}
	mod, err := worldhost.LoadFromEnv(context.Background())
	if err != nil {
		return nil, err
	}
	spec := []byte(info.Spec)
	if string(spec) == "null" {
		spec = nil
	}
	mt, _, err := mod.OpenRow(worldhost.WorldRow{Seed: info.Seed, Spec: spec, GenVersion: info.GenVersion, AtlasHash: info.AtlasHash}, worldhost.WorldOptions{})
	if err != nil {
		return nil, err
	}
	return worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{}), nil
}

func openGround(info zoneInfo) (movement.Ground, error) {
	t, err := openTerrain(info)
	if err != nil || t == nil {
		return movement.Flat{}, err
	}
	var surface movement.Ground = t
	if a, err := structures.ParseAtlas(t.World().Atlas); err == nil {
		o, _ := structures.Towers(a, t)
		surface = structures.Wrap(t, o)
	}
	if cv, err := worldhost.NewCaves(t.World(), worldhost.CaveOptions{Workers: 1}); err == nil {
		return worldhost.NewCaveTerrain(t, surface, cv), nil
	}
	return surface, nil
}
