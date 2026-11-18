package dialog

import (
	"strings"
	"testing"
)

func richCtx() Context {
	return Context{
		Player: "Nicole", Level: 12, Gear: 2, Hour: 13, Open: true,
		Char: Char{Class: ClassMage, Sunsteel: true},
		Work: Work{Shop: true, Rest: true, Forge: true, Bounty: true},
		Sites: []Site{
			{Kind: KindBandit, Key: "site:1", Name: "Rook Hollow", X: 200, Z: 100, DX: 200, DZ: 100},
			{Kind: KindVault, Key: "site:2", Name: "Sealed Keep", X: 800, Z: -300, DX: 800, DZ: -300},
			{Kind: KindTower, Key: "site:3", X: -400, Z: 0, DX: -400},
		},
	}
}

func lastIsExit(cs []Choice) bool {
	return len(cs) > 0 && len(cs) <= MaxChoices && cs[len(cs)-1].Kind == "leave" && cs[len(cs)-1].Act == "bye"
}

func TestEveryNodeOffersAnExit(t *testing.T) {
	topics := []string{"who", "place", "chat", "rumour", "family", "origin", "wants", "secret", "nonsense", "ck-class", "ck-warmth", "ck-level", "ck-item"}
	ctxs := []Context{richCtx(), {Player: "Nicole", Level: 1, Hour: 23, Night: true}, {Level: 3, Work: Work{Shop: true, Forge: true, Rest: true, Bounty: true}}}
	n := 0
	for id := uint64(1); id <= 40; id++ {
		for role := uint8(0); role <= RoleGuard; role++ {
			p := person(id*17+uint64(role), role)
			for _, key := range []string{"", KeyKeeper, KeyMeadows, KeySmith, KeyBounty, KeyCaptain, KeyMasterSmith} {
				p.Key = key
				ps := PersonaOf(p)
				for ci, ctx := range ctxs {
					for _, mem := range []Memory{{}, {Met: true, Talks: 3, Affinity: 9}, {Met: true, Talks: 7, Affinity: 30}} {
						open := Open(p, mem, ctx)
						if !lastIsExit(open.Choices) {
							t.Fatalf("open: no exit: person %d role %d key %q ctx %d: %+v", p.ID, role, key, ci, open.Choices)
						}
						for _, topic := range topics {
							m := mem
							r := Reply(p, &m, ctx, topic)
							if r.Line == "" {
								t.Fatalf("empty line for %s", topic)
							}
							if !lastIsExit(r.Choices) {
								t.Fatalf("reply %s: no exit: %+v", topic, r.Choices)
							}
							n++
						}
						if qc := QuestChoices(p, ps, mem, ctx, "9", true); !lastIsExit(qc) {
							t.Fatalf("quest: no exit: %+v", qc)
						}
					}
				}
			}
		}
	}
	if n < 1000 {
		t.Fatalf("only %d nodes", n)
	}
}

func TestFinishKeepsTheExitWhenFull(t *testing.T) {
	p := person(5, RoleVillager)
	var cs []Choice
	for i := 0; i < 9; i++ {
		cs = append(cs, Choice{Text: "x", Kind: "topic"})
	}
	cs = append(cs[:3], append([]Choice{{Text: "bye", Kind: "leave", Act: "bye"}}, cs[3:]...)...) // the exit buried in the middle
	out := Finish(cs, p, Memory{})
	if !lastIsExit(out) || len(out) != MaxChoices {
		t.Fatalf("%+v", out)
	}
	if again := Finish(out, p, Memory{}); len(again) != len(out) {
		t.Fatal("not idempotent")
	}
	if only := Finish(nil, p, Memory{}); len(only) != 1 || !lastIsExit(only) {
		t.Fatalf("empty list: %+v", only)
	}
}

func TestChoicesAreInYourVoiceWithTags(t *testing.T) {
	ctx := richCtx()
	p := person(8, RoleBlacksmith)
	ps := PersonaOf(p)
	cs := Menu(p, ps, Memory{Met: true, Talks: 1, Affinity: 5}, ctx)
	tags := map[string]bool{}
	for _, c := range cs {
		if c.Tag != "" {
			tags[c.Tag] = true
		}
		if strings.HasSuffix(c.Text, ":") || c.Text == "Goodbye." || c.Text == "Rumours" {
			t.Fatalf("menu-label answer: %q", c.Text)
		}
		if c.Kind != "leave" && !strings.ContainsAny(c.Text[len(c.Text)-1:], ".?!") {
			t.Fatalf("not a spoken line: %q", c.Text)
		}
	}
	for _, want := range []string{"Barter", "Rumour", "Leave"} {
		if !tags[want] {
			t.Fatalf("missing tag %q in %+v", want, cs)
		}
	}
	if cs[len(cs)-1].Tag != "Leave" {
		t.Fatalf("exit not last: %+v", cs)
	}
	// Work and the forge are tagged by what they open.
	var work []string
	for _, c := range cs {
		if c.Kind == "work" {
			work = append(work, c.Tag)
		}
	}
	if len(work) == 0 {
		t.Fatal("no services")
	}
}

func TestCheckPassAndFail(t *testing.T) {
	p := person(21, RoleVillager)
	ps := PersonaOf(p)
	ctx := richCtx()

	cases := []struct {
		c    Check
		ctx  func(Context) Context
		mem  Memory
		pass bool
	}{
		{Check{Kind: CheckClass, Class: ClassMage}, func(c Context) Context { return c }, Memory{}, true},
		{Check{Kind: CheckClass, Class: ClassArcher}, func(c Context) Context { return c }, Memory{}, false},
		{Check{Kind: CheckLevel, Need: 10}, func(c Context) Context { return c }, Memory{}, true},
		{Check{Kind: CheckLevel, Need: 10}, func(c Context) Context { c.Level = 9; return c }, Memory{}, false},
		{Check{Kind: CheckWarmth, Need: 3}, func(c Context) Context { return c }, Memory{Affinity: 6}, true},
		{Check{Kind: CheckWarmth, Need: 3}, func(c Context) Context { return c }, Memory{Affinity: 5}, false},
		{Check{Kind: CheckItem}, func(c Context) Context { return c }, Memory{}, true},
		{Check{Kind: CheckItem}, func(c Context) Context { c.Char.Sunsteel = false; return c }, Memory{}, false},
	}
	for _, tc := range cases {
		cx := tc.ctx(ctx)
		if got := tc.c.Pass(cx, tc.mem); got != tc.pass {
			t.Errorf("%s: pass = %v, want %v", tc.c.Tag(), got, tc.pass)
		}
		m := tc.mem
		topic := topicOfCheck(tc.c)
		// CheckFor sets the need per person, so test the reply through the check itself.
		n := checkReply(p, ps, &m, cx, tc.c)
		if n.Check == nil || n.Check.Pass != tc.pass || n.Check.Tag != tc.c.Tag() {
			t.Errorf("%s: result %+v", topic, n.Check)
		}
		if tc.pass {
			if n.Line == "" || n.Mood == "stern" {
				t.Errorf("%s pass line %q", topic, n.Line)
			}
		} else if n.Line != failLines[ps.Temper][failIndex(tc.c.Kind)] {
			t.Errorf("%s: a failed check should get the in-character refusal, got %q", topic, n.Line)
		}
	}
	if (Check{Kind: CheckWarmth, Need: 3}).Tag() != "Warmth ♥♥♥" || (Check{Kind: CheckLevel, Need: 10}).Tag() != "Level 10" || (Check{Kind: CheckItem}).Tag() != "Sunsteel" {
		t.Fatal("tags")
	}
}

func TestFailedChecksAreShownLowAndPassedOnesAreNot(t *testing.T) {
	p := person(8, RoleBlacksmith)
	ps := PersonaOf(p)
	poor := Context{Level: 1, Hour: 13, Work: Work{Shop: true}}
	rich := richCtx()
	seenLow, seenOK := false, false
	for talks := 0; talks < 8; talks++ {
		for _, c := range checkChoices(p, ps, Memory{Talks: talks}, poor, 4) {
			seenLow = seenLow || (c.Low && c.Tag != "")
		}
		for _, c := range checkChoices(p, ps, Memory{Talks: talks, Affinity: 20}, rich, 4) {
			if c.Kind == "check" && !c.Low && c.Tag != "" {
				seenOK = true
			}
		}
	}
	if !seenLow || !seenOK {
		t.Fatalf("low %v ok %v", seenLow, seenOK)
	}
}

func TestPassedChecksUnlockThings(t *testing.T) {
	ctx := richCtx()
	smith := person(31, RoleBlacksmith)
	m := Memory{Met: true, Talks: 2, Affinity: 12}
	// Sunsteel: a discount.
	n := Reply(smith, &m, ctx, "ck-item")
	if n.Perk == nil || n.Perk.Kind != PerkDiscount || n.Perk.Pct <= 0 {
		t.Fatalf("sunsteel gave no discount: %+v", n)
	}
	// Warmth at a shop: a discount; away from a shop: a secret rumour that can be marked.
	m = Memory{Met: true, Talks: 2, Affinity: 12}
	if n := Reply(smith, &m, ctx, "ck-warmth"); n.Perk == nil {
		t.Fatalf("warmth at a shop: %+v", n)
	}
	villager := person(32, RoleVillager)
	vc := ctx
	vc.Work = Work{}
	m = Memory{Met: true, Talks: 2, Affinity: 12}
	n = Reply(villager, &m, vc, "ck-warmth")
	if n.Rumour == nil || (n.Rumour.Kind != KindVault && n.Rumour.Kind != KindTower) {
		t.Fatalf("secret rumour expected: %+v", n)
	}
	var mark bool
	for _, c := range n.Choices {
		mark = mark || c.Kind == "mark"
	}
	if !mark {
		t.Fatal("secret rumour has no [Mark]")
	}
	// Level: the dangerous place.
	m = Memory{Met: true, Talks: 2}
	n = Reply(villager, &m, vc, "ck-level")
	lvl := CheckFor(villager, PersonaOf(villager), CheckLevel, vc)
	if vc.Level >= lvl.Need && (n.Rumour == nil || (n.Rumour.Kind != KindBandit && n.Rumour.Kind != KindVault)) {
		t.Fatalf("danger rumour expected: %+v", n)
	}
	// Class: the class lore, different per class.
	m = Memory{Met: true, Talks: 2}
	c := Check{Kind: CheckClass, Class: ClassMage}
	n = checkReply(villager, PersonaOf(villager), &m, ctx, c)
	found := false
	for _, l := range classLore[ClassMage] {
		found = found || strings.HasSuffix(n.Line, l)
	}
	if !found {
		t.Fatalf("class lore missing: %q", n.Line)
	}
	if Discount(100, 15) != 85 || Discount(1, 50) != 1 || Discount(10, 0) != 10 {
		t.Fatal("discount")
	}
}

func TestGoodbyeFlow(t *testing.T) {
	p := person(3, RoleInnkeeper)
	ps := PersonaOf(p)
	m := Memory{Met: true, Talks: 4}
	ex := ExitChoice(p, m)
	if ex.Kind != "leave" || ex.Tag != "Leave" || ex.Act != "bye" || ex.Text == "" {
		t.Fatalf("exit %+v", ex)
	}
	n := ByeNode(p, ps, m, "Nicole")
	if !n.Bye || n.Line == "" || len(n.Choices) != 0 {
		t.Fatalf("bye node %+v", n)
	}
	// Different goodbyes over visits, and each temperament has its own farewells.
	seen := map[string]bool{}
	for talks := 0; talks < 20; talks++ {
		seen[ExitChoice(p, Memory{Talks: talks}).Text] = true
	}
	if len(seen) < 3 {
		t.Fatalf("the exit never changes: %v", seen)
	}
	for tp := Temper(0); tp < numTempers; tp++ {
		if len(farewells[tp]) < 4 || len(partLines[tp]) < 3 || len(chatLines[tp]) < 4 {
			t.Fatalf("temperament %s lacks lines", tp)
		}
	}
}

func TestTemperamentsSoundDifferent(t *testing.T) {
	// Eight temperaments, each with its own work, menu, chat, refusal, reaction and parting lines.
	seen := map[string]Temper{}
	for tp := Temper(0); tp < numTempers; tp++ {
		var all []string
		for _, w := range workLines[tp] {
			all = append(all, w)
		}
		all = append(all, menuLines[tp][:]...)
		all = append(all, chatLines[tp]...)
		all = append(all, passReact[tp]...)
		for _, f := range failLines[tp] {
			all = append(all, f)
		}
		all = append(all, partLines[tp]...)
		for _, l := range all {
			if o, dup := seen[l]; dup {
				t.Fatalf("%q is spoken by %s and %s", l, o, tp)
			}
			seen[l] = tp
		}
	}
	// Two people in one town of different temperaments answer small talk differently.
	a, b := Person{ID: 1, Role: RoleVillager, Town: "X"}, Person{ID: 2, Role: RoleVillager, Town: "X"}
	var pa, pb Persona
	for id := uint64(1); id < 200; id++ {
		a.ID, b.ID = id, id+1
		pa, pb = PersonaOf(a), PersonaOf(b)
		if pa.Temper != pb.Temper {
			break
		}
	}
	if ChatLine(a, pa, Memory{}) == ChatLine(b, pb, Memory{}) {
		t.Fatal("two temperaments gave the same small talk")
	}
}

func TestHaggleAndParting(t *testing.T) {
	p := person(14, RoleBounty)
	ps := PersonaOf(p)
	ctx := richCtx()
	n, ok := HaggleReply(p, ps, Memory{}, ctx)
	if !ok || n.Check == nil || !n.Check.Pass {
		t.Fatalf("level 12 should win the haggle: %+v", n)
	}
	ctx.Level = 2
	n, ok = HaggleReply(p, ps, Memory{}, ctx)
	if ok || n.Check == nil || n.Check.Pass || n.Line != failLines[ps.Temper][failIndex(CheckLevel)] {
		t.Fatalf("level 2 should lose it: %+v", n)
	}
	if line := PartingLine(p, ps, Memory{Talks: 1}, "Nicole"); line == "" || strings.Contains(line, "{") {
		t.Fatalf("parting line %q", line)
	}
}

func TestClassOfWeapon(t *testing.T) {
	for w, c := range map[string]string{"sword": ClassKnight, "spear": ClassLancer, "bow": ClassArcher, "staff": ClassMage, "wand": ClassMage, "fists": ""} {
		if ClassOfWeapon(w) != c {
			t.Errorf("%s -> %q", w, ClassOfWeapon(w))
		}
	}
}
