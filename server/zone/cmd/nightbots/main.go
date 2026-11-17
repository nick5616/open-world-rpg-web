// Command nightbots is WP15's networked acceptance: headless fighters
// against a real zone process at night.
//
//	go run ./server/zone/cmd/nightbots -url ws://127.0.0.1:PORT/ws -scenario demon   -out run.txt
//	go run ./server/zone/cmd/nightbots -url ws://127.0.0.1:PORT/ws -scenario defense -out run.txt
//
// demon:   one bot first raises a pack of LOW-level demons (dev Interact 52,
//
//	level 1) and kills them with the ordinary sword (CR 048: only
//	high-level demons are immune), then raises a pack of level 20
//	demons and fights them with the sword for 40 s (they must all
//	survive: wounds regenerate), then takes a sunsteel blade (dev
//	Interact 50 action 6, combat.yaml materials.sunsteel; WP14 sets
//	the same loadout material from the forged item) and kills them,
//	then raises another pack, sets the world clock to seconds before
//	dawn and watches sunrise burn them.
//
// defense: two bots with sunsteel stand at a town's ward garden, the
//
//	ward falters (dev Interact 52 action 1: the same StartDefense a
//	seeded night uses), and they fight every wave until the event
//	ends; PASS when the ward holds.
//
// The bot plumbing (dial, predict, reconcile, claims) is adapted from
// server/zone/cmd/combatbots/main.go; the fighting is
// internal/combat/combatbot's Brain.
package main

import (
	"context"
	"encoding/binary"
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
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/weather"
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

func fail(f string, a ...any) {
	logf("FAIL: "+f, a...)
	os.Exit(1)
}

func isDemonType(t uint16) bool {
	e := combatdefs.D.EnemyByID(int(t & 0xff))
	return e != nil && e.Family == "demon"
}

func main() {
	var (
		url      = flag.String("url", "ws://127.0.0.1:8092/ws", "zone WebSocket endpoint")
		scenario = flag.String("scenario", "demon", "demon | defense")
		out      = flag.String("out", "", "also write the log here")
		jsonOut  = flag.String("json", "", "write the summary JSON here")
		townFlag = flag.Int("town", -1, "town index (default: the one nearest the atlas spawn)")
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
	var nd game.NightDebug
	if err := getJSON(base+"/debug/night?towns=1", &nd); err != nil || len(nd.Towns) == 0 {
		fail("night debug: %v (%d towns)", err, len(nd.Towns))
	}
	logf("world %s seed %d: world time %.0f, %02d:%02d, night %v, night %d, moon %d, %d towns", info.WorldID, info.Seed, nd.WorldTime, int(nd.Hour), int((nd.Hour-math.Floor(nd.Hour))*60), nd.Night, nd.NightIdx, nd.Moon, len(nd.Towns))
	sx, sz := 2048.0, 2048.0
	if a := atlasSpawn(info); a != nil {
		sx, sz = a[0], a[1]
	}
	town := nd.Towns[0]
	best := math.Inf(1)
	for _, t := range nd.Towns {
		if d := math.Hypot(t.X-sx, t.Z-sz); (*townFlag < 0 && d < best) || t.Index == *townFlag {
			town, best = t, d
		}
	}
	priv, _, err := ticket.PrivateKeyFromEnv()
	if err != nil {
		fail("ticket key: %v", err)
	}
	res := map[string]any{"scenario": *scenario, "town": town}
	ok := false
	switch *scenario {
	case "demon":
		ok = demonScenario(base, info, ground, priv, *url, town, res)
	case "defense":
		ok = defenseScenario(base, info, ground, priv, *url, town, res)
	default:
		fail("unknown scenario %s", *scenario)
	}
	res["pass"] = ok
	if *jsonOut != "" {
		b, _ := json.MarshalIndent(res, "", "  ")
		_ = os.WriteFile(*jsonOut, b, 0o644)
	}
	if !ok {
		logf("FAIL")
		os.Exit(1)
	}
	logf("PASS")
}

// openSpot finds walkable dry ground at about distance d from (cx, cz).
func openSpot(g movement.Ground, cx, cz, d float64) (float64, float64) {
	for k := 0; k < 32; k++ {
		a := float64(k) * math.Pi / 8
		r := d + float64(k/16)*25
		x, z := cx+r*math.Cos(a), cz+r*math.Sin(a)
		y := g.HeightAt(x, z)
		ok := movement.WaterAt(g, x, z) < y-0.3 && movement.SlopeAt(g, x, z).T2 < constants.WalkableTanSq*0.5
		for _, o := range [][2]float64{{6, 0}, {-6, 0}, {0, 6}, {0, -6}} {
			if movement.SlopeAt(g, x+o[0], z+o[1]).T2 > constants.WalkableTanSq*0.6 || movement.WaterAt(g, x+o[0], z+o[1]) > g.HeightAt(x+o[0], z+o[1])-0.3 {
				ok = false
			}
		}
		if ok {
			return x, z
		}
	}
	return cx + d, cz
}

func demonScenario(base string, info zoneInfo, g movement.Ground, priv []byte, url string, town game.TownDebug, res map[string]any) bool {
	x, z := openSpot(g, town.X, town.Z, town.WardR+70)
	b := newBot("Sol", "sword", priv, info, g, url, x, z)
	home := movement.Vec3{X: x, Y: g.HeightAt(x, z), Z: z}
	b.setPlan(&home, 30)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go b.run(ctx)
	if !b.waitWelcome(10 * time.Second) {
		return false
	}
	logf("Sol stands %.0f m outside the ward of %s at (%.0f, %.0f)", math.Hypot(x-town.X, z-town.Z)-town.WardR, town.Name, x, z)

	// 0. CR 048: low-level demons are hurt by ordinary steel and die to it.
	b.interact(game.InteractNight, 3, 1<<8) // raise a level 1 lesser pack
	time.Sleep(1500 * time.Millisecond)
	lowIDs := b.demonIDs()
	logf("phase 0: %d level 1 demons rose (%v); fighting with an ordinary sword for up to 60 s", len(lowIDs), lowIDs)
	if len(lowIDs) == 0 {
		logf("no demons rose")
		return false
	}
	b.resetCounters()
	t0 := time.Now()
	for time.Since(t0) < 60*time.Second && len(b.aliveDemons(lowIDs)) > 0 {
		time.Sleep(500 * time.Millisecond)
	}
	p0 := b.snapshotCounters(lowIDs)
	logf("phase 0 result: %d hits, %d damage, demons killed by the ordinary sword: %d/%d (%.1f s)", p0.hits, p0.damage, p0.killed, len(lowIDs), time.Since(t0).Seconds())
	res["lowLevel"] = p0
	lowDie := p0.killed == len(lowIDs) && len(b.aliveDemons(lowIDs)) == 0
	logf("CHECK a low-level demon dies to ordinary damage: %v", lowDie)

	// 1. Ordinary steel against level 20 demons: 40 s of fighting, nobody dies.
	b.interact(game.InteractNight, 3, 20<<8) // raise a level 20 lesser pack
	time.Sleep(1500 * time.Millisecond)
	ids := b.demonIDs()
	logf("phase 1: %d level 20 demons rose (%v); fighting with an ordinary sword for 40 s", len(ids), ids)
	if len(ids) == 0 {
		logf("no demons rose")
		return false
	}
	b.resetCounters()
	time.Sleep(40 * time.Second)
	p1 := b.snapshotCounters(ids)
	logf("phase 1 result: %d hits accepted on demons, %d damage dealt, %d 'shrugged' events, demon health dipped to %d%% (lowest seen), demons killed by steel: %d, demons alive: %d/%d",
		p1.hits, p1.damage, p1.shrugged, p1.minHP, p1.killed, p1.alive, len(ids))
	res["ordinary"] = p1
	survived := p1.killed == 0 && p1.alive == len(ids) && p1.hits >= 10 && p1.damage > p1.maxHPDamage(ids)
	logf("CHECK a demon survives ordinary damage: %v (damage dealt %d >= the pack's full health and every demon alive)", survived, p1.damage)

	// 2. Sunsteel: they die.
	b.interact(combat.InteractCombat, combat.ActSetMaterial, 0|3<<8) // material id 3 = sunsteel
	logf("phase 2: Sol takes up a sunsteel blade (Interact 50 action 6, material sunsteel)")
	b.resetCounters()
	t0 = time.Now()
	for time.Since(t0) < 90*time.Second && len(b.aliveDemons(ids)) > 0 {
		time.Sleep(500 * time.Millisecond)
	}
	p2 := b.snapshotCounters(ids)
	dt := time.Since(t0).Seconds()
	var nd game.NightDebug
	_ = getJSON(base+"/debug/night", &nd)
	for _, d := range nd.DemonList {
		logf("  zone: demon %d %s (%s, lvl %d) hp %.0f/%.0f seared %.0f wounds %.0f %s", d.ID, d.Key, d.Rank, d.Level, d.HP, d.HPMax, d.Seared, d.Wounds, d.State)
	}
	logf("phase 2 result: %d hits accepted, %d damage, demons killed by Sol: %d, alive: %d (%.1f s)", p2.hits, p2.damage, p2.killed, len(b.aliveDemons(ids)), dt)
	res["sunsteel"] = p2
	sunsteel := len(b.aliveDemons(ids)) == 0 && p2.killed == len(ids)
	logf("CHECK a demon dies to sunsteel: %v", sunsteel)

	// 3. Sunrise: back to steel, raise a pack, skip the clock to dawn.
	b.interact(combat.InteractCombat, combat.ActSetMaterial, 0)
	b.interact(game.InteractNight, 3, 20<<8) // level 20: steel must not kill them before the sun does
	time.Sleep(1500 * time.Millisecond)
	ids3 := b.demonIDs()
	fresh := []uint32{}
	for _, id := range ids3 {
		dup := false
		for _, o := range ids {
			dup = dup || o == id
		}
		if !dup {
			fresh = append(fresh, id)
		}
	}
	now := float64(time.Now().UnixMilli()) / 1000
	tod := math.Mod(now, constants.DayLengthS)
	want := constants.DawnHour*constants.DayLengthS/24 - 8
	off := math.Mod(want-tod+2*constants.DayLengthS, constants.DayLengthS)
	logf("phase 3: %d fresh demons; setting the world clock to 05:59:52 (offset %.0f s)", len(fresh), off)
	b.resetCounters()
	b.interact(game.InteractNight, 2, uint32(int32(off)))
	t0 = time.Now()
	for time.Since(t0) < 25*time.Second && (len(b.aliveDemons(fresh)) > 0 || b.dawnSeen() == 0) {
		time.Sleep(250 * time.Millisecond)
	}
	p3 := b.snapshotCounters(fresh)
	burned := b.burnedCount(fresh)
	logf("phase 3 result: dawn events %d, demons burned %d of %d, alive %d, killed by Sol %d", b.dawnSeen(), burned, len(fresh), len(b.aliveDemons(fresh)), p3.killed)
	res["sunrise"] = map[string]any{"fresh": len(fresh), "burned": burned, "alive": len(b.aliveDemons(fresh)), "dawn": b.dawnSeen()}
	sunrise := len(fresh) > 0 && len(b.aliveDemons(fresh)) == 0 && burned == len(fresh)
	logf("CHECK sunrise burns demons in the open: %v", sunrise)
	res["bot"] = b.summary()
	return lowDie && survived && sunsteel && sunrise
}

func defenseScenario(base string, info zoneInfo, g movement.Ground, priv []byte, url string, town game.TownDebug, res map[string]any) bool {
	gx, gz := town.GardenX, town.GardenZ
	party := []*bot{
		newBot("Ana", "sword", priv, info, g, url, gx+3, gz),
		newBot("Bo", "spear", priv, info, g, url, gx-3, gz),
	}
	garden := movement.Vec3{X: gx, Y: g.HeightAt(gx, gz), Z: gz}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, b := range party {
		b.setPlan(&garden, 40)
		go b.run(ctx)
	}
	for _, b := range party {
		if !b.waitWelcome(10 * time.Second) {
			return false
		}
		b.interact(combat.InteractCombat, combat.ActSetMaterial, 0|3<<8)
	}
	logf("Ana (sword) and Bo (spear), both with sunsteel, stand at the ward garden of %s (%.0f, %.0f); ward radius %.0f m", town.Name, gx, gz, town.WardR)
	time.Sleep(time.Second)
	party[0].interact(game.InteractNight, 1, 0) // the ward falters
	t0 := time.Now()
	result := 0
	lastDbg := time.Now()
	for time.Since(t0) < 8*time.Minute {
		if r := party[0].defenseResult(); r != 0 {
			result = r
			break
		}
		time.Sleep(500 * time.Millisecond)
		if time.Since(lastDbg) > 10*time.Second {
			lastDbg = time.Now()
			var nd game.NightDebug
			if getJSON(base+"/debug/night", &nd) == nil {
				var parts []string
				for _, d := range nd.DemonList {
					if d.HP > 0 {
						parts = append(parts, fmt.Sprintf("%s %.0fm %s", d.Key, math.Hypot(d.X-gx, d.Z-gz), d.State))
					}
				}
				ward := 0.0
				for _, df := range nd.Defenses {
					ward = df.Ward
				}
				logf("  zone: ward %.0f; demons (distance to the garden, state): %s", ward, strings.Join(parts, ", "))
			}
		}
	}
	time.Sleep(time.Second)
	names := map[int]string{0: "timeout", game.DefenseHeld: "HELD", game.DefenseBroken: "BROKEN", game.DefenseAbandoned: "ABANDONED"}
	logf("defense ended after %.0f s: %s", time.Since(t0).Seconds(), names[result])
	for _, b := range party {
		s := b.summary()
		logf("%s: %d demon kills, %d claims accepted, %d downs, %d damage taken, reward %d XP", b.name, s["demonKills"], s["claimsAccepted"], s["downs"], s["damageTaken"], s["defenseXP"])
		res[b.name] = s
	}
	res["result"] = names[result]
	res["seconds"] = time.Since(t0).Seconds()
	both := party[0].summary()["defenseXP"].(int) > 0 && party[1].summary()["defenseXP"].(int) > 0
	logf("CHECK a town defense event runs start to finish with two players: %v (result %s, both rewarded %v)", result == game.DefenseHeld && both, names[result], both)
	return result == game.DefenseHeld && both
}

// ---- the bot (adapted from server/zone/cmd/combatbots/main.go) ----

type bot struct {
	name, weapon string
	priv         []byte
	info         zoneInfo
	ground       movement.Ground
	url          string
	spawn        movement.Vec3

	mu       sync.Mutex
	conn     transport.Conn
	brain    *combatbot.Brain
	dec      snapshot.Decoder
	frame    *snapshot.Frame
	welcome  *proto.Welcome
	pred     [512]movement.State
	predSeq  [512]uint32
	frames   [512]proto.InputFrame
	entityID uint32
	corr     int
	accepted int
	refused  int
	downs    int
	hurt     int
	goal     *movement.Vec3
	leash    float64
	dirty    bool
	kickMsg  string

	// night counters
	hits, damage, shrugged int
	minHP                  map[uint32]int
	maxHP                  map[uint32]int
	died                   map[uint32]uint32 // demon id -> killer (0 = sunrise)
	burned                 map[uint32]bool
	dawn                   int
	demonKills             int
	defense                int
	defenseXP              int
	seen                   map[uint32]uint16 // demon id -> typeId
}

func newBot(name, weapon string, priv []byte, info zoneInfo, g movement.Ground, url string, x, z float64) *bot {
	return &bot{name: name, weapon: weapon, priv: priv, info: info, ground: g, url: url, spawn: movement.Vec3{X: x, Z: z},
		minHP: map[uint32]int{}, maxHP: map[uint32]int{}, died: map[uint32]uint32{}, burned: map[uint32]bool{}, seen: map[uint32]uint16{}}
}

func (b *bot) setPlan(goal *movement.Vec3, leash float64) {
	b.mu.Lock()
	b.goal, b.leash, b.dirty = goal, leash, true
	b.mu.Unlock()
}

func (b *bot) waitWelcome(d time.Duration) bool {
	t0 := time.Now()
	for time.Since(t0) < d {
		b.mu.Lock()
		ok := b.welcome != nil && b.conn != nil
		b.mu.Unlock()
		if ok {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	logf("%s: no welcome (%s)", b.name, b.kickMsg)
	return false
}

func (b *bot) interact(kind, action uint8, arg uint32) {
	b.mu.Lock()
	c := b.conn
	b.mu.Unlock()
	if c != nil {
		_ = c.SendReliable(proto.Encode(&proto.Interact{TargetKind: kind, Action: action, Arg: arg}))
	}
}

func (b *bot) demonIDs() []uint32 {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []uint32
	if b.frame == nil {
		return nil
	}
	for _, e := range b.frame.Ents {
		if e.Kind == proto.EntityKindEnemy && isDemonType(e.TypeID) && e.HealthPct > 0 {
			if _, dead := b.died[e.ID]; !dead {
				out = append(out, e.ID)
			}
		}
	}
	return out
}

func (b *bot) aliveDemons(ids []uint32) []uint32 {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []uint32
	for _, id := range ids {
		if _, dead := b.died[id]; dead || b.burned[id] {
			continue
		}
		out = append(out, id)
	}
	return out
}

type counters struct {
	Hits      int `json:"hits"`
	Damage    int `json:"damage"`
	Shrugged  int `json:"shrugged"`
	MinHP     int `json:"minHealthPct"`
	Killed    int `json:"killedByBot"`
	Alive     int `json:"alive"`
	hits      int
	damage    int
	shrugged  int
	minHP     int
	killed    int
	alive     int
	healthMax map[uint32]int
}

func (c counters) maxHPDamage(ids []uint32) int {
	// Each lesser demon at level L has hp * (1 + 0.1 (L - 1)); the pack's
	// full health is at most a few hundred points: compare against the HP
	// the demons' definitions give at level 1, times a safety factor.
	def := combatdefs.D.EnemyByKey("gloamling")
	return int(def.HP * float64(len(ids)))
}

func (b *bot) resetCounters() {
	b.mu.Lock()
	b.hits, b.damage, b.shrugged = 0, 0, 0
	b.minHP = map[uint32]int{}
	b.mu.Unlock()
}

func (b *bot) snapshotCounters(ids []uint32) counters {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := counters{hits: b.hits, damage: b.damage, shrugged: b.shrugged, minHP: 100}
	for _, id := range ids {
		if v, ok := b.minHP[id]; ok && v < c.minHP {
			c.minHP = v
		}
		if k, dead := b.died[id]; dead && k == b.entityID {
			c.killed++
		} else if !dead && !b.burned[id] {
			c.alive++
		}
	}
	c.Hits, c.Damage, c.Shrugged, c.MinHP, c.Killed, c.Alive = c.hits, c.damage, c.shrugged, c.minHP, c.killed, c.alive
	return c
}

func (b *bot) burnedCount(ids []uint32) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, id := range ids {
		if b.burned[id] {
			n++
		}
	}
	return n
}

func (b *bot) dawnSeen() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.dawn
}

func (b *bot) defenseResult() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.defense
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
	tk := ticket.Sign(b.priv, ticket.Claims{AccountID: "wp15-" + b.name, CharacterID: "wp15-night-" + strings.ToLower(b.name), CharacterName: b.name,
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
	w := combatdefs.D.WeaponByKey(b.weapon)
	_ = c.SendReliable(proto.Encode(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActEquipWeapon, Arg: uint32(w.ID) << 8}))
	b.mu.Lock()
	b.conn = c
	b.mu.Unlock()
	t := time.NewTicker(time.Second / constants.InputSendHz)
	defer t.Stop()
	status := time.NewTicker(15 * time.Second)
	defer status.Stop()
	var last proto.InputFrame
	for {
		select {
		case <-status.C:
			b.mu.Lock()
			if b.brain != nil {
				p := b.brain.State.Pos
				logf("%s at (%.0f, %.0f, %.0f) hp %.0f%%  attacks %d dodges %d  accepted %d refused %d  corrections %d", b.name, p.X, p.Y, p.Z, b.brain.HP*100, b.brain.Attacks, b.brain.Dodges, b.accepted, b.refused, b.corr)
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
		if b.dirty {
			b.brain.Goal, b.brain.Leash = b.goal, b.leash
			b.dirty = false
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
			// Steel only: the start kit's Ember Flick is fire (ordinary damage
			// to a demon), and a bot that kites with it would never test the blade.
			b.brain.Spell = nil
			logf("%s joined as entity %d at (%.1f, %.1f, %.1f) with a %s", b.name, msg.EntityID, pos.X, pos.Y, pos.Z, b.weapon)
		case *proto.Snapshot:
			if f, err := b.dec.Apply(msg); err == nil {
				b.frame = f
				for _, e := range f.Ents {
					if e.Kind == proto.EntityKindEnemy && isDemonType(e.TypeID) {
						b.seen[e.ID] = e.TypeID
						if v, ok := b.minHP[e.ID]; !ok || int(e.HealthPct) < v {
							if e.HealthPct > 0 {
								b.minHP[e.ID] = int(e.HealthPct)
							}
						}
					}
				}
				b.reconcile(f.Self, msg.AckInputSeq)
			}
		case *proto.HitResult:
			if msg.Accepted {
				b.accepted++
				if _, demon := b.seen[msg.TargetID]; demon {
					b.hits++
					b.damage += int(msg.Damage)
				}
			} else {
				b.refused++
			}
		case *proto.Event:
			b.event(msg)
		case *proto.Kick:
			b.kickMsg = msg.Reason
		}
		b.mu.Unlock()
	}
}

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
		if _, demon := b.seen[ev.EntityID]; demon {
			b.died[ev.EntityID] = ev.TargetID
			if ev.TargetID == b.entityID {
				b.demonKills++
				logf("%s killed a demon (%d, +%d xp)", b.name, ev.EntityID, ev.Value)
			}
		}
	case combat.EvPlayerDowned:
		if ev.EntityID == b.entityID {
			b.downs++
			logf("%s was downed", b.name)
		}
	case combat.EvPlayerHurt:
		b.hurt += int(ev.Value)
	case combat.EvRefused:
		if ev.TargetID == combat.ActSetMaterial {
			logf("%s: REFUSED: set material (is LODESTONE_ZONE_DEV_COMBAT on?)", b.name)
		}
	case game.EventDemonShrugged:
		b.shrugged++
	case game.EventDemonBurned:
		b.burned[ev.EntityID] = ev.Value == 1
		if ev.Value == 1 {
			b.died[ev.EntityID] = 0
		}
	case game.EventDawn:
		b.dawn++
		logf("%s: DAWN: %s (burned %d, fled %d)", b.name, ev.Data, ev.Value, ev.TargetID)
	case game.EventDusk:
		logf("%s: DUSK: %s (moon %d)", b.name, ev.Data, ev.Value)
	case game.EventDemonsRose:
		logf("%s: %d demons rose (rank %d) at (%.0f, %.0f)", b.name, ev.Value, ev.TargetID, proto.CmToMeters(ev.X), proto.CmToMeters(ev.Z))
	case game.EventDefenseWarning:
		logf("%s: DEFENSE: the ward of %s falters; first wave in %d s", b.name, ev.Data, ev.Value)
	case game.EventDefenseWave:
		n := 0
		if len(ev.Data) >= 4 {
			n = int(binary.LittleEndian.Uint16(ev.Data[2:]))
		}
		logf("%s: DEFENSE: wave %d of %d (%d demons)", b.name, ev.Value, ev.Data[0], n)
	case game.EventWardHealth:
		if b.name == "Ana" && (ev.Value%100 < 15 || ev.Value == 0) {
			logf("%s: ward garden health %d", b.name, ev.Value)
		}
	case game.EventDefenseEnded:
		b.defense = int(ev.Value)
		logf("%s: DEFENSE ENDED (%d): %s", b.name, ev.Value, ev.Data)
	case game.EventDefenseReward:
		b.defenseXP += int(ev.Value)
		logf("%s: defense reward +%d XP", b.name, ev.Value)
	case game.EventWorldClock:
		if len(ev.Data) >= 9 {
			off := math.Float64frombits(binary.LittleEndian.Uint64(ev.Data[1:]))
			t := float64(time.Now().UnixMilli())/1000 + off
			logf("%s: world clock offset %.0f s: %02.0f:%02.0f, night %v, moon %d", b.name, off, math.Floor(weather.Hour(t)), math.Mod(weather.Hour(t)*60, 60), weather.IsNight(t), ev.Value)
		}
	case 2:
		if ev.EntityID == b.entityID && b.brain != nil {
			b.brain.Rebase(movement.NewState(movement.Vec3{X: proto.CmToMeters(ev.X), Y: proto.CmToMeters(ev.Y), Z: proto.CmToMeters(ev.Z)}))
		}
	}
}

func (b *bot) summary() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := map[string]any{"weapon": b.weapon, "claimsAccepted": b.accepted, "claimsRefused": b.refused, "damageTaken": b.hurt, "downs": b.downs,
		"corrections": b.corr, "demonKills": b.demonKills, "defenseXP": b.defenseXP}
	if b.brain != nil {
		s["attacks"], s["dodges"] = b.brain.Attacks, b.brain.Dodges
	}
	return s
}

func nowMs() float64 { return float64(time.Now().UnixMicro()) / 1000 }

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

var terrainOnce struct {
	sync.Once
	t   *worldhost.Terrain
	err error
}

func openTerrain(info zoneInfo) (*worldhost.Terrain, error) {
	terrainOnce.Do(func() {
		if info.AtlasHash == "" {
			return
		}
		mod, err := worldhost.LoadFromEnv(context.Background())
		if err != nil {
			terrainOnce.err = err
			return
		}
		spec := []byte(info.Spec)
		if string(spec) == "null" {
			spec = nil
		}
		mt, _, err := mod.OpenRow(worldhost.WorldRow{Seed: info.Seed, Spec: spec, GenVersion: info.GenVersion, AtlasHash: info.AtlasHash}, worldhost.WorldOptions{})
		if err != nil {
			terrainOnce.err = err
			return
		}
		terrainOnce.t = worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{})
	})
	return terrainOnce.t, terrainOnce.err
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
	var g movement.Ground = surface
	if cv, err := worldhost.NewCaves(t.World(), worldhost.CaveOptions{Workers: 1}); err == nil {
		g = worldhost.NewCaveTerrain(t, surface, cv)
	}
	// WP20: buildings on top, as the zone does, so bots fighting in a town
	// bump the same walls (the defense happens at the ward garden).
	if b, err := t.World().TownsBytes(); err == nil {
		if tw, err := towns.Parse(b); err == nil {
			g = towns.NewGround(g, tw)
		}
	}
	return g, nil
}
