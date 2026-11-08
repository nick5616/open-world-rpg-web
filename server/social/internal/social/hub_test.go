package social

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/constants"
	sp "lodestone/server/pkg/socialproto"
	"lodestone/server/social/internal/client"
)

// Integration tests against real Redis and a scratch Postgres database.
// They skip when `npm run infra:up` has not been run (dbtest).

func TestEveryChannel(t *testing.T) {
	e := newEnv(t, nil)
	alice, bob, carol := e.player("Alice"), e.player("Bob"), e.player("Carol")
	a, b, c := e.connect(alice), e.connect(bob), e.connect(carol)

	// Alice and Bob stand 10 m apart in region 2,2 (zone-1); Carol is far
	// away in region 3,1 on another zone server.
	send(t, a, presence("2,2", 2048, 2048, "zone-1"))
	send(t, b, presence("2,2", 2058, 2048, "zone-1"))
	send(t, c, presence("3,1", 3500, 1500, "zone-2"))
	for _, cl := range []*client.Client{a, b, c} {
		must(t, cl, "zone history after first presence", func(f client.Frame) bool {
			var h sp.S2CHistory
			return f.Type == sp.S2CTypeHistory && f.Decode(&h) == nil && h.Channel == sp.ChannelZone
		})
	}

	send(t, a, chat(sp.ChannelGlobal, "hello world"))
	for _, cl := range []*client.Client{a, b, c} {
		must(t, cl, "global", client.Chat(sp.ChannelGlobal, "hello world"))
	}

	send(t, a, chat(sp.ChannelZone, "anyone in 2,2?"))
	must(t, b, "zone to same region", client.Chat(sp.ChannelZone, "anyone in 2,2?"))

	send(t, a, chat(sp.ChannelLocal, "psst"))
	f := must(t, b, "local within 30 m", client.Chat(sp.ChannelLocal, "psst"))
	var lm sp.S2CChat
	_ = f.Decode(&lm)
	if lm.Message.X != 2048 || lm.Message.Z != 2048 || lm.Message.FromName != "Alice" {
		t.Fatalf("local message must carry the speaker's position for bubbles: %+v", lm.Message)
	}
	must(t, a, "local echo to speaker", client.Chat(sp.ChannelLocal, "psst"))
	never(t, c, "zone/local must not reach another region", 300*time.Millisecond, func(f client.Frame) bool {
		return client.Chat(sp.ChannelZone, "anyone in 2,2?")(f) || client.Chat(sp.ChannelLocal, "psst")(f)
	})

	// Bob walks 40 m away: local no longer reaches him.
	send(t, b, presence("2,2", 2088, 2048, "zone-1"))
	time.Sleep(100 * time.Millisecond)
	send(t, a, chat(sp.ChannelLocal, "still there?"))
	must(t, a, "echo", client.Chat(sp.ChannelLocal, "still there?"))
	never(t, b, "local beyond 30 m", 300*time.Millisecond, client.Chat(sp.ChannelLocal, "still there?"))

	// Party: Alice invites Carol (another zone); party chat reaches only them.
	send(t, a, sp.C2SPartyInvite{Type: sp.C2STypePartyInvite, Name: "carol"}) // case-insensitive
	inv := partyInvite(c, t)
	if inv.FromName != "Alice" {
		t.Fatalf("invite from %q", inv.FromName)
	}
	send(t, c, sp.C2SPartyRespond{Type: sp.C2STypePartyRespond, PartyID: inv.PartyID, Accept: true})
	must(t, a, "party state", partyStateWith(2, alice.ID))
	must(t, c, "party state", partyStateWith(2, alice.ID))
	send(t, c, chat(sp.ChannelParty, "omw"))
	must(t, a, "party chat", client.Chat(sp.ChannelParty, "omw"))
	never(t, b, "party chat to non-member", 300*time.Millisecond, client.Chat(sp.ChannelParty, "omw"))

	// Whisper across zones, then /r.
	send(t, b, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "CAROL", Text: "hi from zone-1"})
	f = must(t, c, "whisper", client.Chat(sp.ChannelWhisper, "hi from zone-1"))
	var wm sp.S2CChat
	_ = f.Decode(&wm)
	if wm.Message.FromName != "Bob" || wm.Message.ToName != "Carol" {
		t.Fatalf("whisper fields: %+v", wm.Message)
	}
	must(t, b, "delivered", client.WhisperStatus("Carol", sp.WhisperStatusDelivered))
	must(t, b, "sender echo", client.Chat(sp.ChannelWhisper, "hi from zone-1"))
	send(t, c, sp.C2SReply{Type: sp.C2STypeReply, Text: "hi back"})
	must(t, b, "reply", client.Chat(sp.ChannelWhisper, "hi back"))

	// System: the party invite flow put nothing there, but a decline would.
	e.hub.SystemMessage(context.Background(), e.world, alice.ID, "You found a waypoint.")
	must(t, a, "system", client.Chat(sp.ChannelSystem, "You found a waypoint."))
	never(t, b, "system is per player", 200*time.Millisecond, client.Chat(sp.ChannelSystem, "You found a waypoint."))
}

func TestWhisperRules(t *testing.T) {
	e := newEnv(t, nil)
	alice, bob, ghost, dave := e.player("Alice"), e.player("Bob"), e.player("Ghost"), e.localPlayer("Dave")
	a, b := e.connect(alice), e.connect(bob)
	// Ghost connects once (so the name exists), then leaves.
	g := e.connect(ghost)
	g.Close()
	time.Sleep(200 * time.Millisecond)

	send(t, a, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "ghost", Text: "you there?"})
	must(t, a, "offline status", client.WhisperStatus("Ghost", sp.WhisperStatusOffline))
	conv := keyChat(e.world, sp.ChannelWhisper, convScope(alice.ID, ghost.ID))
	if n, _ := e.rdb.LLen(context.Background(), conv).Result(); n != 0 {
		t.Fatalf("offline whispers must not be stored, list has %d", n)
	}

	send(t, a, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Nobody_Here", Text: "?"})
	must(t, a, "unknown target", client.Error(sp.ErrorCodeUnknownTarget))

	// Bob blocks Alice: Alice sees "delivered", Bob sees nothing, nothing stored.
	send(t, b, sp.C2SBlock{Type: sp.C2STypeBlock, Name: "alice"})
	must(t, b, "relations after block", func(f client.Frame) bool {
		var r sp.S2CRelations
		return f.Type == sp.S2CTypeRelations && f.Decode(&r) == nil && len(r.Blocked) == 1 && r.Blocked[0] == "Alice"
	})
	send(t, a, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Bob", Text: "let me in"})
	must(t, a, "blocked looks delivered", client.WhisperStatus("Bob", sp.WhisperStatusDelivered))
	never(t, b, "blocked whisper dropped", 300*time.Millisecond, client.Chat(sp.ChannelWhisper, "let me in"))
	if n, _ := e.rdb.LLen(context.Background(), keyChat(e.world, sp.ChannelWhisper, convScope(alice.ID, bob.ID))).Result(); n != 0 {
		t.Fatalf("dropped whisper was stored (%d)", n)
	}
	// Block also hides Alice's public chat from Bob, and stops her invites.
	send(t, a, chat(sp.ChannelGlobal, "public line"))
	must(t, a, "own echo", client.Chat(sp.ChannelGlobal, "public line"))
	never(t, b, "blocked player's global chat hidden", 300*time.Millisecond, client.Chat(sp.ChannelGlobal, "public line"))
	send(t, a, sp.C2SPartyInvite{Type: sp.C2STypePartyInvite, Name: "Bob"})
	never(t, b, "blocked player's invite dropped", 300*time.Millisecond, client.Type(sp.S2CTypePartyInvite))
	// Bob whispering Alice while blocking her is refused for Bob.
	send(t, b, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Alice", Text: "x"})
	must(t, b, "blocker cannot whisper", client.WhisperStatus("Alice", sp.WhisperStatusNotAllowed))

	// Local profile: no global chat, whispers only to friends and party.
	d := e.connect(dave)
	send(t, d, chat(sp.ChannelGlobal, "hi all"))
	must(t, d, "local profile global refused", client.Error(sp.ErrorCodeNotAllowed))
	send(t, d, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Alice", Text: "hey stranger"})
	must(t, d, "local profile stranger whisper refused", client.WhisperStatus("Alice", sp.WhisperStatusNotAllowed))
	send(t, d, sp.C2SFriendRequest{Type: sp.C2STypeFriendRequest, Name: "Alice"})
	must(t, a, "friend request system line", client.Chat(sp.ChannelSystem, "Dave sent you a friend request."))
	send(t, a, sp.C2SFriendRespond{Type: sp.C2STypeFriendRespond, Name: "Dave", Accept: true})
	must(t, d, "friends list with Alice online", func(f client.Frame) bool {
		var fr sp.S2CFriends
		return f.Type == sp.S2CTypeFriends && f.Decode(&fr) == nil && len(fr.Friends) == 1 &&
			fr.Friends[0].Name == "Alice" && fr.Friends[0].State == sp.FriendStateAccepted && fr.Friends[0].Online
	})
	send(t, d, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Alice", Text: "hey friend"})
	must(t, a, "local profile whisper to friend", client.Chat(sp.ChannelWhisper, "hey friend"))
	// They can read global chat.
	send(t, b, chat(sp.ChannelGlobal, "readable by all"))
	must(t, d, "local profile reads global", client.Chat(sp.ChannelGlobal, "readable by all"))
}

func TestRateLimitsAndLength(t *testing.T) {
	e := newEnv(t, nil)
	a := e.connect(e.player("Alice"))
	send(t, a, presence("1,1", 10, 10, "zone-1"))

	send(t, a, chat(sp.ChannelGlobal, "one"))
	must(t, a, "first global", client.Chat(sp.ChannelGlobal, "one"))
	send(t, a, chat(sp.ChannelGlobal, "two"))
	must(t, a, "slow mode", client.Error(sp.ErrorCodeSlowMode))

	lim := DefaultLimits()
	for i := 0; i < int(lim.ZoneBurst)+3; i++ {
		send(t, a, chat(sp.ChannelZone, "z"+string(rune('a'+i))))
	}
	must(t, a, "zone rate limited", client.Error(sp.ErrorCodeRateLimited))
	time.Sleep(300 * time.Millisecond)
	if got := a.Count(func(f client.Frame) bool {
		var m sp.S2CChat
		return f.Type == sp.S2CTypeChat && f.Decode(&m) == nil && m.Message.Channel == sp.ChannelZone
	}); got != int(lim.ZoneBurst) {
		t.Fatalf("zone burst: %d accepted, want %d", got, int(lim.ZoneBurst))
	}

	send(t, a, chat(sp.ChannelParty, strings.Repeat("x", constants.ChatMaxLen+1)))
	must(t, a, "too long", client.Error(sp.ErrorCodeTooLong))
	send(t, a, chat(sp.ChannelSystem, "fake loot"))
	must(t, a, "system channel refused", client.Error(sp.ErrorCodeNotAllowed))
}

func TestHistoryOnJoinAndFilter(t *testing.T) {
	e := newEnv(t, nil)
	alice, bob := e.player("Alice"), e.player("Bob")
	a := e.connect(alice)
	b := e.connect(bob)
	send(t, a, chat(sp.ChannelGlobal, "what the fuck is that"))
	must(t, b, "filtered by default", client.Chat(sp.ChannelGlobal, "what the **** is that"))
	must(t, a, "sender also filtered", client.Chat(sp.ChannelGlobal, "what the **** is that"))
	send(t, a, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Bob", Text: "secret"})
	must(t, b, "whisper", client.Chat(sp.ChannelWhisper, "secret"))

	// Bob opts out and reconnects: history arrives unfiltered, whispers too,
	// and /r goes back to Alice from history alone.
	send(t, b, sp.C2SSetFilter{Type: sp.C2STypeSetFilter, Profanity: false})
	must(t, b, "relations filter off", func(f client.Frame) bool {
		var r sp.S2CRelations
		return f.Type == sp.S2CTypeRelations && f.Decode(&r) == nil && !r.ProfanityFilter
	})
	b.Close()
	time.Sleep(100 * time.Millisecond)
	b = e.connect(bob)
	must(t, b, "global history raw", func(f client.Frame) bool {
		var h sp.S2CHistory
		return f.Type == sp.S2CTypeHistory && f.Decode(&h) == nil && h.Channel == sp.ChannelGlobal &&
			len(h.Messages) == 1 && h.Messages[0].Text == "what the fuck is that"
	})
	must(t, b, "whisper history", func(f client.Frame) bool {
		var h sp.S2CHistory
		return f.Type == sp.S2CTypeHistory && f.Decode(&h) == nil && h.Channel == sp.ChannelWhisper &&
			h.Conversation == "Alice" && len(h.Messages) == 1 && h.Messages[0].Text == "secret"
	})
	send(t, b, sp.C2SReply{Type: sp.C2STypeReply, Text: "got it"})
	must(t, a, "reply after reconnect", client.Chat(sp.ChannelWhisper, "got it"))

	// Mute hides Alice from Bob everywhere, history included.
	send(t, b, sp.C2SMute{Type: sp.C2STypeMute, Name: "Alice"})
	must(t, b, "relations muted", func(f client.Frame) bool {
		var r sp.S2CRelations
		return f.Type == sp.S2CTypeRelations && f.Decode(&r) == nil && len(r.Muted) == 1
	})
	send(t, a, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Bob", Text: "muted line"})
	never(t, b, "muted whisper hidden", 300*time.Millisecond, client.Chat(sp.ChannelWhisper, "muted line"))
}

func TestPartyLifecycleAndReconnectGrace(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.PartyGrace = 1500 * time.Millisecond
		c.ReapEvery = 200 * time.Millisecond
	})
	ps := []*player{e.player("Ann"), e.player("Ben"), e.player("Cat"), e.player("Dan"), e.player("Eve")}
	cl := make([]*client.Client, len(ps))
	for i, p := range ps {
		cl[i] = e.connect(p)
	}
	invite := func(from, to int) {
		send(t, cl[from], sp.C2SPartyInvite{Type: sp.C2STypePartyInvite, Name: ps[to].Name})
	}
	accept := func(i int) {
		inv := partyInvite(cl[i], t)
		send(t, cl[i], sp.C2SPartyRespond{Type: sp.C2STypePartyRespond, PartyID: inv.PartyID, Accept: true})
	}
	// Ann invites Ben and Cat before either answers (two reserved party
	// ids); both acceptances must land in the same party.
	invite(0, 1)
	invite(0, 2)
	accept(1)
	must(t, cl[0], "party of 2", partyStateWith(2, ps[0].ID))
	accept(2)
	must(t, cl[0], "party of 3", partyStateWith(3, ps[0].ID))
	invite(0, 3)
	accept(3)
	must(t, cl[0], "party of 4", partyStateWith(4, ps[0].ID))
	invite(0, 4)
	must(t, cl[0], "party full", client.Error(sp.ErrorCodePartyFull))
	invite(1, 4)
	must(t, cl[1], "only leader invites", client.Error(sp.ErrorCodeNotLeader))

	// Promote, kick, leave.
	send(t, cl[0], sp.C2SPartyPromote{Type: sp.C2STypePartyPromote, Name: "ben"})
	must(t, cl[2], "Ben leads", partyStateWith(4, ps[1].ID))
	send(t, cl[1], sp.C2SPartyKick{Type: sp.C2STypePartyKick, Name: "Dan"})
	must(t, cl[3], "Dan kicked", client.Type(sp.S2CTypePartyLeft))
	must(t, cl[0], "party of 3", partyStateWith(3, ps[1].ID))
	send(t, cl[1], sp.C2SPartyLeave{Type: sp.C2STypePartyLeave})
	must(t, cl[1], "Ben left", client.Type(sp.S2CTypePartyLeft))
	f := must(t, cl[0], "leadership passes on", partyStateWith(2, ""))
	var st sp.S2CPartyState
	_ = f.Decode(&st)
	if st.LeaderID == ps[1].ID {
		t.Fatal("leaver kept leadership")
	}

	// Cat drops without a goodbye and comes back inside the grace period.
	cl[2].CloseNow()
	must(t, cl[0], "Cat shown offline", func(f client.Frame) bool {
		var s sp.S2CPartyState
		if f.Type != sp.S2CTypePartyState || f.Decode(&s) != nil {
			return false
		}
		for _, m := range s.Members {
			if m.Name == "Cat" && !m.Online {
				return true
			}
		}
		return false
	})
	time.Sleep(500 * time.Millisecond)
	cl[2] = e.connect(ps[2])
	must(t, cl[2], "Cat still in party after reconnect", partyStateWith(2, ""))
	time.Sleep(1500 * time.Millisecond) // past the original grace deadline
	if s, ok := lastPartyState(cl[0]); !ok || len(s.Members) != 2 {
		t.Fatalf("reconnect within grace must keep the party, got %+v ok=%v", s, ok)
	}

	// Cat drops again and stays away: after the grace period the party of
	// two disbands.
	cl[2].CloseNow()
	if _, err := cl[0].WaitFor(contextT(t, 5*time.Second), client.Type(sp.S2CTypePartyLeft)); err != nil {
		t.Fatalf("party should disband after grace: %v", err)
	}
	if n, _ := e.rdb.Exists(context.Background(), keyPartyOf(ps[0].ID), keyPartyOf(ps[2].ID)).Result(); n != 0 {
		t.Fatalf("partyof pointers left behind: %d", n)
	}
}

func contextT(t *testing.T, d time.Duration) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}

func TestFriendsReportsAndDuplicateLogin(t *testing.T) {
	e := newEnv(t, nil)
	alice, bob := e.player("Alice"), e.player("Bob")
	a, b := e.connect(alice), e.connect(bob)
	send(t, b, presence("2,3", 2100, 3100, "zone-7"))

	send(t, a, sp.C2SFriendRequest{Type: sp.C2STypeFriendRequest, Name: "bob"})
	must(t, b, "pending in", func(f client.Frame) bool {
		var fr sp.S2CFriends
		return f.Type == sp.S2CTypeFriends && f.Decode(&fr) == nil && len(fr.Friends) == 1 && fr.Friends[0].State == sp.FriendStatePendingIn
	})
	// Asking back accepts.
	send(t, b, sp.C2SFriendRequest{Type: sp.C2STypeFriendRequest, Name: "alice"})
	must(t, a, "accepted, online, region", func(f client.Frame) bool {
		var fr sp.S2CFriends
		return f.Type == sp.S2CTypeFriends && f.Decode(&fr) == nil && len(fr.Friends) == 1 &&
			fr.Friends[0].State == sp.FriendStateAccepted && fr.Friends[0].Online && fr.Friends[0].Region == "2,3"
	})

	// Bob goes offline: Alice's list updates.
	b.Close()
	must(t, a, "friend offline", func(f client.Frame) bool {
		var fr sp.S2CFriends
		return f.Type == sp.S2CTypeFriends && f.Decode(&fr) == nil && len(fr.Friends) == 1 && !fr.Friends[0].Online
	})
	b = e.connect(bob)

	// Report with context.
	send(t, b, chat(sp.ChannelGlobal, "rude thing"))
	must(t, a, "line to report", client.Chat(sp.ChannelGlobal, "rude thing"))
	send(t, a, sp.C2SReport{Type: sp.C2STypeReport, Name: "Bob", Channel: sp.ChannelGlobal, Reason: "rude"})
	must(t, a, "report ack", func(f client.Frame) bool {
		var s sp.S2CSystem
		return f.Type == sp.S2CTypeSystem && f.Decode(&s) == nil && strings.Contains(s.Text, "report about Bob")
	})
	var ctxJSON []byte
	var reportedName, reason string
	if err := e.pool.QueryRow(context.Background(), `SELECT context, reported_name, reason FROM reports WHERE reporter = $1::uuid`, alice.ID).Scan(&ctxJSON, &reportedName, &reason); err != nil {
		t.Fatal(err)
	}
	var rc struct{ Messages []sp.ChatMessage }
	_ = json.Unmarshal(ctxJSON, &rc)
	if reportedName != "Bob" || reason != "rude" || len(rc.Messages) == 0 || rc.Messages[len(rc.Messages)-1].Text != "rude thing" {
		t.Fatalf("report row: name=%q reason=%q context=%s", reportedName, reason, ctxJSON)
	}

	// Duplicate login: the newer socket wins.
	a2 := e.connect(alice)
	must(t, a, "old socket replaced", client.Error(sp.ErrorCodeReplaced))
	send(t, b, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Alice", Text: "which window?"})
	must(t, a2, "new socket gets whispers", client.Chat(sp.ChannelWhisper, "which window?"))
}

func TestBadTicketsRefused(t *testing.T) {
	e := newEnv(t, nil)
	ctx := ctx5(t)
	if _, _, err := client.Connect(ctx, e.url, "garbage"); err == nil || !strings.Contains(err.Error(), "bad_auth") {
		t.Fatalf("garbage ticket: %v", err)
	}
	// A zone ticket is not a social ticket.
	p := e.player("Zed")
	if _, _, err := client.Connect(ctx, e.url, signZoneTicket(e, p)); err == nil || !strings.Contains(err.Error(), "bad_auth") {
		t.Fatalf("zone-audience ticket: %v", err)
	}
}

func TestAdminMuteAndBan(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	// Real rows: moderation acts on accounts, found by character name.
	var accID, charID string
	if err := e.pool.QueryRow(ctx, `INSERT INTO accounts (auth_provider, auth_subject) VALUES ('dev', $1) RETURNING id::text`, "wp08-"+accountapi.NewUUID()).Scan(&accID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `INSERT INTO worlds (id, name, seed, spec, gen_version, atlas_hash) VALUES ($1::uuid, 't', 1, '{}', 'x', 'x')`, e.world); err != nil {
		t.Fatal(err)
	}
	if err := e.pool.QueryRow(ctx, `INSERT INTO characters (account_id, world_id, name) VALUES ($1::uuid, $2::uuid, 'Troll') RETURNING id::text`, accID, e.world).Scan(&charID); err != nil {
		t.Fatal(err)
	}
	troll := &player{ID: charID, Name: "Troll", AccountID: accID}
	e.chars = append(e.chars, charID)
	c := e.connect(troll)
	admin := &Admin{Store: e.hub.store, RDB: e.rdb, Actor: "test"}

	if _, err := admin.Apply(ctx, "mute", "", "troll", "spam"); err != nil {
		t.Fatal(err)
	}
	must(t, c, "mute notice", func(f client.Frame) bool {
		var s sp.S2CSystem
		return f.Type == sp.S2CTypeSystem && f.Decode(&s) == nil && strings.Contains(s.Text, "muted by a moderator")
	})
	send(t, c, chat(sp.ChannelLocal, "spam"))
	must(t, c, "muted cannot chat", client.Error(sp.ErrorCodeMuted))

	if _, err := admin.Apply(ctx, "ban", e.world, "Troll", "repeat"); err != nil {
		t.Fatal(err)
	}
	must(t, c, "banned and closed", client.Error(sp.ErrorCodeBanned))
	if _, _, err := client.Connect(ctx5(t), e.url, e.ticket(troll)); err == nil || !strings.Contains(err.Error(), "banned") {
		t.Fatalf("banned account must be refused on connect: %v", err)
	}
	var n int
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM moderation_log WHERE subject_id = $1`, accID).Scan(&n)
	if n != 2 {
		t.Fatalf("moderation_log rows = %d, want 2", n)
	}
}
