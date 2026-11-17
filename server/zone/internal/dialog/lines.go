package dialog

import (
	"fmt"
	"math"
	"strings"
)

// Greetings by temperament: a first meeting and a meeting after that (they
// use your name once met). {me} is the NPC, {name} the player.
var greetFirst = [numTempers][]string{
	Warm:     {"Well, hello there. I don't think we've met. I'm {me}.", "Welcome, welcome. You look like someone who's walked a long way.", "A new face! Come closer, I don't bite. Hard."},
	Gruff:    {"Hm. Stranger. State your business.", "You're new. Don't touch anything and we'll get along.", "Yes? Make it quick, I've work waiting."},
	Nervous:  {"Oh! Hello. You startled me. I'm, um, {me}. Not that you asked.", "Is that... are you friendly? You look friendly. Probably friendly.", "Hello. Yes. Hello. Sorry. It's been a long week."},
	Cheerful: {"Hello, hello, hello! A new traveller! Today's already better.", "Well, look who's wandered in! I'm {me}, and I'm delighted.", "Ha! A fresh face! Sit, stand, wave, I don't mind which."},
	Weary:    {"Oh. Hello. Pardon me, I've been on my feet since before the rooster.", "Another traveller. Good. Someone should be going places.", "Hm? Yes. Hello. I'm {me}. Ask quickly, I might nod off."},
	Gossipy:  {"Ooh, a stranger! Come here, come here, tell me everything. I'm {me}.", "Well! I haven't seen you before, and I see everyone. Where are you from?", "A new face, and a good coat. You've got a story, I can tell."},
	Wry:      {"Another adventurer. How lovely. I'll try to contain my joy.", "Ah, a stranger with a sword. We don't get many of those. Daily.", "Hello. I'm {me}. Yes, that's really my name; no, I won't be changing it."},
	Proud:    {"Greetings, traveller. You stand in {town}, which is more than most can say.", "Ah. A visitor. You'll find {town} has much to be proud of.", "Well met. I'm {me}, and I've been at this a long time. Ask what you like."},
}

var greetMet = [numTempers][]string{
	Warm:     {"{name}! Good to see you again. Come in, sit, tell me how you've been.", "Oh, {name}, there you are. I was hoping you'd stop by.", "Well, if it isn't {name}. You look well. Tired, but well."},
	Gruff:    {"{name}. Back again. What now?", "Ah. {name}. You're not bleeding, so that's something.", "{name}. Good. Hm. What is it?"},
	Nervous:  {"{name}! Oh, thank goodness, it's you. I thought it might be... never mind.", "Ah, {name}. Hello. You're, um, still in one piece. Good. That's good.", "{name}! You came back. People don't, usually. I mean, not that... hello."},
	Cheerful: {"{name}! My favourite visitor! Don't tell the others.", "Look who's back! {name}! The day just got a lot better.", "{name}, my friend! How's the road? Tell me everything, or at least the funny parts."},
	Weary:    {"{name}. Hello again. You're looking livelier than me. That's easy.", "Oh, {name}. Good. A friendly face is a rare sight today.", "Hm, {name}. Pull up a stool, if you can find one that isn't broken."},
	Gossipy:  {"{name}! You won't believe what I heard since last time. Well, you will, but still.", "{name}! Oh, I was just talking about you. Kindly! Mostly.", "Ah, {name}, my dear, the very person. I've news. I always have news."},
	Wry:      {"{name}. You're back. The suspense was killing me. Not really.", "Ah, {name}. Still alive. I owe someone a coin.", "{name}. Always a pleasure. That's mostly true."},
	Proud:    {"{name}. {town} remembers its friends. What can I do for you?", "Ah, {name}. Back in {town}. Good. You always did have taste.", "{name}! Well met again. Your name is spoken here, you know."},
}

var farewells = [numTempers][]string{
	Warm:     {"Take care of yourself out there. Come back safe.", "Safe roads, {name}. And eat something."},
	Gruff:    {"Off with you, then.", "Mind yourself. Don't die. It's untidy."},
	Nervous:  {"Oh, you're going? Be careful. Careful. Please.", "Goodbye! Stay away from the dark. And, you know, things."},
	Cheerful: {"Off you pop! Bring me a story when you're back!", "Cheerio! Tell the road I said hello!"},
	Weary:    {"Go on, then. I'll be here. I'm always here.", "Safe travels. I'd come with you but my feet have filed a complaint."},
	Gossipy:  {"Come back soon and tell me everything! Everything!", "Off you go, then! I'll just tell the others about you. Kindly."},
	Wry:      {"Farewell. Try not to become a cautionary tale.", "Goodbye. Do come back, I haven't been entertained since spring."},
	Proud:    {"Go well, {name}. {town} will keep your seat warm.", "Farewell. May your road be worthy of you."},
}

// Farewell is the goodbye line.
func Farewell(p Person, ps Persona, m Memory, player string) string {
	return fill(pick(farewells[ps.Temper], p.ID, uint64(m.Talks)+77), p, player)
}

// ---- remarks: the thing they notice about the world or about you ----

// Context is the world as this player meets it (the glue builds it).
type Context struct {
	Player  string
	Level   int
	Gear    int // 0 nothing wielded, 1 basic, 2 good, 3 great
	Hour    float64
	Day     int
	Weather string // weather.StateKeys: clear, cloudy, windy, fog, drizzle, rain, thunderstorm, snow, snowstorm, heat_haze, sandstorm
	Night   bool
	Defense bool // a night defense is running at this town
	Open    bool // the person's service is open (daytime for most)
	Event   string
	Act     int // the main story act the player is on (0 not started, 7 beaten)
	Deeds   []Deed
	Sites   []Site // real places nearby, for rumours
	Work    Work   // what this person can do for you
}

// Deed is something the zone knows this player did.
type Deed struct {
	Kind string // camp, tower, warden, vault, beaten, boss
	Name string
}

// Work is the services the person offers (the glue knows what's open).
type Work struct {
	Shop    bool
	Bounty  bool
	Rest    bool
	Forge   bool
	ShopWhy string // "wares" label hint
}

func timeWord(h float64) string {
	switch {
	case h < 5 || h >= 21:
		return "night"
	case h < 11:
		return "morning"
	case h < 17:
		return "day"
	}
	return "evening"
}

func weatherGroup(w string) string {
	switch w {
	case "drizzle", "rain":
		return "rain"
	case "thunderstorm":
		return "storm"
	case "snow", "snowstorm":
		return "snow"
	case "fog":
		return "fog"
	case "heat_haze", "sandstorm":
		return "heat"
	case "windy":
		return "wind"
	}
	return ""
}

var weatherLines = map[string][2][]string{ // [upbeat, dry]
	"rain":  {{"Good rain, this. The fields will drink it up.", "A little wet never hurt anybody. Much."}, {"Rain again. My boots have given up.", "If it gets any wetter I'll start charging the fish rent."}},
	"storm": {{"Listen to that sky! Something's going on up there.", "Thunder always makes the stew taste better. Don't ask me why."}, {"Stay clear of the high ground in this. Lightning has no manners.", "That storm is looking for someone. Let it not be us."}},
	"snow":  {{"Snow! Doesn't it make everything quiet? I love that.", "Look how clean it is. For about an hour."}, {"Snow. Lovely, if you've a fire. Do you have a fire?", "My fingers have gone on strike."}},
	"fog":   {{"Misty out. Everything looks like a story this morning.", "Fog's friendly, if you don't mind not seeing anything."}, {"Can't see my own boots. Mind where you wander.", "Fog like this hides things. Not all of them kind."}},
	"heat":  {{"Warm out. Properly warm. Drink plenty.", "The whole world smells of baking. I'm not complaining."}, {"Too hot to think. Too hot to stand. I'm doing both badly.", "Mind the dust out there. It gets in everything, including opinions."}},
	"wind":  {{"Good wind today. Clears the head.", "Windy! Hold on to your hat. And your opinions."}, {"This wind will have the roof off by evening.", "Wind like this carries sounds. Keep your voice down."}},
}

func (c *Context) remarks(p Person, ps Persona, m Memory) []string {
	var out []string
	up := 0
	if !ps.Temper.upbeat() {
		up = 1
	}
	if c.Defense {
		out = append(out, "The beacon's burning and the whole town is holding its breath. Whatever you're planning, plan fast.")
	}
	if c.Night {
		if p.Dwarven {
			out = append(out, "Night? Up there? Down here it's all the same. I'd keep your blade out regardless.")
		} else if ps.Temper == Nervous {
			out = append(out, "It's dark out. Really dark. You shouldn't be out in it. Should you? I don't know. I'd stay in.")
		} else {
			out = append(out, pick([]string{"It's late. Keep to the lanterns if you're heading out.", "Night's no time for walking. The Unsung come bolder every month.", "You'll want a torch if you're going out. And a better plan than 'hope'."}, p.ID, uint64(m.Talks)))
		}
	}
	if g := weatherGroup(c.Weather); g != "" && !p.Dwarven {
		out = append(out, pick(weatherLines[g][up], p.ID, uint64(m.Talks)+3))
	}
	switch tw := timeWord(c.Hour); {
	case tw == "morning" && !c.Night:
		out = append(out, pick([]string{"Early start. Good. The best of the day goes to those who use it.", "Morning light is the honest kind. It shows everything.", "You're up early. Or you never went to bed. Either way, good for you."}, p.ID, uint64(m.Talks)+5))
	case tw == "evening" && !c.Night:
		out = append(out, pick([]string{"Dusk's coming. The lanterns will be lit soon.", "Almost dark. Best find a roof before the Unsung find you.", "Evening already. Time slips like a wet fish."}, p.ID, uint64(m.Talks)+6))
	}
	switch {
	case c.Level <= 2:
		out = append(out, pick([]string{"You look new to all this. Go gently. The world isn't as kind as the hills around here.", "Fresh to the road? Take it slow, stay on the paths and keep your back to something solid."}, p.ID, uint64(m.Talks)+8))
	case c.Level >= 15:
		out = append(out, pick([]string{"Folk are starting to talk about you, you know. Mostly good things.", "You carry yourself like someone who's seen the bad side of the night and walked out."}, p.ID, uint64(m.Talks)+9))
	case c.Level >= 8:
		out = append(out, "You've got the look of someone who's survived a few things. Keep it up.")
	}
	switch c.Gear {
	case 0:
		if c.Level >= 2 {
			out = append(out, "Where's your weapon? Walking around bare-handed... either you're very brave or you've left it somewhere. Please say you've left it somewhere.")
		}
	case 3:
		out = append(out, "That's a fine piece of kit you're carrying. Whoever made it knew their work.")
	}
	for i, d := range c.Deeds {
		switch d.Kind {
		case "camp":
			out = append(out, fmt.Sprintf("They say the camp at %s has gone quiet. I've a good guess who to thank.", orThe(d.Name, "the old camp")))
		case "tower":
			out = append(out, fmt.Sprintf("%s hums a little clearer since you climbed it. I've heard it. Others have too.", orThe(d.Name, "The tower")))
		case "warden":
			out = append(out, "Word came up from the deep halls that the warden is down. Whoever did it, I'd like to shake their hand. Is it you?")
		case "beaten":
			out = append(out, "The Hush is silenced, and the song is back. I can hear it, even in the walls. Thank you. Truly.")
		case "vault":
			out = append(out, fmt.Sprintf("You've been into %s, haven't you? Come back alive and still smiling. That's rarer than gold.", orThe(d.Name, "a sealed vault")))
		}
		_ = i
	}
	switch {
	case c.Act >= 1 && c.Act <= 6:
		out = append(out, pick(actLines[c.Act-1], p.ID, uint64(m.Talks)+11))
	}
	if c.Event != "" {
		out = append(out, fmt.Sprintf("Something's afoot — %s. Keep your eyes open.", c.Event))
	}
	return out
}

func orThe(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

var actLines = [6][]string{
	{"The song is thin, they say. Maybe you can do something about that."},
	{"Three forks ringing together... they tell me you're the one doing it. That's something."},
	{"Verses in the deep. I hope you're careful with those vaults. Riddles bite."},
	{"The vigil is close, I hear. The captain won't sleep. None of us will."},
	{"A Dawnheart, they say. If anyone can forge one, a master can. Mind you bring the lens."},
	{"The Heartfall. Everyone's pretending not to look in that direction. Everyone knows you're headed there."},
}

// Greeting is the opening line: a greeting (first meeting or met before:
// they use your name once met), then one thing they notice, rotating with
// how often you have talked so it doesn't repeat.
func Greeting(p Person, ps Persona, m Memory, ctx Context) string {
	pool := greetFirst[ps.Temper]
	if m.Met {
		pool = greetMet[ps.Temper]
	}
	if k, ok := keyChars[p.Key]; ok {
		extra := k.Greet
		if m.Met {
			extra = k.GreetMet
		}
		if len(extra) > 0 && (m.Talks == 0 || m.Talks%3 == 0) {
			pool = extra
		}
	}
	if p.Dwarven {
		pool = dwarfGreet(m.Met, ps.Temper)
	}
	base := pick(pool, p.ID, uint64(m.Talks)*7+1)
	line := fill(base, p, ctx.Player)
	if rs := ctx.remarks(p, ps, m); len(rs) > 0 {
		line += " " + fill(rs[int(mix(p.ID^uint64(m.Talks)*13))%len(rs)], p, ctx.Player)
	}
	return line
}

func dwarfGreet(met bool, t Temper) []string {
	if met {
		return []string{"{name}. Back down the stairs, I see. Good. The hall's warmer for it.", "Ah, {name}. You've not got lost yet. The stone must like you.", "{name}. Come, sit. The stew's not worse than yesterday."}
	}
	return []string{"Surface-folk. Mind the beams. I'm {me}.", "Hm. A visitor. We don't get many that stay. State your business, then your name.", "Welcome to {town}. The stone is old and the welcome is older. Don't touch the walls."}
}

// ---- topics ----

func compassWord(dx, dz float64) string {
	// +z is south in worldgen's frame.
	a := math.Atan2(-dz, dx) * 180 / math.Pi
	dirs := []string{"east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"}
	k := int(math.Floor((a+22.5)/45)) % 8
	if k < 0 {
		k += 8
	}
	return dirs[k]
}

// DistWord says how far: "a short walk", "about 400 m", "a long way (2 km)".
func DistWord(m float64) string {
	switch {
	case m < 150:
		return "just a short walk"
	case m < 1000:
		return fmt.Sprintf("about %d m", int(math.Round(m/50)*50))
	}
	return fmt.Sprintf("about %.1f km", math.Round(m/100)/10)
}

// Who is the "who are you" answer.
func Who(p Person, ps Persona) string {
	role := RoleWord(p.Role)
	if k, ok := keyChars[p.Key]; ok && k.Who != "" {
		return fill(k.Who, p, "")
	}
	town := p.Town
	if town == "" {
		town = "here"
	} else {
		town = "in " + town
	}
	var intro string
	switch ps.Temper {
	case Warm:
		intro = fmt.Sprintf("I'm %s. I'm the %s %s, and I like to think I'm a decent one.", p.Name, role, town)
	case Gruff:
		intro = fmt.Sprintf("%s. %s %s. That's all there is to it.", p.Name, strings.ToUpper(role[:1])+role[1:], town)
	case Nervous:
		intro = fmt.Sprintf("I'm %s! The %s %s. I try not to cause trouble. I mostly succeed.", p.Name, role, town)
	case Cheerful:
		intro = fmt.Sprintf("%s, at your service! The best %s %s, if I say so myself, and I do, often.", p.Name, role, town)
	case Weary:
		intro = fmt.Sprintf("%s. I'm the %s %s. It's work. Someone has to do it, and it keeps being me.", p.Name, role, town)
	case Gossipy:
		intro = fmt.Sprintf("I'm %s, the %s %s. If it's happened here, I know about it. If it's about to, I probably know that too.", p.Name, role, town)
	case Wry:
		intro = fmt.Sprintf("%s. The %s %s. The job is exactly as glamorous as it sounds.", p.Name, role, town)
	default:
		intro = fmt.Sprintf("I am %s, %s %s. I've held this post longer than most of these walls have stood.", p.Name, aOrAn(role), role+" "+town)
	}
	return intro + " " + ps.Quirk
}

func aOrAn(w string) string {
	if w != "" && strings.ContainsRune("aeiou", rune(w[0])) {
		return "an"
	}
	return "a"
}

// Place is "about this place": the settlement, the region, the neighbours.
func Place(p Person, ps Persona) string {
	if k, ok := keyChars[p.Key]; ok && k.Place != "" {
		return fill(k.Place, p, "") + neighboursLine(p)
	}
	town := p.Town
	if town == "" {
		town = "this place"
	}
	var b strings.Builder
	if p.Dwarven {
		fmt.Fprintf(&b, "%s? Cut from the rock by hands older than the road. We keep our forges hot and our doors heavy.", town)
	} else {
		var open string
		switch ps.Temper {
		case Warm:
			open = fmt.Sprintf("%s is home. It isn't grand, but it's got heart, and a good well.", town)
		case Gruff:
			open = fmt.Sprintf("%s. It stands. It's mostly walls and stubbornness.", town)
		case Nervous:
			open = fmt.Sprintf("%s is... fine. Mostly fine. I check the locks twice.", town)
		case Cheerful:
			open = fmt.Sprintf("%s is the finest town in %s, and I'll fight anyone who says otherwise. Politely.", town, orThe(p.Region, "the valley"))
		case Weary:
			open = fmt.Sprintf("%s. It's quiet, mostly. I've learned to be thankful for mostly.", town)
		case Gossipy:
			open = fmt.Sprintf("%s! Oh, there's so much to tell. Everyone here is related to everyone else, and every one of them is feuding.", town)
		case Wry:
			open = fmt.Sprintf("%s: charming, by the standards of a town with one good road.", town)
		default:
			open = fmt.Sprintf("%s has stood a long time and will stand longer. We built it well.", town)
		}
		b.WriteString(open)
	}
	if p.Region != "" {
		fmt.Fprintf(&b, " It sits in %s.", p.Region)
	}
	b.WriteString(neighboursLine(p))
	return b.String()
}

func neighboursLine(p Person) string {
	var parts []string
	for i, n := range p.Neighbours {
		if i == 2 {
			break
		}
		d := math.Hypot(n.DX, n.DZ)
		parts = append(parts, fmt.Sprintf("%s, %s %s", n.Name, DistWord(d), compassWord(n.DX, n.DZ)))
	}
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return " The closest neighbour is " + parts[0] + "."
	}
	return " The nearest neighbours are " + parts[0] + ", and " + parts[1] + "."
}

// Backstory is a personal answer: layer 1 family, 2 origin, 3 what they want,
// 4 a confidence. The key characters' lines come from keyChars.
func Backstory(p Person, ps Persona, layer int) string {
	switch layer {
	case 1:
		return ps.Family
	case 2:
		return ps.Origin
	case 3:
		return ps.Wants
	}
	return ps.Secret
}

// Personal topics, in the order they unlock: topic key, the question, the
// affinity it needs.
var personal = []struct {
	Key  string
	Ask  string
	Need int
}{
	{"family", "Do you have family here?", 1},
	{"origin", "Where are you from?", 2},
	{"wants", "What do you hope for?", 4},
	{"secret", "You seem like you're holding something back.", 7},
}

func personalLayer(key string) int {
	for i, x := range personal {
		if x.Key == key {
			return i + 1
		}
	}
	return 0
}
