// Package dialog is the zone's conversation engine with townsfolk (playtest
// 4, CR 049). It is pure: no clocks, no randomness beyond hashes of the
// ids it is given, no I/O. The game glue (internal/game/dialog.go) feeds it
// who is talking (Person), what the world looks like to this player right
// now (Context), what this player remembers of this person (Memory) and the
// real places nearby (Site candidates for rumours); it answers with a Node:
// a line and the choices under it.
//
// Every person gets a Persona (a temperament, a quirk and a small backstory)
// generated from their id, role and settlement out of the pools below, so two
// townsfolk in one town rarely sound alike; the handful of characters the
// starting town and the main story name get hand-written voices (keys.go).
package dialog

import "strings"

// Roles mirror server/pkg/towns (the package does not import it so it stays
// a leaf; the glue converts).
const (
	RoleVillager   = 0
	RoleMerchant   = 1
	RoleBlacksmith = 2
	RoleInnkeeper  = 3
	RoleBounty     = 4
	RoleFarmer     = 5
	RoleGuard      = 6
)

var roleWord = [7]string{"villager", "merchant", "blacksmith", "innkeeper", "bounty keeper", "farmer", "guard"}

// RoleWord is the role's name.
func RoleWord(r uint8) string {
	if int(r) < len(roleWord) {
		return roleWord[r]
	}
	return "villager"
}

// Temper is a temperament.
type Temper uint8

// The temperaments.
const (
	Warm Temper = iota
	Gruff
	Nervous
	Cheerful
	Weary
	Gossipy
	Wry
	Proud
	numTempers
)

var temperName = [numTempers]string{"warm", "gruff", "nervous", "cheerful", "weary", "gossipy", "wry", "proud"}

func (t Temper) String() string {
	if t < numTempers {
		return temperName[t]
	}
	return "warm"
}

// upbeat temperaments see the weather and the world kindly.
func (t Temper) upbeat() bool { return t == Warm || t == Cheerful || t == Gossipy || t == Proud }

// Mood hints the client turns into a gesture (nod, shrug, lean in...).
func (t Temper) Mood() string {
	switch t {
	case Warm:
		return "warm"
	case Gruff:
		return "stern"
	case Nervous:
		return "uneasy"
	case Cheerful:
		return "bright"
	case Weary:
		return "tired"
	case Gossipy:
		return "lean"
	case Wry:
		return "wry"
	}
	return "proud"
}

// Near is a neighbouring settlement: its name and where it lies from here
// (metres, +x east, +z south: worldgen's frame).
type Near struct {
	Name   string
	DX, DZ float64
}

// Person is who is talking.
type Person struct {
	ID         uint64
	Name       string
	Role       uint8
	Town       string // settlement name ("" unknown)
	Region     string // region name ("" unknown)
	Dwarven    bool   // a dwarven hall (CR 043): its own voice
	Key        string // a hand-written character (keys.go), "" none
	Neighbours []Near // nearest first, at most a few
}

// Persona is the person under the name.
type Persona struct {
	Temper Temper
	Quirk  string // a habit, in their own words
	Family string
	Origin string
	Wants  string
	Secret string
}

func mix(x uint64) uint64 {
	x += 0x9E3779B97F4A7C15
	x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9
	x = (x ^ (x >> 27)) * 0x94D049BB133111EB
	return x ^ (x >> 31)
}

func hstr(s string) uint64 {
	h := uint64(14695981039346656037)
	for i := 0; i < len(s); i++ {
		h = (h ^ uint64(s[i])) * 1099511628211
	}
	return h
}

// pick chooses one of list by hash h and a salt ("" for an empty list).
func pick(list []string, h, salt uint64) string {
	if len(list) == 0 {
		return ""
	}
	return list[mix(h^salt*0xD6E8FEB86659FD93)%uint64(len(list))]
}

// PersonaOf is the deterministic persona of p. Role and hall bias the
// temperament a little (guards lean gruff and proud, innkeepers warm and
// gossipy); the rest is the id. A key character keeps its hand-written
// temperament and lines (keys.go).
func PersonaOf(p Person) Persona {
	h := mix(p.ID ^ hstr(p.Town)*31 ^ uint64(p.Role)<<56)
	w := [numTempers]int{4, 3, 3, 4, 3, 3, 3, 3}
	switch p.Role {
	case RoleGuard:
		w[Gruff] += 3
		w[Proud] += 2
		w[Nervous]--
	case RoleInnkeeper:
		w[Warm] += 3
		w[Gossipy] += 3
	case RoleMerchant:
		w[Cheerful] += 2
		w[Wry]++
		w[Gossipy]++
	case RoleBlacksmith:
		w[Gruff] += 2
		w[Proud] += 2
	case RoleFarmer:
		w[Weary] += 2
		w[Warm]++
	case RoleBounty:
		w[Wry] += 2
		w[Weary]++
	}
	if p.Dwarven {
		w[Gruff] += 4
		w[Proud] += 2
		w[Wry]++
		w[Cheerful] -= 2
		w[Nervous] -= 2
	}
	sum := 0
	for _, x := range w {
		sum += x
	}
	r := int(mix(h^0x11) % uint64(sum))
	t := Temper(0)
	for i, x := range w {
		if r < x {
			t = Temper(i)
			break
		}
		r -= x
	}
	ps := Persona{Temper: t}
	if p.Dwarven {
		ps.Quirk = pick(dwarfQuirks, h, 2)
		ps.Family = pick(dwarfFamilies, h, 3)
		ps.Origin = pick(dwarfOrigins, h, 4)
		ps.Wants = pick(dwarfWants[p.Role%7], h, 5)
		ps.Secret = pick(dwarfSecrets, h, 6)
	} else {
		ps.Quirk = pick(quirks, h, 2)
		ps.Family = pick(families, h, 3)
		ps.Origin = pick(origins, h, 4)
		ps.Wants = pick(wants[p.Role%7], h, 5)
		ps.Secret = pick(secrets, h, 6)
	}
	if k, ok := keyChars[p.Key]; ok {
		ps.Temper = k.Temper
		if k.Quirk != "" {
			ps.Quirk = k.Quirk
		}
		if k.Family != "" {
			ps.Family = k.Family
		}
		if k.Origin != "" {
			ps.Origin = k.Origin
		}
		if k.Wants != "" {
			ps.Wants = k.Wants
		}
		if k.Secret != "" {
			ps.Secret = k.Secret
		}
	}
	return ps
}

// fill expands {me} {town} {region} {name} in a template.
func fill(s string, p Person, player string) string {
	if !strings.Contains(s, "{") {
		return s
	}
	town := p.Town
	if town == "" {
		town = "this place"
	}
	region := p.Region
	if region == "" {
		region = "these parts"
	}
	if player == "" {
		player = "friend"
	}
	return strings.NewReplacer("{me}", p.Name, "{town}", town, "{region}", region, "{name}", player).Replace(s)
}

var quirks = []string{
	"I count my steps. Always have. Four hundred and twelve from here to the well.",
	"I talk to the weather. It never listens, but it never argues either.",
	"I can't start a day without something hot in my hands. Tea, soup, a stolen pie.",
	"I hum when I think, and I'm told it's the same three notes. I can't hear it.",
	"I keep a pebble in my pocket from every place I've been. Heavy coat, light conscience.",
	"I never trust a quiet dog. Loud ones are honest.",
	"I name every crow that visits. That one is Gerald. Gerald owes me a button.",
	"I read the clouds. I'm wrong about half the time, and loud about it every time.",
	"I can't pass a puddle without checking my reflection. The face hasn't improved.",
	"I save the heels of every loaf. Someone will want them. Eventually.",
	"I tap the doorframe three times when I leave a room. Don't ask. It works.",
	"I sleep with one boot on. You never know when you'll have to run.",
	"I whistle at the dusk lanterns as they light. They've never whistled back, but I'm patient.",
	"I carry a little wooden spoon everywhere. For soup emergencies.",
}

var families = []string{
	"My sister runs the busiest stall at the market, and her son is convinced he'll be a knight. He's nine and afraid of geese.",
	"There's just me and an old cat who thinks she owns the place. She has a point.",
	"I have a husband, two daughters and a roof that leaks over the youngest's bed. We move her bed. The roof wins.",
	"My brother went off to see the world and sends a letter every spring. It's always about food.",
	"My mother lives upstairs and has an opinion about everything I do. It's good for me, apparently.",
	"My wife and I have been married thirty years. Neither of us remembers who proposed. Neither will back down.",
	"I lost my folks young, but the whole street raised me, and every one of them took credit.",
	"I've three nephews who visit on feast days and eat everything that isn't nailed down.",
	"My father taught me the trade and never once said I did it right. Best compliment I ever got.",
	"My cousin and I haven't spoken in six years over a goat. It was a very good goat.",
}

var origins = []string{
	"I came here years back from a river town to the south. Couldn't tell you why I stayed. The bread, mostly.",
	"Born three doors down. I've been all the way to the edge of the fields once. Wasn't impressed.",
	"I walked in from the hills the autumn the wells went bitter, meaning to stay a night. That's a lot of nights ago.",
	"My family came from the coast. We still say the sea is just around the corner, though it's a hundred leagues off.",
	"I was a caravan driver once. You get a feel for places. This one felt like a good place to put the wheels down.",
	"Grew up on a farm past the ridge. The soil was stubborn and so was I; we parted friends.",
	"I came for a wedding and stayed for the soup. Never did make it to the wedding, to be honest.",
	"I'm from a mining camp up north, long since quiet. You never lose the habit of watching ceilings.",
	"I washed up here after a long road with nothing but a good coat. The coat's gone. The road ended.",
	"I was a shepherd's apprentice. Sheep teach you patience and nothing else, and here I am, patient.",
}

var wants = [7][]string{
	{"I'd like to see the sea once, before my knees decide otherwise.", "I want a proper garden, a real one with a fence and no crows.", "I'd like the lanterns to stay lit all night, every night, without anyone getting hurt for it.", "A quiet life. Is that so much? Apparently it is."},
	{"I want to open a second stall, with a roof. A roof! Imagine.", "I'm saving for a cart with four good wheels. Three wheels is a lifestyle, not a plan.", "I'd love to meet a trader with honest scales. I'd marry them. Or at least do business.", "One day I'd like a customer who doesn't haggle. Just once. As an experience."},
	{"I want to forge something that outlasts me. A blade, a bell, anything with a true edge.", "Starmetal. I'd give a year's work to hold some, just once.", "I want an apprentice with patient hands. They're rarer than good iron.", "I'd like one night's sleep without the forge in it."},
	{"I want a full house on a feast night, singing, and nobody breaking my chairs.", "I dream of a cellar that never runs dry, a roof that never drips and a cat that never sheds.", "I'd like to hear the old song in full, just once. Nobody remembers all the verses.", "I want every guest to leave better than they came. It's a small ambition. It costs me a lot of bread."},
	{"I'd like a month where the board comes down empty. A whole month of nothing to hire anyone for.", "I want to retire somewhere with no map on the wall.", "I'd like to know every one of the folk who took my jobs came home. I keep a count. I don't like the number.", "A decent clerk. I'm drowning in ledgers."},
	{"I want rain on time, for once, and the crows to take a holiday.", "A good harvest and a good year in the same breath. It happens, I'm told.", "I'd like my boots to dry. The marsh in spring is my only enemy.", "I want my daughter to see the harvest feast with her own eyes, not through a shutter."},
	{"I want a posting without anything strange in it. Just a gate and a lantern.", "I'd like to hang up this spear and take up pottery. Don't laugh.", "I want to be the one who sees the dawn after the longest night, standing. That's all.", "I want to be good enough that nobody has to find out what I'd do if I failed."},
}

var secrets = []string{
	"Between us: I'm frightened of the dark. Not the night, the dark. The kind in cellars. I light a candle in every room I'm alone in.",
	"I once found a coin purse on the road and kept it. I've been paying it back a little at a time, as anonymous gifts. Don't tell the baker where his extra loaves come from.",
	"I write songs. Awful ones. I burn them in the stove. The house is very warm.",
	"I never learned to read. I memorise everything. Please don't tell anyone; I can smell a lie a mile off, but I can't read a sign.",
	"I'm the one who leaves the apples on the old widow's step. She thinks it's a ghost. I've let her.",
	"I've never told a soul, but I've been planning to leave. Not now. Someday. It helps to have somewhere to leave to.",
	"I think the demons are lonely. I've no proof. It's just the way they stand at the edge of the lanterns, watching.",
	"There's a path behind the old mill nobody walks. I do, some evenings. It's the only place I can hear myself think.",
}

var dwarfQuirks = []string{
	"I knock on every wall I pass. Stone talks, if you ask it nicely.",
	"I can tell a hall's age by the smell of its dust.",
	"I keep a hammer under my pillow. Not for fighting. For comfort.",
	"I haven't seen the sun since last spring. Not missing it. Much.",
	"I count the cracks in every ceiling. This one has seven. It had six yesterday.",
	"I never sit with my back to a tunnel. Old habit. Old tunnels.",
}

var dwarfFamilies = []string{
	"My brothers work the forge and the lower shafts. We meet at supper and argue about iron.",
	"My wife digs deeper than any of us, and comes home with better stories. And better ore.",
	"I've a daughter who wants to see the surface. I tell her it's just a very big ceiling. She doesn't believe me.",
	"My father's father cut half these steps. I cut a dozen of my own. That's the family trade.",
}

var dwarfOrigins = []string{
	"Born in this hall, in the room past the second arch. I'll be buried in the wall beside it, as is proper.",
	"I came down from a hall further east. Their forge went cold. Ours is warm, and so was the welcome. Eventually.",
	"I dug my way here, as it happens. A cave-in, a wrong turn, a very long tunnel. Stayed for the stew.",
	"My clan settled here before the Deep Road was cut. We're older than the beams, and we remind everyone.",
}

var dwarfWants = [7][]string{
	{"A hall with a window. One. Just to see what the fuss is about.", "A good stone to carve my name in."},
	{"A shipment of clean iron and a customer who knows the difference.", "A shelf big enough for what I'm owed."},
	{"One bar of starmetal. That's all. One. And a long, quiet week.", "To forge a door that never needs oiling."},
	{"A cellar that stays cool and a fire that stays warm.", "A song in the hall that isn't about mushrooms."},
	{"A board with no job on it about the lower halls.", "An end to the noise below."},
	{"A mushroom that grows in daylight. Heresy, I know.", "Glowworms that obey. Any command at all."},
	{"A quiet watch, and a visitor who doesn't need rescuing.", "To hear the great door close without a worry."},
}

var dwarfSecrets = []string{
	"I hear something at night through the floor. Not a creature. A voice, humming one note. I've told no one.",
	"Between us: I've never been past the second gate. I tell everyone I have. It's a long way down.",
	"I think my grandfather left a map in the wall of the east hall. I haven't had the nerve to look.",
}
