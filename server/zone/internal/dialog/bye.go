package dialog

// The goodbye and the offer (playtest 5, CR 053).

// ByeNode is the person's answer to your goodbye: their farewell, no
// answers; the box closes by itself after it (the glue schedules that).
func ByeNode(p Person, ps Persona, m Memory, player string) Node {
	return Node{Line: Farewell(p, ps, m, player), Mood: ps.Temper.Mood(), Bye: true}
}

// QuestChoices are the answers under a quest offer: accept, haggle when the
// offer pays, decline and the way out.
func QuestChoices(p Person, ps Persona, m Memory, ctx Context, qid string, canHaggle bool) []Choice {
	cs := []Choice{{Text: "I'll do it.", Kind: "quest", Act: "accept:" + qid}}
	if canHaggle {
		c := HaggleCheck()
		cs = append(cs, Choice{Text: "That's a lot of risk for that. I'm worth more.", Kind: "check", Tag: c.Tag(), Low: !c.Pass(ctx, m), Act: "haggle:" + qid})
	}
	cs = append(cs, Choice{Text: "Not right now.", Kind: "quest", Act: "decline"})
	return Finish(cs, p, m)
}

// HaggleBonusPct is the extra a passed haggle pays on a quest's gold.
const HaggleBonusPct = 25

// HaggleCheck is the level a person wants to see before they pay more.
func HaggleCheck() Check { return Check{Kind: CheckLevel, Need: 6} }

// HaggleReply answers "I'm worth more": a pass pays a bonus on accepting.
func HaggleReply(p Person, ps Persona, m Memory, ctx Context) (Node, bool) {
	c := HaggleCheck()
	pass := c.Pass(ctx, m)
	n := Node{Mood: ps.Temper.Mood(), Check: &CheckResult{Tag: c.Tag(), Pass: pass}}
	if !pass {
		n.Line = failLines[ps.Temper][failIndex(CheckLevel)]
		n.Mood = "stern"
		return n, false
	}
	n.Line = pick(passReact[ps.Temper], p.ID, uint64(m.Talks)+9) + " Fine. A better purse for the job, then, and don't tell the next one."
	return n, true
}
