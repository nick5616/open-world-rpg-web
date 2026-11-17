package game

// Base building (playtest 3, CR 041, contracts/build.yaml). A building
// piece is a camp piece (camps.go: same table, same area streaming, same
// ownership by the zone that owns the ground, same collision set); this file
// is what is different about it:
//
//   - Placement (Interact 90/1 with a building kind): the pure rules of
//     server/pkg/camps/build.go (grid, sockets, support, overlap, other
//     players' pieces) plus the zone's: no building in or beside a
//     settlement, on a road or in a site, a per-character budget and a
//     per-256 m-area budget (the counters are kept by campIndex), and the
//     cost in items taken in the same item transaction that makes the piece.
//   - Deconstruct (90/2): the owner, or the owner's party when shared, gets
//     build.refundPct of the cost back; a piece that other pieces rest on is
//     refused (camps.Orphans over the pieces within 16 m).
//   - Repair (90/11) and weathering: a piece's condition is stored with the
//     world day it was stamped and aged lazily (wear by material, mending
//     inside a warding hearth's ward), so nothing is written as pieces wear.
//   - Use (90/3): doors and gates toggle their state (persisted, sent as a
//     change, the solid set rebuilt next tick); the bed rests (with the comfort
//     of the furnishings around it) and is the respawn point; the large chest,
//     forge, kitchen hearth and carpenter's bench reuse the camps' chest and
//     station panels; the warding hearth is a permanent fire for the night
//     hooks (fireSpot with its own radius).
//   - Home (90/12): back to your bed, under the fast-travel cooldown and the
//     rest's combat lock; share (90/13): your party may use your pieces.
//   - Event 1820 summarises your base (pieces, budget, comfort, bed, hearth).
//
// Cost model: nothing runs per tick but the coalesced rebuild of the solid
// set (campTouch), and the owner's once-a-second campSeen.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/camps"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

const buildNearM = 16.0 // pieces within this of a placement are the rules' neighbours

func isBed(kind int) bool {
	d := campdefs.D.ByID(kind)
	return d != nil && d.Build != nil && d.Build.Use == "bed"
}

func isHearth(kind int) bool {
	d := campdefs.D.ByID(kind)
	return d != nil && d.Build != nil && d.Build.Use == "hearth"
}

// chestSlotsOf is the slot count of a chest kind (0: not a chest).
func chestSlotsOf(kind int) int {
	if kind == campdefs.Chest {
		return campdefs.D.Chest.Slots
	}
	if d := campdefs.D.ByID(kind); d != nil && d.Build != nil && d.Build.Use == "chest" {
		return d.Build.Slots
	}
	return 0
}

// bp is the piece as the building rules see it.
func (p *campPiece) bp() *camps.BP {
	return &camps.BP{ID: p.ID, Kind: p.Kind, Rot: p.Rot, X: p.XCm, Y: p.YCm, Z: p.ZCm, State: p.State, Owner: p.Owner, Party: p.Party, Lock: p.Lock}
}

func (s *Server) worldDay() float64 { return s.worldTimeS() / constants.DayLengthS }

// inWard: the piece lies inside a warding hearth's circle.
func (s *Server) inWard(p *campPiece) bool {
	for _, f := range s.camp.fires {
		if f.r > 0 && (f.x-p.X)*(f.x-p.X)+(f.z-p.Z)*(f.z-p.Z) < f.r*f.r {
			return true
		}
	}
	return false
}

// buildCond is a building piece's condition now (percent): worn by its
// material per in-game day since it was stamped, down to the floor, or mended
// inside a hearth's ward. Camp pieces are always 100.
func (s *Server) buildCond(p *campPiece) float64 {
	d := campdefs.D.ByID(p.Kind)
	if d == nil || d.Build == nil {
		return 100
	}
	b := &campdefs.D.Build
	days := math.Max(0, s.worldDay()-p.CondDay)
	c := p.Cond
	if s.inWard(p) {
		c = math.Min(100, c+b.MendPerDay*days)
	} else if d.Build.Mat >= 0 && d.Build.Mat < len(b.Materials) {
		floor := math.Min(c, b.WeatherFloor)
		c = math.Max(floor, c-b.Materials[d.Build.Mat].Weather*days)
	}
	return math.Max(0, math.Min(100, c))
}

// ---- comfort ----

// buildComfort is the bed's comfort score: the furnishings within
// comfort.radiusM, each kind counted up to perKindCap, worn pieces (under 50
// percent) not at all.
func (s *Server) buildComfort(bed *campPiece) int {
	cf := &campdefs.D.Build.Comfort
	counts := map[int]int{}
	score := 0
	for _, q := range s.piecesNear(bed.X, bed.Z, cf.RadiusM) {
		d := campdefs.D.ByID(q.Kind)
		if d == nil || d.Build == nil || d.Build.Comfort == 0 || q.Owner != bed.Owner {
			continue
		}
		if counts[q.Kind] >= cf.PerKindCap || s.buildCond(q) < 50 {
			continue
		}
		counts[q.Kind]++
		score += d.Build.Comfort
	}
	return min(score, cf.MaxScore)
}

func comfortTier(score int) string {
	name := ""
	for _, t := range campdefs.D.Build.Comfort.Tiers {
		if score >= t.Score {
			name = t.Name
		}
	}
	return name
}

// ---- the world for the rules ----

type buildEnv struct {
	campEnv
}

// NoBuild: 0, or why this ground is not for building: a settlement (and its
// margin), a road or footpath, a site (ruin, shrine, camp, tower, landmark).
func (v buildEnv) NoBuild(x, z, r float64) int {
	b := &campdefs.D.Build
	if v.InTown(x, z, b.TownMarginM) {
		return camps.RefuseTown
	}
	if tw := v.s.cfg.Towns; tw != nil {
		for i := range tw.T.Roads {
			rd := &tw.T.Roads[i]
			lim := rd.Width/2 + b.RoadMarginM + r
			for j := 0; j+1 < len(rd.Points); j++ {
				if distSeg(x, z, rd.Points[j][0], rd.Points[j][2], rd.Points[j+1][0], rd.Points[j+1][2]) < lim {
					return camps.RefuseRoad
				}
			}
		}
	}
	if ex := v.s.cfg.Explore; ex != nil {
		for i := range ex.Atlas.Sites {
			a := &ex.Atlas.Sites[i]
			if a.Radius <= 0 || !buildSite(a) {
				continue
			}
			if math.Hypot(a.X-x, a.Z-z) < a.Radius+b.SiteMarginM {
				return camps.RefuseSite
			}
		}
	}
	return 0
}

// buildSite: the sites players visit (the content sites: towers, landmarks,
// enemy camps, ruins, watchtowers, shrines, bandit camps); settlements have
// their own margin.
func buildSite(a *structures.Site) bool {
	switch {
	case a.Category == structures.CategoryPOI && (a.Kind == structures.POITower || a.Kind == structures.POILandmark || a.Kind == structures.POIEnemyCamp):
		return true
	case a.Category == structures.CategoryStructure && (a.Kind == combat.StructRuin || a.Kind == combat.StructWatchtower || a.Kind == combat.StructShrine || a.Kind == combat.StructBanditCamp):
		return true
	}
	return false
}

func distSeg(px, pz, ax, az, bx, bz float64) float64 {
	dx, dz := bx-ax, bz-az
	l2 := dx*dx + dz*dz
	t := 0.0
	if l2 > 0 {
		t = math.Max(0, math.Min(1, ((px-ax)*dx+(pz-az)*dz)/l2))
	}
	return math.Hypot(px-(ax+t*dx), pz-(az+t*dz))
}

// piecesBP lists the building rules' view of the pieces within r of (x, z).
func (s *Server) piecesBP(x, z, r float64) []*camps.BP {
	ps := s.piecesNear(x, z, r)
	out := make([]*camps.BP, 0, len(ps))
	for _, p := range ps {
		out = append(out, p.bp())
	}
	return out
}

// ---- place ----

func (s *Server) buildMissing(sess *session, def *campdefs.Piece, cost []campdefs.Cost) []map[string]any {
	ci := sess.items
	var miss []map[string]any
	for _, c := range cost {
		if have := ci.inv.Count(c.Item); have < c.Qty {
			miss = append(miss, map[string]any{"item": c.Item, "qty": c.Qty, "have": have})
		}
	}
	return miss
}

func (s *Server) buildPlace(sess *session, m *proto.Interact, def *campdefs.Piece, kind, rot int, xcm, zcm int32) {
	e, ci := sess.ent, sess.items
	b := &campdefs.D.Build
	if ci == nil {
		s.campRefuse(sess, m.Action, 0, camps.RefuseUnknown)
		return
	}
	c := &s.camp
	if c.nBuild[e.CharacterID] >= b.Budget {
		s.campRefuse(sess, m.Action, 0, camps.RefuseBudget)
		return
	}
	x, z := camps.Cm2M(xcm), camps.Cm2M(zcm)
	a := campArea(x, z)
	if c.nArea[a] >= b.AreaBudget {
		s.campRefuse(sess, m.Action, 0, camps.RefuseAreaFull)
		return
	}
	if def.Build.Cat == "furnish" && def.Max > 0 {
		n := 0
		for _, q := range c.byOwner[e.CharacterID] {
			if q.Kind == kind {
				n++
			}
		}
		if n >= def.Max {
			s.campRefuse(sess, m.Action, 0, camps.RefuseKindLimit)
			return
		}
	}
	w := camps.BuildWant{Kind: kind, Rot: rot, X: xcm, Z: zcm, Owner: e.CharacterID, Party: e.PartyID,
		FeetX: e.Move.Pos.X, FeetY: e.Move.Pos.Y, FeetZ: e.Move.Pos.Z}
	if m.Arg != 0 {
		w.HasY, w.Y = true, int32(int64(m.Arg)-1048576)
	}
	y, why := camps.CheckBuild(w, s.piecesBP(x, z, buildNearM), buildEnv{campEnv{s}})
	if why == 0 && def.Solid {
		bp := &camps.BP{Kind: kind, Rot: rot, X: xcm, Y: y, Z: zcm}
		for _, bx := range camps.BoxesOf(bp) {
			for _, o := range s.ents {
				if (o.Kind == proto.EntityKindPlayer || o.Kind == proto.EntityKindNpc || o.Kind == proto.EntityKindEnemy) && bodyInBox(o, bx) {
					why = camps.RefuseBody
					break
				}
			}
		}
	}
	if why != 0 {
		s.campRefuse(sess, m.Action, 0, why)
		return
	}
	if miss := s.buildMissing(sess, def, def.Build.Cost); len(miss) > 0 {
		jb, _ := json.Marshal(miss)
		s.sendEvent(sess, &proto.Event{Kind: EventBuildMissing, EntityID: e.ID, TargetID: uint32(kind), Data: jb})
		s.campRefuse(sess, m.Action, 0, camps.RefuseMaterials)
		return
	}
	var d items.Delta
	for _, cl := range def.Build.Cost {
		if !ci.inv.Spend(cl.Item, cl.Qty, &d) {
			s.campRefuse(sess, m.Action, 0, camps.RefuseMaterials)
			return
		}
	}
	p := &campPiece{ID: s.campNewID(), Kind: kind, Rot: rot, XCm: xcm, YCm: y, ZCm: zcm, Owner: e.CharacterID, OwnerName: e.Name, Party: e.PartyID,
		Cond: 100, CondDay: s.worldDay(), PlacedAt: s.cfg.Now(), SeenAt: s.cfg.Now()}
	p.X, p.Y, p.Z = x, camps.Cm2M(y), z
	p.Lock = s.buildSharing(e.CharacterID)
	if n := chestSlotsOf(kind); n > 0 {
		p.chest = make([]*chestSlot, n)
	}
	s.campIndex(p)
	p.mine = true
	s.campCommit(sess, &d, "build place "+def.Key, nil, func() {
		if s.camp.pieces[p.ID] == p {
			s.campSave(p)
		}
	})
	s.campTouch()
	s.campSendAreas(sess)
	s.campNotify(p, 1, e.ID)
	s.campBroadcastCtl(p.json())
	if isHearth(kind) {
		s.campFires()
	}
	s.sendBuildInfo(sess)
	s.questsDeed(sess, quests.DeedBuild) // CR 051: the timber errand
	s.log.Info("build piece placed", "piece", p.ID, "kind", def.Key, "owner", e.CharacterID, "x", p.X, "y", p.Y, "z", p.Z, "rot", rot)
}

func bodyInBox(o *Entity, b [9]float64) bool {
	// Rotated box test with the body's capacity radius.
	dx, dz := o.Move.Pos.X-b[0], o.Move.Pos.Z-b[1]
	u := dx*b[2] + dz*b[3]
	v := dz*b[2] - dx*b[3]
	cu, cv := math.Max(-b[4], math.Min(b[4], u)), math.Max(-b[5], math.Min(b[5], v))
	r := constants.PlayerCapsuleRadius + campdefs.D.Placement.BodyClearM
	if math.Hypot(u-cu, v-cv) >= r {
		return false
	}
	y := o.Move.Pos.Y
	return y < b[7] && y+1.9 > b[6]
}

// buildSharing is the owner's current share setting (1: shared with the party).
func (s *Server) buildSharing(owner string) int {
	for _, q := range s.camp.byOwner[owner] {
		if camps.Builds(q.Kind) {
			return q.Lock
		}
	}
	return 0
}

// ---- deconstruct ----

func (s *Server) buildAllowed(sess *session, p *campPiece, action uint8) bool {
	if camps.Allows(sess.ent.CharacterID, sess.ent.PartyID, p.bp()) {
		return true
	}
	s.campRefuse(sess, action, p.ID, camps.RefuseNotYours)
	return false
}

func (s *Server) buildDeconstruct(sess *session, p *campPiece) {
	e, ci := sess.ent, sess.items
	if !s.buildAllowed(sess, p, CampActPickup) {
		return
	}
	if !p.chestEmpty() {
		s.campRefuse(sess, CampActPickup, p.ID, camps.RefuseNotEmpty)
		return
	}
	def := campdefs.D.ByID(p.Kind)
	if ci == nil {
		s.campRefuse(sess, CampActPickup, p.ID, camps.RefuseUnknown)
		return
	}
	near := s.piecesBP(p.X, p.Z, buildNearM)
	if hold := camps.Orphans(near, p.ID, campEnv{s}); len(hold) > 0 {
		s.campRefuse(sess, CampActPickup, p.ID, camps.RefuseHolds)
		return
	}
	var d items.Delta
	var got []*items.Item
	for _, cl := range def.Build.Cost {
		n := int(math.Round(float64(cl.Qty) * campdefs.D.Build.RefundPct / 100))
		if n < 1 {
			continue
		}
		if !ci.inv.CanFit(cl.Item, n) {
			s.campRefuse(sess, CampActPickup, p.ID, camps.RefuseFull)
			return
		}
		it := items.Stack(cl.Item, n)
		it.Prov = []items.Prov{{Ev: "build_refund", Char: e.CharacterID, Name: e.Name, At: s.cfg.Now().UnixMilli()}}
		ci.inv.Add(it, &d)
		got = append(got, it)
	}
	st, world, id := s.cfg.CampStore, s.cfg.WorldID, p.ID
	var before func(ctx context.Context) error
	if st != nil {
		before = func(ctx context.Context) error { return st.DeleteCamp(ctx, world, id) }
	}
	s.campCommit(sess, &d, "build deconstruct "+def.Key, before, nil)
	s.campRemove(p, 1, true)
	if isHearth(p.Kind) {
		s.campFires()
	}
	s.sendGranted(sess, SourceCraft, got)
	s.log.Info("build piece deconstructed", "piece", p.ID, "kind", def.Key, "by", e.CharacterID, "owner", p.Owner)
}

// ---- repair ----

func (s *Server) buildRepairCost(p *campPiece) []campdefs.Cost {
	def := campdefs.D.ByID(p.Kind)
	cond := s.buildCond(p)
	if cond >= 99.5 {
		return nil
	}
	var out []campdefs.Cost
	for _, cl := range def.Build.Cost {
		n := int(math.Ceil(float64(cl.Qty) * campdefs.D.Build.RepairPct / 100 * (100 - cond) / 100))
		out = append(out, campdefs.Cost{Item: cl.Item, Qty: max(1, n)})
	}
	return out
}

func (s *Server) buildRepair(sess *session, p *campPiece) {
	e, ci := sess.ent, sess.items
	if !camps.Builds(p.Kind) || ci == nil {
		s.campRefuse(sess, CampActRepair, p.ID, camps.RefuseUnknown)
		return
	}
	if !s.buildAllowed(sess, p, CampActRepair) {
		return
	}
	cost := s.buildRepairCost(p)
	if len(cost) == 0 {
		return
	}
	if miss := s.buildMissing(sess, nil, cost); len(miss) > 0 {
		jb, _ := json.Marshal(miss)
		s.sendEvent(sess, &proto.Event{Kind: EventBuildMissing, EntityID: e.ID, TargetID: uint32(p.Kind), Data: jb})
		s.campRefuse(sess, CampActRepair, p.ID, camps.RefuseMaterials)
		return
	}
	var d items.Delta
	for _, cl := range cost {
		if !ci.inv.Spend(cl.Item, cl.Qty, &d) {
			s.campRefuse(sess, CampActRepair, p.ID, camps.RefuseMaterials)
			return
		}
	}
	s.commitItems(sess, &d, nil, "build repair")
	p.Cond, p.CondDay = 100, s.worldDay()
	s.campSave(p)
	s.campNotify(p, 2, e.ID)
	s.campBroadcastCtl(p.json())
	s.sendBuildInfo(sess)
}

// ---- use ----

func (s *Server) buildUse(sess *session, p *campPiece, def *campdefs.Piece) {
	e, ci := sess.ent, sess.items
	sh := def.Build
	if sh.Door {
		if !camps.Allows(e.CharacterID, e.PartyID, p.bp()) {
			s.campRefuse(sess, CampActUse, p.ID, camps.RefuseLocked)
			return
		}
		p.State ^= 1
		s.campSave(p)
		s.campTouch()
		s.campNotify(p, 2, e.ID)
		s.campBroadcastCtl(p.json())
		return
	}
	station := func(kind int) {
		if ci == nil {
			return
		}
		if !s.campCanUse(e, p) {
			s.campRefuse(sess, CampActUse, p.ID, camps.RefuseLocked)
			return
		}
		ci.station = &openStation{kind: kind, prop: p.ID, x: p.X, y: p.Y, z: p.Z}
		s.sendEvent(sess, &proto.Event{Kind: EventStation, EntityID: e.ID, TargetID: uint32(kind), Value: int32(s.smithing(e)), Data: binary.LittleEndian.AppendUint64(nil, p.ID)})
	}
	switch sh.Use {
	case "bed":
		s.campRest(sess, p)
	case "chest":
		if !s.campCanUse(e, p) {
			s.campRefuse(sess, CampActUse, p.ID, camps.RefuseLocked)
			return
		}
		s.sessCamp(sess).openChest = p.ID
		s.sendChest(sess, p)
	case "forge":
		station(StationForge)
	case "cook":
		station(StationCook)
	case "workbench":
		station(StationWorkbench)
	case "hearth":
		s.campNote(sess, 1, "The hearth burns on. Demons keep away from your home, and it slowly mends your pieces.")
	}
}

// ---- home and sharing ----

func (s *Server) buildHome(sess *session) {
	e := sess.ent
	var bed *campPiece
	best := -1
	for _, p := range s.camp.byOwner[e.CharacterID] {
		if isBed(p.Kind) {
			if sc := s.buildComfort(p); sc > best {
				bed, best = p, sc
			}
		}
	}
	if bed == nil {
		s.campRefuse(sess, CampActHome, 0, camps.RefuseNoHome)
		return
	}
	cs := s.sessCamp(sess)
	now := s.cfg.Now()
	rd := &campdefs.D.Rested
	if e.cbt != nil && s.cbt.w != nil && (e.cbt.Downed || e.cbt.InCombatWithin(s.cbt.w.Tick(), rd.CombatLockS)) {
		s.campRefuse(sess, CampActHome, 0, camps.RefuseCombat)
		return
	}
	cd := time.Duration(campdefs.D.Build.Home.CooldownS * float64(time.Second))
	if !cs.homeAt.IsZero() && now.Sub(cs.homeAt) < cd {
		s.campRefuse(sess, CampActHome, 0, camps.RefuseCooldown)
		return
	}
	if sess.x != nil && now.Sub(sess.x.lastTravel) < fastTravelCooldown {
		s.campRefuse(sess, CampActHome, 0, camps.RefuseCooldown)
		return
	}
	if !bed.mine || !s.ownsPoint(bed.X, bed.Z) {
		s.campRefuse(sess, CampActHome, 0, camps.RefuseElsewhere)
		return
	}
	cs.homeAt = now
	if sess.x != nil {
		sess.x.lastTravel = now
	}
	s.Teleport(e, movement.Vec3{X: bed.X, Y: bed.Y, Z: bed.Z})
	s.campNote(sess, 2, "You are home.")
	s.sendBuildInfo(sess)
	s.log.Info("home travel", "character", e.CharacterID, "piece", bed.ID)
}

func (s *Server) buildShare(sess *session, mode int) {
	e := sess.ent
	if mode != 0 {
		mode = 1
	}
	changed := 0
	for _, p := range s.camp.byOwner[e.CharacterID] {
		if !camps.Builds(p.Kind) || (p.Lock == mode && p.Party == e.PartyID) {
			continue
		}
		p.Lock, p.Party = mode, e.PartyID
		changed++
		s.campSave(p)
		s.campNotify(p, 2, e.ID)
		s.campBroadcastCtl(p.json())
	}
	if changed > 0 {
		for _, o := range s.sessions {
			if o.camp != nil && o.camp.openChest != 0 && o.ent != nil {
				if p := s.camp.pieces[o.camp.openChest]; p != nil && p.Owner == e.CharacterID {
					if !s.campCanUse(o.ent, p) {
						o.camp.openChest = 0
					}
					s.sendChest(o, p)
				}
			}
		}
	}
	s.sendBuildInfo(sess)
}

// ---- Event 1820 ----

type buildInfoJSON struct {
	Pieces     int     `json:"pieces"`
	Budget     int     `json:"budget"`
	Share      bool    `json:"share"`
	AreaUsed   int     `json:"areaUsed"`
	AreaBudget int     `json:"areaBudget"`
	Comfort    comfort `json:"comfort"`
	Home       *homeJS `json:"home"`
	HomeCdMs   int64   `json:"homeCdMs"`
	Hearth     *hearJS `json:"hearth"`
}

type comfort struct {
	Score int       `json:"score"`
	Max   int       `json:"max"`
	Tier  string    `json:"tier"`
	Next  *nextTier `json:"next"`
}

type nextTier struct {
	Score int    `json:"score"`
	Name  string `json:"name"`
}

type homeJS struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

type hearJS struct {
	X float64 `json:"x"`
	Z float64 `json:"z"`
	R float64 `json:"r"`
}

func (s *Server) sendBuildInfo(sess *session) {
	e := sess.ent
	if e == nil || !s.campsOn() {
		return
	}
	b := &campdefs.D.Build
	out := buildInfoJSON{Pieces: s.camp.nBuild[e.CharacterID], Budget: b.Budget, Share: s.buildSharing(e.CharacterID) == 1,
		AreaUsed: s.camp.nArea[campArea(e.Move.Pos.X, e.Move.Pos.Z)], AreaBudget: b.AreaBudget}
	out.Comfort = comfort{Max: b.Comfort.MaxScore}
	var bed *campPiece
	best := -1
	for _, p := range s.camp.byOwner[e.CharacterID] {
		switch {
		case isBed(p.Kind):
			if sc := s.buildComfort(p); sc > best {
				bed, best = p, sc
			}
		case isHearth(p.Kind) && out.Hearth == nil:
			out.Hearth = &hearJS{X: p.X, Z: p.Z, R: b.Hearth.WardRadiusM}
		}
	}
	if bed != nil {
		out.Home = &homeJS{X: bed.X, Y: bed.Y, Z: bed.Z}
		out.Comfort.Score, out.Comfort.Tier = best, comfortTier(best)
		for _, t := range b.Comfort.Tiers {
			if t.Score > best {
				out.Comfort.Next = &nextTier{Score: t.Score, Name: t.Name}
				break
			}
		}
	}
	if cs := sess.camp; cs != nil && !cs.homeAt.IsZero() {
		if left := time.Duration(b.Home.CooldownS*float64(time.Second)) - s.cfg.Now().Sub(cs.homeAt); left > 0 {
			out.HomeCdMs = left.Milliseconds()
		}
	}
	jb, _ := json.Marshal(out)
	s.sendEvent(sess, &proto.Event{Kind: EventBuildInfo, EntityID: e.ID, Value: int32(out.Pieces), Data: jb})
}
