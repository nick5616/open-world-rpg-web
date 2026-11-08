package director

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/ticket"
)

// TestAcceptanceTicketFile verifies the ticket a real headless browser
// received from the real director during the WP04 acceptance run
// (client/src/account/dev/acceptance.mjs writes the file, then runs this test
// with LODESTONE_WP04_TICKET_FILE set). It uses the same ticket.Verify call
// and public key a zone server uses, which is the check WP03's zone performs
// on connect; the cross-package run against the real zone happens at merge.
//
// The signature, audience and claims are checked at the moment the browser
// received the ticket (receivedAt), so the committed evidence file stays
// verifiable after the 60 s lifetime; with LODESTONE_WP04_FRESH=1 (set by the
// acceptance script) it is also checked against the wall clock.
func TestAcceptanceTicketFile(t *testing.T) {
	path := env.Str("LODESTONE_WP04_TICKET_FILE", "")
	if path == "" {
		t.Skip("set LODESTONE_WP04_TICKET_FILE (written by client/src/account/dev/acceptance.mjs)")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var runs []struct {
		Label        string `json:"label"`
		Ticket       string `json:"ticket"`
		SocialTicket string `json:"socialTicket"`
		ZoneID       string `json:"zoneId"`
		WorldID      string `json:"worldId"`
		CharacterID  string `json:"characterId"`
		Local        bool   `json:"isLocalProfile"`
		ReceivedAt   int64  `json:"receivedAt"`
	}
	if err := json.Unmarshal(raw, &runs); err != nil || len(runs) == 0 {
		t.Fatal("bad ticket file", err)
	}
	pub, dev, err := ticket.PublicKeyFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if dev {
		t.Log("verifying with the development ticket key (the acceptance run uses the dev key)")
	}
	for _, r := range runs {
		at := time.UnixMilli(r.ReceivedAt)
		c, err := ticket.Verify(pub, r.Ticket, ticket.AudienceZone(r.ZoneID), at)
		if err != nil {
			t.Fatalf("%s: zone ticket rejected: %v", r.Label, err)
		}
		if c.CharacterID != r.CharacterID || c.WorldID != r.WorldID || c.IsLocalProfile != r.Local {
			t.Fatalf("%s: claims %+v do not match the session", r.Label, c)
		}
		if r.Local && (c.ProfileID == "" || c.AccountID != "") || !r.Local && c.AccountID == "" {
			t.Fatalf("%s: owner claims wrong: %+v", r.Label, c)
		}
		if _, err := ticket.Verify(pub, r.SocialTicket, ticket.AudienceSocial, at); err != nil {
			t.Fatalf("%s: social ticket rejected: %v", r.Label, err)
		}
		if _, err := ticket.Verify(pub, r.Ticket, ticket.AudienceZone("some-other-zone"), at); err == nil {
			t.Fatalf("%s: ticket accepted by the wrong zone", r.Label)
		}
		if env.Bool("LODESTONE_WP04_FRESH", false) {
			if _, err := ticket.Verify(pub, r.Ticket, ticket.AudienceZone(r.ZoneID), time.Now()); err != nil {
				t.Fatalf("%s: not valid right now: %v", r.Label, err)
			}
		}
		t.Logf("%s: OK zone=%s character=%s (%s) local=%v expires=%s", r.Label, r.ZoneID, c.CharacterName, c.CharacterID, c.IsLocalProfile, c.ExpiresAt.Format(time.RFC3339))
	}
}
