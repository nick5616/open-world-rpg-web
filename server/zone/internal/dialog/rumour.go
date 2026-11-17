package dialog

import (
	"fmt"
	"math"
	"strings"
	"unicode"
)

// Rumour kinds: what a person can point you at. The glue fills Sites from the
// atlas and the zone's own state; every site is real.
const (
	KindCave     = "cave"
	KindShaft    = "mineshaft"
	KindDwarf    = "dwarf"
	KindBandit   = "bandit"
	KindTower    = "tower"
	KindSky      = "sky"
	KindPalace   = "palace"
	KindShrine   = "shrine"
	KindVault    = "vault"
	KindHerb     = "herb"
	KindFish     = "fish"
	KindStable   = "stable"
	KindEvent    = "event"
	KindLandmark = "landmark"
)

// Site is a real place near the person that the player may not have been to.
type Site struct {
	Kind   string
	Key    string // stable id ("site:123"): what "heard it" remembers
	Name   string // "" unnamed
	X, Z   float64
	NoPos  bool    // no place to mark (a happening with no spot)
	DX, DZ float64 // offset from the person (m)
	Done   bool    // the player has been, cleared, attuned, opened it...
	Detail string  // extra words (an event's description)
}

// Dist is how far from the person.
func (s Site) Dist() float64 { return math.Hypot(s.DX, s.DZ) }

// Rumour is what they tell you.
type Rumour struct {
	Key  string
	Kind string
	Text string
	Name string
	X, Z float64
	Pos  bool // there is somewhere to put a marker
}

var rumourTexts = map[string][]string{
	KindCave:     {"there's a cave mouth {where}{named}. Folk say it goes deeper than it should. Bring a torch.", "an old cave {where}{named} breathes cold air on warm days. Something down there is exhaling.", "there's a cave {where}{named} nobody has properly mapped. I'd go myself, if I were twenty years younger and less sensible."},
	KindShaft:    {"there's an old mineshaft {where}{named}, with a winch and a long rope. Folk drop pebbles down it and never hear them land.", "the miners left a shaft {where}{named}. They left in a hurry, and they left their lanterns.", "a shaft goes down {where}{named}. It connects to caves, if the stories are true. Mind the rope."},
	KindDwarf:    {"dwarves have dug in {where}{named}. Hard folk, honest in trade, and they hate being called short.", "there's a dwarven hold {where}{named}. Their forge work is the best you'll see this side of the world. They won't say so. They won't need to.", "the dwarves keep halls {where}{named}. Go carefully, ask politely and don't touch the walls."},
	KindBandit:   {"bandits have made a camp {where}{named}. They've been robbing the road. Somebody with a blade and a plan could clear it, and there's coin in it.", "there's a bandit camp {where}{named}. Smoke by day, laughter by night. I'd like both to stop.", "a gang's holed up {where}{named}. The carters won't go past it, and the carters will go past anything."},
	KindTower:    {"there's a tower {where}{named} with a crystal at the top that hums when you stand close. Climb it, and the map opens like a tablecloth.", "an old tower stands {where}{named}. The keepers called them forks, you know, tuning forks. Touch the crystal and listen.", "a tower {where}{named} that nobody's climbed in years. The view is meant to be worth every handhold."},
	KindSky:      {"folk swear there's an island floating in the sky {where}{named}. I'd not have believed it, but I've seen its shadow.", "a piece of land hangs in the air {where}{named}. If you could get up there, you'd be the first of us to walk on a cloud.", "some say a floating island drifts {where}{named}. A glider might get you close. A fool might get you the rest of the way."},
	KindPalace:   {"there's a palace in the sky {where}{named}. Halls, towers, a ward on the door. The old ones built it and then left, or never left.", "they say a sky palace sleeps {where}{named}. It wakes for those who earn it. I'd start by looking up."},
	KindShrine:   {"deep under the world there's a shrine {where}{named}, where demons gather in waves. The wards flicker down there. Not a place for the careless.", "a shrine in the Depths {where}{named} keeps drawing the Unsung. Cleanse it and the dark gives a little ground."},
	KindVault:    {"there's a sealed vault {where}{named}. Riddles on the door and keepers inside. Fortunes for the clever, and a long climb for the rest.", "an old vault lies {where}{named}. The wardens sealed it with riddles the Unsung can't answer. You might do better."},
	KindHerb:     {"there's a patch of good herbs {where}{named}. Nobody's picked it clean. Not yet.", "a herb patch grows {where}{named}, thick and untouched. Good for potions. Good for the purse."},
	KindFish:     {"there's a lovely fishing spot {where}{named}: still water, deep shadows and fish the size of your leg. Bring a rod.", "{where}{named}, the water goes dark and quiet, the way fish like it. Some say a legend lives there."},
	KindStable:   {"there's a stable {where}{named} with a steed to be had, if you've the coin and a gentle hand. Walking is for people with time.", "a steed merchant keeps a yard {where}{named}. Ride into the next valley before breakfast. Folk do."},
	KindEvent:    {"something is happening {where}{named}. Go and see. {detail}", "there's a stir {where}{named}. Folk are running toward it, or away. {detail}"},
	KindLandmark: {"there's something worth the walk {where}{named}. I won't spoil it.", "a landmark rises {where}{named}. Everyone's seen it. Hardly anyone's visited."},
}

var tempFrame = [numTempers][2]string{
	Warm:     {"since you ask, ", ""},
	Gruff:    {"", " Don't make me regret telling you."},
	Nervous:  {"I shouldn't say, but ", " Please don't tell anyone it was me."},
	Cheerful: {"oh, you'll love this: ", " Isn't that grand?"},
	Weary:    {"hm. ", " That's all I know. I'd go myself, but my feet disagree."},
	Gossipy:  {"between us, ", " But you didn't hear it from me."},
	Wry:      {"well, ", " Do try to come back."},
	Proud:    {"few know this, but ", " I wouldn't tell just anyone."},
}

// roleLikes: the places each role talks about first.
var roleLikes = map[uint8][]string{
	RoleBlacksmith: {KindCave, KindShaft, KindDwarf, KindVault},
	RoleGuard:      {KindBandit, KindShrine, KindTower},
	RoleFarmer:     {KindHerb, KindFish, KindStable},
	RoleInnkeeper:  {KindEvent, KindFish, KindTower, KindStable},
	RoleMerchant:   {KindStable, KindDwarf, KindVault, KindCave},
	RoleBounty:     {KindBandit, KindDwarf, KindShrine, KindSky, KindPalace},
	RoleVillager:   {KindTower, KindHerb, KindFish, KindLandmark},
}

func likes(role uint8, kind string) bool {
	for _, k := range roleLikes[role] {
		if k == kind {
			return true
		}
	}
	return false
}

// RumourKey is what Memory.Hear records for a rumour about site key.
func RumourKey(siteKey string) string { return "r:" + siteKey }

// PickRumour chooses what p tells m next: a real nearby place the player has
// not done and has not already been told about, nearest first with a role
// bias and a per-person jitter so two townsfolk point at different things.
// ok = false when there is nothing (left) to tell.
func PickRumour(p Person, ps Persona, m Memory, sites []Site) (Rumour, bool) {
	best, bs := -1, math.Inf(1)
	for i, s := range sites {
		if s.Done || m.Has(RumourKey(s.Key)) {
			continue
		}
		sc := s.Dist() + float64(mix(p.ID^hstr(s.Key))%400)
		if likes(p.Role, s.Kind) {
			sc -= 450
		}
		if sc < bs {
			best, bs = i, sc
		}
	}
	if best < 0 {
		return Rumour{}, false
	}
	return tell(p, ps, sites[best]), true
}

func tell(p Person, ps Persona, s Site) Rumour {
	tx := rumourTexts[s.Kind]
	if len(tx) == 0 {
		tx = rumourTexts[KindLandmark]
	}
	t := pick(tx, p.ID, hstr(s.Key))
	where := DistWord(s.Dist()) + " " + compassWord(s.DX, s.DZ)
	if s.NoPos || s.Dist() < 1 {
		where = "nearby"
	}
	named := ""
	if s.Name != "" {
		named = ", " + s.Name
	}
	t = strings.NewReplacer("{where}", where, "{named}", named, "{detail}", s.Detail).Replace(t)
	t = strings.TrimSpace(t)
	fr := tempFrame[ps.Temper]
	t = fr[0] + t + fr[1]
	if fr[0] == "" || strings.HasSuffix(strings.TrimSpace(fr[0]), ".") {
		t = upperFirst(t)
	}
	return Rumour{Key: s.Key, Kind: s.Kind, Text: upperFirst(t), Name: s.Name, X: s.X, Z: s.Z, Pos: !s.NoPos}
}

func upperFirst(s string) string {
	for i, r := range s {
		return string(unicode.ToUpper(r)) + s[i+len(string(r)):]
	}
	return s
}

// NoRumour is what they say when they have nothing new.
func NoRumour(p Person, ps Persona) string {
	switch ps.Temper {
	case Gossipy:
		return "Honestly? You've heard it all from me. I'm as surprised as you are. Come back after the next market and I'll have something."
	case Gruff:
		return "Nothing you haven't heard. Go and find something yourself."
	case Nervous:
		return "No. Nothing. Well, nothing I'd... no. Nothing."
	case Wry:
		return "I've told you everything interesting I know, which is about as much as I know."
	}
	return fmt.Sprintf("I've told you all I know hereabouts, truly. Go and see for yourself. %s", pick([]string{"The world's bigger than my stories.", "Folk like you make the next story.", "Come back with one of your own."}, p.ID, 9))
}
