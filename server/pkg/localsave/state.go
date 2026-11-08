package localsave

import "encoding/json"

// Vec3 is a world position in meters.
type Vec3 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// Progress mirrors the character_progress table (spec 11). Bitsets are bytes
// (base64 in JSON) indexed by atlas POI / container ids.
type Progress struct {
	Towers           []byte          `json:"towers"`
	Waypoints        []byte          `json:"waypoints"`
	ContainersOpened []byte          `json:"containersOpened"`
	Discoveries      []byte          `json:"discoveries"`
	SkillTree        json.RawMessage `json:"skillTree"`
	SpellsKnown      []string        `json:"spellsKnown"`
	SpellsEquipped   []string        `json:"spellsEquipped"`
}

// Item mirrors the items table so an upgrade can insert inventory rows as-is.
type Item struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	BaseID    string          `json:"baseId"`
	ItemLevel int             `json:"itemLevel"`
	Rarity    int             `json:"rarity"`
	Affixes   json.RawMessage `json:"affixes"`
	Sockets   json.RawMessage `json:"sockets"`
	Slot      string          `json:"slot,omitempty"`
	RollSeed  int64           `json:"rollSeed"`
}

// State is the character state carried in a save blob: the same fields an
// account character keeps in characters + character_progress + items, so the
// upgrade transaction is a straight copy. Zone servers (WP06/WP14) fill it at
// save points; new fields must be optional so old exported blobs still parse.
type State struct {
	CharacterID  string          `json:"characterId"`
	WorldID      string          `json:"worldId"`
	Name         string          `json:"name"`
	Level        int             `json:"level"`
	XP           int64           `json:"xp"`
	Position     Vec3            `json:"position"`
	LastWaypoint *int64          `json:"lastWaypoint"`
	StaminaMax   float64         `json:"staminaMax"`
	Appearance   json.RawMessage `json:"appearance"`
	Progress     Progress        `json:"progress"`
	Items        []Item          `json:"items"`
}

// NewCharacterState is a level-1 character standing at spawn, matching the
// column defaults of the characters table.
func NewCharacterState(characterID, worldID, name string, spawn Vec3, appearance json.RawMessage) State {
	if len(appearance) == 0 {
		appearance = json.RawMessage(`{}`)
	}
	return State{
		CharacterID: characterID, WorldID: worldID, Name: name,
		Level: 1, Position: spawn, StaminaMax: 100, Appearance: appearance,
		Progress: Progress{
			Towers: []byte{}, Waypoints: []byte{}, ContainersOpened: []byte{}, Discoveries: []byte{},
			SkillTree: json.RawMessage(`{}`), SpellsKnown: []string{}, SpellsEquipped: []string{},
		},
		Items: []Item{},
	}
}

// Marshal returns the state's canonical JSON text for signing.
func (s State) Marshal() []byte {
	b, _ := json.Marshal(s) // only fails on unmarshalable types, which State has none of
	return b
}
