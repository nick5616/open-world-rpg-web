package accountapi

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"strings"
)

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// IsUUID reports a canonical lowercase UUID. Ids arriving from browsers are
// checked before they reach Postgres so a bad id is a 400, not a 500.
func IsUUID(s string) bool { return uuidRe.MatchString(s) }

// NormalizeUUID lowercases and validates; "" if invalid.
func NormalizeUUID(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if !IsUUID(s) {
		return ""
	}
	return s
}

// NewUUID returns a random (v4) UUID.
func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
