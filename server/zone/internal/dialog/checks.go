package dialog

// Conversation craft for playtest 5 (CR 053): the answers are written in the
// player's own voice, each with a short tag at the front where it helps
// ([Leave], [Quest], [Barter], [Rumour], [Work], [Mark]); check tags depend
// on who you are ([Mage], [Warmth ♥♥♥], [Level 10], [Sunsteel]); passing one
// unlocks something, failing one gets an in-character refusal and the tag
// shows it was too low. Every node ends with a way out. Pure, like the rest
// of the package.

import (
	"fmt"
	"strings"
)

// Char is what the glue knows about the player's character beyond the level.
type Char struct {
	Class    string // Knight, Lancer, Archer, Mage: from the wielded weapon of the active loadout ("" unknown)
	Sunsteel bool   // carries sunsteel (an ingot, or a sunsteel weapon)
}

// Classes (the weapon kind of the active loadout names one).
const (
	ClassKnight = "Knight"
	ClassLancer = "Lancer"
	ClassArcher = "Archer"
	ClassMage   = "Mage"
)

// ClassOfWeapon names the class a combat.yaml weapon implies.
func ClassOfWeapon(w string) string {
	switch w {
	case "sword":
		return ClassKnight
	case "spear":
		return ClassLancer
	case "bow":
		return ClassArcher
	case "staff", "wand":
		return ClassMage
	}
	return ""
}

var allClasses = []string{ClassKnight, ClassLancer, ClassArcher, ClassMage}

// Check kinds.
const (
	CheckClass  = "class"
	CheckWarmth = "warmth"
	CheckLevel  = "level"
	CheckItem   = "item"
)

// Check is a gate on a line you can say.
type Check struct {
	Kind  string
	Need  int    // hearts (warmth), level (level)
	Class string // the class asked for (class)
}

// Hearts is how many hearts their warmth shows (0-5; two affinity a heart).
func Hearts(aff int) int { return max(0, min(5, aff/2)) }

// Tag is the text in the brackets.
func (c Check) Tag() string {
	switch c.Kind {
	case CheckClass:
		return c.Class
	case CheckWarmth:
		return "Warmth " + strings.Repeat("♥", c.Need)
	case CheckLevel:
		return fmt.Sprintf("Level %d", c.Need)
	}
	return "Sunsteel"
}

// Pass reports whether you meet the check.
func (c Check) Pass(ctx Context, m Memory) bool {
	switch c.Kind {
	case CheckClass:
		return ctx.Char.Class == c.Class
	case CheckWarmth:
		return Hearts(m.Affinity) >= c.Need
	case CheckLevel:
		return ctx.Level >= c.Need
	}
	return ctx.Char.Sunsteel
}

// CheckResult is what the node tells the client about the check you just
// tried (a chip in the transcript).
type CheckResult struct {
	Tag  string `json:"tag"`
	Pass bool   `json:"pass"`
}

// topicCheck maps a reply topic to its check ("ck-warmth" etc.).
func topicOfCheck(c Check) string { return "ck-" + c.Kind }

// CheckFor is person p's check of a kind (the need depends on them).
func CheckFor(p Person, ps Persona, kind string, ctx Context) Check {
	switch kind {
	case CheckClass:
		return Check{Kind: kind, Class: allClasses[mix(p.ID^0xC1A55)%uint64(len(allClasses))]}
	case CheckWarmth:
		need := 3
		switch ps.Temper {
		case Warm, Cheerful, Gossipy:
			need = 2
		case Gruff, Proud:
			need = 4
		}
		return Check{Kind: kind, Need: need}
	case CheckLevel:
		need := []int{5, 8, 10}[mix(p.ID^0x1E7E1)%3]
		if p.Role == RoleBounty || p.Role == RoleGuard {
			need += 3
		}
		return Check{Kind: kind, Need: need}
	}
	return Check{Kind: CheckItem}
}

// offeredChecks are the checks this person can put in front of you, in the
// order they rotate. The sunsteel one is for people who work the forge.
func offeredChecks(p Person, ps Persona, m Memory, ctx Context) []Check {
	var cs []Check
	ks := []string{CheckWarmth, CheckClass, CheckLevel}
	if p.Role == RoleBlacksmith || p.Key == KeySmith || p.Key == KeyMasterSmith {
		ks = []string{CheckItem, CheckWarmth, CheckClass, CheckLevel}
	}
	for _, k := range ks {
		cs = append(cs, CheckFor(p, ps, k, ctx))
	}
	// Rotate with how often you have talked so the offer changes.
	r := m.Talks % len(cs)
	return append(cs[r:], cs[:r]...)
}

// checkAsk is what you say to attempt a check.
func checkAsk(c Check, p Person, ctx Context) string {
	switch c.Kind {
	case CheckClass:
		switch c.Class {
		case ClassMage:
			return "I can feel something humming under this place. Can you?"
		case ClassArcher:
			return "I've been reading the tracks around here. Something has been walking the edge of town."
		case ClassLancer:
			return "I've held a line against worse than the dark. Is there something that needs holding?"
		}
		return "I've kept a blade sharp on a lot of roads. Anything that wants cutting?"
	case CheckWarmth:
		if merchantLike(p, ctx) {
			return "We're friends by now. Surely a friend gets a better price?"
		}
		return "You trust me by now. What aren't you telling everyone else?"
	case CheckLevel:
		return "I've seen worse than a few bandits. Where's the real danger?"
	}
	return "I carry sunsteel in my pack. Care to take a look?"
}

func merchantLike(p Person, ctx Context) bool {
	return ctx.Work.Shop
}

// ---- exits ----

// Player-voice goodbye lines, rotated.
var leaveLines = []string{"Take care.", "I should go.", "That's all for now. Thanks.", "Until next time.", "I'd better get moving."}
var leaveByRole = map[uint8][]string{
	RoleBlacksmith: {"Keep the fire hot."},
	RoleInnkeeper:  {"Save me a bed."},
	RoleGuard:      {"Keep the watch."},
	RoleFarmer:     {"Good luck with the crops."},
	RoleBounty:     {"I'll see you at the board."},
	RoleMerchant:   {"Good trade to you."},
}

// ExitChoice is the way out: a goodbye in your voice, different from visit
// to visit.
func ExitChoice(p Person, m Memory) Choice {
	pool := leaveLines
	if r := leaveByRole[p.Role]; len(r) > 0 && m.Talks%3 == 1 {
		pool = r
	}
	return Choice{Text: pick(pool, p.ID, uint64(m.Talks)+31), Kind: "leave", Tag: "Leave", Act: "bye"}
}

// MaxChoices is how many answers one node shows (the 1-6 keys).
const MaxChoices = 6

// Finish tags the choices and makes sure the way out is there, last, even if
// the list has to give up a lesser answer for it. Every node goes through it
// (idempotent), so no conversation can dead-end.
func Finish(cs []Choice, p Person, m Memory) []Choice {
	var out []Choice
	exit := false
	for _, c := range cs {
		if c.Kind == "leave" {
			if !exit {
				exit = true
				c.Tag = firstNonEmpty(c.Tag, "Leave")
				out = append(out, c)
			}
			continue
		}
		out = append(out, c)
	}
	// The way out goes last.
	var ex Choice
	if exit {
		for i, c := range out {
			if c.Kind == "leave" {
				ex = c
				out = append(out[:i], out[i+1:]...)
				break
			}
		}
	} else {
		ex = ExitChoice(p, m)
	}
	if len(out) > MaxChoices-1 {
		out = out[:MaxChoices-1]
	}
	for i := range out {
		if out[i].Tag == "" {
			out[i].Tag = tagOf(out[i])
		}
	}
	return append(out, ex)
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// tagOf is the default tag of a choice by what it does.
func tagOf(c Choice) string {
	act, arg, _ := strings.Cut(c.Act, ":")
	switch act {
	case "work":
		switch arg {
		case "shop":
			return "Barter"
		case "bounty":
			return "Work"
		case "rest":
			return "Rest"
		case "forge":
			return "Forge"
		}
	case "topic":
		if arg == "rumour" {
			return "Rumour"
		}
	case "mark":
		return "Mark"
	case "accept":
		return "Quest"
	case "haggle":
		return ""
	}
	if c.Kind == "rumour" {
		return "Rumour"
	}
	return ""
}

// ---- the lines you say, by what they do ----

func shopAsk(p Person) string {
	switch p.Role {
	case RoleBlacksmith:
		return "Show me what's on the anvil."
	case RoleInnkeeper:
		return "What's cooking? I'd like to see the menu."
	case RoleMerchant:
		return "Let's see your wares."
	}
	return "I'd like to buy something, if you've got it."
}

// chatAsk is the small-talk question for the role.
func chatAsk(p Person) string {
	switch p.Role {
	case RoleBlacksmith:
		return "How's the forge treating you?"
	case RoleInnkeeper:
		return "How's business?"
	case RoleBounty:
		return "Is the board keeping you busy?"
	case RoleGuard:
		return "Quiet watch?"
	case RoleFarmer:
		return "How's the land this year?"
	case RoleMerchant:
		return "How's trade?"
	}
	return "How are you holding up?"
}

// ---- what they say back, by temperament ----

// Work lines (they open the service): shop, bounty, rest, forge.
var workLines = [numTempers][4]string{
	Warm:     {"Take a look. Take your time, there's no hurry in my shop.", "There. Pick something kind to your knees.", "Sit, breathe, mend. The kettle's on.", "Mind your sleeves by the coals. Fire loves a good cuff."},
	Gruff:    {"Look, then. Buy or leave. Don't prod.", "There. Pick one you can finish.", "Beds are there. Boots off the blankets.", "Forge is hot. Touch nothing you can't pay for."},
	Nervous:  {"Oh, yes, of course, have a look! Everything's, um, mostly fine.", "Here, here. Maybe not the hard ones? Unless you like the hard ones.", "Rest! Yes. It's quiet here. Probably.", "Careful, it's very hot. I said very. Be careful."},
	Cheerful: {"Browse away, my friend! Every shelf is a story!", "Take your pick! Adventure, glory, mild danger!", "A rest, the best idea of the day! Put your feet up!", "Hammer time! Do you want a hammer? Please say yes."},
	Weary:    {"Have a look. I'll just lean here.", "The board's there. I'd read it myself but my eyes have retired.", "Take a bed. I'd join you, but someone has to stay upright.", "The forge is there. Try not to need me."},
	Gossipy:  {"Look, look! Everything has a history. Ask me about the lamp!", "Oh, the board! Half of these are about people you'd know if you lived here.", "Rest up. I'll be here, telling everyone what I think of your boots.", "Forge is yours. Don't let on I let you."},
	Wry:      {"Browse. I'll try to conceal my excitement.", "The board. It's where hope goes to be priced.", "A bed. It's soft. Compared to the road. Compared to most things.", "The forge. It bites. It's honest about it."},
	Proud:    {"Examine my wares. You will find nothing wanting.", "The board, and the good name behind it. Choose with care.", "Rest under a good roof. You do us honour.", "The forge is worthy of your hands. Show it so."},
}

func workIndex(kind string) int {
	switch kind {
	case "shop":
		return 0
	case "bounty":
		return 1
	case "rest":
		return 2
	}
	return 3
}

// WorkLine is what they say as the service opens.
func WorkLine(p Person, ps Persona, kind string) string {
	return workLines[ps.Temper][workIndex(kind)]
}

// Menu lines (what they say as you come back to the topics).
var menuLines = [numTempers][3]string{
	Warm:     {"What else is on your mind, dear?", "Go on, ask. I've time.", "Anything else? I like the company."},
	Gruff:    {"Well?", "Out with it, then.", "Something else, or are you leaving?"},
	Nervous:  {"Was there... something else? I'm listening. Mostly.", "Oh, you're still here! That's fine. Good. Fine.", "Another question? That's fine. I think."},
	Cheerful: {"What next? I love a next!", "Ask away, ask away!", "More? Wonderful. More is my favourite."},
	Weary:    {"Mm. What else?", "Go on. I'm still awake, probably.", "Another question. Sure."},
	Gossipy:  {"What else? There's always something else.", "Ooh, another question. Keep them coming.", "Go on, go on. I'm listening, and so is everyone else."},
	Wry:      {"Another question. How delightful.", "Do go on. I've nowhere important to be.", "What else would you like to take from me?"},
	Proud:    {"What more would you know?", "Speak. I'll answer as I see fit.", "You may continue."},
}

// MenuLine is the line over the topics when you come back to them.
func MenuLine(p Person, ps Persona, m Memory) string {
	return menuLines[ps.Temper][(p.ID+uint64(m.Talks))%3]
}

// Chat: the small talk, four per temperament, rotating as you ask again.
var chatLines = [numTempers][]string{
	Warm:     {"Better for the company. The days are long but there's always someone to look after, which helps.", "I can't complain. Well, I can, but I'd rather ask about you. How are your feet?", "Content. That's a word I didn't use when I was young, and now it's my favourite.", "Some days heavy, some light. Today's light. Today you walked in."},
	Gruff:    {"Working. That's how.", "Busy. Tired. Alive. Pick two and leave me the third.", "Complaining uses breath. I save mine.", "Fine. Don't make a fuss over it."},
	Nervous:  {"Oh, I'm... fine. Fine. You didn't hear anything outside, did you? No. No, of course not.", "I haven't slept. Not properly. The wind's been very... talkative.", "Holding up! Mostly! The shaking's just the cold. Probably the cold.", "Better now that someone's here. I mean, not you personally. Well, you personally. Is that rude?"},
	Cheerful: {"Magnificent! A bit sore, a bit hungry, but magnificent!", "Splendid! The sun came up. That's already two good things.", "Couldn't be better! Could be a little better with pie, but that's life!", "Fantastic. I've decided to be, so I am."},
	Weary:    {"Alive. Not much more to say on it.", "Tired. Properly tired, the bone kind. It'll pass or it won't.", "I've had better years. I've had worse. The worse ones were shorter.", "One foot, then the other. It's the whole secret."},
	Gossipy:  {"Oh, you know me, up to my elbows in everyone's business. It keeps the blood going!", "Brilliantly! Three people told me three different versions of the same quarrel. A good week.", "I'm marvellous, and I hear the baker's cousin isn't. Terrible shame. Ask me why.", "Busy! Rumour has a way of creating work. Anyway, how are you? Really?"},
	Wry:      {"Splendidly, in the way a bridge holds up a rainstorm.", "Fine. The usual mixture of fine and unrewarded.", "I'm holding. Whether that's up or out remains to be seen.", "Oh, you know. Thriving. The town thrives, I follow along behind it."},
	Proud:    {"Well. I do my part. Someone must keep standards, and I find it is usually me.", "I've had a long life of good work. Today is one more good day on the pile.", "Dignified. Sturdy. Ask anyone. Don't ask them in front of me.", "I hold my post and my head. Both are still up."},
}

// ChatLine is the small-talk answer.
func ChatLine(p Person, ps Persona, m Memory) string {
	return pick(chatLines[ps.Temper], p.ID, uint64(m.Talks)+101)
}

// Passing reactions: a first beat before the reward.
var passReact = [numTempers][]string{
	Warm:     {"Oh, now that's a good one. Come closer.", "I like how you ask. Here."},
	Gruff:    {"Hm. Fair. You've earned it.", "Right. Not just talk, then."},
	Nervous:  {"Oh! You, um, you can tell. All right. Lean in.", "Okay. Okay. I trust you. Mostly."},
	Cheerful: {"Ha! Now we're talking!", "Oh, you're good. I like you. Listen."},
	Weary:    {"Mm. That's enough for me. Listen.", "All right. You've done your share. Here."},
	Gossipy:  {"Ooh! Yes! Close the door, I don't care about the door, listen.", "I knew it! Right, this stays between us."},
	Wry:      {"Well, well. You're not decoration after all.", "That's more than most manage. Come here."},
	Proud:    {"You have standing. Hear it, then.", "You've shown worth. I'll answer in kind."},
}

// Failing refusals, in character: class, warmth, level, item.
var failLines = [numTempers][4]string{
	Warm:     {"Oh, sweet of you to ask, but that's a thing for a different sort of traveller. Ask me something else.", "I'd love to, but we're still getting to know each other. Stay a while and I will.", "That's no place for someone still growing into their boots. Come back stronger, I'll be here.", "That would take the right kind of metal, dear. Come back when you've got it."},
	Gruff:    {"Not you. Wrong sort. Next question.", "I don't know you well enough. Spend longer here.", "You'd die. Come back when you won't.", "Where's the proof? Words don't smelt."},
	Nervous:  {"Oh, no, I, that's... not really for your kind, I think? Sorry. Sorry!", "I can't! I mean, I shouldn't! We've only just met, haven't we? Sorry.", "You're not ready! I don't mean to be rude! But you're not!", "I, um, need to see it first. Sorry. The metal. Not you."},
	Cheerful: {"Ha, not your trade, friend! Ask me something I'm allowed to say!", "Ah, not yet! Friends first, secrets after! Stay for a while!", "Ha! A little more sword-practice first, I'd say. Come back when you're bigger!", "Bring me the shiny stuff and I'll be delighted! Not today though!"},
	Weary:    {"Wrong shoulders for it. Ask something else.", "I'm too tired to trust someone new. Another time.", "You'd not last the first hour. Level up, then ask.", "Show me the metal. Words weigh nothing."},
	Gossipy:  {"Ooh, it's not for your sort, love. Ask about the blacksmith instead, he's much worse.", "Give it time! A secret like that needs more than a handshake, and you've only had the one.", "I'd tell you if I thought you'd live to repeat it. Another few levels, darling.", "I'd like to see some shine first. Ask me again with proof."},
	Wry:      {"Alas, you appear to be the wrong shape for that.", "We've barely met. I'd hate to ruin the mystery.", "Come back when you're a little less fragile. It's meant as a compliment. Mostly.", "Prove it. I've heard the stories. I want the metal."},
	Proud:    {"That is not for you. Not yet, and not that path.", "We are not so close yet. Earn it.", "You are not ready, and I'd not send you to be buried.", "Show me the craft. I do not take claims on trust."},
}

func failIndex(kind string) int {
	switch kind {
	case CheckClass:
		return 0
	case CheckWarmth:
		return 1
	case CheckLevel:
		return 2
	}
	return 3
}

// classLore: what a mage, archer, lancer or knight is told that the rest are not.
var classLore = map[string][]string{
	ClassMage:   {"The hum under this valley is older than the town. Folk like you hear it as a pitch. The rest of us only feel it in our teeth. Stand still beside a tower and listen: it rings back.", "Staff or wand, mind what you spend. A mage burning bright by the walls draws the Unsung like a lantern does moths. Rest your mana before you rest yourself.", "The old keepers wrote that the Lodestone sings in every element. Whoever walks with spells walks closer to it. That's a gift. It's also a leash."},
	ClassArcher: {"Quiet feet, long sight. The Unsung come at the edge of the lantern light, and the one who sees them first lives. Walk the hills before dusk and learn where the cover is.", "Fletch your own if you can. A cheap arrow flies true until the day it matters. Sunsteel tips shine and the demons hate them.", "A bow reaches what a blade can't. High ground, then patience. Nothing I know of has ever beaten both."},
	ClassLancer: {"A spear holds the line. Keep your feet planted and your reach long, and the pack breaks on you like water. Hold at the gates at dusk and the town holds with you.", "Don't chase. A lancer who chases dies. A lancer who waits, and lets the thing run onto the point, goes home for supper.", "The old guard trained with spears for a reason: distance. The Unsung don't tire, but they do blunder."},
	ClassKnight: {"A sword wants a steady hand. Blades dull the second you doubt them, so don't. And never strike without a place to retreat to.", "Parry first, riposte second. The old knights taught it, and the ones who forgot are why we've graveyards.", "Whatever you carry, keep it clean and keep it near. A night's too long to learn how heavy a rusted blade is."},
}

// smithLore: what a sunsteel-carrier is told at the forge.
var smithLore = []string{
	"Sunsteel. Hold it up to the lantern: see the glow? It's not the metal. It remembers sun, and it won't rest in the hand of anything that's not alive. The Unsung hate it for that.",
	"You carry it well, and you've the look of someone who knows the weight of it. Keep it dry, keep it close. Work it at a proper forge and it'll sing back.",
	"Sunsteel's rare as a kind word from a tax collector. I'll tell you this: the folk who can work it are fewer each year, and I'd not waste a gram of it.",
}

// Perk: what a passed check does beside the words.
const (
	PerkDiscount = "discount" // arg: percent off their wares
	PerkBonus    = "bonus"    // arg: a better reward on the quest on offer
)

// Perks: a node can carry a reward the glue applies.
type Perk struct {
	Kind string
	Pct  int
}

// Discount applies a percentage off a price (at least 1 gold).
func Discount(price, pct int) int {
	if pct <= 0 {
		return price
	}
	return max(1, price*(100-pct)/100)
}

func checkReply(p Person, ps Persona, m *Memory, ctx Context, c Check) Node {
	n := Node{Mood: ps.Temper.Mood()}
	pass := c.Pass(ctx, *m)
	n.Check = &CheckResult{Tag: c.Tag(), Pass: pass}
	if !pass {
		n.Line = failLines[ps.Temper][failIndex(c.Kind)]
		n.Mood = "stern"
		return n
	}
	react := pick(passReact[ps.Temper], p.ID, uint64(m.Talks)+7)
	first := m.Hear("t:" + topicOfCheck(c))
	switch c.Kind {
	case CheckClass:
		n.Line = react + " " + pick(classLore[c.Class], p.ID, uint64(m.Talks)+13)
	case CheckItem:
		n.Line = react + " " + pick(smithLore, p.ID, uint64(m.Talks)+17)
		n.Perk = &Perk{Kind: PerkDiscount, Pct: 15}
		n.Line += " Here: fifteen off, for one who respects the metal."
	case CheckWarmth:
		if merchantLike(p, ctx) {
			n.Line = react + " Ten off, then, for a friend. Don't tell the other customers."
			n.Perk = &Perk{Kind: PerkDiscount, Pct: 10}
			break
		}
		// A secret: the rarest place nearby, else something they have kept to themselves.
		if r, ok := PickRumourOf(p, ps, *m, ctx.Sites, rareKinds); ok {
			m.Hear(RumourKey(r.Key))
			n.Line = react + " " + r.Text
			n.Rumour = &r
			if r.Pos {
				n.Choices = append(n.Choices, Choice{Text: "Mark that on my map, would you?", Kind: "mark", Act: "mark:" + r.Key})
			}
		} else if !m.Has("t:secret") {
			m.Hear("t:secret")
			n.Line = react + " " + ps.Secret
		} else {
			n.Line = react + " I've nothing left that I haven't told you. That's what friendship costs, in the end."
		}
	case CheckLevel:
		if r, ok := PickRumourOf(p, ps, *m, ctx.Sites, dangerKinds); ok {
			m.Hear(RumourKey(r.Key))
			n.Line = react + " " + r.Text
			n.Rumour = &r
			if r.Pos {
				n.Choices = append(n.Choices, Choice{Text: "Mark that on my map, would you?", Kind: "mark", Act: "mark:" + r.Key})
			}
		} else {
			n.Line = react + " I've nothing dangerous left to point you at. You've cleared the neighbourhood, or I've told you everything."
		}
	}
	_ = first
	return n
}

var rareKinds = []string{KindVault, KindShrine, KindPalace, KindDwarf, KindSky, KindTower}
var dangerKinds = []string{KindBandit, KindShaft, KindShrine, KindVault, KindPalace, KindDwarf, KindCave}

// PickRumourOf is PickRumour over the sites of some kinds.
func PickRumourOf(p Person, ps Persona, m Memory, sites []Site, kinds []string) (Rumour, bool) {
	var sel []Site
	for _, s := range sites {
		for _, k := range kinds {
			if s.Kind == k {
				sel = append(sel, s)
				break
			}
		}
	}
	return PickRumour(p, ps, m, sel)
}

// ---- parting words ----

var partLines = [numTempers][]string{
	Warm:     {"Careful out there, {name}!", "Come back safe, you hear?", "Off so soon? Safe roads!"},
	Gruff:    {"Hm. Fine. Go, then.", "Rude. But fine.", "Mind the road."},
	Nervous:  {"Oh! You're going! Be careful!", "Wait, no, that's fine. Go. Go safely!", "Please stay in the light!"},
	Cheerful: {"Off you go! Bring stories back!", "Cheerio! The road's lucky to have you!", "Bye, bye! Tell the hills I said hello!"},
	Weary:    {"Mm. Safe travels.", "Go on, then. I'll be here.", "Mind yourself."},
	Gossipy:  {"Leaving already?! I hadn't even got to the good part!", "Come back and tell me everything!", "Off you go! I'll tell them you said goodbye!"},
	Wry:      {"Oh. Leaving mid-sentence. Bold.", "Farewell, I suppose. Don't be a cautionary tale.", "Do come back. Or don't. I'll cope."},
	Proud:    {"Go well, then.", "Our talk is unfinished. Another day.", "Farewell. Walk with purpose."},
}

// PartingLine is what they call after you when you walk away mid-talk.
func PartingLine(p Person, ps Persona, m Memory, player string) string {
	return fill(pick(partLines[ps.Temper], p.ID, uint64(m.Talks)+211), p, player)
}

// ---- the menu's extra answers ----

// checkChoices builds the check answers the person offers now (at most n).
func checkChoices(p Person, ps Persona, m Memory, ctx Context, n int) []Choice {
	var out []Choice
	for _, c := range offeredChecks(p, ps, m, ctx) {
		if len(out) >= n {
			break
		}
		if c.Kind == CheckItem && !ctx.Char.Sunsteel && m.Talks%2 == 1 {
			continue // the smith offers the sunsteel question every other visit unless you carry some
		}
		out = append(out, Choice{Text: checkAsk(c, p, ctx), Kind: "check", Tag: c.Tag(), Low: !c.Pass(ctx, m), Act: "topic:" + topicOfCheck(c)})
	}
	return out
}

// checkOf finds the check behind a "ck-..." topic.
func checkOf(p Person, ps Persona, ctx Context, topic string) (Check, bool) {
	k, ok := strings.CutPrefix(topic, "ck-")
	if !ok {
		return Check{}, false
	}
	switch k {
	case CheckClass, CheckWarmth, CheckLevel, CheckItem:
		return CheckFor(p, ps, k, ctx), true
	}
	return Check{}, false
}
