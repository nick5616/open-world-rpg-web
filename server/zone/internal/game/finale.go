package game

// The finale (playtest 2, CR 035): the Hush at the Heartfall, the last
// fight of "The Last Song". A set piece run by the zone that owns the
// Heartfall, like a sealed vault:
//
//   - Armed when a player who may fight it (Act VI on its last step, or a
//     character who beat the game: a rematch) or their party member comes
//     into the arena. The intro: the Hush rises, untouchable and still for
//     finaleIntroS while a title card plays (Event 1604), then fights.
//   - Phase 1 (100-70 %): its own attacks, and every ~26 s the shroud: a
//     ward of silence (8 % of its health) that only sunsteel or Light can
//     break (ordinary hits do nothing). Broken: it staggers and takes 1.5x
//     damage for a few seconds. Unbroken after 10 s: the Long Quiet, a
//     blow to everyone in the arena and the Hush heals.
//   - Phase 2 (70-35 %): the choir. The Hush is untouchable at the heart
//     of the arena while its Hollow Bells (party size + 1, 2-4, around the
//     edge; only sunsteel or Light cracks them) toll: the chorus falls under
//     every player. The last bell shattered: it reels (stagger, 2x damage).
//   - Phase 3 (35-0 %): faster, a lance, the shroud again, and the endless
//     night every ~30 s: the stars go out (7 s warning) and only those
//     standing in a well of dawn are spared, one player per well (two in
//     one well and the well fails them both): split up.
//   - Scaling: health and damage by engaged players (combat's party
//     scaling, up to 4 tuned), bells and wells by players in the arena; the
//     Starless Vow (post-game hard mode) raises its level by 4 and quickens
//     every mechanic. Downed players can be revived (revive.go).
//   - Victory: Act VI completes (the ending sequence, Event 1605), the
//     counters behind "beat the game", "together" and the hard mode
//     achievements; the arena keeps a dawn glow for a minute. A wipe resets
//     it (combat's boss reset), re-armed after finaleRearmS.

import (
	"encoding/json"
	"math"
	"sort"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/quests"
	"lodestone/server/zone/internal/story"
)

const (
	heartfallR      = 30.0 // the arena (combat.yaml bosses.the_hush.arenaRadius)
	finaleIntroS    = 7.0
	finaleRearmS    = 8.0
	finaleShroudS   = 26.0 // between shrouds (Starless: 20)
	finaleShroudUp  = 10.0 // to break it
	finaleChorusS   = 7.0  // between chorus strikes while bells toll (Starless: 5.5)
	finaleNightS    = 30.0 // between endless nights (Starless: 24)
	finaleNightWarn = 7.0
	finaleWellR     = 3.5
	finaleDawnS     = 60.0 // the arena's dawn glow after a victory
)

// Finale phases (Event 1603 value).
const (
	FinaleIdle   = 0
	FinaleIntro  = 1
	FinaleFight  = 2
	FinaleWon    = 3
	FinaleChoir  = 4 // a fight phase: the bells
	FinaleStarry = 5 // a fight phase: the endless night
)

type finaleState struct {
	run     *finaleRun
	rearmAt uint32
	dawnTil uint32
	told    map[uint32]string
	shrug   map[uint32]uint32
}

type finaleRun struct {
	g          *combat.Group
	hush       *combat.Enemy
	hard       bool
	level      int
	introUntil uint32
	phase      int // the Hush's boss phase seen (0-2)
	shroud     float64
	shroudMax  float64
	shroudEnd  uint32
	nextShroud uint32
	takenMult  float64
	takenUntil uint32
	bells      []*combat.Group
	nextChorus uint32
	wells      [][2]float64
	nightAt    uint32
	nextNight  uint32
	part       map[uint32]bool
	engaged    bool
}

func (s *Server) finaleSecs(sec float64) uint32 { return uint32(math.Round(sec * 30)) }

// finaleMayFight: a character who may wake the Hush.
func (s *Server) finaleMayFight(sess *session) bool {
	if sess == nil || sess.quests == nil {
		return false
	}
	if q := sess.quests.log.ByKey(story.Key(story.Acts)); q != nil {
		if c := q.Current(); c != nil && c.Obj.Kind == quests.ObjStory && c.Obj.Family == story.TagHush {
			return true
		}
	}
	return sess.cnt != nil && sess.cnt.st.Stat("finale") > 0
}

func (s *Server) finaleTick(tick uint32) {
	p := s.storyPlaces()
	f := &s.sty.fin
	if p == nil || s.cbt.w == nil || !p.Heartfall.OK {
		return
	}
	hf := p.Heartfall
	if f.run == nil {
		if tick%15 != 3 || tick < f.rearmAt || !s.ownsPoint(hf.X, hf.Z) {
			if tick%30 == 5 {
				s.finaleTellAll()
			}
			return
		}
		var who []*session
		ok := false
		for _, e := range s.playersNear(hf.X, hf.Z, hf.R+6) {
			sess := s.byChar[e.CharacterID]
			if sess == nil || (e.cbt != nil && e.cbt.Downed) {
				continue
			}
			who = append(who, sess)
			ok = ok || s.finaleMayFight(sess)
		}
		if !ok {
			if tick%30 == 5 {
				s.finaleTellAll()
			}
			return
		}
		s.finaleArm(who)
		return
	}
	r := f.run
	w := s.cbt.w
	w.SettleStoryStrikes()
	if !r.hush.Alive() || w.Enemy(r.hush.ID) == nil {
		return // finaleOnKill ran (or it was despawned)
	}
	now := tick
	inArena := s.playersNear(hf.X, hf.Z, hf.R+4)
	for _, e := range inArena {
		r.part[e.ID] = true
	}
	// A wipe: combat resets a boss nobody stands near for 15 s.
	if r.engaged && r.hush.Boss.FightSeconds(now) == 0 {
		s.finaleReset("The Hush sinks back into the silence. The Heartfall waits.")
		return
	}
	if now < r.introUntil {
		return
	}
	if !r.engaged && r.hush.Boss.FightSeconds(now) > 0 {
		r.engaged = true
	}
	ph := r.hush.Boss.Phase
	if ph != r.phase {
		r.phase = ph
		s.finalePhase(r, inArena)
	}
	alive := 0
	for _, e := range inArena {
		if e.cbt != nil && !e.cbt.Downed {
			alive++
		}
	}
	// The shroud (phases 1 and 3).
	if r.shroud > 0 && now >= r.shroudEnd {
		r.shroud = 0
		s.finaleSay(hf, "The Hush", "Hush now. Hush.")
		for _, e := range inArena {
			if e.cbt != nil && !e.cbt.Downed {
				w.HurtPlayerBy(e.ID, r.hush, "hush_night", e.cbt.HPMax*0.4)
			}
		}
		r.hush.HP = math.Min(r.hush.HPMax, r.hush.HP+r.hush.HPMax*0.05)
		s.finaleTellAll()
	}
	if ph != 1 && r.shroud <= 0 && now >= r.nextShroud && (r.nightAt == 0 || r.nightAt-now > s.finaleSecs(finaleShroudUp+2)) {
		r.shroudMax = r.hush.HPMax * 0.08
		if r.hard {
			r.shroudMax = r.hush.HPMax * 0.1
		}
		r.shroud = r.shroudMax
		r.shroudEnd = now + s.finaleSecs(finaleShroudUp)
		r.nextShroud = now + s.finaleSecs(s.finaleEvery(finaleShroudS, 20))
		s.finaleSay(hf, "", "The Hush draws the silence around itself. Break the shroud with sunsteel or Light!")
		s.finaleTellAll()
	}
	// The choir.
	if ph == 1 && len(r.bells) > 0 {
		bells := 0
		for _, g := range r.bells {
			for _, m := range g.Members {
				if m.Alive() {
					bells++
				}
			}
		}
		if bells == 0 {
			r.bells = nil
			r.takenMult, r.takenUntil = 2, now+s.finaleSecs(8)
			w.Hold(r.hush, 6)
			s.finaleSay(hf, "", "The last bell shatters. The Hush reels: strike now!")
			s.finaleTellAll()
		} else if now >= r.nextChorus && alive > 0 {
			r.nextChorus = now + s.finaleSecs(s.finaleEvery(finaleChorusS, 5.5))
			for _, e := range inArena {
				if e.cbt != nil && !e.cbt.Downed {
					w.StoryStrike(r.hush, "hush_chorus", e.Move.Pos, 3.0)
				}
			}
		}
	}
	// The endless night (phase 3).
	if ph == 2 {
		if r.nightAt == 0 && now >= r.nextNight {
			n := min(4, max(2, alive))
			rot := float64(now%360) * math.Pi / 180
			r.wells = r.wells[:0]
			for i := 0; i < n; i++ {
				a := rot + float64(i)*2*math.Pi/float64(n)
				r.wells = append(r.wells, [2]float64{hf.X + hf.R*0.6*math.Cos(a), hf.Z + hf.R*0.6*math.Sin(a)})
			}
			r.nightAt = now + s.finaleSecs(finaleNightWarn)
			s.finaleSay(hf, "", "The Hush swallows the stars. Find a well of dawn: one each!")
			s.finaleTellAll()
		} else if r.nightAt != 0 && now >= r.nightAt {
			s.finaleNight(r, inArena)
			r.nightAt = 0
			r.nextNight = now + s.finaleSecs(s.finaleEvery(finaleNightS, 24))
			s.finaleTellAll()
		}
	}
	if tick%30 == 5 {
		s.finaleTellAll()
	}
}

func (s *Server) finaleEvery(normal, hard float64) float64 {
	if r := s.sty.fin.run; r != nil && r.hard {
		return hard
	}
	return normal
}

// finaleArm spawns the Hush and plays the intro.
func (s *Server) finaleArm(who []*session) {
	p := s.storyPlaces()
	hf := p.Heartfall
	w := s.cbt.w
	level, hard := 12, false
	for _, sess := range who {
		level = max(level, s.storyLevel(sess)+1)
		hard = hard || (sess.cnt != nil && sess.cnt.st.Stat("vow") > 0 && sess.cnt.st.Stat("finale") > 0)
	}
	if hard {
		level += 4
	}
	center := movement.Vec3{X: hf.X, Y: s.cfg.Ground.HeightAt(hf.X, hf.Z), Z: hf.Z}
	arena := combat.Arena{Center: center, Radius: heartfallR, Kind: "test"}
	g := w.AddGroup(&combat.Group{Kind: combat.GroupBoss, Anchor: center, Radius: heartfallR, Element: 8, Level: level, Site: -1, Boss: "the_hush", Arena: &arena, Name: "The Heartfall"})
	w.SpawnNow(g)
	if len(g.Members) == 0 {
		return
	}
	hush := g.Members[0]
	hush.Name = "The Hush"
	r := &finaleRun{g: g, hush: hush, hard: hard, level: level, part: map[uint32]bool{}, takenMult: 1}
	now := s.tick
	r.introUntil = now + s.finaleSecs(finaleIntroS)
	r.nextShroud = r.introUntil + s.finaleSecs(14)
	w.Hold(hush, finaleIntroS)
	hush.Guard = s.finaleGuard
	s.sty.fin.run = r
	s.sty.fin.dawnTil = 0
	sub := "Mother of the Unsung"
	if hard {
		sub = "Mother of the Unsung · Starless"
	}
	lines := []string{"So the little songs come at last.", "I was here before the first fire. I will be here after the last.", "Sing, then. I will listen until you stop."}
	b, _ := json.Marshal(struct {
		Eyebrow  string   `json:"eyebrow"`
		Title    string   `json:"title"`
		Subtitle string   `json:"subtitle"`
		Lines    []string `json:"lines"`
		Ms       int      `json:"ms"`
		Hard     bool     `json:"hard"`
		X        float64  `json:"x"`
		Z        float64  `json:"z"`
		Boss     uint32   `json:"boss"`
	}{"The Heartfall", "The Hush", sub, lines, int(finaleIntroS * 1000), hard, hf.X, hf.Z, hush.ID})
	for _, e := range s.playersNear(hf.X, hf.Z, hf.R+120) {
		r.part[e.ID] = true
		s.sendEventTo(e, &proto.Event{Kind: EventFinaleIntro, EntityID: hush.ID, Value: int32(finaleIntroS * 1000), X: cm(hf.X), Z: cm(hf.Z), Data: b})
	}
	s.log.Info("finale: the Hush rises", "level", level, "hard", hard, "players", len(who))
	s.finaleTellAll()
}

// finaleGuard decides every hit on the Hush (combat.Guard).
func (s *Server) finaleGuard(e *combat.Enemy, src uint32, dmg float64, killing bool) float64 {
	r := s.sty.fin.run
	if r == nil || r.hush != e {
		return dmg
	}
	now := s.tick
	if now < r.introUntil {
		return 0
	}
	if r.phase == 1 && len(r.bells) > 0 {
		s.finaleShrug(src, "The choir shields the Hush. Shatter the Hollow Bells (sunsteel or Light)!")
		return 0
	}
	if r.shroud > 0 {
		if !killing {
			s.finaleShrug(src, "Only sunsteel or Light can break the shroud.")
			return 0
		}
		r.shroud -= dmg
		if r.shroud <= 0 {
			r.shroud = 0
			r.nextShroud = now + s.finaleSecs(s.finaleEvery(finaleShroudS, 20))
			r.takenMult, r.takenUntil = 1.5, now+s.finaleSecs(5)
			s.cbt.w.Hold(e, 3.5)
			s.finaleSay(s.storyPlaces().Heartfall, "", "The shroud shatters! The Hush staggers.")
			if pe := s.entityByID(src); pe != nil {
				if sess := s.byChar[pe.CharacterID]; sess != nil && sess.cnt != nil {
					sess.cnt.st.Add("shrouds", 1)
					sess.cnt.recheck = true
				}
			}
			s.finaleTellAll()
		}
		return 0
	}
	if now < r.takenUntil {
		dmg *= r.takenMult
	}
	return dmg
}

func (s *Server) finaleShrug(src uint32, line string) {
	f := &s.sty.fin
	if f.shrug == nil {
		f.shrug = map[uint32]uint32{}
	}
	if s.tick < f.shrug[src] {
		return
	}
	f.shrug[src] = s.tick + 45
	if pe := s.entityByID(src); pe != nil && pe.Kind == proto.EntityKindPlayer {
		s.storySay(s.byChar[pe.CharacterID], "", line)
	}
}

// finalePhase: the Hush crossed a health threshold.
func (s *Server) finalePhase(r *finaleRun, inArena []*Entity) {
	hf := s.storyPlaces().Heartfall
	w := s.cbt.w
	switch r.phase {
	case 1: // the choir
		r.shroud = 0
		w.MoveEnemy(r.hush, movement.Vec3{X: hf.X, Z: hf.Z})
		n := min(4, max(2, len(inArena)+1))
		rot := float64(s.tick%360) * math.Pi / 180
		for i := 0; i < n; i++ {
			a := rot + float64(i)*2*math.Pi/float64(n)
			x, z := w.WalkableNear(hf.X+hf.R*0.75*math.Cos(a), hf.Z+hf.R*0.75*math.Sin(a), 6, 2)
			g := w.SpawnDemons(movement.Vec3{X: x, Z: z}, []string{"hollow_bell"}, r.level)
			for _, m := range g.Members {
				m.Name = "Hollow Bell"
			}
			r.bells = append(r.bells, g)
		}
		r.nextChorus = s.tick + s.finaleSecs(4)
		s.finaleSay(hf, "The Hush", "Hear my choir. They have sung over every grave since the Breaking.")
		s.finaleSay(hf, "", "The Hush is untouchable while its Hollow Bells toll. Shatter them with sunsteel or Light!")
	case 2: // the endless night
		r.nextNight = s.tick + s.finaleSecs(6)
		r.nextShroud = s.tick + s.finaleSecs(18)
		s.finaleSay(hf, "The Hush", "Enough. Let there be no more stars.")
	}
	s.finaleTellAll()
}

// finaleNight strikes everyone outside a well of dawn (one per well).
func (s *Server) finaleNight(r *finaleRun, inArena []*Entity) {
	in := make([]int, len(r.wells))
	well := map[uint32]int{}
	for _, e := range inArena {
		if e.cbt == nil || e.cbt.Downed {
			continue
		}
		well[e.ID] = -1
		for i, wl := range r.wells {
			if math.Hypot(e.Move.Pos.X-wl[0], e.Move.Pos.Z-wl[1]) <= finaleWellR {
				well[e.ID] = i
				in[i]++
				break
			}
		}
	}
	hit := 0
	for _, e := range inArena {
		i, ok := well[e.ID]
		if !ok || (i >= 0 && in[i] == 1) {
			continue
		}
		hit++
		s.cbt.w.HurtPlayerBy(e.ID, r.hush, "hush_night", e.cbt.HPMax*0.75)
	}
	r.wells = r.wells[:0]
	hf := s.storyPlaces().Heartfall
	if hit == 0 {
		s.finaleSay(hf, "", "Dawn holds in the wells. The night passes over you.")
	} else {
		s.finaleSay(hf, "", "The endless night falls on those without a well of their own.")
	}
}

func (s *Server) finaleSay(hf story.Place, speaker, text string) {
	s.storySayNear(hf.X, hf.Z, hf.R+80, speaker, text)
}

// finaleReset: a wipe or everyone left; the Heartfall re-arms.
func (s *Server) finaleReset(line string) {
	r := s.sty.fin.run
	if r == nil {
		return
	}
	hf := s.storyPlaces().Heartfall
	s.finaleSay(hf, "", line)
	s.finaleClear(r)
	s.sty.fin.run = nil
	s.sty.fin.rearmAt = s.tick + s.finaleSecs(finaleRearmS)
	s.log.Info("finale reset")
	s.finaleTellAll()
}

func (s *Server) finaleClear(r *finaleRun) {
	w := s.cbt.w
	for _, g := range r.bells {
		for _, m := range g.Members {
			if m.Alive() {
				w.Despawn(m)
			}
		}
	}
	r.bells = nil
	if r.hush.Alive() {
		w.Despawn(r.hush)
	}
	w.RetireGroup(r.g)
}

// finaleOnKill: the Hush fell (bells are ordinary kills).
func (s *Server) finaleOnKill(k combat.KillInfo) {
	r := s.sty.fin.run
	if r == nil || k.Enemy != r.hush {
		return
	}
	hf := s.storyPlaces().Heartfall
	for _, id := range k.Eligible {
		r.part[id] = true
	}
	for _, e := range s.playersNear(hf.X, hf.Z, hf.R+40) {
		r.part[e.ID] = true
	}
	for id := range r.hush.DamageBy {
		r.part[id] = true
	}
	var who []*session
	var names []string
	for id := range r.part {
		pe := s.entityByID(id)
		if pe == nil || pe.Kind != proto.EntityKindPlayer {
			continue
		}
		if sess := s.byChar[pe.CharacterID]; sess != nil {
			who = append(who, sess)
		}
	}
	sort.Slice(who, func(i, j int) bool { return who[i].ent.ID < who[j].ent.ID })
	for _, sess := range who {
		names = append(names, sess.ent.Name)
	}
	together := len(who) >= 2
	for _, g := range r.bells {
		for _, m := range g.Members {
			if m.Alive() {
				s.cbt.w.Despawn(m)
			}
		}
	}
	r.bells = nil
	s.cbt.w.RetireGroup(r.g)
	s.sty.fin.run = nil
	s.sty.fin.rearmAt = s.tick + s.finaleSecs(finaleDawnS)
	s.sty.fin.dawnTil = s.tick + s.finaleSecs(finaleDawnS)
	ids := map[uint32]bool{}
	for _, sess := range who {
		ids[sess.ent.ID] = true
		first := false
		if sess.cnt != nil {
			first = sess.cnt.st.Stat("finale") == 0
			sess.cnt.st.Add("finale", 1)
			if together {
				sess.cnt.st.Add("finaleparty", 1)
			}
			if r.hard {
				sess.cnt.st.Add("finalehard", 1)
				if together {
					sess.cnt.st.Add("finalehardparty", 1)
				}
			}
			sess.cnt.recheck = true
			s.saveContent(sess)
		}
		b, _ := json.Marshal(struct {
			Title    string   `json:"title"`
			Lines    []string `json:"lines"`
			Together bool     `json:"together"`
			Hard     bool     `json:"hard"`
			Names    []string `json:"names"`
			First    bool     `json:"first"`
			Earned   string   `json:"earned"`
		}{story.Title, endingLines(names, together, r.hard), together, r.hard, names, first, "the Dawnsinger"})
		s.sendEvent(sess, &proto.Event{Kind: EventStoryEnding, EntityID: sess.ent.ID, Value: int32(len(who)), Data: b})
	}
	s.storySignal(ids, story.TagHush)
	for _, sess := range who {
		s.sendStorySync(sess)
	}
	s.log.Info("finale: the Hush is silenced", "players", len(who), "hard", r.hard, "together", together, "seconds", math.Round(r.hush.Boss.FightSeconds(s.tick)))
	s.finaleTellAll()
}

// endingLines is the ending's text over the sunrise.
func endingLines(names []string, together, hard bool) []string {
	who := "you"
	if together && len(names) > 1 {
		who = joinNames(names)
	}
	l := []string{
		"The Hush is silenced, and the Heartfall is still.",
		"Under the hills the Lodestone stirs, and sings, and every tower on every hilltop rings with it.",
		"In the towns the lanterns burn a little longer than they need to. Nobody minds.",
		"The night will come again. It always does. But it will remember its manners for a while.",
	}
	if together {
		l = append(l, "They will sing of "+who+", who kept the last song together.")
	} else {
		l = append(l, "They will sing of the one who kept the last song.")
	}
	if hard {
		l = append(l, "Even under the Starless Vow, the dawn came.")
	}
	return append(l, "The dawn comes.")
}

func joinNames(n []string) string {
	switch len(n) {
	case 0:
		return ""
	case 1:
		return n[0]
	case 2:
		return n[0] + " and " + n[1]
	}
	out := ""
	for i, x := range n {
		switch {
		case i == len(n)-1:
			out += "and " + x
		default:
			out += x + ", "
		}
	}
	return out
}

// finaleData is Event 1603's JSON.
func (s *Server) finaleData() (int, []byte) {
	p := s.storyPlaces()
	f := &s.sty.fin
	hf := p.Heartfall
	type wellV struct {
		X float64 `json:"x"`
		Z float64 `json:"z"`
		R float64 `json:"r"`
	}
	out := struct {
		Phase    int     `json:"phase"`
		X        float64 `json:"x"`
		Z        float64 `json:"z"`
		R        float64 `json:"r"`
		Boss     uint32  `json:"boss"`
		Shroud   int     `json:"shroud"` // % of the shroud left, 0 none
		ShroudMs int     `json:"shroudMs"`
		Bells    int     `json:"bells"`
		Wells    []wellV `json:"wells"`
		NightMs  int     `json:"nightMs"`
		Hard     bool    `json:"hard"`
		Stagger  bool    `json:"stagger"`
	}{X: hf.X, Z: hf.Z, R: hf.R, Wells: []wellV{}}
	now := s.tick
	if r := f.run; r != nil {
		out.Boss, out.Hard = r.hush.ID, r.hard
		switch {
		case now < r.introUntil:
			out.Phase = FinaleIntro
		case r.phase == 1 && len(r.bells) > 0:
			out.Phase = FinaleChoir
		case r.phase == 2:
			out.Phase = FinaleStarry
		default:
			out.Phase = FinaleFight
		}
		if r.shroud > 0 && r.shroudMax > 0 {
			out.Shroud = int(math.Ceil(r.shroud / r.shroudMax * 100))
			out.ShroudMs = int(int64(r.shroudEnd-now) * 1000 / 30)
		}
		for _, g := range r.bells {
			for _, m := range g.Members {
				if m.Alive() {
					out.Bells++
				}
			}
		}
		for _, wl := range r.wells {
			out.Wells = append(out.Wells, wellV{wl[0], wl[1], finaleWellR})
		}
		if r.nightAt > now {
			out.NightMs = int(int64(r.nightAt-now) * 1000 / 30)
		}
		out.Stagger = now < r.takenUntil
	} else if now < f.dawnTil {
		out.Phase = FinaleWon
	}
	b, _ := json.Marshal(out)
	return out.Phase, b
}

// finaleTellAll sends 1603 to the players near the Heartfall when it changed.
func (s *Server) finaleTellAll() {
	p := s.storyPlaces()
	if p == nil || !p.Heartfall.OK {
		return
	}
	for _, e := range s.playersNear(p.Heartfall.X, p.Heartfall.Z, p.Heartfall.R+260) {
		s.finaleTell(s.byChar[e.CharacterID])
	}
}

func (s *Server) finaleTell(sess *session) {
	p := s.storyPlaces()
	if sess == nil || sess.ent == nil || p == nil || !p.Heartfall.OK {
		return
	}
	f := &s.sty.fin
	if f.told == nil {
		f.told = map[uint32]string{}
	}
	ph, b := s.finaleData()
	msg := string(b)
	if r := f.run; r != nil && r.shroud > 0 {
		msg += "" // the shroud's percentage is in b: sent on change only
	}
	if f.told[sess.ent.ID] == msg {
		return
	}
	f.told[sess.ent.ID] = msg
	s.sendEvent(sess, &proto.Event{Kind: EventFinaleState, EntityID: sess.ent.ID, Value: int32(ph), X: cm(p.Heartfall.X), Z: cm(p.Heartfall.Z), Data: b})
}
