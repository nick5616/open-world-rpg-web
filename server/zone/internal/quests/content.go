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
	Smith      string  // the blacksmith's name
	SmithAt    Place   // the blacksmith's work spot (the forge)
	Forge      Place   // the forge prop
	Ore        Place   // sunlit sunsteel veins (area)
	Mouth      Place   // the cave mouth that leads to them
	Shaft      Place   // the sunlit shaft above them (glide down it), if any
	OreDepth   float64 // how far below the surface the veins are (m), 0 unknown
	Shrine     Place   // where the Light tome rests
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
	// Playtest 2: say where the pickaxe is (every character carries one,
	// items.yaml starter) and that the seam is deep, at the bottom of the
	// sunlit shaft, not on the surface under the marker.
	const pick = "Take the pickaxe from your pack: aim at the bright vein and press E until it breaks, then pick up the ore."
	oreNote := "Sunsteel only forms where daylight reaches into a cave: look at the bottom of sunlit shafts. " + pick
	var oreMarkers []Marker
	if p.Ore.OK {
		deep := "where daylight reaches into it"
		if p.OreDepth >= 20 {
			deep = fmt.Sprintf("about %.0f m down, at the bottom of a sunlit shaft", math.Round(p.OreDepth/10)*10)
		}
		route := "Walk in from the cave mouth and follow the tunnels down."
		if p.Shaft.OK {
			route = "Walk in from the cave mouth and follow the tunnels down, or jump down the shaft (G opens your glider)."
		}
		oreNote = fmt.Sprintf("Sunsteel glints in %s (%s), %s. %s %s One vein gives enough ore for a blade.", nameOr(p.Ore.Name, "the cave"), p.Ore.Where, deep, route, pick)
		oreMarkers = append(oreMarkers, Marker{X: p.Ore.X, Z: p.Ore.Z, R: math.Max(p.Ore.R, 20), Label: "Sunsteel ore (deep below)"})
	}
	if p.Mouth.OK {
		oreMarkers = append(oreMarkers, Marker{X: p.Mouth.X, Z: p.Mouth.Z, Label: nameOr(p.Mouth.Name, "Cave mouth")})
	}
	if p.Shaft.OK {
		oreMarkers = append(oreMarkers, Marker{X: p.Shaft.X, Z: p.Shaft.Z, Label: nameOr(p.Shaft.Name, "Sunlit shaft")})
	}
	const sayHead = "Steel won't kill what walks at night: demons close their wounds and laugh. Only sunsteel bites them, or Light magic, or the sunrise. "
	const sayTail = " Bring back four ore, buy my blueprint, and we'll forge you a blade. You've a pickaxe in your pack; here, take a little coin too."
	oreSay := sayHead + "Sunsteel ore grows where daylight reaches into the caves." + sayTail
	if p.Ore.OK {
		oreSay = sayHead + fmt.Sprintf("There's a sunlit seam deep in %s, %s, at the bottom of the shaft the daylight falls through.", nameOr(p.Ore.Name, "the cave"), p.Ore.Where) + sayTail
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
			Text:    "Mine 4 sunsteel ore with your pickaxe",
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

// The first quest (playtest 2, new player onboarding): before the Ward, a
// townsperson of the Haven town asks a new character to thin out the
// slimes in the meadows around it, so the first goal is close by and
// teaches talking (E) and fighting; the last line sends them on to the
// blacksmith, and finishing it starts the Ward.
const (
	MeadowsKey    = "story:meadows"
	MeadowsID     = 0x534c494d // "SLIM"
	MeadowsSlimes = 5
	MeadowsGold   = 15
	MeadowsXP     = 60
	MeadowsFamily = "slime"
)

// MeadowsReward is what the giver hands over on the way out (besides the
// gold and XP): draughts for the road and a first piece of armour.
var MeadowsReward = []ItemQty{{Item: "potion:health", Qty: 2}, {Item: "armor:leather_cap", Qty: 1}}

// MeadowsPlaces is what "Slimes in the meadows" points at: the giver and the
// nearest slime packs around the town.
type MeadowsPlaces struct {
	Settlement int
	Town       string
	Giver      string // the townsperson's name
	GiverRole  int    // towns role (the talk steps match role + settlement)
	GiverTitle string // "farmer"
	GiverAt    Place
	Packs      []Place // slime packs (areas), nearest first
	Smith      string  // who the last line sends you to
}

// Meadows builds the starter quest; nil without a giver or slimes to mark.
func Meadows(p MeadowsPlaces, nowMs int64) *Quest {
	if p.Giver == "" || len(p.Packs) == 0 {
		return nil
	}
	giver := []Marker{}
	if p.GiverAt.OK {
		giver = append(giver, Marker{X: p.GiverAt.X, Z: p.GiverAt.Z, Label: p.Giver + ", " + p.GiverTitle})
	}
	var packs []Marker
	for _, pk := range p.Packs {
		packs = append(packs, Marker{X: pk.X, Z: pk.Z, R: math.Max(pk.R, 18), Label: "Slimes"})
	}
	where := ""
	if len(p.Packs) > 0 && p.Packs[0].Where != "" {
		where = " The nearest lot is " + p.Packs[0].Where + "."
	}
	smith := nameOr(p.Smith, "the blacksmith")
	talk := Objective{Kind: ObjTalk, Role: p.GiverRole, Settlement: p.Settlement, Site: -1}
	steps := []Step{
		{
			Text:    fmt.Sprintf("Talk to %s, the %s of %s", p.Giver, p.GiverTitle, p.Town),
			Note:    "Walk up to them and press E to talk. Townsfolk give quests and trade.",
			Say:     fmt.Sprintf("You're new here? Then you're just in time. The slimes have crept out of the meadows again and they're eating everything green. Thin them out for me: five should teach them.%s Left click swings your sword, 1 to 4 cast the spells you know, F dodges. They're slow and soft; you'll be fine.", where),
			Obj:     talk,
			Markers: giver,
		},
		{
			Text:    fmt.Sprintf("Kill %d slimes in the meadows around %s", MeadowsSlimes, p.Town),
			Note:    "The marked meadows have slimes. Left click attacks, 1-4 cast spells, F dodges. Health comes back out of combat; R drinks a draught.",
			Obj:     Objective{Kind: ObjKill, Family: MeadowsFamily, Count: MeadowsSlimes, Settlement: -1, Site: -1},
			Markers: packs,
		},
		{
			Text:    fmt.Sprintf("Return to %s in %s", p.Giver, p.Town),
			Note:    "Your reward waits in town.",
			Say:     fmt.Sprintf("Ha! That'll keep them off the cabbages. Here's your pay, a couple of draughts for the road, and my old cap: wear it (I, your pack). Now, if you mean to stay out after dark, go and see %s at the forge. Slimes are nothing next to what walks at night.", smith),
			Obj:     talk,
			Markers: giver,
			Grant:   MeadowsReward,
		},
	}
	return &Quest{ID: MeadowsID, Key: MeadowsKey, Kind: KindStory, Title: "Slimes in the meadows", Giver: p.Giver + ", " + p.GiverTitle + " of " + p.Town,
		Settlement: p.Settlement, Steps: steps, Gold: MeadowsGold, XP: MeadowsXP, Accepted: nowMs}
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
