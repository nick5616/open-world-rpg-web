package game

// Playtest 2 fishing (CR 026, contracts/content.yaml `fishing`): Interact 88
// and Events 1080-1084. The zone owns every catch:
//
//   cast   (88/1, the bobber's x/z)  the angler holds a rod, stands on the
//          ground in reach of water at least minDepthM deep; the zone
//          classifies the water (lake, river, sea: atlas node flags), reads
//          the biome, the world clock and the rain, and rolls the catch
//          from a seed (world seed, character, the character's cast count,
//          the bobber's cell; content.RollCatch). The angler gets the bite
//          time and the false nibbles (1080), never the species.
//   hook   (88/2) must arrive after the bite and within hookWindowMs (plus
//          latency slack): the fight's seed and numbers follow (1081). A
//          strike before the bite spooks the fish.
//   land   (88/3, the client's fight ms) must come no sooner than the
//          fastest possible win (content.FightMinMs) by the zone's clock
//          and the client's; the fish goes into the inventory (persisted
//          like any item), the codex and the feats (1082).
//   lose   (88/4) the line snapped, the fish escaped, or the angler reeled
//          in; walking away (walkAwayM) or a missed bite ends it too (1083).
//
// Casts are rate limited (castCooldownS after each outcome; castBurst, then
// one per castEveryS) on top of the Interact limiter. Others within seeM
// see the angler's pose and line through the emote event (1090, id 20 with
// the bobber, 21 holding the catch up; emotes.go). Nothing runs per tick
// for a player who isn't fishing.

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"time"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ratelimit"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

// Interact 88 `fishing`.
const (
	InteractFishing = 88

	FishActCast   = 1 // targetId = bobber x cm | z cm << 32 (u32 each)
	FishActHook   = 2 // targetId = cast seq
	FishActLand   = 3 // targetId = cast seq, arg = the client's fight ms
	FishActLose   = 4 // targetId = cast seq, arg = reason (FishLost*)
	FishActDevRod = 9 // dev builds only: a rod in the pack
)

// Events 1080-1084.
const (
	EventFishCast    = 1080
	EventFishHooked  = 1081
	EventFishCaught  = 1082
	EventFishLost    = 1083
	EventFishRefused = 1084
)

// Why a fish was lost (Event 1083 value; 88/4 arg).
const (
	FishLostEarly      = 1 // struck before the bite
	FishLostMissed     = 2 // the bite went unanswered
	FishLostSnapped    = 3 // the line snapped (client)
	FishLostEscaped    = 4 // the fish won the fight (client)
	FishLostCancelled  = 5 // reeled in
	FishLostWalkedAway = 6
	FishLostTooQuick   = 7 // a fight shorter than possible
	FishLostTooLong    = 8
	FishLostPackFull   = 9
)

// Cast refusals (Event 1084 value).
const (
	FishRefuseNoRod   = 1
	FishRefuseNoWater = 2
	FishRefuseReach   = 3
	FishRefuseTooSoon = 4
	FishRefuseBusy    = 5 // a line is already out
	FishRefuseNotNow  = 6 // swimming, climbing, gliding, downed, underground
	FishRefuseBadSeq  = 7
)

const (
	fishHookSlackMs = 700 // latency allowance after the hook window
	fishLandSlackMs = 400 // jitter allowance on the fastest fight
	fishMissGraceMs = 2500
)

// fishFast (LODESTONE_ZONE_FISH_FAST=1, dev zones only) makes every bite
// come after ~1.5 s (evidence runs, tests).
var fishFast = os.Getenv("LODESTONE_ZONE_FISH_FAST") == "1"

// fishCast is a line in the water.
type fishCast struct {
	seq     uint32
	at      time.Time
	x, y, z float64 // the bobber
	water   int
	catch   content.Catch
	hooked  time.Time
}

// fishState is a session's fishing.
type fishState struct {
	seq    uint32
	casts  uint32 // without a content state: casts this session (the roll seed)
	cast   *fishCast
	next   time.Time // no cast before this
	bucket ratelimit.Bucket
}

func (s *Server) fishOf(sess *session) *fishState {
	if sess.fish == nil {
		fi := &contentdefs.D.Fishing
		sess.fish = &fishState{bucket: ratelimit.New(fi.CastBurst, 1/math.Max(0.1, fi.CastEveryS))}
	}
	return sess.fish
}

// fishInteract applies Interact 88 (tick goroutine).
func (s *Server) fishInteract(sess *session, m *proto.Interact, now time.Time) {
	e := sess.ent
	if e == nil {
		return
	}
	fs := s.fishOf(sess)
	refuse := func(r int32) {
		s.sendEvent(sess, &proto.Event{Kind: EventFishRefused, EntityID: e.ID, TargetID: uint32(m.TargetID), Value: r, Data: []byte{m.Action}})
	}
	switch m.Action {
	case FishActCast:
		s.fishCastAt(sess, fs, float64(uint32(m.TargetID))/100, float64(uint32(m.TargetID>>32))/100, now, refuse)
	case FishActHook:
		c := fs.cast
		if c == nil || uint64(c.seq) != m.TargetID || !c.hooked.IsZero() {
			refuse(FishRefuseBadSeq)
			return
		}
		el := now.Sub(c.at).Milliseconds()
		switch {
		case el < int64(c.catch.BiteMs)-50:
			s.fishStop(sess, FishLostEarly)
		case el > int64(c.catch.BiteMs+contentdefs.D.Fishing.HookWindowMs+fishHookSlackMs):
			s.fishStop(sess, FishLostMissed)
		default:
			c.hooked = now
			f := contentdefs.D.FishByID(c.catch.Species)
			b, _ := json.Marshal(struct {
				Seq      uint32  `json:"seq"`
				Seed     uint32  `json:"seed"`
				Strength float64 `json:"strength"`
				Erratic  float64 `json:"erratic"`
				Stamina  float64 `json:"stamina"`
				Rarity   int     `json:"rarity"`
				MinMs    int     `json:"minMs"`
			}{c.seq, c.catch.FightSeed, f.Fight.Strength, f.Fight.Erratic, f.Fight.Stamina, f.Rarity, content.FightMinMs(f)})
			s.sendEvent(sess, &proto.Event{Kind: EventFishHooked, EntityID: e.ID, TargetID: c.seq, Value: int32(f.Rarity), Data: b})
		}
	case FishActLand:
		c := fs.cast
		if c == nil || uint64(c.seq) != m.TargetID || c.hooked.IsZero() {
			refuse(FishRefuseBadSeq)
			return
		}
		f := contentdefs.D.FishByID(c.catch.Species)
		minMs := int64(content.FightMinMs(f))
		el := now.Sub(c.hooked).Milliseconds()
		switch {
		case el < minMs-fishLandSlackMs || int64(m.Arg) < minMs-50:
			s.fishStop(sess, FishLostTooQuick)
		case el > int64(contentdefs.D.Fishing.MaxFightS*1000)+5000:
			s.fishStop(sess, FishLostTooLong)
		default:
			s.fishLanded(sess, fs, c, f, now)
		}
	case FishActLose:
		c := fs.cast
		if c == nil || uint64(c.seq) != m.TargetID {
			refuse(FishRefuseBadSeq)
			return
		}
		r := int32(m.Arg)
		if r != FishLostSnapped && r != FishLostEscaped && r != FishLostMissed {
			r = FishLostCancelled
		}
		s.fishStop(sess, r)
	case FishActDevRod:
		ci := sess.items
		if !s.cfg.DevSpawn || ci == nil || !ci.inv.CanFit(contentdefs.D.Fishing.Rod, 1) {
			refuse(FishRefuseNotNow)
			return
		}
		var d items.Delta
		it := items.Stack(contentdefs.D.Fishing.Rod, 1)
		ci.inv.Add(it, &d)
		s.commitItems(sess, &d, nil, "dev rod")
		s.sendGranted(sess, SourceContent, []*items.Item{it})
	default:
		refuse(FishRefuseBadSeq)
	}
}

// fishWaterKind classifies the water at (x, z): a river where the atlas
// marks one around the point, else a lake, else the sea (or by height when
// the atlas has no node flags).
func (s *Server) fishWaterKind(x, z, surface float64) int {
	if s.cbt.w != nil && s.cbt.w.Atlas != nil {
		a := s.cbt.w.Atlas
		f := a.NodeFlagsNear(x, z)
		switch {
		case f&combat.NodeRiver != 0:
			return content.WaterRiver
		case f&combat.NodeLake != 0:
			return content.WaterLake
		case f&combat.NodeSea != 0:
			return content.WaterSea
		}
		if surface <= a.SeaLevel+0.3 {
			return content.WaterSea
		}
	}
	return content.WaterLake
}

func (s *Server) fishCastAt(sess *session, fs *fishState, x, z float64, now time.Time, refuse func(int32)) {
	e := sess.ent
	fi := &contentdefs.D.Fishing
	ci := sess.items
	if ci == nil || ci.inv.Count(fi.Rod) == 0 {
		refuse(FishRefuseNoRod)
		return
	}
	if fs.cast != nil {
		refuse(FishRefuseBusy)
		return
	}
	g := s.cfg.Ground
	if g == nil || (e.cbt != nil && e.cbt.Downed) || !emoteModeOK(e) {
		refuse(FishRefuseNotNow)
		return
	}
	p := e.Move.Pos
	if p.Y < g.HeightAt(p.X, p.Z)-2.5 { // in a cave below the surface
		refuse(FishRefuseNotNow)
		return
	}
	d := math.Hypot(x-p.X, z-p.Z)
	if d < fi.CastM[0]-1 || d > fi.CastM[1]+1 {
		refuse(FishRefuseReach)
		return
	}
	w := movement.WaterAt(g, x, z)
	if math.IsInf(w, 0) || math.IsNaN(w) || w-g.HeightAt(x, z) < fi.MinDepthM || w > p.Y+3 || w < p.Y-20 {
		refuse(FishRefuseNoWater)
		return
	}
	if now.Before(fs.next) || !fs.bucket.Take(now) {
		refuse(FishRefuseTooSoon)
		return
	}
	// The roll: the character's cast count (persisted with the content state) keeps rolls fresh across sessions.
	var n uint32
	if sess.cnt != nil {
		n = uint32(sess.cnt.st.Add("casts", 1))
	} else {
		fs.casts++
		n = fs.casts
	}
	t := s.worldTimeS()
	raining := s.rainingAt(x, z, t) // CR 030: the weather where the bobber lands
	if s.cfg.Rain != nil {
		raining = *s.cfg.Rain
	}
	cond := content.FishConditions{Water: s.fishWaterKind(x, z, w), Biome: s.biomeAt(x, z), Hour: weather.Hour(t), Raining: raining}
	catch, ok := content.RollCatch(content.FishSeed(s.cfg.Seed, hashString(e.CharacterID), n, x, z), cond)
	if !ok { // nothing lives there: a silverfin always does in fresh water, a mackerel at sea
		refuse(FishRefuseNoWater)
		return
	}
	if fishFast {
		catch.BiteMs = 1200 + catch.BiteMs%600
		catch.Nibbles = nil
	}
	fs.seq++
	c := &fishCast{seq: fs.seq, at: now, x: x, y: w, z: z, water: cond.Water, catch: catch}
	fs.cast = c
	b, _ := json.Marshal(struct {
		Seq      uint32 `json:"seq"`
		Water    string `json:"water"`
		BiteMs   int    `json:"biteMs"`
		WindowMs int    `json:"windowMs"`
		Nibbles  []int  `json:"nibbles"`
	}{c.seq, fi.Waters[cond.Water], catch.BiteMs, fi.HookWindowMs, catch.Nibbles})
	s.sendEvent(sess, &proto.Event{Kind: EventFishCast, EntityID: e.ID, TargetID: c.seq, Value: int32(catch.BiteMs), X: cm(x), Y: cm(w), Z: cm(z), Data: b})
	s.playEmote(sess, EmoteFishing, true, 0, x, w, z) // others see the pose and the line (emotes.go)
}

// fishLanded pays out a won fight.
func (s *Server) fishLanded(sess *session, fs *fishState, c *fishCast, f *contentdefs.Fish, now time.Time) {
	e := sess.ent
	ci := sess.items
	if ci == nil || !ci.inv.CanFit(f.Item, 1) {
		s.fishStop(sess, FishLostPackFull)
		return
	}
	var d items.Delta
	it := items.Stack(f.Item, 1)
	it.Prov = []items.Prov{{Ev: "fish", Char: e.CharacterID, Name: e.Name, Src: "fish:" + strconv.Itoa(c.catch.WeightG) + "g", At: now.UnixMilli(), Local: ci.persist == persistLocal}}
	ci.inv.Add(it, &d)
	s.commitItems(sess, &d, nil, "fish")
	s.sendGranted(sess, SourceContent, []*items.Item{it})
	first, record, count, best := true, false, 1, c.catch.WeightG
	if cs := sess.cnt; cs != nil {
		first, record = cs.st.Landed(f.Key, c.catch.WeightG, f.Rarity == 3)
		r := cs.st.Fish[f.Key]
		count, best = r[0], r[1]
		cs.recheck = true
	}
	b, _ := json.Marshal(struct {
		Key     string `json:"key"`
		Name    string `json:"name"`
		Item    string `json:"item"`
		WeightG int    `json:"weightG"`
		Rarity  int    `json:"rarity"`
		Water   string `json:"water"`
		First   bool   `json:"first"`
		Record  bool   `json:"record"`
		Count   int    `json:"count"`
		Best    int    `json:"best"`
	}{f.Key, f.Name, f.Item, c.catch.WeightG, f.Rarity, contentdefs.D.Fishing.Waters[c.water], first, record, count, best})
	s.sendEvent(sess, &proto.Event{Kind: EventFishCaught, EntityID: e.ID, TargetID: uint32(f.ID), Value: int32(c.catch.WeightG), Data: b})
	fs.cast = nil
	fs.next = now.Add(time.Duration(contentdefs.D.Fishing.CastCooldownS * float64(time.Second)))
	s.stopEmote(sess, false)
	s.playEmote(sess, EmoteShowCatch, false, int32(f.ID), e.Move.Pos.X, e.Move.Pos.Y, e.Move.Pos.Z)
	if first {
		s.grantCombatXP(combat.XPGrant{Player: e.ID, XP: 15 + 25*int64(f.Rarity), Reason: "fish"})
	}
	if sess.cnt != nil {
		s.contentAchievements(sess)
		s.saveContent(sess)
	}
	s.questsDeed(sess, quests.DeedFish) // CR 051: the pond errand
	s.log.Info("fish landed", "character", e.CharacterID, "fish", f.Key, "g", c.catch.WeightG)
}

// fishStop ends sess's cast (if any) with a reason: the angler hears why
// (1083), the line leaves everyone's view.
func (s *Server) fishStop(sess *session, reason int32) {
	fs := sess.fish
	if fs == nil || fs.cast == nil {
		return
	}
	c := fs.cast
	fs.cast = nil
	fs.next = s.cfg.Now().Add(time.Duration(contentdefs.D.Fishing.CastCooldownS * float64(time.Second)))
	if sess.ent != nil {
		s.sendEvent(sess, &proto.Event{Kind: EventFishLost, EntityID: sess.ent.ID, TargetID: c.seq, Value: reason})
	}
	if em := sess.emotes; em != nil && em.loop != nil && em.loop.fishing {
		s.stopEmote(sess, true)
	}
}

// fishCheck (emotesTick, once a second while a line is out): an unanswered
// bite or a fight past maxFightS ends it.
func (s *Server) fishCheck(sess *session, now time.Time) {
	fs := sess.fish
	if fs == nil || fs.cast == nil {
		return
	}
	c := fs.cast
	fi := &contentdefs.D.Fishing
	if c.hooked.IsZero() && now.Sub(c.at).Milliseconds() > int64(c.catch.BiteMs+fi.HookWindowMs+fishHookSlackMs+fishMissGraceMs) {
		s.fishStop(sess, FishLostMissed)
	} else if !c.hooked.IsZero() && now.Sub(c.hooked).Seconds() > fi.MaxFightS+5 {
		s.fishStop(sess, FishLostTooLong)
	}
}

// fishLeave drops a leaving session's line.
func (s *Server) fishLeave(sess *session) {
	if sess.fish != nil {
		sess.fish.cast = nil
	}
}
