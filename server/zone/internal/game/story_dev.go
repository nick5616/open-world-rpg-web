package game

// Dev console shortcuts for the main story (CR 035; Interact 250 action 28,
// LODESTONE_ZONE_DEV zones only, like every console command): jump to an
// act and step, go to the Heartfall, end the vigil's waves, set the Hush's
// health, win the fight, forget the story. `/story ...` in the console.

import (
	"fmt"
	"math"

	"lodestone/server/pkg/movement"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/quests"
	"lodestone/server/zone/internal/story"
)

// DevStory* (Interact 250/28 arg).
const (
	DevStoryJump      = 1 // targetId: act | step << 8
	DevStoryHeartfall = 2 // teleport to the Heartfall's edge
	DevStoryWin       = 3 // the Hush falls (a fight must be running)
	DevStoryReset     = 4 // forget the main story (acts, the ending's counters stay)
	DevStoryHush      = 5 // targetId: the Hush's health in percent (phases follow)
	DevStoryVigil     = 6 // the vigil's waves end as held
	DevStoryPlaces    = 7 // where everything is (the result line)
	DevStoryBells     = 8 // shatter the Hush's bells (the choir ends)
	DevStoryDown      = 9 // the Hush (or anything near) downs you: try a revive
)

func (s *Server) devStory(sess *session, sub, target int) (int32, string) {
	p := s.storyPlaces()
	if p == nil || sess.quests == nil {
		return devFailed("no main story on this world")
	}
	e := sess.ent
	switch sub {
	case DevStoryJump:
		act, step := target&0xff, target>>8
		if act < 1 || act > story.Acts {
			return devBad("act 1-%d", story.Acts)
		}
		l := sess.quests.log
		for n := 1; n <= story.Acts; n++ {
			if q := l.ByKey(story.Key(n)); q != nil {
				l.Remove(q.ID)
			}
			l.Forget(story.Key(n))
		}
		q := story.Act(act, p, 0)
		if step < 0 || step >= len(q.Steps) {
			return devBad("act %d has steps 0-%d", act, len(q.Steps)-1)
		}
		sk, ok := story.CatchUp(l, p, act, step, s.cfg.Now().UnixMilli())
		if !ok {
			return devFailed("could not start act %d", act)
		}
		for _, it := range sk.Items {
			s.questGrant(sess, []quests.ItemQty{it}, "story:dev:"+it.Item+fmt.Sprint(s.tick), "dev console")
		}
		sess.quests.recheck = true
		s.storyIntro(sess, act)
		s.sendQuestLog(sess)
		s.saveQuests(sess)
		s.sendStorySync(sess)
		return devOK("act %d (%s), step %d: %s", act, story.ActList[act-1].Title, step, q.Steps[step].Text)
	case DevStoryHeartfall:
		hf := p.Heartfall
		x, z := hf.X, hf.Z+hf.R+14
		s.Teleport(e, movement.Vec3{X: x, Y: s.cfg.Ground.HeightAt(x, z) + 0.5, Z: z})
		return devOK("the Heartfall (%.0f, %.0f), %s", hf.X, hf.Z, hf.Region)
	case DevStoryWin:
		if v := s.sty.vigil; v != nil && v.sovereign != nil {
			for _, m := range v.sovereign.Members {
				s.cbt.w.Slay(m, e.ID)
			}
			return devOK("the Starless Sovereign falls")
		}
		r := s.sty.fin.run
		if r == nil || !r.hush.Alive() {
			return devFailed("the Hush is not awake")
		}
		r.introUntil, r.bells = 0, nil
		r.shroud = 0
		r.hush.Guard = nil
		s.cbt.w.ApplyDevDamage(r.hush, e.ID, r.hush.HP+1)
		return devOK("the Hush falls")
	case DevStoryHush:
		r := s.sty.fin.run
		if r == nil || !r.hush.Alive() || target < 1 || target > 100 {
			return devFailed("the Hush is not awake (or bad percent)")
		}
		r.introUntil = 0
		g := r.hush.Guard
		r.hush.Guard = nil
		dmg := r.hush.HP - r.hush.HPMax*float64(target)/100
		if dmg > 0 {
			s.cbt.w.ApplyDevDamage(r.hush, e.ID, dmg)
		}
		r.hush.Guard = g
		return devOK("the Hush at %d %% (phase %d)", int(math.Round(r.hush.HP/r.hush.HPMax*100)), r.hush.Boss.Phase+1)
	case DevStoryVigil:
		v := s.sty.vigil
		if v == nil {
			return devFailed("no vigil running")
		}
		s.nightInit()
		if d := s.night.defs[v.town]; d != nil {
			for _, g := range d.groups {
				for _, m := range g.Members {
					if m.Alive() {
						s.cbt.w.Despawn(m)
					}
				}
			}
			d.part[e.ID] = true
			s.endDefense(d, DefenseHeld, "The last wave breaks. The ward blooms again.")
			delete(s.night.defs, v.town)
		} else {
			s.storyDefenseEnded(v.town, DefenseHeld, []uint32{e.ID})
		}
		return devOK("the vigil held: the Sovereign comes")
	case DevStoryReset:
		l := sess.quests.log
		for n := 1; n <= story.Acts; n++ {
			if q := l.ByKey(story.Key(n)); q != nil {
				l.Remove(q.ID)
			}
			l.Forget(story.Key(n))
		}
		s.sendQuestLog(sess)
		s.saveQuests(sess)
		s.storyMaybeStart(sess)
		s.sendStorySync(sess)
		return devOK("the main story starts over")
	case DevStoryPlaces:
		return devOK("keeper %s (%s) · stone %s · forks %s, %s, %s, %s · vaults %s, %s · vigil %s (%s) · smith %s of %s · sanctum %s · last fork %s · heartfall %.0f,%.0f",
			p.Keeper.Name, p.Home, p.Tablet.Name, p.Forks[0].Name, p.Forks[1].Name, p.Forks[2].Name, p.Forks[3].Name, p.Vaults[0].Name, p.Vaults[1].Name,
			p.Vigil.Name, p.Captain.Name, p.Smith.Name, p.Smith.Town, p.Sanctum.Name, p.LastFork.Name, p.Heartfall.X, p.Heartfall.Z)
	case DevStoryBells:
		r := s.sty.fin.run
		if r == nil || len(r.bells) == 0 {
			return devFailed("no bells tolling")
		}
		for _, g := range r.bells {
			for _, m := range g.Members {
				s.cbt.w.Slay(m, e.ID)
			}
		}
		return devOK("the bells shatter")
	case DevStoryDown:
		var src *combat.Enemy
		if r := s.sty.fin.run; r != nil && r.hush.Alive() {
			src = r.hush
		}
		if src == nil {
			for _, en := range s.cbt.w.Enemies() {
				if en.Alive() && math.Hypot(en.Pos.X-e.Move.Pos.X, en.Pos.Z-e.Move.Pos.Z) < 60 {
					src = en
					break
				}
			}
		}
		if src == nil || e.cbt == nil {
			return devFailed("nothing near to down you")
		}
		if sess.dev != nil {
			sess.dev.flags &^= DevFlagGod
			e.cbt.DevGod = false
		}
		s.cbt.w.HurtPlayerBy(e.ID, src, "hush_night", 1e6)
		return devOK("downed by %s", src.Name)
	}
	return devBad("story: jump, heartfall, win, hush, vigil, bells, down, reset, places")
}
