package dialog

// The hand-written characters: the people the starting town and the main
// story (docs/decisions/0024-main-story.md) already name. Their names are
// generated with the world, so the lines say {me} and never a fixed name;
// the glue decides who they are from the quest and story places (the one who
// gives "Slimes in the meadows", the innkeeper of the Haven, the vigil's
// captain, the master smith) and sets Person.Key.

// Key character ids (Person.Key).
const (
	KeyKeeper      = "keeper"      // the Haven's keeper of the inn: Act I of the story (Ulus on the official world)
	KeyMeadows     = "meadows"     // who gives "Slimes in the meadows"
	KeySmith       = "smith"       // the Haven's blacksmith: the Ward against the night, sunsteel
	KeyBounty      = "bounty"      // the Haven's bounty keeper
	KeyCaptain     = "captain"     // the guard captain of the vigil town: Act IV
	KeyMasterSmith = "mastersmith" // the master smith of Act V
)

// KeyChar is a hand-written voice. Empty fields fall back to the generated
// persona; Who replaces the "who are you" answer, Greet / GreetMet add to the
// temperament's greetings, Place replaces "about this place".
type KeyChar struct {
	Temper                               Temper
	Quirk, Family, Origin, Wants, Secret string
	Who, Place                           string
	Greet, GreetMet                      []string
}

var keyChars = map[string]KeyChar{
	KeyKeeper: {
		Temper: Warm,
		Who:    "I keep the inn, such as it is: six beds, one good pot and a cat nobody admits to owning. Everyone passes through sooner or later, so I hear everything. It's the only reason I'm any use.",
		Quirk:  "I wipe the same cup while I listen. It's the cleanest cup in the valley and I've no idea how many conversations it has heard.",
		Family: "My grandmother raised me in this very inn. She used to say the Lodestone hums under these hills and the hum keeps the night polite. I thought it was a bedtime story. I'm less sure lately.",
		Origin: "Born upstairs, in the room with the crooked beam. I've never slept anywhere else for longer than a week, and I always came home sooner.",
		Wants:  "I want the night to be polite again. That's all. Lanterns lit, doors unbarred, a song in the common room.",
		Secret: "Some nights I stand in the cellar and listen. There's a note down there, very low, like a bell under a pillow. It's thinner than it was when I was small. That's what frightens me.",
		Place:  "{town}? It's the last warm light before the wild. Folk come through on their way to somewhere braver, eat my stew, and leave a little less afraid. I like to think the stew does it.",
		Greet:  []string{"Come in, come in, mind the cat. Sit anywhere that isn't the cat."},
		GreetMet: []string{
			"{name}! There you are. Sit. The pot's hot and I've been wondering how the road treated you.",
		},
	},
	KeyMeadows: {
		Temper: Weary,
		Who:    "I'm {me}. I work this land, or what the slimes leave of it. Barley, beans, patience, in that order of supply.",
		Quirk:  "I count the crows and the slimes at dawn. The crows are down. The slimes are up. I don't like the arithmetic.",
		Family: "There are four of us on this plot and one very opinionated goat. The goat has taken the slimes personally.",
		Origin: "My folks farmed here, and theirs before. The soil remembers us, even if the slimes don't.",
		Wants:  "A morning where I walk the south field and nothing in it moves that I didn't plant.",
		Secret: "I've started leaving a little grain at the edge of the field for the slimes. Don't laugh. It slows them down. Possibly. Don't tell anyone I said so.",
		Place:  "{town} feeds itself, mostly, and the meadows south of the wall are where the food is, so naturally that's where the slimes are. The packs wander out past the fences every spring. Somebody has to thin them.",
		Greet:  []string{"Careful where you step. The south field's gone soft and I'm not sure all of it is mud."},
		GreetMet: []string{
			"{name}. You, I'm glad to see. Anything that walks upright and holds a blade is welcome on my land.",
		},
	},
	KeySmith: {
		Temper: Gruff,
		Who:    "I'm {me}. I work iron. Mostly I work it badly at first and well by the third heating. People forget the first two.",
		Quirk:  "I won't talk while the metal is in the fire. If I go quiet, wait. If I swear, wait longer.",
		Family: "My teacher taught me, and her teacher taught her, and none of them ever wrote anything down. It's all in the hands. Mine are getting old.",
		Origin: "I came to this forge as a boy to carry coal. The coal's lighter now. I'm not.",
		Wants:  "Sunsteel. Properly worked, once, before my hands go. The old smiths said it remembers the sun. I'd like to hold something that remembers anything.",
		Secret: "The first blade I ever finished broke on the first hard swing, and the man who bought it never came back. I've never known if he lived. Every blade I forge since, I forge for him.",
		Place:  "{town} is a good town for a forge. Honest folk, mean winters, and an unreasonable number of people who think a sword can be mended with a wish. It can't. It takes me.",
		Greet:  []string{"Hm. You want something made, or something mended? If it's neither, mind the sparks."},
		GreetMet: []string{
			"{name}. Good. I can spot a blade that's seen real work. Show me how it's holding.",
		},
	},
	KeyBounty: {
		Temper: Wry,
		Who:    "I'm {me}. I keep the board. Folk post their troubles, I post the price. It's mostly honest work, if you count the dying.",
		Quirk:  "I read every notice twice, once for what it says and once for what it doesn't. The second reading is the dangerous one.",
		Family: "I had a partner once, out on the roads. Now I send other people out on them. It's kinder, mostly. To me.",
		Origin: "I was a wayfinder before the knees went. You can't unlearn a map. So I pin them to a wall and hand them out.",
		Wants:  "A week where nobody pins anything new. I keep the board. I'd love to see its wood.",
		Secret: "I don't post the worst ones. The ones that would only send somebody's child off to die for fifty gold. I burn them. Don't mention it.",
		Place:  "{town}? Quiet, if you ignore the ledger. Everyone's got a problem and a few coins. Half the trade is knowing which problems can be solved with a sword and which with a conversation.",
		Greet:  []string{"New face. Good. The board has been eating old ones."},
		GreetMet: []string{
			"{name}. Back for more? I admire the optimism. The board has something fresh, if you've the stomach for it.",
		},
	},
	KeyCaptain: {
		Temper: Proud,
		Who:    "I'm {me}, captain of the watch. If it comes through that gate, I've met it first. If it comes over the wall, someone is going to hear about it.",
		Quirk:  "I walk the wall at dusk and count the lanterns by name. We lost one last winter. I still count it.",
		Family: "My watch is my family. Eleven souls, four of them stubborn, two of them children's size. Don't underestimate those two.",
		Origin: "I served three towns before this one. They all fell quiet. This is the last I'll serve, and I mean to keep it loud.",
		Wants:  "To see dawn from the wall after the longest night, and every lantern still lit.",
		Secret: "I've seen something at the edge of the lantern light that wasn't an animal and wasn't a demon. It was too tall. It stood still and watched. I haven't told the watch.",
		Place:  "{town} is the last lantern on this road. The wall isn't tall, but it's honest, and the folk behind it are stubborn. That counts for more than height.",
		Greet:  []string{"Halt, and well met. State your business, then take your time stating it; I like to see how people stand."},
		GreetMet: []string{
			"{name}. The watch knows you. That's rarer praise than it sounds. What do you need?",
		},
	},
	KeyMasterSmith: {
		Temper: Proud,
		Who:    "I'm {me}, a master of the forge. You see this hand? It has shaped iron since before you could hold a spoon. When I say a thing can be forged, it can.",
		Quirk:  "I tap every blade against my ear before I judge it. Steel sings, if it's honest.",
		Family: "My apprentice is the best I ever taught and she knows it, and that's the whole trouble with her.",
		Origin: "I learned at the great forges of the old kingdoms, before they were ash. What I know, I carry. There's no one left to ask.",
		Wants:  "To forge something worth the name. A Dawnheart, they say: a sunsteel that holds a song. I'd hammer my own hands to stumps for it.",
		Secret: "I'm afraid I've been the greatest smith there is for so long that I've forgotten how to be a beginner. I'd like to be astonished by metal again.",
		Place:  "{town}: good water, good coal, good iron, and the best forge on this side of the world. I'm not bragging. I'm cataloguing.",
		Greet:  []string{"Hm. Hands that have worked, a face that's travelled. Sit near the fire, not the anvil."},
		GreetMet: []string{
			"{name}. You've brought dust and stories and I haven't had either in a while. Sit.",
		},
	},
}
