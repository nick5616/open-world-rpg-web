package quests

import (
	"fmt"
	"math"
)

// Errands (playtest 4, CR 051): the first hour after the slimes. Six short
// jobs, each given by a person of the starting town and each sending the
// player to one system at a place near town: ore and the forge (smith),
// timber and the hammer (the mentor, who also gave the slimes), a torch and
// a cave mouth (the guard), a first fish (the innkeeper), a steed (the
// merchant) and a tower (the bounty keeper). Ordinary quests: a talk step to
// begin with (for a new character the chain starts the next one itself), one
// or two counting "do" steps (ObjDo: mine, fell, smelt, build, torch, fish,
// steed, ride), a reach or attune step, and a talk step to finish.

// Errand ids; keys are ErrandKey(id).
const (
	ErrandOre    = "ore"
	ErrandTimber = "timber"
	ErrandTorch  = "torch"
	ErrandPond   = "pond"
	ErrandSteed  = "steed"
	ErrandTower  = "tower"
)

// ErrandChain is the order a new character meets them in. The first
// ErrandPrologue of them come before the Ward.
var ErrandChain = []string{ErrandOre, ErrandTimber, ErrandTorch, ErrandPond, ErrandSteed, ErrandTower}

// ErrandPrologue: how many errands a new character does before the Ward
// starts by itself (ore, timber, torch: the tools its first step needs).
const ErrandPrologue = 3

// Deeds the glue signals (Signal.Kind ObjDo, Family = deed).
const (
	DeedMine  = "mine"
	DeedFell  = "fell"
	DeedSmelt = "smelt"
	DeedBuild = "build"
	DeedTorch = "torch"
	DeedFish  = "fish"
	DeedSteed = "steed"
	DeedRide  = "ride"
)

const errandPrefix = "story:errand:"

// ErrandKey is an errand's quest key.
func ErrandKey(id string) string { return errandPrefix + id }

// IsErrand reports whether key is an errand's.
func IsErrand(key string) bool {
	return len(key) > len(errandPrefix) && key[:len(errandPrefix)] == errandPrefix
}

// ErrandID is the wire id of an errand quest (stable, distinct from every
// other quest id: the top bit set).
func ErrandID(id string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(id); i++ {
		h = (h ^ uint32(id[i])) * 16777619
	}
	return h | 0x80000000
}

// Person is a townsperson an errand talks to.
type Person struct {
	Name  string
	Role  int
	Title string // "blacksmith"
	At    Place
}

// ErrandPlaces is everything the errands point at, resolved by the glue
// around the home settlement.
type ErrandPlaces struct {
	Settlement int
	Town       string
	Smith      Person
	Mentor     Person // gave the slimes: the farmer (or the nearest to one)
	Guard      Person
	Innkeeper  Person
	Merchant   Person
	Keeper     Person // the bounty keeper
	Forge      Place
	OreMouth   Place // the nearest cave with copper or iron in its walls: the mouth
	OreVeins   Place // and where the veins are (an area)
	DarkMouth  Place // the nearest cave mouth for the torch
	Water      Place // deep enough to fish
	Tower      Place // the nearest climbable tower
	TowerSite  int
	TowerName  string
}

// Rewards by errand: gold, XP and items (tuned with CR 048's curve: the
// three prologue errands are about 215 XP, a little over half of level 2).
type errandReward struct {
	gold  int
	xp    int64
	items []ItemQty
	rep   int
}

var errandRewards = map[string]errandReward{
	ErrandOre:    {gold: 15, xp: 70, items: []ItemQty{{Item: "weapon:copper_sword", Qty: 1}, {Item: "tool:whetstone", Qty: 1}}},
	ErrandTimber: {gold: 15, xp: 70, items: []ItemQty{{Item: "camp:bedroll", Qty: 1}, {Item: "wood:firewood", Qty: 4}}},
	ErrandTorch:  {gold: 20, xp: 80, items: []ItemQty{{Item: "potion:health", Qty: 2}}},
	ErrandPond:   {gold: 20, xp: 70, items: []ItemQty{{Item: "potion:health", Qty: 1}}},
	ErrandSteed:  {gold: 25, xp: 60},
	ErrandTower:  {gold: 40, xp: 120},
}

// ErrandStart is what a giver hands over when the errand begins.
func ErrandStart(id string) []ItemQty {
	switch id {
	case ErrandTimber:
		return []ItemQty{{Item: "wood:log", Qty: 3}}
	case ErrandPond:
		return []ItemQty{{Item: "tool:fishing_rod", Qty: 1}}
	case ErrandSteed:
		return []ItemQty{{Item: "tool:spirit_whistle", Qty: 1}}
	}
	return nil
}

// ErrandGiver is who gives errand id (Name "" when the town lacks them).
func (p *ErrandPlaces) ErrandGiver(id string) Person {
	switch id {
	case ErrandOre:
		return p.Smith
	case ErrandTimber:
		return p.Mentor
	case ErrandTorch:
		return p.Guard
	case ErrandPond:
		return p.Innkeeper
	case ErrandSteed:
		return p.Merchant
	case ErrandTower:
		return p.Keeper
	}
	return Person{}
}

func (g Person) marker(label string) []Marker {
	if !g.At.OK {
		return nil
	}
	return []Marker{{X: g.At.X, Z: g.At.Z, Label: g.Name + ", " + label}}
}

func (g Person) talk(settlement int) Objective {
	return Objective{Kind: ObjTalk, Role: g.Role, Settlement: settlement, Site: -1}
}

func place(pl Place, r float64, label string) []Marker {
	if !pl.OK {
		return nil
	}
	return []Marker{{X: pl.X, Z: pl.Z, R: r, Label: label}}
}

func where(pl Place) string {
	if pl.Where == "" {
		return "near town"
	}
	return pl.Where
}

func do(deed string, n int) Objective {
	return Objective{Kind: ObjDo, Family: deed, N: n, Settlement: -1, Site: -1}
}

// Errand builds errand id; nil when its giver or a place it needs is
// missing (the chain skips it). withTalk: the quest starts with a talk step
// (the chain started it before the player met the giver); without it the
// giver's line is the offer's Say (Errand's second result) and the quest
// starts at its first deed.
func Errand(id string, p *ErrandPlaces, withTalk bool, nowMs int64) (*Quest, string) {
	g := p.ErrandGiver(id)
	if g.Name == "" {
		return nil, ""
	}
	var say string
	var mid []Step
	title, last := "", ""
	switch id {
	case ErrandOre:
		if !p.OreMouth.OK || !p.Forge.OK {
			return nil, ""
		}
		title = "First ore"
		say = fmt.Sprintf("%s says you can swing a sword. Lovely. Swords come out of rock, though. There's a pickaxe in your pack: the cave mouth %s has copper and iron in its walls. Break three veins loose, working at the bright bits until they give, and bring me the ore. Then my forge will show you the rest.", nameOr(p.Mentor.Name, "The farmer"), where(p.OreMouth))
		mid = []Step{
			{Text: "Mine 3 veins in the cave with your pickaxe", Note: "Work at a bright vein with the pickaxe until it breaks, then pick up what falls. It is dark in there, so keep your torch handy.",
				Obj: do(DeedMine, 3), Markers: append(place(p.OreMouth, 0, "Cave mouth"), place(p.OreVeins, math.Max(p.OreVeins.R, 20), "Ore in the walls")...)},
			{Text: "Smelt ore into an ingot at the forge", Note: "Step up to the forge and choose a smelt recipe: two ore make one ingot.",
				Obj: do(DeedSmelt, 1), Markers: place(p.Forge, 0, "Forge, "+p.Town)},
		}
		last = "There. Metal, from rock, by your own hands. I'd made this one up for you while you were away: copper, honest, not pretty. Put it on from your pack. And come back when you want to hear about the sunsteel."
	case ErrandTimber:
		title = "Timber"
		say = "Slimes gone, cabbages saved, and you're not even winded. Right then: a favour that's more fun than it sounds. Take the axe from your pack, fell three trees, then take up the hammer and put something up a little way out of town. Everyone should build one crooked thing."
		mid = []Step{
			{Text: "Fell 3 trees with your axe", Note: "Chop at a trunk until it comes down, then pick up the logs. Any three trees will do.",
				Obj: do(DeedFell, 3), Markers: g.marker("")},
			{Text: "Build something with the hammer", Note: "Pick a piece (a foundation, a floor or a wall) and place it a short walk outside the town and off the roads. I gave you logs to start.",
				Obj: do(DeedBuild, 1), Markers: g.marker("")},
		}
		last = "Would you look at that. Crooked, proud and yours. Here: a bedroll for it. Lay it out from your camp things and sleep on it, and you wake up Rested: faster healing for a good while."
	case ErrandTorch:
		if !p.DarkMouth.OK {
			return nil, ""
		}
		title = "The dark mouth"
		say = fmt.Sprintf("See that hole %s? Folk go in, folk come out strange. I'd go myself if I weren't on duty. Light the torch from your pack and walk right up to the mouth. Carry that light in and see how far it reaches. Then tell me it isn't scary.", where(p.DarkMouth))
		mid = []Step{
			{Text: "Light your torch", Note: "It burns until you douse it or go for a swim.", Obj: do(DeedTorch, 1), Markers: g.marker("")},
			{Text: "Carry the light to the cave mouth", Note: "Walk up to the marked mouth. Inside, caves are dark; your torch shows the walls and the veins.",
				Obj: Objective{Kind: ObjReach, X: p.DarkMouth.X, Z: p.DarkMouth.Z, R: 14, Settlement: -1, Site: -1}, Markers: place(p.DarkMouth, 0, "Cave mouth")},
		}
		last = "You went in and out in one piece. Good. That's the whole trick of the dark: bring your own light. Take these for the road, and keep the torch lit when the stone closes in."
	case ErrandPond:
		if !p.Water.OK {
			return nil, ""
		}
		title = "Something for the pot"
		say = fmt.Sprintf("The trout's off the menu because nobody brings me any. Here's a rod, on the house. Deep water %s: face it and cast, and when the float dips and a '!' shows, strike. Bring back whatever bites.", where(p.Water))
		mid = []Step{
			{Text: "Catch a fish", Note: "Face deep water and cast. When the float goes under, strike, then reel in steadily and let the line rest when it strains.",
				Obj: do(DeedFish, 1), Markers: place(p.Water, math.Max(p.Water.R, 25), "Fishing water")},
		}
		last = "Would you look at that, a real fish. Put it on the hearth over there and it heals you better than any draught I sell. Don't tell the cook."
	case ErrandSteed:
		title = "Faster legs"
		say = "Forty gold, that whistle, to anyone else. You've been good for my trade, so it's yours. Blow it out in the open and wait: something old comes galloping. Then climb up beside it. Hold on."
		mid = []Step{
			{Text: "Whistle for your steed, out in the open", Note: "It gallops in from a way off and stands beside you.", Obj: do(DeedSteed, 1), Markers: g.marker("")},
			{Text: "Climb on", Note: "Mount beside it, and dismount when you are done. You can't swing a sword up there, but spells work.", Obj: do(DeedRide, 1)},
		}
		last = "Ha! You sat that like you were born in the saddle. Mind the night: demons spook it."
	case ErrandTower:
		if !p.Tower.OK {
			return nil, ""
		}
		title = "A view of the land"
		say = fmt.Sprintf("You've run all of our small errands. Here's the big one: %s, %s. A tower you can climb. Reach the top and put your hand to the crystal and the land opens up on your map. Walk up the spiral; your glider gets you down.", nameOr(p.TowerName, "the tower"), where(p.Tower))
		mid = []Step{
			{Text: fmt.Sprintf("Climb %s and attune to its crystal", nameOr(p.TowerName, "the tower")), Note: "Climb to the top and lay your hand on the crystal. Attuning reveals the map around it and makes you a little stronger.",
				Obj: Objective{Kind: ObjAttune, Site: p.TowerSite, Settlement: -1}, Markers: place(p.Tower, math.Max(p.Tower.R, 15), nameOr(p.TowerName, "Tower"))},
		}
		last = "I could see you up there, a speck. Now you have a map and a head start. Go and sit with the innkeeper: there's an old story in this town that has been waiting for someone with your boots. And ask around: people here know of places you'd never find alone."
	default:
		return nil, ""
	}
	var steps []Step
	if withTalk {
		steps = append(steps, Step{
			Text: fmt.Sprintf("Talk to %s, the %s of %s", g.Name, g.Title, p.Town),
			Note: "Walk up to them and talk.",
			Say:  say,
			Obj:  g.talk(p.Settlement), Markers: g.marker(g.Title),
		})
	}
	steps = append(steps, mid...)
	steps = append(steps, Step{
		Text: fmt.Sprintf("Return to %s", g.Name),
		Note: "Your reward waits in town.",
		Say:  last,
		Obj:  g.talk(p.Settlement), Markers: g.marker(g.Title),
	})
	r := errandRewards[id]
	return &Quest{ID: ErrandID(id), Key: ErrandKey(id), Kind: KindStory, Title: title, Giver: g.Name + ", " + g.Title + " of " + p.Town,
		Settlement: p.Settlement, Steps: steps, Gold: r.gold, XP: r.xp, Items: r.items, Rep: r.rep, Start: ErrandStart(id), Accepted: nowMs}, say
}

// NextErrand is the first errand of the chain (within the first n) that the
// log has neither started nor done, "" when there is none.
func NextErrand(l *Log, n int) string {
	for i, id := range ErrandChain {
		if i >= n {
			break
		}
		k := ErrandKey(id)
		if !l.HasStarted(k) && !l.IsDone(k) && l.ByKey(k) == nil {
			return id
		}
	}
	return ""
}

// ErrandsDone counts the chain's finished errands.
func ErrandsDone(l *Log) int {
	n := 0
	for _, id := range ErrandChain {
		if l.IsDone(ErrandKey(id)) {
			n++
		}
	}
	return n
}
