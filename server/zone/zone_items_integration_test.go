package main

// Items across process boundaries (WP14 acceptance): the real zone binary on
// the default world (seed 20261108), a scratch Postgres with real character
// rows, clients over WebSocket.
//
//   - TestZoneProcessKillMidGrantNeverDuplicates: the zone process is
//     KILLED (TerminateProcess / SIGKILL, no shutdown path) while an item
//     grant's transaction is open, and again right after it committed, and
//     during a new character's starter grant; after every restart the
//     player opens the same container again. Postgres must hold every roll
//     exactly once (spec 11: "a crash can lose a roll but never duplicate
//     one").
//   - TestZoneProcessDropPickupDespawn: a dropped item is a public pickup
//     another player takes (owner and provenance change in Postgres), a
//     dropped item survives a zone restart, and despawns on the (shortened)
//     timer with its row deleted.
//
// Set LODESTONE_EVIDENCE=1 to print the step log (docs/evidence/wp14-*).

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/game"
)

const itemsZoneID = "zone-itest-items"

type syncBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type itemZone struct {
	cmd  *exec.Cmd
	logs *syncBuf
	port int
}

func startItemZone(t *testing.T, bin, wasm, dbURL, world string, port int, extra ...string) *itemZone {
	t.Helper()
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", port),
		"LODESTONE_ZONE_ID="+itemsZoneID,
		"LODESTONE_WORLD_ID="+world,
		"LODESTONE_WORLD_SEED=20261108",
		"LODESTONE_GEN_VERSION=dev",
		"LODESTONE_WORLDGEN_WASM="+wasm,
		"LODESTONE_PG_URL="+dbURL,
		"LODESTONE_ZONE_NO_REDIS=1",
		"LODESTONE_ZONE_WT_ADDR=off",
		"LODESTONE_ZONE_EXIT_AFTER=120s",
		"LODESTONE_ZONE_NO_ATLAS_ENEMIES=1",
	)
	cmd.Env = append(cmd.Env, extra...)
	z := &itemZone{cmd: cmd, logs: &syncBuf{}, port: port}
	cmd.Stdout, cmd.Stderr = z.logs, z.logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { z.kill() })
	waitHealthy(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	return z
}

// kill ends the process the hard way: no shutdown, no queue flush.
func (z *itemZone) kill() {
	if z.cmd.ProcessState == nil {
		_ = z.cmd.Process.Kill()
		_ = z.cmd.Wait()
	}
}

func (z *itemZone) waitLog(t *testing.T, substr string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !strings.Contains(z.logs.String(), substr) {
		if time.Now().After(deadline) {
			t.Fatalf("zone never logged %q; logs:\n%s", substr, tail(z.logs.String(), 40))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func tail(s string, n int) string {
	l := strings.Split(s, "\n")
	if len(l) > n {
		l = l[len(l)-n:]
	}
	return strings.Join(l, "\n")
}

type itemClient struct {
	t    *testing.T
	c    transport.Conn
	msgs chan proto.Message
	evs  []*proto.Event
	ents map[uint32]string // pickups seen in the latest snapshots (approximate: names on first sight)
	mu   sync.Mutex
}

func dialItems(t *testing.T, port int, world, char, name string, x, z float64) *itemClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := transport.DialWebSocket(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws?spawn=%s,%s", port, strconv.FormatFloat(x, 'f', 2, 64), strconv.FormatFloat(z, 'f', 2, 64)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(transport.CloseNormal, "") })
	priv, _, _ := ticket.PrivateKeyFromEnv()
	tk := ticket.Sign(priv, ticket.Claims{AccountID: "acct-" + char, CharacterID: char, CharacterName: name, WorldID: world, Audience: ticket.AudienceZone(itemsZoneID)})
	if err := c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: proto.TransportWebsocket})); err != nil {
		t.Fatal(err)
	}
	w := &itemClient{t: t, c: c, msgs: make(chan proto.Message, 8192), ents: map[uint32]string{}}
	go func() {
		defer close(w.msgs)
		for {
			b, err := c.Recv(context.Background())
			if err != nil {
				return
			}
			if m, err := proto.DecodeMessage(b); err == nil {
				w.msgs <- m
			}
		}
	}()
	return w
}

func (w *itemClient) pump(d time.Duration) {
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-w.msgs:
			if !ok {
				return
			}
			if e, ok := m.(*proto.Event); ok {
				w.evs = append(w.evs, e)
			}
		case <-deadline:
			return
		}
	}
}

func (w *itemClient) last(kind uint16, d time.Duration) *proto.Event {
	w.t.Helper()
	deadline := time.Now().Add(d)
	for {
		for i := len(w.evs) - 1; i >= 0; i-- {
			if w.evs[i].Kind == kind {
				return w.evs[i]
			}
		}
		if time.Now().After(deadline) {
			w.t.Fatalf("no event %d", kind)
		}
		w.pump(50 * time.Millisecond)
	}
}

func (w *itemClient) count(kind uint16) int {
	n := 0
	for _, e := range w.evs {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

type invJSON struct {
	Gold  int `json:"gold"`
	Items []struct {
		H    uint32   `json:"h"`
		B    string   `json:"b"`
		Q    int      `json:"q"`
		S    string   `json:"s"`
		V    bool     `json:"v"`
		T    bool     `json:"t"`
		P    int      `json:"p"`
		Sock []string `json:"k"`
	} `json:"items"`
}

func (w *itemClient) inventory() invJSON {
	var inv invJSON
	_ = json.Unmarshal(w.last(game.EventInventory, 3*time.Second).Data, &inv)
	return inv
}

func (w *itemClient) interact(kind uint8, id uint64, action uint8, arg uint32) {
	_ = w.c.SendReliable(proto.Encode(&proto.Interact{TargetKind: kind, TargetID: id, Action: action, Arg: arg}))
}

// containers decodes the newest Event 406.
func (w *itemClient) containers() []struct {
	ID      uint64
	X, Y, Z float64
	Opened  bool
} {
	ev := w.last(game.EventContainers, 5*time.Second)
	b := ev.Data
	n := int(binary.LittleEndian.Uint16(b[1:]))
	out := make([]struct {
		ID      uint64
		X, Y, Z float64
		Opened  bool
	}, 0, n)
	o := 3
	for i := 0; i < n; i++ {
		var c struct {
			ID      uint64
			X, Y, Z float64
			Opened  bool
		}
		c.ID = binary.LittleEndian.Uint64(b[o:])
		c.X = float64(int32(binary.LittleEndian.Uint32(b[o+8:]))) / 100
		c.Y = float64(int32(binary.LittleEndian.Uint32(b[o+12:]))) / 100
		c.Z = float64(int32(binary.LittleEndian.Uint32(b[o+16:]))) / 100
		c.Opened = b[o+21] == 1
		o += 22
		out = append(out, c)
	}
	return out
}

type itemFixture struct {
	t      *testing.T
	pool   *pgxpool.Pool
	dbURL  string
	world  string
	bin    string
	wasm   string
	spawnX float64
	spawnZ float64
	log    *strings.Builder
}

func (f *itemFixture) logf(format string, a ...any) {
	line := fmt.Sprintf("[%s] ", time.Now().Format("15:04:05.000")) + fmt.Sprintf(format, a...)
	f.log.WriteString(line + "\n")
	f.t.Log(line)
}

func newItemFixture(t *testing.T) *itemFixture {
	if testing.Short() {
		t.Skip("builds and runs the zone binary")
	}
	mod, wasmPath := terrainWasm(t)
	pool, dbURL := dbtest.Postgres(t)
	ctx := context.Background()
	mt, err := mod.Mint(20261108, nil, worldhost.WorldOptions{MaxInstances: 2})
	if err != nil {
		t.Fatal(err)
	}
	var world string
	if err := pool.QueryRow(ctx, `INSERT INTO worlds (name, seed, spec, gen_version, atlas_hash) VALUES ($1, 20261108, $2::jsonb, $3, $4) RETURNING id::text`,
		mt.Name, string(mt.Spec), mt.GenVersion, mt.AtlasHash).Scan(&world); err != nil {
		t.Fatal(err)
	}
	a, err := structures.ParseAtlas(mt.World.Atlas)
	if err != nil {
		t.Fatal(err)
	}
	return &itemFixture{t: t, pool: pool, dbURL: dbURL, world: world, bin: buildZone(t), wasm: wasmPath, spawnX: a.SpawnX, spawnZ: a.SpawnZ, log: &strings.Builder{}}
}

func (f *itemFixture) character(name string) string {
	f.t.Helper()
	ctx := context.Background()
	var acct, char string
	if err := f.pool.QueryRow(ctx, `INSERT INTO accounts (auth_provider, auth_subject) VALUES ('dev', $1) RETURNING id::text`, name+strconv.FormatInt(time.Now().UnixNano(), 36)).Scan(&acct); err != nil {
		f.t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `INSERT INTO characters (account_id, world_id, name) VALUES ($1::uuid, $2::uuid, $3) RETURNING id::text`, acct, f.world, name).Scan(&char); err != nil {
		f.t.Fatal(err)
	}
	return char
}

// dbUnits sums qty per base for a character.
func (f *itemFixture) dbUnits(char string) map[string]int {
	rows, err := f.pool.Query(context.Background(), `SELECT base_id, sum(qty)::int FROM items WHERE owner_character_id = $1::uuid GROUP BY base_id`, char)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var b string
		var n int
		_ = rows.Scan(&b, &n)
		out[b] = n
	}
	return out
}

func (f *itemFixture) markers(char, prefix string) int {
	var n int
	_ = f.pool.QueryRow(context.Background(), `SELECT count(*) FROM loot_grants WHERE character_id = $1::uuid AND grant_key LIKE $2`, char, prefix+"%").Scan(&n)
	return n
}

func fmtUnits(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%d ", k, m[k])
	}
	return strings.TrimSpace(b.String())
}

// grantedUnits sums Event 401 entries of one source.
func grantedUnits(w *itemClient, source uint32) map[string]int {
	out := map[string]int{}
	for _, e := range w.evs {
		if e.Kind != game.EventLootGranted || e.TargetID != source {
			continue
		}
		var list []struct {
			B string `json:"b"`
			Q int    `json:"q"`
		}
		_ = json.Unmarshal(e.Data, &list)
		for _, x := range list {
			out[x.B] += x.Q
		}
	}
	return out
}

// pickContainers finds containers near the spawn (the zone lists them once
// their chunks are cached around a player).
func (f *itemFixture) pickContainers(port int, n int) []struct {
	ID      uint64
	X, Y, Z float64
	Opened  bool
} {
	f.t.Helper()
	scout := dialItems(f.t, port, f.world, f.character("Scout"), "Scout", f.spawnX, f.spawnZ)
	defer scout.c.Close(transport.CloseNormal, "")
	deadline := time.Now().Add(20 * time.Second)
	for {
		scout.pump(500 * time.Millisecond)
		var list []struct {
			ID   string  `json:"id"`
			X    float64 `json:"x"`
			Y    float64 `json:"y"`
			Z    float64 `json:"z"`
			Kind string  `json:"kind"`
		}
		_ = json.Unmarshal([]byte(get(f.t, fmt.Sprintf("http://127.0.0.1:%d/debug/containers?x=%f&z=%f&r=200", port, f.spawnX, f.spawnZ))), &list)
		if len(list) >= n {
			out := make([]struct {
				ID      uint64
				X, Y, Z float64
				Opened  bool
			}, 0, len(list))
			for _, c := range list {
				id, _ := strconv.ParseUint(c.ID, 10, 64)
				out = append(out, struct {
					ID      uint64
					X, Y, Z float64
					Opened  bool
				}{ID: id, X: c.X, Y: c.Y, Z: c.Z})
			}
			sort.Slice(out, func(i, j int) bool {
				return math.Hypot(out[i].X-f.spawnX, out[i].Z-f.spawnZ) < math.Hypot(out[j].X-f.spawnX, out[j].Z-f.spawnZ)
			})
			return out[:n]
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("fewer than %d containers near the spawn (%.0f, %.0f)", n, f.spawnX, f.spawnZ)
		}
	}
}

func TestZoneProcessKillMidGrantNeverDuplicates(t *testing.T) {
	f := newItemFixture(t)
	port := freePort(t)
	f.logf("world %s, spawn settlement at (%.1f, %.1f)", f.world, f.spawnX, f.spawnZ)

	// Find containers with a plain zone.
	z := startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port)
	cs := f.pickContainers(port, 2)
	z.kill()
	for i, c := range cs {
		f.logf("container %d: id %d at (%.1f, %.1f, %.1f)", i, c.ID, c.X, c.Y, c.Z)
	}
	char := f.character("Grantee")
	f.logf("character %s", char)

	// ---- 1. Kill DURING the starter grant of a brand-new character, then
	// during the container grant, both while the transaction is open. ----
	z = startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port, "LODESTONE_ZONE_TEST_ITEM_TX_DELAY_MS=1500")
	p := dialItems(t, port, f.world, char, "Grantee", cs[0].X+1.0, cs[0].Z)
	z.waitLog(t, `"note":"starter"`, 10*time.Second)
	f.logf("starter grant transaction open (held 1.5 s before COMMIT); killing the zone process")
	z.kill()
	f.logf("after kill #1: DB units %q, markers starter=%d", fmtUnits(f.dbUnits(char)), f.markers(char, "starter"))
	if u := f.dbUnits(char); len(u) != 0 || f.markers(char, "starter") != 0 {
		t.Fatalf("an uncommitted grant left rows: %v", u)
	}

	z = startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port, "LODESTONE_ZONE_TEST_ITEM_TX_DELAY_MS=1500")
	p = dialItems(t, port, f.world, char, "Grantee", cs[0].X+1.0, cs[0].Z)
	p.pump(2500 * time.Millisecond) // starter (re-granted: it never landed) commits after 1.5 s
	z.waitLog(t, `"note":"starter"`, 5*time.Second)
	p.interact(game.InteractContainer, cs[0].ID, game.ActionUse, 0)
	p.last(game.EventContainerOpened, 5*time.Second)
	firstRoll := grantedUnits(p, game.SourceContainer)
	f.logf("container 0 opened in game: %q", fmtUnits(firstRoll))
	z.waitLog(t, `"note":"container"`, 5*time.Second)
	f.logf("container grant transaction open; killing the zone process")
	z.kill()
	after2 := f.dbUnits(char)
	f.logf("after kill #2: DB units %q, markers container=%d starter=%d", fmtUnits(after2), f.markers(char, "container:"), f.markers(char, "starter"))
	if f.markers(char, "container:") != 0 || f.markers(char, "starter") != 1 || after2["potion:health"] != 3 || after2["currency:gold"] != 20 {
		t.Fatalf("after a kill mid container grant: starter once, container not granted; got %v", after2)
	}

	// ---- 2. Restart; open the same container again: granted (same seed,
	// same roll), once. Then kill right AFTER the commit. ----
	z = startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port, "LODESTONE_ZONE_TEST_ITEM_COMMIT_DELAY_MS=2000")
	p = dialItems(t, port, f.world, char, "Grantee", cs[0].X+1.0, cs[0].Z)
	p.pump(2000 * time.Millisecond)
	p.interact(game.InteractContainer, cs[0].ID, game.ActionUse, 0)
	p.last(game.EventContainerOpened, 5*time.Second)
	reroll := grantedUnits(p, game.SourceContainer)
	f.logf("container 0 re-opened after the crash: %q (same seed: same roll)", fmtUnits(reroll))
	if fmtUnits(reroll) != fmtUnits(firstRoll) {
		t.Fatalf("the re-roll differs: %v vs %v", reroll, firstRoll)
	}
	z.waitLog(t, "TEST item tx committed", 5*time.Second)
	f.logf("container grant COMMITTED; killing the zone process before it hears back")
	z.kill()
	after3 := f.dbUnits(char)
	f.logf("after kill #3: DB units %q, markers container=%d", fmtUnits(after3), f.markers(char, "container:"))
	if f.markers(char, "container:") != 1 {
		t.Fatalf("committed grant not marked")
	}
	want := map[string]int{"potion:health": 3, "currency:gold": 20}
	for k, v := range firstRoll {
		want[k] += v
	}
	if fmtUnits(after3) != fmtUnits(want) {
		t.Fatalf("DB %q, want starter + one roll %q", fmtUnits(after3), fmtUnits(want))
	}

	// ---- 3. Restart; the container is opened for this character: refused.
	// A second container under a commit kill, then a clean session. ----
	z = startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port, "LODESTONE_ZONE_TEST_ITEM_COMMIT_DELAY_MS=2000")
	p = dialItems(t, port, f.world, char, "Grantee", cs[0].X+1.0, cs[0].Z)
	p.pump(2000 * time.Millisecond)
	p.interact(game.InteractContainer, cs[0].ID, game.ActionUse, 0)
	ref := p.last(game.EventItemRefused, 5*time.Second)
	f.logf("container 0 again: refused, reason %d (8 = already opened)", ref.Value)
	if ref.Value != game.ItemRefuseOpened {
		t.Fatalf("refusal %d", ref.Value)
	}
	if fmtUnits(f.dbUnits(char)) != fmtUnits(want) {
		t.Fatal("refused open changed the database")
	}
	p.c.Close(transport.CloseNormal, "")
	p = dialItems(t, port, f.world, char, "Grantee", cs[1].X+1.0, cs[1].Z)
	p.pump(2000 * time.Millisecond)
	p.interact(game.InteractContainer, cs[1].ID, game.ActionUse, 0)
	p.last(game.EventContainerOpened, 5*time.Second)
	second := grantedUnits(p, game.SourceContainer)
	z.waitLog(t, "TEST item tx committed", 5*time.Second)
	z.kill()
	for k, v := range second {
		want[k] += v
	}
	f.logf("container 1 opened %q, committed, killed; DB units %q", fmtUnits(second), fmtUnits(f.dbUnits(char)))

	z = startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port)
	p = dialItems(t, port, f.world, char, "Grantee", cs[1].X+1.0, cs[1].Z)
	p.pump(2000 * time.Millisecond)
	inv := p.inventory()
	got := map[string]int{}
	for _, it := range inv.Items {
		got[it.B] += it.Q
	}
	for _, c := range cs {
		p.interact(game.InteractContainer, c.ID, game.ActionUse, 0)
	}
	p.pump(800 * time.Millisecond)
	f.logf("clean restart: inventory in game %q; both containers refused (%d refusals)", fmtUnits(got), p.count(game.EventItemRefused))
	final := f.dbUnits(char)
	f.logf("final DB units %q; want %q; loot_grants: starter=%d container=%d", fmtUnits(final), fmtUnits(want), f.markers(char, "starter"), f.markers(char, "container:"))
	if fmtUnits(final) != fmtUnits(want) || fmtUnits(got) != fmtUnits(want) || f.markers(char, "container:") != 2 || f.markers(char, "starter") != 1 || p.count(game.EventItemRefused) != 2 {
		t.Fatalf("duplication or loss: DB %q game %q want %q", fmtUnits(final), fmtUnits(got), fmtUnits(want))
	}
	f.logf("PASS: 4 hard kills mid-grant (2 with the transaction open, 2 right after COMMIT): every roll exactly once in Postgres")
	z.kill()
	if os.Getenv("LODESTONE_EVIDENCE") == "1" {
		fmt.Print(f.log.String())
	}
}

func TestZoneProcessDropPickupDespawn(t *testing.T) {
	f := newItemFixture(t)
	port := freePort(t)
	a, b := f.character("Dropper"), f.character("Finder")
	z := startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port, "LODESTONE_ZONE_DROP_DESPAWN=8s")
	x, zz := f.spawnX+20, f.spawnZ+20
	ca := dialItems(t, port, f.world, a, "Dropper", x, zz)
	cb := dialItems(t, port, f.world, b, "Finder", x+1.5, zz)
	ca.pump(1500 * time.Millisecond)
	cb.pump(500 * time.Millisecond)
	var pot uint32
	for _, it := range ca.inventory().Items {
		if it.B == "potion:health" {
			pot = it.H
		}
	}
	ca.interact(game.InteractItem, uint64(pot), game.ItemActDrop, 1)
	d := ca.last(game.EventDropped, 3*time.Second)
	f.logf("Dropper dropped 1 potion:health -> public pickup entity %d", d.EntityID)
	var itemID string
	deadline := time.Now().Add(5 * time.Second)
	for itemID == "" && time.Now().Before(deadline) {
		_ = f.pool.QueryRow(context.Background(), `SELECT id::text FROM items WHERE owner_character_id IS NULL AND world_id = $1::uuid AND base_id = 'potion:health'`, f.world).Scan(&itemID)
		time.Sleep(50 * time.Millisecond)
	}
	if itemID == "" {
		t.Fatal("dropped item has no world row")
	}
	f.logf("Postgres: item %s lies in the world (owner NULL, despawn_at set)", itemID)
	cb.interact(game.InteractPickup, uint64(d.EntityID), game.ActionUse, 0)
	tk := cb.last(game.EventItemTaken, 3*time.Second)
	f.logf("Finder took it: Event 411 qty %d %s", tk.Value, tk.Data)
	var owner string
	var prov []byte
	var tradeable, verified bool
	deadline = time.Now().Add(5 * time.Second)
	for owner != b && f.dbUnits(b)["potion:health"] != 4 && time.Now().Before(deadline) {
		_ = f.pool.QueryRow(context.Background(), `SELECT COALESCE(owner_character_id::text, ''), provenance, tradeable, verified FROM items WHERE id = $1::uuid`, itemID).Scan(&owner, &prov, &tradeable, &verified)
		time.Sleep(50 * time.Millisecond)
	}
	if owner != b && f.dbUnits(b)["potion:health"] != 4 {
		t.Fatalf("taken item not Finder's in Postgres (owner %q, Finder %v)", owner, f.dbUnits(b))
	}
	f.logf("Postgres: Finder holds potion:health x%d (stack merged; provenance %s)", f.dbUnits(b)["potion:health"], provOf(f, b))
	if f.markers(b, "take:") != 1 {
		t.Fatal("take not marked")
	}

	// Drop gold; restart the zone while it lies there; it comes back, then
	// despawns on the 8 s timer and its row goes.
	var gold uint32
	for _, it := range ca.inventory().Items {
		if it.B == "currency:gold" {
			gold = it.H
		}
	}
	ca.interact(game.InteractItem, uint64(gold), game.ItemActDrop, 7)
	ca.last(game.EventDropped, 3*time.Second)
	droppedAt := time.Now()
	time.Sleep(500 * time.Millisecond)
	z.kill()
	f.logf("Dropper dropped 7 gold; zone killed while it lies there")
	z = startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port, "LODESTONE_ZONE_DROP_DESPAWN=8s")
	z.waitLog(t, "dropped items restored", 5*time.Second)
	f.logf("restart: %s", lineWith(z.logs.String(), "dropped items restored"))
	time.Sleep(time.Until(droppedAt.Add(9500 * time.Millisecond)))
	z.waitLog(t, "dropped item despawned", 5*time.Second)
	var n int
	deadline = time.Now().Add(3 * time.Second)
	for {
		_ = f.pool.QueryRow(context.Background(), `SELECT count(*) FROM items WHERE owner_character_id IS NULL AND world_id = $1::uuid`, f.world).Scan(&n)
		if n == 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	f.logf("checked %.1f s after the drop (despawn timer 8 s, restart in between): pickup despawned, world rows left: %d", time.Since(droppedAt).Seconds(), n)
	if n != 0 {
		t.Fatal("despawned item's row not deleted")
	}
	if u := f.dbUnits(a); u["currency:gold"] != 13 {
		t.Fatalf("Dropper's gold %v", u)
	}
	f.logf("PASS")
	if os.Getenv("LODESTONE_EVIDENCE") == "1" {
		fmt.Print(f.log.String())
	}
}

func provOf(f *itemFixture, char string) string {
	var p string
	_ = f.pool.QueryRow(context.Background(), `SELECT provenance::text FROM items WHERE owner_character_id = $1::uuid AND base_id = 'potion:health'`, char).Scan(&p)
	return p
}

func lineWith(logs, s string) string {
	for _, l := range strings.Split(logs, "\n") {
		if strings.Contains(l, s) {
			return strings.TrimSpace(l)
		}
	}
	return ""
}

var _ = http.Get
