package social

import (
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	sp "lodestone/server/pkg/socialproto"
)

func TestFilterMasksWordsNotInnocentOnes(t *testing.T) {
	cases := map[string]string{
		"what the fuck":            "what the ****",
		"absolutely FUCKING great": "absolutely ******* great",
		"sh1t happens":             "**** happens",
		"fuuuuck":                  "*******",
		"you ass!":                 "you ***!",
		// Things a naive substring filter breaks:
		"an assassin in class":       "an assassin in class",
		"Scunthorpe is a town":       "Scunthorpe is a town",
		"passing the cockatrice":     "passing the cockatrice",
		"a Bitchin' sword dropped!!": "a Bitchin' sword dropped!!",
		"hello there":                "hello there",
		"wow!!!":                     "wow!!!",
	}
	for in, want := range cases {
		if got := defaultFilter.Clean(in); got != want {
			t.Errorf("Clean(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCleanText(t *testing.T) {
	if _, code := cleanText("   "); code == "" {
		t.Fatal("empty text must be refused")
	}
	long := strings.Repeat("é", constants.ChatMaxLen) // 280 runes, 560 bytes: allowed
	if got, code := cleanText(long); code != "" || got != long {
		t.Fatalf("280 multi-byte characters must pass, got code %q", code)
	}
	if _, code := cleanText(long + "x"); code != sp.ErrorCodeTooLong {
		t.Fatalf("281 characters must be too_long, got %q", code)
	}
	if got, _ := cleanText("a\nb\x00c"); got != "a b c" {
		t.Fatalf("control characters must become spaces, got %q", got)
	}
}

func TestLocalRadius(t *testing.T) {
	if !within(100, 100, 121, 121, constants.LocalChatRadiusM) { // 29.7 m
		t.Fatal("29.7 m is inside 30 m")
	}
	if within(100, 100, 122, 122, constants.LocalChatRadiusM) { // 31.1 m
		t.Fatal("31.1 m is outside 30 m")
	}
}

func TestConvScopeIsSymmetric(t *testing.T) {
	if convScope("b", "a") != convScope("a", "b") || convScope("a", "b") != "a:b" {
		t.Fatal("both sides of a whisper must name the same list")
	}
}

func TestGlobalSlowMode(t *testing.T) {
	l := newLimits(DefaultLimits())
	b, code := l.chat(sp.ChannelGlobal)
	if code != sp.ErrorCodeSlowMode {
		t.Fatalf("global refusals are slow_mode, got %q", code)
	}
	t0 := time.Unix(1000, 0)
	if !b.Take(t0) {
		t.Fatal("first global message passes")
	}
	if b.Take(t0.Add(9900 * time.Millisecond)) {
		t.Fatal("second global message inside 10 s must wait")
	}
	if !b.Take(t0.Add(10 * time.Second)) {
		t.Fatal("one message per 10 s")
	}
}

func TestChannelBucketsAreIndependent(t *testing.T) {
	l := newLimits(DefaultLimits())
	t0 := time.Unix(1000, 0)
	party, _ := l.chat(sp.ChannelParty)
	for party.Take(t0) {
	}
	whisper, _ := l.chat(sp.ChannelWhisper)
	if !whisper.Take(t0) {
		t.Fatal("an empty party bucket must not block whispers")
	}
	if b, _ := l.chat(sp.ChannelSystem); b != nil {
		t.Fatal("players have no bucket for the system channel")
	}
}

func TestPartyRecord(t *testing.T) {
	p := &partyRecord{ID: "p", Leader: "a", Members: []partyMember{{"a", "A"}, {"b", "B"}, {"c", "C"}}}
	p.remove("b")
	if p.has("b") || len(p.Members) != 2 || p.nameOf("c") != "C" {
		t.Fatalf("remove: %+v", p)
	}
	if ids := p.memberIDs(); ids[0] != "a" || ids[1] != "c" {
		t.Fatalf("memberIDs order: %v", ids)
	}
}

func TestParseOrigins(t *testing.T) {
	got := ParseOrigins("https://play.example.com, http://localhost:5173")
	if len(got) != 2 || got[0] != "play.example.com" || got[1] != "localhost:5173" {
		t.Fatalf("ParseOrigins: %v", got)
	}
}

func TestHistoryLengthsMatchSpec(t *testing.T) {
	want := map[sp.Channel]int64{sp.ChannelGlobal: 200, sp.ChannelZone: 100, sp.ChannelParty: 100, sp.ChannelWhisper: 100, sp.ChannelSystem: 50, sp.ChannelLocal: 0}
	for ch, n := range want {
		if historyLen(ch) != n {
			t.Errorf("history %s = %d, want %d", ch, historyLen(ch), n)
		}
	}
}
