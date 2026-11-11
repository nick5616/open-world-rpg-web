// Package story is the main questline, "The Last Song" (playtest 2, CR 035;
// docs/decisions/0024-main-story.md): six acts that take a character from the
// Haven town to the Heartfall, where the Hush waits. Pure: no I/O, clocks or
// goroutines. The places are world-global (resolved once per zone from the
// towns buffer, the atlas, the vault plans and the terrain by
// internal/game/story.go), so every zone of a world and every member of a
// party gets the same acts, and party members can share steps.
//
// Each act is an ordinary quest (internal/quests) of kind KindMain with the
// key "story:main:<act>": markers, the tracker, the journal, saving, the
// handoff all come for free. Acts after the first open with a level gate
// (ObjLevel) that a party member behind can skip by catching up (CatchUp).
//
// All names and lines are proposals for Nicole.
package story

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"lodestone/server/zone/internal/quests"
)

// Acts is the number of acts; Title the questline's name.
const (
	Acts  = 6
	Title = "The Last Song"
)

// Quest items (contracts/items.yaml) the acts hand over.
const (
	ItemFork      = "quest:keepers_fork"
	ItemVerseDawn = "quest:verse_dawn"
	ItemVerseDusk = "quest:verse_dusk"
	ItemLens      = "quest:archon_lens"
	ItemDawnheart = "quest:dawnheart"
	// ItemWhistle (playtest 2 co-op): Act I hands each player a spirit
	// whistle. Act II is three towers in three regions, kilometres apart;
	// nothing told a new player a steed could be bought.
	ItemWhistle = "tool:spirit_whistle"
)

// Story happenings (quests.ObjStory tags) the glue signals.
const (
	TagVigil     = "vigil"     // the vigil's waves broken (Act IV)
	TagSovereign = "sovereign" // the Starless Sovereign fell (Act IV)
	TagHush      = "hush"      // the Hush fell (Act VI: the ending)
)

// ActInfo is an act's fixed data.
type ActInfo struct {
	Title    string
	Subtitle string // the intro card's line
	Level    int    // the act's level gate (0 none)
	Gold     int
	XP       int64
	Roll     int // rolled rare-or-better items on completion
}

// ActList is every act (index act-1).
var ActList = [Acts]ActInfo{
	{Title: "The Fading Hum", Subtitle: "The Lodestone's song is going quiet", Level: 0, Gold: 60, XP: 250},
	{Title: "The Tuning Forks", Subtitle: "Wake the crystals that answer the hum", Level: 5, Gold: 120, XP: 500},
	{Title: "Verses in the Deep", Subtitle: "The keepers sealed the words away", Level: 8, Gold: 200, XP: 700, Roll: 1},
	{Title: "The Night Unsung", Subtitle: "Keep the vigil. The Starless walks", Level: 10, Gold: 260, XP: 900, Roll: 1},
	{Title: "Dawnforged", Subtitle: "A heart of sunsteel to carry the song", Level: 12, Gold: 320, XP: 1000, Roll: 1},
	{Title: "The Heartfall", Subtitle: "Where the Lodestone broke, the Hush waits", Level: 14, Gold: 600, XP: 2000, Roll: 2},
}

// Key is act n's quest key; ID its wire id ("MN" + act).
func Key(n int) string { return "story:main:" + strconv.Itoa(n) }

// ID is act n's quest id.
func ID(n int) uint32 { return 0x4d4e0000 | uint32(n) }

// ActOf returns the act a key names (0 if it is not a main story key).
func ActOf(key string) int {
	rest, ok := strings.CutPrefix(key, "story:main:")
	if !ok {
		return 0
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n < 1 || n > Acts {
		return 0
	}
	return n
}

// NPC is a townsperson a step talks to.
type NPC struct {
	OK         bool
	Settlement int
	Town       string
	Index      int // towns-buffer NPC index (the objective's NPC is Index + 1)
	Role       int
	Name       string
	Title      string // "innkeeper"
	X, Z       float64
}

// Place is an atlas site (or the Heartfall, Site -1).
type Place struct {
	OK     bool
	Site   int
	Name   string
	Region string
	X, Z   float64
	R      float64
	Hint   string // a vault's puzzle line
}

// Places is everything the acts point at.
type Places struct {
	HomeX, HomeZ float64 // the Haven town's centre ("420 m north-east of ...")
	Home         string  // the Haven town's name
	Keeper       NPC     // Acts I-III: the Haven town's innkeeper (or another elder)
	Tablet       Place   // Act I: the Last Keeper's stone
	Forks        [4]Place
	Vaults       [2]Place
	Captain      NPC   // Act IV: the vigil town's guard (or bounty keeper)
	Vigil        Place // the vigil town (Site: settlement index)
	Smith        NPC   // Act V: the master smith of the far town
	Sanctum      Place // Act V: a guarded boss site near the smith
	LastFork     Place // Act VI: the tower of the last region
	Heartfall    Place // Act VI: the arena
}

func (p *Places) where(x, z float64) string {
	return quests.Where(p.HomeX, p.HomeZ, x, z, p.Home)
}

func talk(n NPC) quests.Objective {
	return quests.Objective{Kind: quests.ObjTalk, Role: n.Role, Settlement: n.Settlement, NPC: n.Index + 1, Site: -1}
}

func npcMarker(n NPC) []quests.Marker {
	return []quests.Marker{{X: n.X, Z: n.Z, Label: n.Name + ", " + n.Town}}
}

func siteMarker(pl Place, label string) []quests.Marker {
	return []quests.Marker{{X: pl.X, Z: pl.Z, R: pl.R, Label: label}}
}

func gate(level int, home string) quests.Step {
	return quests.Step{
		Text: fmt.Sprintf("Grow stronger: reach level %d", level),
		Note: fmt.Sprintf("Bounties, townsfolk's requests and the wilds beyond %s will season you. In a party, the one behind can catch up in the journal (J).", home),
		Obj:  quests.Objective{Kind: quests.ObjLevel, N: level, Settlement: -1, Site: -1},
	}
}

func attune(p *Places, t Place, text string) quests.Step {
	name := t.Name
	if t.Region != "" {
		name += " in " + t.Region // two towers can share a name
	}
	return quests.Step{
		Text:    fmt.Sprintf(text, name),
		Note:    fmt.Sprintf("%s, %s. Climb to the top and lay your hand on the crystal (E). A crystal you attuned before answers again. Far? Call your steed (5); an attuned crystal is a fast travel point (M).", t.Name, p.where(t.X, t.Z)),
		Obj:     quests.Objective{Kind: quests.ObjAttune, Site: t.Site, Settlement: -1},
		Markers: siteMarker(t, "Tower crystal: "+t.Name),
	}
}

// Act builds act n (nil when the places it needs are missing).
func Act(n int, p *Places, nowMs int64) *quests.Quest {
	if n < 1 || n > Acts || p == nil {
		return nil
	}
	info := ActList[n-1]
	q := &quests.Quest{ID: ID(n), Key: Key(n), Kind: quests.KindMain, Title: fmt.Sprintf("%s · Act %s: %s", Title, Roman(n), info.Title),
		Settlement: -1, Gold: info.Gold, XP: info.XP, RollItems: info.Roll, Accepted: nowMs}
	k := p.Keeper
	var steps []quests.Step
	if info.Level > 0 {
		steps = append(steps, gate(info.Level, p.Home))
	}
	switch n {
	case 1:
		if !k.OK || !p.Tablet.OK || !p.Forks[0].OK {
			return nil
		}
		q.Giver = fmt.Sprintf("%s, %s of %s", k.Name, k.Title, k.Town)
		steps = append(steps,
			quests.Step{
				Text:    fmt.Sprintf("Talk to %s, the %s of %s", k.Name, k.Title, k.Town),
				Note:    "Word is the " + k.Title + " has been asking after whoever forged a sunsteel blade.",
				Say:     fmt.Sprintf("So you're the one with the sunsteel. Listen... hear that? No? That's the trouble. My grandmother said the Lodestone hums under these hills, and the hum keeps the night polite. It has gone thin as thread, and every night the Unsung come a little bolder. The last of the shrine keepers left a stone at %s. Read it for me; I never learned their letters.", p.Tablet.Name),
				Obj:     talk(k),
				Markers: npcMarker(k),
			},
			quests.Step{
				Text:    "Read the Last Keeper's stone at " + p.Tablet.Name,
				Note:    fmt.Sprintf("%s, %s. The stone's rune glows blue: walk up and press E.", p.Tablet.Name, p.where(p.Tablet.X, p.Tablet.Z)),
				Obj:     quests.Objective{Kind: quests.ObjRead, Site: p.Tablet.Site, Settlement: -1},
				Markers: siteMarker(Place{X: p.Tablet.X, Z: p.Tablet.Z}, "The Last Keeper's stone"),
			},
			attune(p, p.Forks[0], "Lay your hand on the crystal of %s"),
			quests.Step{
				Text:    fmt.Sprintf("Tell %s what the crystal answered", k.Name),
				Say:     "It hummed back at you? Then the song isn't dead, only quiet. The keepers tuned the world with those towers; they called them forks. Here: my grandmother's tuning fork. It shivers near a crystal. Find the other forks and wake them, and maybe the night will remember its manners. And take this whistle; the forks are far apart, and a spirit steed answers it. Blow it (5) on open ground.",
				Obj:     talk(k),
				Markers: npcMarker(k),
				Grant:   []quests.ItemQty{{Item: ItemFork, Qty: 1}, {Item: ItemWhistle, Qty: 1}},
			})
	case 2:
		if !k.OK || !p.Forks[1].OK || !p.Forks[2].OK || !p.Forks[3].OK {
			return nil
		}
		q.Giver = fmt.Sprintf("%s, %s of %s", k.Name, k.Title, k.Town)
		for _, f := range p.Forks[1:] {
			steps = append(steps, attune(p, f, "Wake the fork of %s"))
		}
		steps = append(steps, quests.Step{
			Text:    fmt.Sprintf("Return to %s in %s", k.Name, k.Town),
			Say:     "Three forks ringing together. I felt it in the floorboards, I swear it. But a song needs words as well as a tune, and the keepers sealed theirs away: the Verses, locked in the vaults under the old stones behind riddles the Unsung cannot answer. Bring them back.",
			Obj:     talk(k),
			Markers: npcMarker(k),
		})
	case 3:
		if !k.OK || !p.Vaults[0].OK || !p.Vaults[1].OK {
			return nil
		}
		q.Giver = fmt.Sprintf("%s, %s of %s", k.Name, k.Title, k.Town)
		for i, v := range p.Vaults {
			verse, item := "Verse of Dawn", ItemVerseDawn
			if i == 1 {
				verse, item = "Verse of Dusk", ItemVerseDusk
			}
			steps = append(steps, quests.Step{
				Text:    fmt.Sprintf("Open %s and claim the %s", v.Name, verse),
				Note:    fmt.Sprintf("%s. %s Then defeat the Vault Keeper. Two can hold what one cannot.", p.where(v.X, v.Z), v.Hint),
				Obj:     quests.Objective{Kind: quests.ObjDungeon, Site: v.Site, Settlement: -1},
				Markers: siteMarker(v, v.Name),
				Grant:   []quests.ItemQty{{Item: item, Qty: 1}},
			})
		}
		steps = append(steps, quests.Step{
			Text:    fmt.Sprintf("Bring the Verses to %s", k.Name),
			Say:     fmt.Sprintf("The Verse of Dawn and the Verse of Dusk. Look at the last line: \"When the Starless walks, keep the vigil, and the song will find its singer.\" The guards of %s have seen something at the edge of their lantern light. Go to %s. Keep the vigil.", p.Vigil.Name, p.Captain.Name),
			Obj:     talk(k),
			Markers: npcMarker(k),
		})
	case 4:
		c := p.Captain
		if !c.OK {
			return nil
		}
		q.Giver = fmt.Sprintf("%s, %s of %s", c.Name, c.Title, c.Town)
		steps = append(steps,
			quests.Step{
				Text:    fmt.Sprintf("Find %s, the %s of %s", c.Name, c.Title, c.Town),
				Note:    fmt.Sprintf("%s, %s.", c.Town, p.where(c.X, c.Z)),
				Say:     "The vigil? Gods. Fine. We light the old beacon, and every Unsung for a league comes to put it out, their Sovereign with them. Hold the ward garden until the last wave breaks, then kill the thing when it comes. Bring friends if you have them. Tell me when you're ready.",
				Obj:     talk(c),
				Markers: npcMarker(c),
			},
			quests.Step{
				Text:    fmt.Sprintf("Tell %s to light the vigil beacon", c.Name),
				Note:    "When you are ready: sunsteel in hand, Light in your spells, draughts in your pack.",
				Say:     "Then we stand. Light the beacon!",
				Obj:     talk(c),
				Markers: npcMarker(c),
			},
			quests.Step{
				Text:    "Hold the ward of " + c.Town + " through the vigil",
				Note:    "Demons come in waves for the ward garden. Only sunsteel and Light kill them. If the ward falls, the captain will light the beacon again.",
				Obj:     quests.Objective{Kind: quests.ObjStory, Family: TagVigil, Settlement: -1, Site: -1},
				Markers: siteMarker(Place{X: p.Vigil.X, Z: p.Vigil.Z, R: p.Vigil.R}, "The vigil: "+c.Town),
			},
			quests.Step{
				Text:    "Defeat the Starless Sovereign",
				Note:    "It walks out of the dark at the edge of " + c.Town + ". Sunsteel and Light, nothing else, will end it.",
				Obj:     quests.Objective{Kind: quests.ObjStory, Family: TagSovereign, Settlement: -1, Site: -1},
				Markers: siteMarker(Place{X: p.Vigil.X, Z: p.Vigil.Z, R: p.Vigil.R + 40}, "The Starless Sovereign"),
			},
			quests.Step{
				Text:    fmt.Sprintf("Report to %s", c.Name),
				Say:     fmt.Sprintf("You did it. You actually... Right. It spoke before it fell, didn't it? \"The Hush remembers.\" The keepers' word for the silence at the heart of everything. If you mean to end this, you'll need a heart of sunsteel to carry the song, and only %s in %s could forge one.", p.Smith.Name, p.Smith.Town),
				Obj:     talk(c),
				Markers: npcMarker(c),
			})
	case 5:
		sm := p.Smith
		if !sm.OK || !p.Sanctum.OK {
			return nil
		}
		q.Giver = fmt.Sprintf("%s, %s of %s", sm.Name, sm.Title, sm.Town)
		steps = append(steps,
			quests.Step{
				Text:    fmt.Sprintf("Bring the Verses to %s, master smith of %s", sm.Name, sm.Town),
				Note:    fmt.Sprintf("%s, %s.", sm.Town, p.where(sm.X, sm.Z)),
				Say:     fmt.Sprintf("Verses, a keeper's fork, and a face full of road dust. I know what you want. A Dawnheart: sunsteel that remembers the sunrise and can hold a song. I can forge it, but I need a lens to focus the light, and the only one left is in %s. Its keeper won't hand it over politely.", p.Sanctum.Name),
				Obj:     talk(sm),
				Markers: npcMarker(sm),
			},
			quests.Step{
				Text:    "Take the lens from " + p.Sanctum.Name,
				Note:    fmt.Sprintf("%s, %s. Defeat its guardian; the lens is yours when the place falls quiet.", p.Sanctum.Name, p.where(p.Sanctum.X, p.Sanctum.Z)),
				Obj:     quests.Objective{Kind: quests.ObjClear, Site: p.Sanctum.Site, X: p.Sanctum.X, Z: p.Sanctum.Z, R: math.Max(p.Sanctum.R, 30), Settlement: -1},
				Markers: siteMarker(Place{X: p.Sanctum.X, Z: p.Sanctum.Z, R: math.Max(p.Sanctum.R, 30)}, p.Sanctum.Name),
				Grant:   []quests.ItemQty{{Item: ItemLens, Qty: 1}},
			},
			quests.Step{
				Text:    fmt.Sprintf("Give the lens to %s", sm.Name),
				Say:     fmt.Sprintf("That's the one. Stand back... There. The Dawnheart. It's warm, and it hums. Take it to the last fork, %s; when it wakes, the Heart will pull you to the Heartfall. To the Hush. Come back and tell me about it, will you?", p.LastFork.Name),
				Obj:     quests.Objective{Kind: quests.ObjGive, Role: sm.Role, Settlement: sm.Settlement, NPC: sm.Index + 1, Items: []quests.ItemQty{{Item: ItemLens, Qty: 1}}, Site: -1},
				Markers: npcMarker(sm),
				Grant:   []quests.ItemQty{{Item: ItemDawnheart, Qty: 1}},
			})
	case 6:
		if !p.LastFork.OK || !p.Heartfall.OK {
			return nil
		}
		q.Giver = "The Dawnheart"
		hf := p.Heartfall
		steps = append(steps,
			attune(p, p.LastFork, "Wake the last fork: the crystal of %s"),
			quests.Step{
				Text:    "Follow the Dawnheart to the Heartfall",
				Note:    fmt.Sprintf("Where the Lodestone broke, %s. The Dawnheart pulls toward it.", p.where(hf.X, hf.Z)),
				Obj:     quests.Objective{Kind: quests.ObjReach, X: hf.X, Z: hf.Z, R: hf.R + 12, Settlement: -1, Site: -1},
				Markers: siteMarker(hf, "The Heartfall"),
			},
			quests.Step{
				Text:    "Silence the Hush",
				Note:    "Break its shroud with sunsteel or Light. When the bells toll, shatter them. When the endless night falls, each of you find your own well of dawn. A fallen friend can be raised: hold E beside them.",
				Obj:     quests.Objective{Kind: quests.ObjStory, Family: TagHush, Settlement: -1, Site: -1},
				Markers: siteMarker(hf, "The Hush"),
			})
	}
	q.Steps = steps
	return q
}

// Roman numerals for act numbers.
func Roman(n int) string {
	r := []string{"", "I", "II", "III", "IV", "V", "VI", "VII"}
	if n < 0 || n >= len(r) {
		return strconv.Itoa(n)
	}
	return r[n]
}

// Progress is how far a log is in the main story: the act being played
// (Acts+1 when every act is done, 0 when none has started) and its step.
func Progress(l *quests.Log) (act, step int) {
	for _, q := range l.Active {
		if n := ActOf(q.Key); n > 0 {
			return n, q.Step
		}
	}
	done := 0
	for n := 1; n <= Acts; n++ {
		if l.IsDone(Key(n)) {
			done = n
		}
	}
	if done == Acts {
		return Acts + 1, 0
	}
	if done > 0 {
		return done + 1, -1 // between acts: the next one not started yet
	}
	return 0, 0
}

// Rank orders progress (higher is further).
func Rank(act, step int) int { return act*64 + step }

// Next is the act a log should start now (0: one is active, or all done).
func Next(l *quests.Log) int {
	for _, q := range l.Active {
		if ActOf(q.Key) > 0 {
			return 0
		}
	}
	for n := 1; n <= Acts; n++ {
		if !l.IsDone(Key(n)) {
			return n
		}
	}
	return 0
}

// Skipped is what a catch-up hands over: the quest items of the steps
// skipped (the relics later steps need) and half the XP of the acts
// skipped.
type Skipped struct {
	Items []quests.ItemQty
	XP    int64
	Acts  []int // acts marked done
}

// CatchUp moves l to act, step (a party member's progress) without playing
// the steps between: earlier acts are remembered as done, the act is
// started at step. Returns what the skipped steps would have handed over
// (nil, false when l is not behind).
func CatchUp(l *quests.Log, p *Places, act, step int, nowMs int64) (*Skipped, bool) {
	ca, cs := Progress(l)
	if act < 1 || act > Acts || Rank(ca, cs) >= Rank(act, step) {
		return nil, false
	}
	target := Act(act, p, nowMs)
	if target == nil || step < 0 || step >= len(target.Steps) {
		return nil, false
	}
	sk := &Skipped{}
	held := map[string]bool{}
	// Items of steps already played in the current act are kept.
	for n := max(1, ca); n <= act; n++ {
		q := Act(n, p, nowMs)
		if q == nil {
			continue
		}
		from := 0
		if n == ca && cs > 0 {
			from = cs
		}
		to := len(q.Steps)
		if n == act {
			to = step
		}
		for i := from; i < to; i++ {
			for _, g := range q.Steps[i].Grant {
				if !held[g.Item] {
					held[g.Item] = true
					sk.Items = append(sk.Items, g)
				}
			}
		}
		if n < act {
			if !l.IsDone(Key(n)) {
				sk.XP += ActList[n-1].XP / 2
				sk.Acts = append(sk.Acts, n)
			}
		}
	}
	for _, q := range append([]*quests.Quest(nil), l.Active...) {
		if ActOf(q.Key) > 0 {
			l.Remove(q.ID)
		}
	}
	for _, n := range sk.Acts {
		l.MarkDone(Key(n))
	}
	if err := l.Add(target); err != nil {
		return nil, false
	}
	l.SetStep(target.Key, step)
	l.Track(target.ID)
	return sk, true
}
