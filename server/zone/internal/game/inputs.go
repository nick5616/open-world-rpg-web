package game

// The tick's input phase (WP19 second pass): joins aside, every session's
// queued messages are applied in session order, as before, but runs of
// sessions whose input this tick is plain movement go to the workers.
//
// Why it is exact: a "plain" session (inputSerial false) has only Input
// messages whose frames to apply carry no attack, cast, drink or mobility
// dash. Applying those touches nothing but the session itself: its ack, its
// frame buffer and budget, its entity's movement state (StepFrameEnv reads
// the ground and this tick's env, both read-only here), its combat player's
// frame record (combat.Player.Frame/RecordFrame without the world effects:
// World.Frame only reaches the world when something started), atomic
// counters, and a reliable Event on its own connection (drowned). It never
// reads another session's state. Everything else (Interact, HitClaim,
// combat frames, a session that has closed) can, so it runs on the tick
// goroutine at its place in the order, after the plain run before it has
// finished. The result is the same as applying every session one by one.
//
// Measured at scenario 1 (300 players on terrain): the serial input phase
// was 1.5-2.2 ms per tick (docs/decisions/v1-capacity.md).

import (
	"time"

	"lodestone/server/pkg/proto"
)

// complexFrameFlags: input bits whose frame can start something the combat
// world turns into effects on others (World.Frame): attacks, casts,
// consumables. A dodge with a cast slot (mobility dash variant) also needs
// the world (cast FX). See inputSerial.
const complexFrameFlags = proto.InputFlagAttack | proto.InputFlagCast | proto.InputFlagInteract

func complexFrame(f proto.InputFrame) bool {
	return f.Flags&complexFrameFlags != 0 || (f.Flags&proto.InputFlagDodge != 0 && f.CastSlot != 0)
}

// takeInputs moves every session's inbox into sess.taken and decides
// whether it must be applied on the tick goroutine.
func (s *Server) takeInputs() {
	for _, sess := range s.sessions {
		sess.mu.Lock()
		sess.taken = sess.inbox
		sess.inbox = sess.spare[:0]
		sess.spare = nil
		sess.mu.Unlock()
		sess.inSerial = s.inputSerial(sess)
	}
}

// inputSerial reports a session whose messages this tick may read or write
// beyond the session itself (see the file comment).
func (s *Server) inputSerial(sess *session) bool {
	if sess.ent == nil {
		return true
	}
	for _, m := range sess.taken {
		in, ok := m.(*proto.Input)
		if !ok {
			return true // HitClaim, Interact
		}
		for _, f := range in.Frames {
			if f.Seq > sess.consumed && complexFrame(f) {
				return true
			}
		}
	}
	for _, f := range sess.frames { // held behind a gap since an earlier tick
		if complexFrame(f) {
			return true
		}
	}
	return false
}

// applyInputs applies every session's taken messages in session order:
// leaves and serial sessions on the tick goroutine, runs of plain sessions
// in parallel (each run finishes before the next serial item).
func (s *Server) applyInputs(now time.Time) {
	batch := s.inBatch[:0]
	flush := func() {
		if len(batch) == 0 {
			return
		}
		b := batch
		parallelFor(len(b), s.phaseWorkers(len(b)), inputChunk, func(_, i int) { s.drainTaken(b[i], now) })
		clear(batch)
		batch = batch[:0]
	}
	for i := 0; i < len(s.sessions); {
		sess := s.sessions[i]
		if sess.closed.Load() {
			flush()
			s.leave(sess) // removes sessions[i]; don't advance
			continue
		}
		i++
		if sess.inSerial {
			flush()
			s.drainTaken(sess, now)
			continue
		}
		batch = append(batch, sess)
	}
	flush()
	s.inBatch = batch
}
