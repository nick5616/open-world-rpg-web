package accountapi

import (
	"errors"
	"math"
	"strings"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/zoneregistry"
)

// Character name rules. Names are typed in `/w Name message` and resolved
// case-insensitively (spec 10), so they are one word of ASCII letters, digits
// and underscores: no spaces to split on, and no look-alike Unicode letters
// that would let "Nicole" and "Nicоle" (Cyrillic о) coexist.
const (
	NameMinLen = 3
	NameMaxLen = 16
)

// ErrNameInvalid explains why a name was rejected; the message is shown to players.
type ErrNameInvalid struct{ Reason string }

// Error is the sentence the character screen shows ("Names are 3 to 16 characters."; playtest 6 polish: it
// printed "invalid name: names are 3 to 16 characters").
func (e ErrNameInvalid) Error() string {
	if e.Reason == "" {
		return "That name can't be used."
	}
	return strings.ToUpper(e.Reason[:1]) + e.Reason[1:] + "."
}

// reservedNames could be mistaken for staff or system messages in chat.
var reservedNames = []string{"admin", "administrator", "system", "server", "moderator", "mod", "gm", "staff", "lodestone", "support", "official", "everyone", "party", "global", "zone", "local", "whisper"}

// ValidateName trims and checks a character name.
func ValidateName(raw string) (string, error) {
	n := strings.TrimSpace(raw)
	if len(n) < NameMinLen || len(n) > NameMaxLen {
		return "", ErrNameInvalid{"names are 3 to 16 characters"}
	}
	for i, r := range n {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9', r == '_':
			if i == 0 {
				return "", ErrNameInvalid{"names start with a letter"}
			}
		default:
			return "", ErrNameInvalid{"use only letters, digits and _"}
		}
	}
	lower := strings.ToLower(n)
	for _, r := range reservedNames {
		if lower == r {
			return "", ErrNameInvalid{"that name is reserved"}
		}
	}
	if strings.Contains(n, "__") {
		return "", ErrNameInvalid{"no repeated underscores"}
	}
	return n, nil
}

// ErrUsernameInvalid is returned for bad dev-auth usernames.
var ErrUsernameInvalid = errors.New("username must be 3-32 characters of letters, digits, _ or -")

// ValidateDevUsername checks a dev-auth username (subject = lowercase form).
func ValidateDevUsername(raw string) (string, error) {
	n := strings.ToLower(strings.TrimSpace(raw))
	if len(n) < 3 || len(n) > 32 {
		return "", ErrUsernameInvalid
	}
	for _, r := range n {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return "", ErrUsernameInvalid
		}
	}
	return n, nil
}

// RegionOf maps a world position to its region (REGION_CHUNKS x CHUNK_SIZE_M
// meters square), clamped to the world so a position slightly outside the
// edge (or NaN from a corrupt save) still lands on a real region.
func RegionOf(p localsave.Vec3) zoneregistry.Region {
	size := float64(constants.RegionChunks * constants.ChunkSizeM)
	clamp := func(v float64) int {
		if math.IsNaN(v) {
			return 0
		}
		i := int(math.Floor(v / size))
		return max(0, min(constants.WorldRegions-1, i))
	}
	return zoneregistry.Region{X: clamp(p.X), Z: clamp(p.Z)}
}
