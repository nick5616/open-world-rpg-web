package quests

import (
	"fmt"
	"math"
)

// WardKey is the starter story quest's key; WardID its wire id ("WARD").
const (
	WardKey = "story:ward"
	WardID  = 0x57415244
)

// Ward's rewards and the starter coin the blacksmith hands over (enough,
// with the 20 starter gold, for the 40-gold sunsteel blueprint).
const (
	WardGold      = 30
	WardXP        = 200
	WardSmithCoin = 25
	LightSpell    = "glint"
	LightTome     = "tome:glint"
)

// Place is a named spot for quest text and markers.
type Place struct {
	OK    bool
	X, Z  float64
	R     float64 // area radius (0: a point)
	Name  string  // "Mossbound Hollow", "the shrine"
	Where string  // "420 m north-east of Draedmore"
}

// WardPlaces is everything "Ward against the night" points at, resolved by
// the glue from the towns buffer, the cave graph and the atlas around the
// player's home settlement.
type WardPlaces struct {
	Settlement int
	Town       string
	Smith      string // the blacksmith's name
	SmithAt    Place  // the blacksmith's work spot (the forge)
	Forge      Place  // the forge prop
	Ore        Place  // sunlit sunsteel veins (area)
	Mouth      Place  // the cave mouth that leads to them
	Shrine     Place  // where the Light tome rests
}

// Ward builds the starter quest line: learn from the blacksmith where
// sunsteel comes from, mine it, buy the blueprint, forge the blade; then
// find Light magic. Spec 8: only sunsteel, Light or sunrise kill demons.
func Ward(p WardPlaces, nowMs int64) *Quest {
	smith := p.Smith
	if smith == "" {
		smith = "the blacksmith"
	}
	smithMarker := []Marker{}
	if p.SmithAt.OK {
		smithMarker = append(smithMarker, Marker{X: p.SmithAt.X, Z: p.SmithAt.Z, Label: smith + ", blacksmith"})
	}
	forgeMarker := smithMarker
	if p.Forge.OK {
		forgeMarker = []Marker{{X: p.Forge.X, Z: p.Forge.Z, Label: "Forge, " + p.Town}}
	}
	oreNote := "Sunsteel only forms where daylight reaches into a cave. Look near cave mouths and sunlit chambers."
	var oreMarkers []Marker
	if p.Ore.OK {
		oreNote = fmt.Sprintf("Sunsteel glints where daylight reaches into %s, %s. Mine the bright veins with your pickaxe (E).", nameOr(p.Ore.Name, "the cave"), p.Ore.Where)
		oreMarkers = append(oreMarkers, Marker{X: p.Ore.X, Z: p.Ore.Z, R: math.Max(p.Ore.R, 20), Label: "Sunsteel ore"})
	}
	if p.Mouth.OK {
		oreMarkers = append(oreMarkers, Marker{X: p.Mouth.X, Z: p.Mouth.Z, Label: nameOr(p.Mouth.Name, "Cave mouth")})
	}
	oreSay := "Steel won't kill what walks at night: demons close their wounds and laugh. Only sunsteel bites them, or Light magic, or the sunrise. Sunsteel ore grows where daylight reaches into the caves. Bring back four ore, buy my blueprint, and we'll forge you a blade. Here, take a little coin for it."
	if p.Ore.OK {
		oreSay = fmt.Sprintf("Steel won't kill what walks at night: demons close their wounds and laugh. Only sunsteel bites them, or Light magic, or the sunrise. There's a sunlit seam in %s, %s. Bring back four ore, buy my blueprint, and we'll forge you a blade. Here, take a little coin for it.", nameOr(p.Ore.Name, "the cave"), p.Ore.Where)
	}

	steps := []Step{
		{
			Text:    fmt.Sprintf("Talk to %s, the blacksmith of %s", smith, p.Town),
			Note:    "Demons regenerate from ordinary weapons. The blacksmith knows what kills them.",
			Say:     oreSay,
			Obj:     Objective{Kind: ObjTalk, Role: 2, Settlement: p.Settlement, Site: -1},
			Markers: smithMarker,
			Grant:   []ItemQty{{Item: "currency:gold", Qty: WardSmithCoin}},
		},
		{
			Text:    "Mine 4 sunsteel ore",
			Note:    oreNote,
			Obj:     Objective{Kind: ObjHave, Items: []ItemQty{{"ore:sunsteel", 4}, {"ingot:sunsteel", 2}, {"weapon:sunsteel_blade", 1}}, Settlement: -1, Site: -1},
			Markers: oreMarkers,
		},
		{
			Text:    fmt.Sprintf("Buy the Sunsteel Blade blueprint from %s", smith),
			Note:    "Blacksmiths sell blueprints for 40 gold. Talk to them by day.",
			Obj:     Objective{Kind: ObjHave, Items: []ItemQty{{"blueprint:sunsteel_blade", 1}, {"weapon:sunsteel_blade", 1}}, Settlement: -1, Site: -1},
			Markers: smithMarker,
		},
		{
			Text:    "Forge the Sunsteel Blade",
			Note:    "At the forge (E): smelt 2 sunsteel ingots from the ore, then forge the blade. Equip it from your inventory (I).",
			Obj:     Objective{Kind: ObjHave, Items: []ItemQty{{"weapon:sunsteel_blade", 1}}, Settlement: -1, Site: -1},
			Markers: forgeMarker,
		},
	}
	if p.Shrine.OK {
		steps = append(steps, Step{
			Text:    fmt.Sprintf("Seek Light magic at %s", nameOr(p.Shrine.Name, "the shrine")),
			Note:    fmt.Sprintf("Light is the other thing demons fear. An old tome of Light rests at %s, %s.", nameOr(p.Shrine.Name, "the shrine"), p.Shrine.Where),
			Obj:     Objective{Kind: ObjReach, X: p.Shrine.X, Z: p.Shrine.Z, R: math.Max(p.Shrine.R, 12), Settlement: -1, Site: -1},
			Markers: []Marker{{X: p.Shrine.X, Z: p.Shrine.Z, R: math.Max(p.Shrine.R, 12), Label: "Tome of Light"}},
			Grant:   []ItemQty{{Item: LightTome, Qty: 1}},
		})
	} else {
		// No shrine nearby: the smith keeps an old tome for you.
		steps[len(steps)-1].Grant = []ItemQty{{Item: LightTome, Qty: 1}}
	}
	steps = append(steps, Step{
		Text: "Learn Light magic: read the Tome of Glint",
		Note: "Open your inventory (I) and Learn the tome. Glint fills an empty spell slot; Light spells kill demons like sunsteel does.",
		Obj:  Objective{Kind: ObjKnow, Spell: LightSpell, Settlement: -1, Site: -1},
	})
	return &Quest{ID: WardID, Key: WardKey, Kind: KindStory, Title: "Ward against the night", Giver: smith + ", blacksmith of " + p.Town,
		Settlement: p.Settlement, Steps: steps, Gold: WardGold, XP: WardXP, Accepted: nowMs}
}

func nameOr(s, or string) string {
	if s == "" {
		return or
	}
	return s
}

// Bounty kinds (WP20 Event 802).
const (
	BountyClear   = 0
	BountyDeliver = 1
	BountySlay    = 2
	BountyExplore = 3
)

// BountyInfo is a board job plus the places its quest marks.
type BountyInfo struct {
	ID         uint32
	Kind       uint8
	Settlement int
	Town       string
	Text       string
	Reward     uint32
	Item       string // deliver
	Qty        int    // deliver
	Site       int    // target atlas site (-1 none)
	SiteName   string
	Target     Place // the target site's area
	Board      Place // where a delivery is handed in (the board)
}

// BountyKey is a held bounty's key.
func BountyKey(settlement int, id uint32) string { return fmt.Sprintf("bounty:%d:%d", settlement, id) }

// BountyXP is the XP a bounty pays on top of its gold.
func BountyXP(reward uint32) int64 { return 40 + int64(reward)/2 }

// FromBounty turns an accepted board job into a quest.
func FromBounty(b BountyInfo, nowMs int64) *Quest {
	q := &Quest{ID: b.ID, Key: BountyKey(b.Settlement, b.ID), Kind: KindBounty, Title: b.Text, Giver: "Bounty board, " + b.Town,
		Settlement: b.Settlement, Gold: int(b.Reward), XP: BountyXP(b.Reward), Accepted: nowMs}
	area := func(label string) []Marker {
		if !b.Target.OK {
			return nil
		}
		return []Marker{{X: b.Target.X, Z: b.Target.Z, R: b.Target.R, Label: label}}
	}
	label := nameOr(b.SiteName, "Bounty target")
	switch b.Kind {
	case BountyClear:
		q.Steps = []Step{{Text: b.Text, Note: "Kill every enemy guarding the place. If someone beat you to it, arriving while it is quiet counts.",
			Obj: Objective{Kind: ObjClear, Site: b.Site, X: b.Target.X, Z: b.Target.Z, R: b.Target.R, Settlement: -1}, Markers: area(label)}}
	case BountySlay:
		q.Steps = []Step{{Text: b.Text, Note: "Demons rise at night. Only sunsteel, Light magic or the sunrise kills them.",
			Obj: Objective{Kind: ObjSlay, Site: b.Site, X: b.Target.X, Z: b.Target.Z, R: b.Target.R + 250, Settlement: -1}, Markers: area(label)}}
	case BountyExplore:
		q.Steps = []Step{{Text: b.Text, Note: "Go there and look around.",
			Obj: Objective{Kind: ObjReach, Site: b.Site, X: b.Target.X, Z: b.Target.Z, R: b.Target.R, Settlement: -1}, Markers: area(label)}}
	default: // deliver
		var m []Marker
		if b.Board.OK {
			m = []Marker{{X: b.Board.X, Z: b.Board.Z, Label: "Hand in: bounty board, " + b.Town}}
		}
		q.Steps = []Step{{Text: b.Text, Note: fmt.Sprintf("Bring them to the bounty board or the bounty keeper in %s.", b.Town),
			Obj: Objective{Kind: ObjTurnIn, Items: []ItemQty{{b.Item, max(1, b.Qty)}}, Settlement: b.Settlement, Site: -1}, Markers: m}}
	}
	return q
}

// Compass names the direction from (x, z) to (tx, tz) (north is -z).
func Compass(x, z, tx, tz float64) string {
	a := math.Atan2(-(tz-z), tx-x) * 180 / math.Pi
	dirs := []string{"east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"}
	k := int(math.Floor((a+22.5)/45)) % 8
	if k < 0 {
		k += 8
	}
	return dirs[k]
}

// Where is "420 m north-east of Draedmore".
func Where(x, z, tx, tz float64, of string) string {
	d := math.Hypot(tx-x, tz-z)
	dist := fmt.Sprintf("%.0f m", math.Round(d/10)*10)
	if d >= 1000 {
		dist = fmt.Sprintf("%.1f km", d/1000)
	}
	return fmt.Sprintf("%s %s of %s", dist, Compass(x, z, tx, tz), of)
}
