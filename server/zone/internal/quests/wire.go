package quests

import "encoding/json"

// The client's view of the log (Event 950) and of an offer (Event 951);
// contracts/events.md documents the JSON.

// WireStep is a step as the journal lists it.
type WireStep struct {
	Text string `json:"text"`
	Done bool   `json:"done"`
}

// WireQuest is one quest as the HUD, map and compass need it.
type WireQuest struct {
	ID       uint32     `json:"id"`
	Key      string     `json:"key"`
	Kind     uint8      `json:"kind"`
	Title    string     `json:"title"`
	Giver    string     `json:"giver"`
	Step     int        `json:"step"`
	Steps    []WireStep `json:"steps"`
	Text     string     `json:"text"`
	Note     string     `json:"note,omitempty"`
	Progress int        `json:"progress"`
	Need     int        `json:"need"` // 0: no count to show
	Markers  []Marker   `json:"markers"`
	Gold     int        `json:"gold"`
	XP       int64      `json:"xp"`
	TurnIn   bool       `json:"turnIn,omitempty"`
	// CR 022: reward items, equipment rolls and reputation (town name).
	Items     []ItemQty `json:"items,omitempty"`
	RollItems int       `json:"rollItems,omitempty"`
	Rep       int       `json:"rep,omitempty"`
	RepTown   string    `json:"repTown,omitempty"`
	// Say (offers only, CR 022): what the giver says when offering it.
	Say string `json:"say,omitempty"`
	// StepMarkers (offers only): every step's markers, so the client can
	// preview where the whole quest takes place before accepting.
	StepMarkers [][]Marker `json:"stepMarkers,omitempty"`
}

type wireLog struct {
	V       int         `json:"v"`
	Tracked uint32      `json:"tracked"`
	Quests  []WireQuest `json:"quests"`
}

func view(q *Quest) WireQuest {
	w := WireQuest{ID: q.ID, Key: q.Key, Kind: q.Kind, Title: q.Title, Giver: q.Giver, Step: q.Step, Gold: q.Gold, XP: q.XP, Progress: q.Progress, Markers: []Marker{},
		Items: q.Items, RollItems: q.RollItems, Rep: q.Rep}
	for i, s := range q.Steps {
		w.Steps = append(w.Steps, WireStep{Text: s.Text, Done: i < q.Step})
	}
	if s := q.Current(); s != nil {
		w.Text, w.Note = s.Text, s.Note
		if s.Markers != nil {
			w.Markers = s.Markers
		}
		if (s.Obj.Kind == ObjHave || s.Obj.Kind == ObjTurnIn || s.Obj.Kind == ObjGive) && len(s.Obj.Items) > 0 && s.Obj.Items[0].Qty > 1 {
			w.Need = s.Obj.Items[0].Qty
		}
		if s.Obj.Kind == ObjKill && s.Obj.N > 0 {
			w.Need = s.Obj.N
		}
		w.TurnIn = s.Obj.Kind == ObjTurnIn
	}
	return w
}

// Wire is Event 950's data.
func (l *Log) Wire() []byte {
	w := wireLog{V: 1, Tracked: l.Tracked, Quests: []WireQuest{}}
	for _, q := range l.Active {
		w.Quests = append(w.Quests, view(q))
	}
	b, _ := json.Marshal(w)
	return b
}

// OfferWire is Event 951's data: the quest as it would start, with every
// step's markers.
func OfferWire(q *Quest) []byte {
	w := view(q)
	for _, s := range q.Steps {
		m := s.Markers
		if m == nil {
			m = []Marker{}
		}
		w.StepMarkers = append(w.StepMarkers, m)
	}
	b, _ := json.Marshal(w)
	return b
}

// OfferWireSay is OfferWire with the giver's offer line and the town whose
// reputation the quest raises (CR 022: townsfolk side quests and stories).
func OfferWireSay(q *Quest, say, repTown string) []byte {
	w := view(q)
	w.Say, w.RepTown = say, repTown
	for _, s := range q.Steps {
		m := s.Markers
		if m == nil {
			m = []Marker{}
		}
		w.StepMarkers = append(w.StepMarkers, m)
	}
	b, _ := json.Marshal(w)
	return b
}
