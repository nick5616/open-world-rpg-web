package main

// Process-boundary test: builds the social binary, runs TWO social processes
// against the same Redis and a scratch Postgres database, and checks that
// players on different processes (presenting different zones) chat, whisper
// and party together, that blocks hold across processes, and that a process
// killed without cleanup has its sessions reaped by the survivor
// (the-circle reap_dead behaviour).

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/accountapi/dbtest"
	sp "lodestone/server/pkg/socialproto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/social/internal/client"
)

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type proc struct {
	cmd  *exec.Cmd
	url  string
	port int
	log  *os.File
}

func startSocial(t *testing.T, bin, pgURL string) *proc {
	t.Helper()
	port := freePort(t)
	logf, err := os.Create(filepath.Join(t.TempDir(), fmt.Sprintf("social-%d.log", port)))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_SOCIAL_PORT=%d", port),
		"LODESTONE_PG_URL="+pgURL,
		"LODESTONE_SOCIAL_PRESENCE_TTL=2s", // short so the reaper test is quick
		"LODESTONE_SOCIAL_REAP_EVERY=300ms",
	)
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &proc{cmd: cmd, port: port, url: fmt.Sprintf("ws://127.0.0.1:%d/ws", port), log: logf}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		logf.Close()
		if t.Failed() {
			b, _ := os.ReadFile(logf.Name())
			t.Logf("social :%d log:\n%s", port, b)
		}
	})
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if r, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port)); err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				return p
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("social process did not become healthy")
	return nil
}

func TestTwoProcessesAcrossZones(t *testing.T) {
	_, pgURL := dbtest.Postgres(t)
	rdb := dbtest.Redis(t)
	bin := filepath.Join(t.TempDir(), "social")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	pa, pb := startSocial(t, bin, pgURL), startSocial(t, bin, pgURL)

	world := accountapi.NewUUID()
	priv, _, _ := ticket.PrivateKeyFromEnv()
	type pl struct{ id, name string }
	alice := pl{accountapi.NewUUID(), "Alice"}
	bob := pl{accountapi.NewUUID(), "Bob"}
	t.Cleanup(func() {
		ctx := context.Background()
		var keys []string
		iter := rdb.Scan(ctx, 0, "*"+world+"*", 1000).Iterator()
		for iter.Next(ctx) {
			keys = append(keys, iter.Val())
		}
		for _, p := range []pl{alice, bob} {
			keys = append(keys, "presence:"+p.id, "charname:"+p.id, "partyof:"+p.id, "partyinv:"+p.id)
		}
		rdb.Del(ctx, keys...)
		rdb.SRem(ctx, "social:worlds", world)
	})
	tk := func(p pl) string {
		return ticket.Sign(priv, ticket.Claims{AccountID: accountapi.NewUUID(), CharacterID: p.id, CharacterName: p.name,
			WorldID: world, Audience: ticket.AudienceSocial})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	a, _, err := client.Connect(ctx, pa.url, tk(alice))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, _, err := client.Connect(ctx, pb.url, tk(bob))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	wait := func(c *client.Client, what string, m func(client.Frame) bool) client.Frame {
		t.Helper()
		wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
		defer wcancel()
		f, err := c.WaitFor(wctx, m)
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		return f
	}
	sendTo := func(c *client.Client, v any) {
		t.Helper()
		if err := c.Send(ctx, v); err != nil {
			t.Fatal(err)
		}
	}

	// Different zone servers, different regions, different social processes.
	sendTo(a, sp.C2SPresence{Type: sp.C2STypePresence, Region: "0,0", X: 100, Z: 100, ZoneID: "zone-west"})
	sendTo(b, sp.C2SPresence{Type: sp.C2STypePresence, Region: "3,3", X: 3900, Z: 3900, ZoneID: "zone-east"})
	time.Sleep(200 * time.Millisecond)

	sendTo(a, sp.C2SChatSend{Type: sp.C2STypeChatSend, Channel: sp.ChannelGlobal, Text: "cross-process global"})
	wait(b, "global across processes", client.Chat(sp.ChannelGlobal, "cross-process global"))

	sendTo(a, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "bob", Text: "west to east"})
	wait(b, "whisper across processes and zones", client.Chat(sp.ChannelWhisper, "west to east"))
	wait(a, "delivered", client.WhisperStatus("Bob", sp.WhisperStatusDelivered))
	sendTo(b, sp.C2SReply{Type: sp.C2STypeReply, Text: "east to west"})
	wait(a, "reply across processes", client.Chat(sp.ChannelWhisper, "east to west"))

	sendTo(a, sp.C2SPartyInvite{Type: sp.C2STypePartyInvite, Name: "Bob"})
	var inv sp.S2CPartyInvite
	_ = wait(b, "invite", client.Type(sp.S2CTypePartyInvite)).Decode(&inv)
	sendTo(b, sp.C2SPartyRespond{Type: sp.C2STypePartyRespond, PartyID: inv.PartyID, Accept: true})
	wait(a, "party state on A", func(f client.Frame) bool {
		var ps sp.S2CPartyState
		return f.Type == sp.S2CTypePartyState && f.Decode(&ps) == nil && len(ps.Members) == 2
	})
	sendTo(b, sp.C2SChatSend{Type: sp.C2STypeChatSend, Channel: sp.ChannelParty, Text: "party across processes"})
	wait(a, "party chat across processes", client.Chat(sp.ChannelParty, "party across processes"))

	// Block on process B drops whispers sent from process A.
	sendTo(b, sp.C2SBlock{Type: sp.C2STypeBlock, Name: "Alice"})
	wait(b, "relations", client.Type(sp.S2CTypeRelations))
	time.Sleep(100 * time.Millisecond)
	before := b.Count(client.Type(sp.S2CTypeChat))
	cursor := a.Len()
	sendTo(a, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Bob", Text: "blocked line"})
	wctx0, wcancel0 := context.WithTimeout(ctx, 5*time.Second)
	if _, err := a.WaitNew(wctx0, cursor, client.WhisperStatus("Bob", sp.WhisperStatusDelivered)); err != nil {
		t.Fatalf("blocked whisper must still say delivered: %v", err)
	}
	wcancel0()
	time.Sleep(300 * time.Millisecond)
	// Only the blocked line matters: unrelated system/party chat (e.g. a late
	// party notice) may legitimately arrive in this window and made the old
	// total-count check flaky under load.
	_ = before
	if b.Count(client.Chat(sp.ChannelWhisper, "blocked line")) != 0 {
		t.Fatal("blocked whisper reached Bob across processes")
	}

	// Kill process B without cleanup: A's reaper notices Bob's presence
	// lapsed and shows him offline in the party.
	_ = pb.cmd.Process.Kill()
	wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
	defer wcancel()
	if _, err := a.WaitFor(wctx, func(f client.Frame) bool {
		var ps sp.S2CPartyState
		if f.Type != sp.S2CTypePartyState || f.Decode(&ps) != nil {
			return false
		}
		for _, m := range ps.Members {
			if m.Name == "Bob" && !m.Online {
				return true
			}
		}
		return false
	}); err != nil {
		t.Fatalf("dead process's session was not reaped: %v", err)
	}
	if v, _ := rdb.HGet(context.Background(), "online:"+world, bob.id).Result(); v != "" {
		t.Fatal("reaper left Bob in the online set")
	}
	sendTo(a, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Bob", Text: "still there?"})
	wait(a, "offline after reap", client.WhisperStatus("Bob", sp.WhisperStatusOffline))
}
