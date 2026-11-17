package game

// Depths demon shrines as a fight (playtest 3, CR 044). Every Depths hall
// has a demon shrine (a vertical world decoration, kind 24, aux = the
// chamber). Standing at it and pressing E (Interact 153, target = the
// chamber) starts a cleansing: three waves of the Depths' creatures wake
// around it, one after the other as each is put down; the last wave's fall
// cleanses the shrine and everyone who fought near it is paid, once per
// character per shrine per shrineCooldownH window (an item marker, like the
// vault chests: no new state). Nobody near for shrineAbandonS ends it and
// the wave is retired.
//
// Cost: nothing while no shrine is live (one map length check a tick); a
// live shrine does its work once a second.

import (
	"math"
	"strconv"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/vertical"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/quests"
)

// Interact target and Events of the shrines (contracts/events.md 1890-1899).
const (
	InteractShrine = 153

	EventShrineState  = 1890 // value = ShrineState*, target = the chamber, data = [wave, waves]
	EventShrineReward = 1891 // value = gold, target = the chamber, data = item names, comma separated
)

// EventShrineState values.
const (
	ShrineStateBusy     = 0 // refused: the shrine was cleansed by you in this window
	ShrineStateStarted  = 1 // a wave woke (data wave = 1-based)
	ShrineStateWaveDone = 2 // a wave fell, the next wakes
	ShrineStateCleansed = 3
	ShrineStateFailed   = 4 // nobody stayed
)

const (
	decoShrine       = 24 // worldgen vertical dk::SHRINE
	shrineCooldownH  = 6.0
	shrineAbandonS   = 90
	shrineNearM      = 60.0 // participants stand within this of the shrine
	shrineReachM     = 9.0
	shrineGoldMul    = 1.5
	shrineRewardItem = 2
)

// shrineWaves: each wave's composition (keys in combat.yaml).
var shrineWaves = [][]string{
	{"ember_demon", "ember_demon", "magma_hound"},
	{"magma_hound", "magma_hound", "ember_demon", "ember_demon"},
	{"obsidian_golem", "cinder_fiend", "magma_hound"},
}

type liveShrine struct {
	aux      int
	x, y, z  float64
	wave     int // index of the wave in play
	group    *combat.Group
	parts    map[uint32]bool
	lastNear uint32
}

// shrineMarker is the reward marker of a shrine in the cooldown window of now.
func shrineMarker(aux int, nowMs int64) string {
	win := int64(shrineCooldownH * 3600e3)
	return "shrine:" + strconv.Itoa(aux) + ":" + strconv.FormatInt(nowMs/win, 10)
}

// shrineDeco finds the Depths shrine of a chamber.
func (s *Server) shrineDeco(aux int) *vertical.Deco {
	vw := s.vertical()
	if vw == nil {
		return nil
	}
	v := vw.Vertical()
	for i := range v.Decos {
		if d := &v.Decos[i]; d.Kind == decoShrine && d.Aux == aux {
			return d
		}
	}
	return nil
}

// shrineInteract is Interact 153 (action 1): start the cleansing, or join one.
func (s *Server) shrineInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	if s.cbt.w == nil {
		return
	}
	aux := int(m.TargetID)
	d := s.shrineDeco(aux)
	if d == nil {
		return
	}
	p := e.Move.Pos
	if math.Hypot(p.X-d.X, p.Z-d.Z) > d.Size+shrineReachM || math.Abs(p.Y-d.Y) > 8 || e.layer != layerDepths {
		return
	}
	state := func(v int32, wave, waves int) {
		s.sendEvent(sess, &proto.Event{Kind: EventShrineState, EntityID: e.ID, TargetID: uint32(aux), Value: v, X: cm(d.X), Y: cm(d.Y), Z: cm(d.Z), Data: []byte{byte(wave), byte(waves)}})
	}
	if sess.items != nil && sess.items.markers[shrineMarker(aux, s.cfg.Now().UnixMilli())] {
		state(ShrineStateBusy, 0, len(shrineWaves))
		return
	}
	if s.shrines == nil {
		s.shrines = map[int]*liveShrine{}
	}
	ls := s.shrines[aux]
	if ls == nil {
		ls = &liveShrine{aux: aux, x: d.X, y: d.Y, z: d.Z, parts: map[uint32]bool{}, lastNear: s.tick}
		s.shrines[aux] = ls
		s.wakeShrineWave(ls)
	}
	ls.parts[e.ID] = true
	state(ShrineStateStarted, ls.wave+1, len(shrineWaves))
}

// wakeShrineWave adds the current wave's group around the shrine.
func (s *Server) wakeShrineWave(ls *liveShrine) {
	comp := shrineWaves[ls.wave]
	elite := ""
	if ls.wave == len(shrineWaves)-1 {
		elite = "shielded"
	}
	y := movement.AtLevel(s.cfg.Ground, ls.y+2).HeightAt(ls.x, ls.z)
	ls.group = s.cbt.w.AddGroup(&combat.Group{Kind: combat.GroupTest, Anchor: movement.Vec3{X: ls.x, Y: y, Z: ls.z}, Radius: 7, Comp: comp, Elite: elite,
		Site: -1, Name: "Demon shrine", AreaLevel: true, Layer: vertical.LayerDepths, Level: s.lootLevelAt(ls.x, ls.z, 20), Element: 8,
		Seed: content.Mix(uint64(ls.aux)<<8 | uint64(ls.wave))})
}

// shrinesTick (content tick): live shrines are checked once a second.
func (s *Server) shrinesTick(tick uint32) {
	if len(s.shrines) == 0 || tick%uint32(constants.TickRateHz) != 0 {
		return
	}
	for aux, ls := range s.shrines {
		near := s.playersNearShrine(ls)
		for _, e := range near {
			ls.parts[e.ID] = true
		}
		if len(near) > 0 {
			ls.lastNear = tick
		} else if tick-ls.lastNear > shrineAbandonS*uint32(constants.TickRateHz) {
			s.cbt.w.RetireGroup(ls.group)
			delete(s.shrines, aux)
			s.log.Info("shrine abandoned", "chamber", aux, "wave", ls.wave)
			continue
		}
		if !groupDead(ls.group) {
			continue
		}
		s.cbt.w.RetireGroup(ls.group)
		ls.wave++
		if ls.wave >= len(shrineWaves) {
			s.shrineCleansed(ls)
			delete(s.shrines, aux)
			continue
		}
		s.wakeShrineWave(ls)
		for _, e := range near {
			if sess := s.byChar[e.CharacterID]; sess != nil {
				s.sendEvent(sess, &proto.Event{Kind: EventShrineState, EntityID: e.ID, TargetID: uint32(aux), Value: ShrineStateWaveDone, Data: []byte{byte(ls.wave + 1), byte(len(shrineWaves))}})
			}
		}
	}
}

func (s *Server) playersNearShrine(ls *liveShrine) []*Entity {
	var out []*Entity
	for _, e := range s.playersNear(ls.x, ls.z, shrineNearM) {
		if e.layer == layerDepths && math.Abs(e.Move.Pos.Y-ls.y) < 40 {
			out = append(out, e)
		}
	}
	return out
}

// shrineCleansed pays everyone who fought near the shrine: gold and rolled
// gear from the vault chest's table, with the Depths' luck.
func (s *Server) shrineCleansed(ls *liveShrine) {
	dg := &contentdefs.D.Dungeons
	now := s.cfg.Now().UnixMilli()
	marker := shrineMarker(ls.aux, now)
	for id := range ls.parts {
		pe := s.entityByID(id)
		if pe == nil || pe.Kind != proto.EntityKindPlayer || math.Hypot(pe.Move.Pos.X-ls.x, pe.Move.Pos.Z-ls.z) > shrineNearM*2 {
			continue
		}
		sess := s.byChar[pe.CharacterID]
		if sess == nil || (sess.items != nil && sess.items.markers[marker]) {
			continue
		}
		gold := int(float64(dg.Chest.Gold[0]+int(content.Mix(uint64(now)^hashString64(pe.CharacterID))%uint64(dg.Chest.Gold[1]-dg.Chest.Gold[0]+1))) * shrineGoldMul)
		s.questGrant(sess, []quests.ItemQty{{Item: "currency:gold", Qty: gold}}, marker+":gold", "demon shrine")
		got := s.rollRewards(sess, shrineRewardItem, dg.Chest.Luck*depthsLootLuck, dg.Chest.MinRarity, marker, "demon shrine")
		names := ""
		for i, it := range got {
			if i > 0 {
				names += ","
			}
			names += it.Base
		}
		s.sendEvent(sess, &proto.Event{Kind: EventShrineState, EntityID: pe.ID, TargetID: uint32(ls.aux), Value: ShrineStateCleansed, Data: []byte{byte(len(shrineWaves)), byte(len(shrineWaves))}})
		s.sendEvent(sess, &proto.Event{Kind: EventShrineReward, EntityID: pe.ID, TargetID: uint32(ls.aux), Value: int32(gold), Data: []byte(names)})
		s.log.Info("shrine cleansed", "character", pe.CharacterID, "chamber", ls.aux, "gold", gold, "items", names)
	}
}
