package game

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"testing"
	"time"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/proto"
)

// musicHarness: a player, one listener 12 m away, one at 35 m (inside
// hearM 40), one at 60 m (outside it).
func musicHarness(t *testing.T) (*harness, *client, *client, *client, *client) {
	t.Helper()
	h := newHarness(t, nil)
	a := h.dial("?spawn=2048,0,2048")
	a.join(h, "music-a", "Bard")
	near := h.dial("?spawn=2060,0,2048")
	near.join(h, "music-near", "Near")
	mid := h.dial("?spawn=2048,0,2083")
	mid.join(h, "music-mid", "Mid")
	far := h.dial("?spawn=2108,0,2048")
	far.join(h, "music-far", "Far")
	for _, c := range []*client{a, near, mid, far} {
		c.pump(150 * time.Millisecond)
	}
	return h, a, near, mid, far
}

// notesMsg packs up to 5 note events and a batch clock into Interact 120/2.
func notesMsg(clock uint16, ns ...MusicNote) *proto.Interact {
	var raw [5]uint16
	for i, n := range ns {
		raw[i] = EncodeMusicNote(n)
	}
	var tid uint64
	for i := 0; i < 4; i++ {
		tid |= uint64(raw[i]) << (16 * i)
	}
	return &proto.Interact{TargetKind: InteractMusic, Action: MusicActNotes, TargetID: tid, Arg: uint32(raw[4]) | uint32(clock)<<16}
}

func startPlaying(t *testing.T, c *client, instrument uint64) {
	t.Helper()
	before := len(c.eventsOf(EventMusicRefused))
	c.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActDevKit})
	c.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActStart, TargetID: instrument})
	c.pump(200 * time.Millisecond)
	if r := c.eventsOf(EventMusicRefused); len(r) != before {
		t.Fatalf("start refused: %+v", r[len(r)-1])
	}
}

func notesOf(t *testing.T, e *proto.Event) []MusicNote {
	t.Helper()
	if len(e.Data)%2 != 0 {
		t.Fatalf("odd note data %d bytes", len(e.Data))
	}
	var out []MusicNote
	for i := 0; i < len(e.Data); i += 2 {
		n, ok := DecodeMusicNote(binary.LittleEndian.Uint16(e.Data[i:]))
		if !ok {
			t.Fatalf("an empty slot was relayed")
		}
		out = append(out, n)
	}
	return out
}

func TestMusicNoteCodec(t *testing.T) {
	for _, n := range []MusicNote{{60, 5, 0}, {127, 7, 63}, {40, 0, 17}, {1, 1, 1}} {
		got, ok := DecodeMusicNote(EncodeMusicNote(n))
		if !ok || got != n {
			t.Fatalf("%+v -> %+v (%v)", n, got, ok)
		}
	}
	if _, ok := DecodeMusicNote(0); ok {
		t.Fatal("0 is the empty slot")
	}
	// The TS twin (client/src/ui/music/wire.ts) packs C4 velocity 5 at 12 ms as this.
	if v := EncodeMusicNote(MusicNote{60, 5, 12}); v != 60|5<<7|12<<10 {
		t.Fatalf("layout %d", v)
	}
}

func TestMusicRelayRadiusAndNoEcho(t *testing.T) {
	_, a, near, mid, far := musicHarness(t)
	if contentdefs.D.Instruments.HearM < 35 || contentdefs.D.Instruments.HearM >= 60 {
		t.Fatalf("hearM %.0f: the harness expects 35 m inside, 60 m outside", contentdefs.D.Instruments.HearM)
	}
	startPlaying(t, a, 1) // the lute
	near.pump(100 * time.Millisecond)
	if e := lastEv(near, EventEmote); e == nil || e.TargetID != EmotePlaying || e.Value != 1 {
		t.Fatalf("the near player should see the playing pose with the lute: %+v", e)
	}
	a.send(notesMsg(1234, MusicNote{60, 5, 0}, MusicNote{64, 4, 20}, MusicNote{67, 6, 41}))
	a.pump(150 * time.Millisecond)
	for _, c := range []*client{near, mid, far} {
		c.pump(100 * time.Millisecond)
	}
	for name, c := range map[string]*client{"near": near, "mid": mid} {
		got := c.eventsOf(EventMusicNotes)
		if len(got) != 1 {
			t.Fatalf("%s: %d note events", name, len(got))
		}
		e := got[0]
		if e.TargetID != 1 || e.Value != 1234 || proto.CmToMeters(e.X) != 2048 {
			t.Fatalf("%s: %+v", name, e)
		}
		ns := notesOf(t, e)
		if len(ns) != 3 || ns[0] != (MusicNote{60, 5, 0}) || ns[2] != (MusicNote{67, 6, 41}) {
			t.Fatalf("%s: notes %+v", name, ns)
		}
	}
	if n := len(far.eventsOf(EventMusicNotes)); n != 0 {
		t.Fatalf("a player 60 m away heard %d batches", n)
	}
	if n := len(a.eventsOf(EventMusicNotes)); n != 0 {
		t.Fatalf("the player got %d echoes of their own notes", n)
	}
}

func TestMusicRefusalsAndRange(t *testing.T) {
	_, a, near, _, _ := musicHarness(t)
	// No instrument in the pack, then notes before starting.
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActStart, TargetID: 2})
	a.send(notesMsg(0, MusicNote{60, 5, 0}))
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActStart, TargetID: 99})
	a.pump(200 * time.Millisecond)
	want := []int32{MusicRefuseNoInstrument, MusicRefuseNotPlaying, MusicRefuseBad}
	got := a.eventsOf(EventMusicRefused)
	if len(got) != len(want) {
		t.Fatalf("refusals %+v", got)
	}
	for i, w := range want {
		if got[i].Value != w {
			t.Fatalf("refusal %d: %d, want %d", i, got[i].Value, w)
		}
	}
	// The flute plays 60..96: a note outside is dropped, a batch of only those is not relayed.
	startPlaying(t, a, 2)
	a.send(notesMsg(10, MusicNote{30, 5, 0}, MusicNote{110, 5, 3}))
	a.send(notesMsg(60, MusicNote{30, 5, 0}, MusicNote{72, 5, 3}, MusicNote{72, 0, 40}))
	a.pump(150 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	evs := near.eventsOf(EventMusicNotes)
	if len(evs) != 1 {
		t.Fatalf("relayed %d batches, want 1", len(evs))
	}
	if ns := notesOf(t, evs[0]); len(ns) != 2 || ns[0].Note != 72 || ns[1].Vel != 0 {
		t.Fatalf("relayed %+v", ns)
	}
}

func TestMusicRateLimits(t *testing.T) {
	_, a, near, _, _ := musicHarness(t)
	startPlaying(t, a, 3) // the hand drum
	in := &contentdefs.D.Instruments
	// Notes started: a burst of notesBurst, the rest dropped (and one "too fast").
	batches := int(in.NotesBurst)/5 + 4
	for i := 0; i < batches; i++ {
		a.send(notesMsg(uint16(i*50), MusicNote{48, 5, 0}, MusicNote{50, 5, 5}, MusicNote{52, 5, 10}, MusicNote{53, 5, 15}, MusicNote{55, 5, 20}))
		if i%int(in.BatchBurst/2) == 0 {
			a.pump(60 * time.Millisecond) // stay under the message bucket
		}
	}
	a.pump(250 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	ons := 0
	for _, e := range near.eventsOf(EventMusicNotes) {
		ons += len(notesOf(t, e))
	}
	// A little refill while the batches went out (notesPerS over ~0.5 s).
	if ons < int(in.NotesBurst) || ons > int(in.NotesBurst)+int(in.NotesPerS) {
		t.Fatalf("relayed %d notes of %d sent, want the burst %.0f (+ refill)", ons, batches*5, in.NotesBurst)
	}
	fast := 0
	for _, r := range a.eventsOf(EventMusicRefused) {
		if r.Value == MusicRefuseTooFast {
			fast++
		}
	}
	if fast != 1 {
		t.Fatalf("too-fast answers %d, want 1 (one per 2 s)", fast)
	}
}

// Interact 120 has its own message bucket: a melody at the batch rate (20/s)
// passes where the generic Interact limiter (10, then 5/s) would drop most.
func TestMusicBatchesBypassInteractLimiter(t *testing.T) {
	_, a, near, _, _ := musicHarness(t)
	startPlaying(t, a, 2)
	const n = 30 // 1.5 s at 20 batches/s: note-offs only (the notes bucket doesn't count them)
	for i := 0; i < n; i++ {
		a.send(notesMsg(uint16(i*50), MusicNote{72, 0, 0}))
		a.pump(50 * time.Millisecond)
	}
	a.pump(150 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	if got := len(near.eventsOf(EventMusicNotes)); got != n {
		t.Fatalf("relayed %d of %d batches", got, n)
	}
	// Other Interacts still have the generic limiter: an emote spam right after is cut by its own rule only.
	a.send(&proto.Interact{TargetKind: InteractEmote, TargetID: 1, Action: EmoteActPlay})
	a.pump(150 * time.Millisecond)
	if len(a.eventsOf(EventEmoteRefused)) != 0 {
		t.Fatalf("the music batches used up the generic Interact budget")
	}
}

func TestMusicBardFeat(t *testing.T) {
	_, a, _, _, _ := musicHarness(t)
	startPlaying(t, a, 1)
	bard := contentdefs.D.Achievement("bard")
	if bard == nil || bard.Stat != "notes" {
		t.Fatalf("feat bard: %+v", bard)
	}
	in := &contentdefs.D.Instruments
	sent := 0
	for i := 0; sent < bard.N; i++ {
		a.send(notesMsg(uint16(i*50), MusicNote{60, 5, 0}, MusicNote{62, 5, 9}, MusicNote{64, 5, 18}, MusicNote{65, 5, 27}, MusicNote{67, 5, 36}))
		sent += 5
		if sent > int(in.NotesBurst)-5 {
			a.pump(time.Duration(5/in.NotesPerS*1000+30) * time.Millisecond) // the refill for one batch
		}
	}
	a.pump(300 * time.Millisecond)
	var earned []string
	for _, e := range a.eventsOf(EventFeatEarned) {
		var f struct{ Key string }
		_ = json.Unmarshal(e.Data, &f)
		earned = append(earned, f.Key)
	}
	if len(earned) != 1 || earned[0] != "bard" {
		t.Fatalf("feats earned %v, want [bard]", earned)
	}
	if n := len(a.eventsOf(EventMusicRefused)); n != 0 {
		t.Fatalf("%d refusals while playing at the allowed rate", n)
	}
}

func TestMusicSongApplauseAndStop(t *testing.T) {
	h, a, near, _, _ := musicHarness(t)
	sg := &contentdefs.D.Instruments.Song
	old := *sg
	sg.MinS, sg.MinNotes = 0.3, 8
	t.Cleanup(func() { *sg = old })
	// Two townsfolk: one 6 m from the player, one 30 m (beyond applause.npcM).
	var npcNear, npcFar *Entity
	_ = h.srv.Do(context.Background(), func() {
		s := h.srv
		mk := func(x float64) *Entity {
			e := &Entity{ID: s.nextID, Kind: proto.EntityKindNpc, Name: "Townsfolk", Health: 100, HealthMax: 100}
			s.nextID++
			e.Move.Pos.X, e.Move.Pos.Z = x, 2048
			s.insertEntity(e)
			return e
		}
		npcNear, npcFar = mk(2054), mk(2078)
		s.town.active = map[int]*Entity{0: npcNear, 1: npcFar}
	})
	startPlaying(t, a, 1)
	for i := 0; i < 2; i++ {
		a.send(notesMsg(uint16(i*400), MusicNote{60, 5, 0}, MusicNote{64, 5, 10}, MusicNote{67, 5, 20}, MusicNote{72, 5, 30}, MusicNote{76, 5, 40}))
		a.pump(400 * time.Millisecond)
	}
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActStop})
	a.pump(200 * time.Millisecond)
	near.pump(150 * time.Millisecond)
	song := lastEv(a, EventMusicSong)
	if song == nil || song.Value != 10 || song.TargetID != 1 {
		t.Fatalf("song end: %+v", song)
	}
	cheered := 0
	for _, e := range near.eventsOf(EventEmote) {
		if e.EntityID == npcNear.ID && e.TargetID == EmoteCheer {
			cheered++
		}
		if e.EntityID == npcFar.ID {
			t.Fatalf("a townsperson beyond npcM applauded")
		}
	}
	if cheered != 1 {
		t.Fatalf("the near townsperson cheered %d times", cheered)
	}
	// Stopped: notes are refused, the pose ended for the listeners.
	a.send(notesMsg(0, MusicNote{60, 5, 0}))
	a.pump(150 * time.Millisecond)
	if r := lastEv(a, EventMusicRefused); r == nil || r.Value != MusicRefuseNotPlaying {
		t.Fatalf("after stop: %+v", r)
	}
	stopSeen := false
	for _, e := range near.eventsOf(EventEmote) {
		if e.TargetID == 0 {
			stopSeen = true
		}
	}
	if !stopSeen {
		t.Fatal("the listener was not told the playing pose ended")
	}
	// A second song within applause.everyS: no ovation.
	startPlaying(t, a, 1)
	a.send(notesMsg(0, MusicNote{60, 5, 0}, MusicNote{64, 5, 10}, MusicNote{67, 5, 20}, MusicNote{72, 5, 30}, MusicNote{76, 5, 40}))
	a.pump(400 * time.Millisecond)
	a.send(notesMsg(400, MusicNote{60, 5, 0}, MusicNote{64, 5, 10}, MusicNote{67, 5, 20}, MusicNote{72, 5, 30}, MusicNote{76, 5, 40}))
	a.pump(100 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActStop})
	a.pump(200 * time.Millisecond)
	if s := lastEv(a, EventMusicSong); s == nil || s.TargetID != 0 {
		t.Fatalf("a second song so soon got an ovation: %+v", s)
	}
}

func TestMusicJamTempo(t *testing.T) {
	_, a, near, _, far := musicHarness(t)
	startPlaying(t, a, 3)
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActTempo, Arg: 500})
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActTempo, Arg: 120})
	a.pump(200 * time.Millisecond)
	if r := lastEv(a, EventMusicRefused); r == nil || r.Value != MusicRefuseBad {
		t.Fatalf("500 bpm: %+v", r)
	}
	if j := lastEv(a, EventJamTempo); j == nil || j.Value != 120 || len(j.Data) != 8 {
		t.Fatalf("the leader's metronome: %+v", j)
	}
	near.pump(100 * time.Millisecond)
	far.pump(100 * time.Millisecond)
	j := lastEv(near, EventJamTempo)
	if j == nil || j.Value != 120 {
		t.Fatalf("near: %+v", j)
	}
	if n := len(far.eventsOf(EventJamTempo)); n != 0 {
		t.Fatalf("far got %d metronomes", n)
	}
	epoch := binary.LittleEndian.Uint64(j.Data)
	// Someone starting to play nearby later joins the jam (the same downbeat).
	near.evs = nil
	startPlaying(t, near, 1)
	got := lastEv(near, EventJamTempo)
	if got == nil || got.Value != 120 || binary.LittleEndian.Uint64(got.Data) != epoch {
		t.Fatalf("a late joiner: %+v", got)
	}
	// The leader stops: the metronome stops for those near.
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActStop})
	a.pump(150 * time.Millisecond)
	near.pump(150 * time.Millisecond)
	if j := lastEv(near, EventJamTempo); j == nil || j.Value != 0 {
		t.Fatalf("after the leader stopped: %+v", j)
	}
}

func TestMusicFiresideRests(t *testing.T) {
	old := musicFiresideTest
	musicFiresideTest = func(s *Server, x, z float64) (bool, float64, float64) { return true, 2050, 2048 }
	fs := &contentdefs.D.Instruments.Fireside
	oldFs := *fs
	fs.SongS = 0.6
	t.Cleanup(func() { musicFiresideTest = old; *fs = oldFs })
	h, a, near, _, _ := musicHarness(t)
	byFire := h.dial("?spawn=2053,0,2050")
	byFire.join(h, "music-fire", "Warm")
	byFire.pump(150 * time.Millisecond)
	startPlaying(t, a, 1)
	for i := 0; i < 5; i++ {
		a.send(notesMsg(uint16(i*250), MusicNote{60, 3, 0}))
		a.pump(250 * time.Millisecond)
	}
	a.pump(200 * time.Millisecond)
	byFire.pump(150 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	if r := lastEv(a, EventCampRested); r == nil || r.Value <= 0 {
		t.Fatalf("the player by the fire: %+v", r)
	}
	if r := lastEv(byFire, EventCampRested); r == nil || r.Value <= 0 {
		t.Fatalf("a listener by the fire: %+v", r)
	}
	if n := len(near.eventsOf(EventCampRested)); n != 0 {
		t.Fatalf("a listener 12 m from the fire rested (%d)", n)
	}
	// Once per song.
	n := len(a.eventsOf(EventCampRested))
	a.send(notesMsg(0, MusicNote{62, 3, 0}))
	a.pump(300 * time.Millisecond)
	if len(a.eventsOf(EventCampRested)) != n {
		t.Fatal("rested again in the same song")
	}
}

func TestMusicNotFromTheSaddle(t *testing.T) {
	h, a, _, _, _ := musicHarness(t)
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActDevKit})
	a.pump(150 * time.Millisecond)
	_ = h.srv.Do(context.Background(), func() {
		for _, sess := range h.srv.sessions {
			if sess.ent != nil && sess.ent.CharacterID == "music-a" {
				sess.ent.TypeID |= TypeRiding
			}
		}
	})
	a.send(&proto.Interact{TargetKind: InteractMusic, Action: MusicActStart, TargetID: 1})
	a.pump(150 * time.Millisecond)
	if r := lastEv(a, EventMusicRefused); r == nil || r.Value != MusicRefuseNotNow {
		t.Fatalf("playing on a steed: %+v", r)
	}
}

func TestMusicEndsWithTheEmote(t *testing.T) {
	_, a, _, _, _ := musicHarness(t)
	startPlaying(t, a, 4)
	// Stopping the loop the emote way (or walking away) ends the playing within a second.
	a.send(&proto.Interact{TargetKind: InteractEmote, Action: EmoteActStop})
	a.pump(1300 * time.Millisecond)
	a.send(notesMsg(0, MusicNote{72, 5, 0}))
	a.pump(150 * time.Millisecond)
	if r := lastEv(a, EventMusicRefused); r == nil || r.Value != MusicRefuseNotPlaying {
		t.Fatalf("still playing after the pose ended: %+v", r)
	}
}
