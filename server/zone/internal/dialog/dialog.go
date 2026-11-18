package dialog

import "strings"

// Memory is what one character remembers of one person. It is stored with
// the character's content state (content.State.Dlg) as small JSON.
type Memory struct {
	Met      bool     `json:"m,omitempty"`
	Talks    int      `json:"t,omitempty"`
	Affinity int      `json:"a,omitempty"`
	Heard    []string `json:"h,omitempty"` // topics and rumours already told
	LastDay  int      `json:"d,omitempty"` // the in-game day of the last talk (+1; 0 never)
}

const maxHeard = 48

// Has reports whether topic key was heard.
func (m Memory) Has(key string) bool {
	for _, h := range m.Heard {
		if h == key {
			return true
		}
	}
	return false
}

// Hear records a topic; the first time it also warms them to you (+1).
// Reports whether it was new.
func (m *Memory) Hear(key string) bool {
	if m.Has(key) {
		return false
	}
	if len(m.Heard) >= maxHeard {
		m.Heard = m.Heard[1:]
	}
	m.Heard = append(m.Heard, key)
	m.Affinity++
	return true
}

// Add warms (or cools) them by n (finished quests: +3).
func (m *Memory) Add(n int) { m.Affinity = max(0, m.Affinity+n) }

// Talked records a conversation opening on in-game day day: you have met,
// the count goes up, and a new day on its own warms them a little.
func (m *Memory) Talked(day int) {
	m.Met = true
	m.Talks++
	if m.LastDay != day+1 {
		m.Affinity++
	}
	m.LastDay = day + 1
}

// Choice is one line you can say. Act is the glue's handle (it is not sent).
type Choice struct {
	ID   int    `json:"id"`
	Text string `json:"text"`
	Kind string `json:"kind"`          // topic, rumour, work, mark, quest, more, leave, check
	Tag  string `json:"tag,omitempty"` // the bracket in front: Leave, Quest, Barter, Rumour, Work, Mark, or a check (Mage, Warmth ♥♥♥, Level 10, Sunsteel)
	Low  bool   `json:"low,omitempty"` // a check you do not meet (the tag is dimmed)
	Act  string `json:"-"`
}

// Node is what the NPC says and what you can answer.
type Node struct {
	Line    string   `json:"line"`
	Mood    string   `json:"mood,omitempty"`
	Choices []Choice `json:"choices"`
	Rumour  *Rumour  `json:"rumour,omitempty"`
	// Check is the check you just tried (a chip in the transcript).
	Check *CheckResult `json:"check,omitempty"`
	// Bye marks the farewell: the box closes by itself after it.
	Bye  bool  `json:"bye,omitempty"`
	Perk *Perk `json:"-"` // what the glue applies (a discount)
}

// Open is the opening node: the greeting and the topics. It does not change
// m: the caller records the talk (Memory.Talked) after.
func Open(p Person, m Memory, ctx Context) Node {
	ps := PersonaOf(p)
	return Node{Line: Greeting(p, ps, m, ctx), Mood: ps.Temper.Mood(), Choices: Menu(p, ps, m, ctx)}
}

// Menu is the topics under a line, in your own voice. At most MaxChoices
// with the way out last; when the list is full the least useful topics give
// way (services, rumours and who they are come first).
func Menu(p Person, ps Persona, m Memory, ctx Context) []Choice {
	var cs []Choice
	add := func(text, kind, act string) { cs = append(cs, Choice{Text: text, Kind: kind, Act: act}) }
	w := ctx.Work
	if w.Shop {
		add(shopAsk(p), "work", "work:shop")
	}
	if w.Bounty {
		add("I could use some work.", "work", "work:bounty")
	}
	if w.Rest {
		add("I could do with a rest.", "work", "work:rest")
	}
	if w.Forge {
		add("Mind if I use your forge?", "work", "work:forge")
	}
	add("Heard anything strange lately?", "rumour", "topic:rumour")
	if !m.Has("t:who") {
		add("Who are you, exactly?", "topic", "topic:who")
	} else {
		for _, pt := range personal {
			if !m.Has("t:"+pt.Key) && m.Affinity >= pt.Need {
				add(pt.Ask, "topic", "topic:"+pt.Key)
				break
			}
		}
	}
	// Room for one check (two when the list is short), then the place and small talk.
	nck := 1
	if MaxChoices-1-len(cs) >= 4 {
		nck = 2
	}
	cs = append(cs, checkChoices(p, ps, m, ctx, nck)...)
	add("What's "+placeWord(p)+" like?", "topic", "topic:place")
	add(chatAsk(p), "topic", "topic:chat")
	return Finish(cs, p, m)
}

func placeWord(p Person) string {
	if p.Town == "" {
		return "this place"
	}
	return p.Town
}

// Reply answers a topic. m is updated (the topic is heard).
func Reply(p Person, m *Memory, ctx Context, topic string) Node {
	ps := PersonaOf(p)
	n := Node{Mood: ps.Temper.Mood()}
	switch topic {
	case "who":
		n.Line = Who(p, ps)
		m.Hear("t:who")
	case "place":
		n.Line = Place(p, ps)
		m.Hear("t:place")
	case "chat":
		n.Line = ChatLine(p, ps, *m)
		m.Hear("t:chat")
	case "rumour":
		r, ok := PickRumour(p, ps, *m, ctx.Sites)
		if !ok {
			n.Line = NoRumour(p, ps)
			break
		}
		m.Hear(RumourKey(r.Key))
		n.Line = r.Text
		n.Rumour = &r
		if r.Pos {
			n.Choices = append(n.Choices, Choice{Text: "Mark that on my map, would you?", Kind: "mark", Act: "mark:" + r.Key})
		}
		if _, more := PickRumour(p, ps, *m, ctx.Sites); more {
			n.Choices = append(n.Choices, Choice{Text: "Anything else you've heard?", Kind: "more", Act: "topic:rumour"})
		}
		n.Choices = append(n.Choices, Choice{Text: "Thanks. I'll look into it.", Kind: "topic", Act: "menu"})
		n.Choices = Finish(n.Choices, p, *m)
		return n
	default:
		if c, ok := checkOf(p, ps, ctx, topic); ok {
			n = checkReply(p, ps, m, ctx, c)
			n.Choices = append(n.Choices, Choice{Text: "Thanks. Back to what I was saying.", Kind: "topic", Act: "menu"})
			n.Choices = Finish(n.Choices, p, *m)
			return n
		}
		layer := personalLayer(topic)
		if layer == 0 {
			n.Line = "Hm? I don't follow."
			break
		}
		n.Line = Backstory(p, ps, layer)
		m.Hear("t:" + topic)
	}
	n.Choices = Menu(p, ps, *m, ctx)
	return n
}

// ClosedLine is what a person says when their service is closed for the night.
func ClosedLine(p Person, ps Persona) string {
	return pick([]string{"We're closed for the night. Come back when the sun is up.", "Not now, it's late. Morning, friend.", "Shut up for the day. If you need me, knock in the morning."}, p.ID, 5)
}

// Join is a small helper for the glue's logs.
func Join(ss ...string) string { return strings.Join(ss, " ") }
