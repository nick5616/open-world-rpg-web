package npc

// What townsfolk say and offer (WP20): dialogue lines by role and time of
// day, merchant wares, and the bounty board's generated jobs (spec 5: "clear
// the bandit camp to the north", "bring 5 iron ingots", "slay the demon
// that haunts the mill"). All seeded by ids and the in-game day, so every
// player in a settlement sees the same board on the same day.

import (
	"encoding/binary"
	"fmt"
	"math"

	"lodestone/server/pkg/towns"
)

var lines = map[uint8][]string{
	towns.RoleVillager:   {"Fine day for it.", "Keep to the roads after dark, friend.", "The lanterns keep the worst away. Mostly.", "Have you climbed the tower yet? You can see three valleys from up there."},
	towns.RoleMerchant:   {"Have a look, everything's honest weight.", "Fresh in this morning.", "Coin or trade, I'm not fussy."},
	towns.RoleBlacksmith: {"Bring me ore and I'll make it worth carrying.", "The forge is hot. Mind your sleeves.", "Sunsteel's the only thing that bites a demon. Remember that."},
	towns.RoleInnkeeper:  {"A bed and a hot meal, that's what you need.", "Rest here. The garden keeps the night out.", "Mind the step, it's been loose since spring."},
	towns.RoleBounty:     {"Work for the brave, pay for the living.", "The board's fresh. Pick something that won't kill you.", "Folk around here pay well for peace and quiet."},
	towns.RoleFarmer:     {"Rain's late again.", "If you see the crows, chase them for me.", "Good soil this side of the river."},
	towns.RoleGuard:      {"Move along.", "Gates close at dusk, not that it stops the dark.", "Trouble on the north road. Watch yourself."},
}

var closedLines = []string{"Come back in the morning, I'm done for the day.", "We're closed. Try the inn.", "Not now, it's late."}

// Say is NPC i's line at time of day t (open: its service is available).
func (w *World) Say(i int, todS float64, open bool) string {
	d := w.NPCs[i].Def
	h := mix(d.ID ^ uint64(todS/90)*0x9E3779B97F4A7C15)
	if !open && d.Role != towns.RoleVillager && d.Role != towns.RoleGuard && d.Role != towns.RoleFarmer {
		return closedLines[h%uint64(len(closedLines))]
	}
	l := lines[d.Role]
	return l[h%uint64(len(l))]
}

// Ware is one item for sale.
type Ware struct {
	Item  string
	Price uint32
	Stock uint16
}

// Item ids are contracts/items.yaml keys (WP14; itemdefs tests check every
// one exists). Prices are in gold (currency:gold, CR 010).
var wares = [5][]Ware{
	{{"food:bread", 4, 20}, {"tool:torch", 6, 12}, {"tool:rope", 10, 6}, {"tool:pickaxe", 40, 3}, {"tool:fishing_rod", 25, 4}},         // general (playtest 2: a fishing rod)
	{{"food:bread", 3, 30}, {"food:cheese", 6, 12}, {"food:apple", 2, 40}, {"food:stew", 9, 8}},                                        // provisions
	{{"herb:heartleaf", 5, 15}, {"potion:health", 25, 6}, {"potion:antidote", 18, 6}, {"seed:wardbloom", 30, 4}},                       // herbalist
	{{"tool:pickaxe", 35, 4}, {"ingot:copper", 12, 10}, {"ingot:iron", 20, 8}, {"tool:whetstone", 8, 10}, {"tool:fishing_rod", 22, 4}}, // tools
	{{"ingot:iron", 22, 10}, {"weapon:iron_sword", 90, 2}, {"weapon:iron_spear", 85, 2}, {"ammo:iron_arrow", 1, 99}, // blacksmith
		{"blueprint:iron_sword", 30, 1}, {"blueprint:silver_sword", 80, 1}, {"blueprint:sunsteel_blade", 40, 1}, {"blueprint:sunsteel_arrow", 30, 1}}, // WP14: spec 7 blueprints "bought from blacksmiths"
}

// SmithWares is what every blacksmith sells (WP14 tests, tools).
func SmithWares() []Ware { return wares[4] }

// Wares is what NPC i sells (nil: nothing).
func (w *World) Wares(i int) []Ware {
	d := w.NPCs[i].Def
	switch {
	case d.Role == towns.RoleMerchant && d.Merchant < 4:
		return wares[d.Merchant]
	case d.Role == towns.RoleBlacksmith:
		return wares[4]
	}
	return nil
}

// EncodeShop is Event 801's data (contracts/events.md).
func EncodeShop(ws []Ware) []byte {
	b := []byte{1, byte(len(ws))}
	for _, x := range ws {
		b = binary.LittleEndian.AppendUint16(b, uint16(len(x.Item)))
		b = append(b, x.Item...)
		b = binary.LittleEndian.AppendUint32(b, x.Price)
		b = binary.LittleEndian.AppendUint16(b, x.Stock)
	}
	return b
}

// Bounty kinds (Event 802).
const (
	BountyClear   = 0
	BountyDeliver = 1
	BountySlay    = 2
	BountyExplore = 3
)

// Bounty is one job on a settlement's board.
type Bounty struct {
	ID         uint32
	Kind       uint8
	Site       int // target atlas site, -1 none
	Qty        uint16
	Reward     uint32
	Text       string
	Settlement int
	Item       string // deliveries: the item key (quests: the turn-in)
}

var deliverItems = []struct{ id, name string }{{"ingot:iron", "iron ingots"}, {"ingot:copper", "copper ingots"}, {"herb:heartleaf", "heartleaf"}, {"hide:wolf", "wolf pelts"}, {"ore:silver", "silver ore"}}

func compass(dx, dz float64) string {
	// North is -z (worldgen README "Coordinates").
	a := math.Atan2(-dz, dx) * 180 / math.Pi
	dirs := []string{"east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"}
	k := int(math.Floor((a+22.5)/45)) % 8
	if k < 0 {
		k += 8
	}
	return dirs[k]
}

// Bounties is settlement si's board on in-game day `day` (3 or 4 jobs).
func (w *World) Bounties(si, day int) []Bounty {
	st := &w.T.Settlements[si]
	h := mix(w.Seed ^ st.ID ^ uint64(day)*0xD6E8FEB86659FD93)
	n := 3 + int(h%2)
	// Nearby structure and camp sites, nearest first (within 1.6 km).
	type cand struct {
		s Site
		d float64
	}
	var near []cand
	for _, s := range w.Sites {
		if s.Category == 2 || (s.Category == 0 && s.Kind == 4) {
			if d := math.Hypot(s.X-st.X, s.Z-st.Z); d < 1600 {
				near = append(near, cand{s, d})
			}
		}
	}
	for i := 1; i < len(near); i++ {
		for j := i; j > 0 && near[j].d < near[j-1].d; j-- {
			near[j], near[j-1] = near[j-1], near[j]
		}
	}
	var out []Bounty
	for k := 0; k < n; k++ {
		r := mix(h + uint64(k+1)*0x9E3779B97F4A7C15)
		b := Bounty{ID: uint32(r>>32) | 1, Site: -1, Settlement: si}
		kind := uint8(r % 4)
		if len(near) == 0 && kind != BountyDeliver {
			kind = BountyDeliver
		}
		switch kind {
		case BountyDeliver:
			it := deliverItems[(r>>8)%uint64(len(deliverItems))]
			b.Item = it.id
			b.Qty = uint16(3 + (r>>16)%6)
			b.Reward = uint32(b.Qty) * (8 + uint32((r>>24)%8))
			b.Text = fmt.Sprintf("Bring %d %s.", b.Qty, it.name)
		default:
			c := near[int((r>>8)%uint64(min(len(near), 4)))]
			b.Site = c.s.Index
			dir := compass(c.s.X-st.X, c.s.Z-st.Z)
			what := siteNoun(c.s)
			name := c.s.Name
			b.Reward = 40 + uint32(c.d/12) + uint32((r>>20)%30)
			switch kind {
			case BountyClear:
				b.Text = fmt.Sprintf("Clear the %s to the %s.", what, dir)
			case BountySlay:
				b.Reward += 60
				if name != "" {
					b.Text = fmt.Sprintf("Slay the demon that haunts %s.", name)
				} else {
					b.Text = fmt.Sprintf("Slay the demon that haunts the %s to the %s.", what, dir)
				}
			default:
				if name != "" {
					b.Text = fmt.Sprintf("Find out what lies in %s, %s of here.", name, dir)
				} else {
					b.Text = fmt.Sprintf("Scout the %s to the %s.", what, dir)
				}
			}
		}
		b.Kind = kind
		out = append(out, b)
	}
	return out
}

func siteNoun(s Site) string {
	if s.Category == 0 {
		return "bandit camp"
	}
	if int(s.Kind) < len(towns.StructureNames) {
		return towns.StructureNames[s.Kind]
	}
	return "ruin"
}

// EncodeBounties is Event 802's data; accepted marks the jobs you hold.
func EncodeBounties(bs []Bounty, accepted func(id uint32) bool) []byte {
	return EncodeBountiesState(bs, func(id uint32) byte {
		if accepted != nil && accepted(id) {
			return 1
		}
		return 0
	})
}

// EncodeBountiesState is EncodeBounties with the accepted byte per job
// (1 = you hold it, 2 = you completed it today; CR 013).
func EncodeBountiesState(bs []Bounty, state func(id uint32) byte) []byte {
	b := []byte{1, byte(len(bs))}
	for _, x := range bs {
		b = binary.LittleEndian.AppendUint32(b, x.ID)
		b = append(b, x.Kind)
		site := uint16(0xFFFF)
		if x.Site >= 0 {
			site = uint16(x.Site)
		}
		b = binary.LittleEndian.AppendUint16(b, site)
		b = binary.LittleEndian.AppendUint16(b, x.Qty)
		b = binary.LittleEndian.AppendUint32(b, x.Reward)
		b = append(b, state(x.ID))
		b = binary.LittleEndian.AppendUint16(b, uint16(len(x.Text)))
		b = append(b, x.Text...)
	}
	return b
}
