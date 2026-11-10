package game

// Playtest 2 instruments (CR 028, contracts/content.yaml instruments).
//
// A player carrying an instrument starts playing (Interact 120/1): the zone
// checks the item and the body (on the ground, not downed) and plays the
// looping system emote 22 (value = the instrument) to the players near them,
// so everyone sees the playing pose (emotes.go re-tells newcomers and ends
// it when the player walks away). The client batches what it plays: one
// Interact 120/2 every instruments.batchMs at most, five note events packed
// into targetId + arg (MIDI note, velocity, ms into the batch), plus the
// client's batch clock so listeners keep the rhythm between batches. The
// zone checks each note against the instrument's range and a per-player
// token bucket of notes started (the rest are dropped) and relays the batch
// as it arrives (Event 1120) to the players within hearM, nobody else.
// Interact 120 has its own message bucket (readLoop: batchBurst then
// batchesPerS), so the generic Interact limiter (10 then 5/s) neither drops
// a fast melody nor counts it.
//
// Nothing is sent per tick. A player who never plays costs nothing; one who
// plays costs a distance check per other player per batch, and a once-a-
// second check (musicTick) for a song that ended in silence, the fireside
// song and a playing pose that ended (walked away, another emote).
//
// Songs: notes with no gap longer than song.gapS. A song of song.minNotes
// over song.minS ends with Event 1122 to the player; townsfolk within
// applause.npcM applaud it (emote 3 to the players near each of them, once
// per applause.everyS). Fireside: fireside.songS of playing at night within
// camps fire.warmthM of a burning campfire grants Rested (with the fire's
// bonus) to the player and to every player by that fire. Jam: a player may
// set a shared metronome (Event 1123: bpm and a downbeat on the server
// clock); players within hearM, and those who start playing there later,
// get it.

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"sort"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ratelimit"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/items"
)

// Interact 120 `music`.
const (
	InteractMusic = 120

	MusicActStart  = 1 // targetId = instrument id
	MusicActNotes  = 2 // targetId = 4 note events, arg = 5th event | batch clock << 16
	MusicActStop   = 3
	MusicActTempo  = 4 // arg = bpm (0 stops the metronome)
	MusicActDevKit = 9 // dev builds only: every instrument in your pack
)

// Events 1120-1123 (contracts/events.md, range 1120-1139).
const (
	EventMusicNotes   = 1120
	EventMusicRefused = 1121
	EventMusicSong    = 1122
	EventJamTempo     = 1123
)

// Refusals (Event 1121 value).
const (
	MusicRefuseNoInstrument = 1
	MusicRefuseNotNow       = 2
	MusicRefuseNotPlaying   = 3
	MusicRefuseTooFast      = 4
	MusicRefuseBad          = 5
)

// EmotePlaying is the system emote of a player playing (value = instrument id).
const EmotePlaying = 22

// EmoteCheer is the wheel's cheer: townsfolk applauding (value 0 cheer, 1 clap).
const EmoteCheer = 3

const (
	musicEveryTicks    = 30 // songs, the fireside, a pose that ended: once a second
	musicNotesPerBatch = 5
	musicRefuseEvery   = 2 * time.Second
)

// musicFiresideTest stands in for "night by a burning campfire" in tests (nil: the camps and the clock decide).
var musicFiresideTest func(s *Server, x, z float64) (bool, float64, float64)

// musicState is one session's playing.
type musicState struct {
	inst      *contentdefs.Instrument
	playing   bool
	notes     ratelimit.Bucket
	refusedAt time.Time
	// The song in progress.
	songNotes int
	songStart time.Time
	lastNote  time.Time
	added     int // notes counted since the last content save
	// Fireside: seconds played by a burning fire at night, this song.
	fireS    float64
	fireLast time.Time
	fireDone bool
	// Townsfolk applause, at most once per applause.everyS.
	ovationAt time.Time
	// The shared metronome this player set (0 = none).
	jamBpm   int
	jamEpoch int64
}

func (s *Server) musicOf(sess *session) *musicState {
	if sess.music == nil {
		in := &contentdefs.D.Instruments
		sess.music = &musicState{notes: ratelimit.New(in.NotesBurst, in.NotesPerS)}
	}
	return sess.music
}

// musicMsgBucket is the readLoop's bucket for Interact 120 (reader goroutine only).
func (sess *session) musicMsgBucket() *ratelimit.Bucket {
	if !sess.musicBktOn {
		in := &contentdefs.D.Instruments
		sess.musicBkt = ratelimit.New(in.BatchBurst, in.BatchesPerS)
		sess.musicBktOn = true
	}
	return &sess.musicBkt
}

// musicInteract applies Interact 120 (tick goroutine).
func (s *Server) musicInteract(sess *session, m *proto.Interact, now time.Time) {
	e := sess.ent
	if e == nil {
		return
	}
	ms := s.musicOf(sess)
	refuse := func(r int32) {
		if (r == MusicRefuseTooFast || r == MusicRefuseNotPlaying) && now.Sub(ms.refusedAt) < musicRefuseEvery {
			return // a stream of batches gets one answer every 2 s
		}
		if r == MusicRefuseTooFast || r == MusicRefuseNotPlaying {
			ms.refusedAt = now
		}
		s.sendEvent(sess, &proto.Event{Kind: EventMusicRefused, EntityID: e.ID, TargetID: uint32(m.Action), Value: r})
	}
	switch m.Action {
	case MusicActStart:
		def := contentdefs.D.Instrument(int(m.TargetID))
		if m.TargetID > 255 || def == nil {
			refuse(MusicRefuseBad)
			return
		}
		ci := sess.items
		if ci == nil || ci.inv.Count(def.Item) == 0 {
			refuse(MusicRefuseNoInstrument)
			return
		}
		if (e.cbt != nil && e.cbt.Downed) || !emoteModeOK(e) {
			refuse(MusicRefuseNotNow)
			return
		}
		s.musicStart(sess, def, now)
	case MusicActNotes:
		if !ms.playing {
			refuse(MusicRefuseNotPlaying)
			return
		}
		s.musicNotes(sess, m, now, refuse)
	case MusicActStop:
		s.musicStop(sess, true, now)
	case MusicActTempo:
		if !ms.playing {
			refuse(MusicRefuseNotPlaying)
			return
		}
		bpm := int(m.Arg)
		jam := &contentdefs.D.Instruments.Jam
		if bpm != 0 && (bpm < jam.Bpm[0] || bpm > jam.Bpm[1]) {
			refuse(MusicRefuseBad)
			return
		}
		s.musicJam(sess, bpm)
	case MusicActDevKit:
		ci := sess.items
		if !s.cfg.DevSpawn || ci == nil {
			refuse(MusicRefuseNotNow)
			return
		}
		var d items.Delta
		var got []*items.Item
		for _, in := range contentdefs.D.Instruments.List {
			if ci.inv.Count(in.Item) > 0 || !ci.inv.CanFit(in.Item, 1) {
				continue
			}
			it := items.Stack(in.Item, 1)
			ci.inv.Add(it, &d)
			got = append(got, it)
		}
		if len(got) > 0 {
			s.commitItems(sess, &d, nil, "dev instruments")
			s.sendGranted(sess, SourceContent, got)
		}
	default:
		refuse(MusicRefuseBad)
	}
}

// musicStart starts (or switches) sess's instrument.
func (s *Server) musicStart(sess *session, def *contentdefs.Instrument, now time.Time) {
	e := sess.ent
	ms := s.musicOf(sess)
	s.fishStop(sess, FishLostCancelled) // the instrument takes the hands (fishing.go)
	ms.inst = def
	ms.playing = true
	s.playEmote(sess, EmotePlaying, true, int32(def.ID), e.Move.Pos.X, e.Move.Pos.Y, e.Move.Pos.Z)
	if s.bards == nil {
		s.bards = map[*session]struct{}{}
	}
	s.bards[sess] = struct{}{}
	// A metronome running nearby joins you to the jam.
	var lead *session
	for o := range s.bards {
		if o == sess || o.ent == nil || o.music == nil || o.music.jamBpm == 0 || !musicNear(o.ent, e, contentdefs.D.Instruments.HearM) {
			continue
		}
		if lead == nil || o.music.jamEpoch > lead.music.jamEpoch {
			lead = o
		}
	}
	if lead != nil {
		s.sendEvent(sess, jamEvent(lead))
	}
	s.log.Debug("music start", "character", e.CharacterID, "instrument", def.Key)
}

// musicNear: within r horizontally and vertically (the emote rule).
func musicNear(a, b *Entity, r float64) bool {
	return math.Hypot(a.Move.Pos.X-b.Move.Pos.X, a.Move.Pos.Z-b.Move.Pos.Z) <= r && math.Abs(a.Move.Pos.Y-b.Move.Pos.Y) <= r
}

// MusicNote is one decoded note event (Event 1120 layout).
type MusicNote struct {
	Note, Vel, OffsetMs uint8
}

// DecodeMusicNote splits a u16 note event (0 = an empty slot: ok false).
func DecodeMusicNote(v uint16) (MusicNote, bool) {
	if v == 0 {
		return MusicNote{}, false
	}
	return MusicNote{Note: uint8(v & 0x7f), Vel: uint8(v>>7) & 7, OffsetMs: uint8(v >> 10)}, true
}

// EncodeMusicNote packs a note event.
func EncodeMusicNote(n MusicNote) uint16 {
	return uint16(n.Note&0x7f) | uint16(n.Vel&7)<<7 | uint16(n.OffsetMs&63)<<10
}

// musicNotes checks one batch and relays what passes.
func (s *Server) musicNotes(sess *session, m *proto.Interact, now time.Time, refuse func(int32)) {
	e := sess.ent
	ms := sess.music
	in := ms.inst
	var raw [musicNotesPerBatch]uint16
	for i := 0; i < 4; i++ {
		raw[i] = uint16(m.TargetID >> (16 * i))
	}
	raw[4] = uint16(m.Arg)
	clock := int32(m.Arg >> 16)
	data := make([]byte, 0, 2*musicNotesPerBatch)
	ons, dropped := 0, 0
	for _, v := range raw {
		n, ok := DecodeMusicNote(v)
		if !ok {
			continue
		}
		if int(n.Note) < in.Range[0] || int(n.Note) > in.Range[1] {
			continue // a client of ours never sends one; a hostile one gains nothing
		}
		if n.Vel > 0 {
			if !ms.notes.Take(now) {
				dropped++
				continue
			}
			ons++
		}
		data = binary.LittleEndian.AppendUint16(data, v)
	}
	if dropped > 0 {
		refuse(MusicRefuseTooFast)
	}
	if len(data) == 0 {
		return
	}
	ev := &proto.Event{Kind: EventMusicNotes, EntityID: e.ID, TargetID: uint32(in.ID), Value: clock, X: cm(e.Move.Pos.X), Y: cm(e.Move.Pos.Y), Z: cm(e.Move.Pos.Z), Data: data}
	r := contentdefs.D.Instruments.HearM
	for _, o := range s.sessions {
		if o.ent == nil || o.ent == e || !musicNear(o.ent, e, r) {
			continue
		}
		s.sendEvent(o, ev)
	}
	if ons == 0 {
		return
	}
	// The song, the fireside, the feats.
	if ms.songNotes == 0 {
		ms.songStart = now
	}
	ms.songNotes += ons
	ms.lastNote = now
	ms.added += ons
	s.musicFireside(sess, now)
	if cs := sess.cnt; cs != nil {
		before := cs.st.Stat("notes")
		after := cs.st.Add("notes", ons)
		for _, f := range contentdefs.D.Feats {
			if f.Stat == "notes" && before < f.N && after >= f.N {
				s.contentFeats(sess)
				s.saveContent(sess)
				ms.added = 0
				break
			}
		}
	}
}

// musicFireside counts playing by a burning campfire at night; fireside.songS of it rests you and everyone by the fire.
func (s *Server) musicFireside(sess *session, now time.Time) {
	ms := sess.music
	if ms.fireDone {
		return
	}
	e := sess.ent
	ok, fx, fz := s.musicFireAt(e.Move.Pos.X, e.Move.Pos.Z)
	fs := &contentdefs.D.Instruments.Fireside
	if !ok {
		ms.fireS, ms.fireLast = 0, time.Time{}
		return
	}
	if !ms.fireLast.IsZero() {
		gap := now.Sub(ms.fireLast).Seconds()
		if gap > fs.GapS {
			ms.fireS = 0
		} else {
			ms.fireS += gap
		}
	}
	ms.fireLast = now
	if ms.fireS < fs.SongS {
		return
	}
	ms.fireDone = true
	warm := campdefs.D.Fire.WarmthM
	rested := 0
	for _, o := range s.sessions {
		oe := o.ent
		if oe == nil || o.left || math.Hypot(oe.Move.Pos.X-fx, oe.Move.Pos.Z-fz) > warm+1 {
			continue
		}
		if s.musicRest(o, o == sess) {
			rested++
		}
	}
	if cs := sess.cnt; cs != nil {
		cs.st.Add("firesongs", 1)
		s.contentFeats(sess)
		s.saveContent(sess)
	}
	s.log.Info("fireside song", "character", e.CharacterID, "rested", rested)
}

// musicFireAt: night, and a burning campfire within fire.warmthM of (x, z) (its x, z).
func (s *Server) musicFireAt(x, z float64) (bool, float64, float64) {
	if musicFiresideTest != nil {
		return musicFiresideTest(s, x, z)
	}
	nowW := s.worldTimeS()
	if !weather.IsNight(nowW) {
		return false, 0, 0
	}
	warm := campdefs.D.Fire.WarmthM
	for _, p := range s.piecesNear(x, z, warm) {
		if p.Kind == campdefs.Campfire && p.BurnUntil > nowW {
			return true, p.X, p.Z
		}
	}
	return false, 0, 0
}

// musicRest grants Rested by the fire (the bedroll's rule without the bedroll: camps.go campRest).
func (s *Server) musicRest(sess *session, player bool) bool {
	e := sess.ent
	rd := &campdefs.D.Rested
	if e.cbt != nil && s.cbt.w != nil && (e.cbt.Downed || e.cbt.InCombatWithin(s.cbt.w.Tick(), rd.CombatLockS)) {
		return false
	}
	cs := s.sessCamp(sess)
	until := s.cfg.Now().Add(time.Duration((rd.DurationS + rd.FireBonusS) * float64(time.Second)))
	if cs.restedOn && !cs.restedUntil.Before(until) {
		return false
	}
	cs.restedUntil, cs.restedFire = until, true
	s.campApplyRested(sess)
	text := "The song and the fire's warmth settle into your bones. You feel Rested."
	if player {
		text = "Your song carries over the fire. You and everyone by it feel Rested."
	}
	s.campNote(sess, 2, text)
	s.sendCampMine(sess)
	return true
}

// musicStop ends sess's playing (the song too); tell: the zone ends the pose (a client stop).
func (s *Server) musicStop(sess *session, tell bool, now time.Time) {
	ms := sess.music
	if ms == nil || !ms.playing {
		return
	}
	ms.playing = false
	s.musicSongEnd(sess, now)
	if ms.jamBpm != 0 {
		s.musicJam(sess, 0)
	}
	if em := sess.emotes; tell && em != nil && em.loop != nil && em.loop.id == EmotePlaying {
		s.stopEmote(sess, true)
	}
	delete(s.bards, sess)
}

// musicSongEnd closes the song in progress: Event 1122, townsfolk applause, a save.
func (s *Server) musicSongEnd(sess *session, now time.Time) {
	ms := sess.music
	e := sess.ent
	n := ms.songNotes
	secs := ms.lastNote.Sub(ms.songStart).Seconds()
	ms.songNotes, ms.fireS, ms.fireLast, ms.fireDone = 0, 0, time.Time{}, false
	if ms.added > 0 && sess.cnt != nil {
		s.saveContent(sess)
		ms.added = 0
	}
	sg := &contentdefs.D.Instruments.Song
	if e == nil || n < sg.MinNotes || secs < sg.MinS {
		return
	}
	applause := 0
	ap := &contentdefs.D.Instruments.Applause
	if ms.ovationAt.IsZero() || now.Sub(ms.ovationAt).Seconds() >= ap.EveryS {
		applause = s.musicApplause(e)
		if applause > 0 {
			ms.ovationAt = now
			if cs := sess.cnt; cs != nil {
				cs.st.Add("ovations", 1)
				s.contentFeats(sess)
				s.saveContent(sess)
			}
		}
	}
	line := ""
	if applause > 0 {
		line = "The townsfolk applaud your song!"
	}
	b, _ := json.Marshal(struct {
		Notes    int     `json:"notes"`
		Seconds  float64 `json:"seconds"`
		Applause int     `json:"applause"`
		Line     string  `json:"line"`
	}{n, math.Round(secs*10) / 10, applause, line})
	s.sendEvent(sess, &proto.Event{Kind: EventMusicSong, EntityID: e.ID, TargetID: uint32(applause), Value: int32(n), Data: b})
}

// musicApplause: the townsfolk within applause.npcM of e cheer or clap (emote 3 to the players near each); how many.
func (s *Server) musicApplause(e *Entity) int {
	ap := &contentdefs.D.Instruments.Applause
	type cand struct {
		e *Entity
		d float64
	}
	var near []cand
	for _, n := range s.town.active {
		if n == nil {
			continue
		}
		if d := math.Hypot(n.Move.Pos.X-e.Move.Pos.X, n.Move.Pos.Z-e.Move.Pos.Z); d <= ap.NpcM && math.Abs(n.Move.Pos.Y-e.Move.Pos.Y) <= ap.NpcM {
			near = append(near, cand{n, d})
		}
	}
	sort.Slice(near, func(i, j int) bool {
		return near[i].d < near[j].d || near[i].d == near[j].d && near[i].e.ID < near[j].e.ID
	})
	if len(near) > ap.MaxNpcs {
		near = near[:ap.MaxNpcs]
	}
	for _, c := range near {
		n := c.e
		ev := &proto.Event{Kind: EventEmote, EntityID: n.ID, TargetID: EmoteCheer, Value: int32(n.ID & 1), X: cm(n.Move.Pos.X), Y: cm(n.Move.Pos.Y), Z: cm(n.Move.Pos.Z)}
		s.emoteTell(n, ev, nil)
	}
	return len(near)
}

// jamEvent is Event 1123 for o's metronome.
func jamEvent(o *session) *proto.Event {
	p := o.ent.Move.Pos
	return &proto.Event{Kind: EventJamTempo, EntityID: o.ent.ID, Value: int32(o.music.jamBpm), X: cm(p.X), Y: cm(p.Y), Z: cm(p.Z), Data: binary.LittleEndian.AppendUint64(nil, uint64(o.music.jamEpoch))}
}

// musicJam sets (bpm > 0) or stops sess's metronome and tells the players within hearM, sess included.
func (s *Server) musicJam(sess *session, bpm int) {
	ms := sess.music
	ms.jamBpm = bpm
	if bpm > 0 {
		ms.jamEpoch = int64(math.Round(s.serverTimeMs()))
	}
	ev := jamEvent(sess)
	r := contentdefs.D.Instruments.HearM
	for _, o := range s.sessions {
		if o.ent != nil && (o == sess || musicNear(o.ent, sess.ent, r)) {
			s.sendEvent(o, ev)
		}
	}
}

// musicTick: once a second, for players playing: a song that ended in
// silence, a playing pose that ended (walked away, another emote, a cast).
func (s *Server) musicTick(tick uint32) {
	if len(s.bards) == 0 || tick%musicEveryTicks != 0 {
		return
	}
	now := s.cfg.Now()
	gap := time.Duration(contentdefs.D.Instruments.Song.GapS * float64(time.Second))
	for sess := range s.bards {
		ms := sess.music
		if sess.ent == nil || sess.left || ms == nil || !ms.playing {
			delete(s.bards, sess)
			continue
		}
		if em := sess.emotes; em == nil || em.loop == nil || em.loop.id != EmotePlaying {
			s.musicStop(sess, false, now)
			continue
		}
		if ms.songNotes > 0 && now.Sub(ms.lastNote) > gap {
			s.musicSongEnd(sess, now)
		}
	}
}

// musicLeave forgets a leaving session (its notes count is saved by contentLeave).
func (s *Server) musicLeave(sess *session) {
	delete(s.bards, sess)
}
